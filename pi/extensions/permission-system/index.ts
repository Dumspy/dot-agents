/**
 * Permission System Extension for Pi
 *
 * Configurable permission gates for Pi tools (read, write, edit, bash, webfetch, etc.).
 * Shows a simple Yes/No/Explain prompt when a tool matches an "ask" rule.
 * Supports secret masking ("cloak") for the read tool via regex patterns.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/permissions.json (global)
 * - <cwd>/.pi/permissions.json (project-local)
 *
 * Example permissions.json:
 * {
 *   "rules": {
 *     "read": {
 *       "*": "allow",
 *       ".env": "cloak",
 *       ".ssh/**": "deny"
 *     },
 *     "bash": {
 *       "*": "ask",
 *       "ls*": "allow",
 *       "git status*": "allow"
 *     },
 *     "webfetch": "ask",
 *     "external_directory": {
 *       "**": "ask",
 *       "~/projects/personal/**": "allow"
 *     }
 *   },
 *   "masks": {
 *     "read": {
 *       ".env": { "pattern": "(=).+", "replace": "$1" }
 *     }
 *   }
 * }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
	DEFAULT_CONFIG,
	applyMask,
	buildSessionApprovalKey,
	createLogEntry,
	deepMerge,
	formatLogLine,
	formatToolDescription,
	getExternalDirectoryRoot,
	getToolValue,
	hardStop,
	resolvePermission,
	resolveToolPath,
	shouldMask,
	type PermissionsConfig,
} from "./lib.js";

function getAgentDir(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
	return join(home, ".pi", "agent");
}

function loadConfig(cwd: string): PermissionsConfig {
	const globalPath = join(getAgentDir(), "permissions.json");
	const projectPath = join(cwd, ".pi", "permissions.json");

	let globalConfig: Partial<PermissionsConfig> = {};
	let projectConfig: Partial<PermissionsConfig> = {};

	if (existsSync(globalPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch (e) {
			console.error(`[permissions] Warning: Could not parse ${globalPath}: ${e}`);
		}
	}

	if (existsSync(projectPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
		} catch (e) {
			console.error(`[permissions] Warning: Could not parse ${projectPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

const SYSTEM_PROMPT_NOTICE = `Permission system is active. Some paths and tools are denied by policy. If a tool call is blocked, stop and report the restriction to the user — never use bash or another tool as a workaround.`;

export default function permissionSystem(pi: ExtensionAPI) {
	let config = DEFAULT_CONFIG;
	const sessionApprovals = new Set<string>();

	function reloadConfig(cwd: string) {
		config = loadConfig(cwd);
	}

	function logDecision(
		toolName: string,
		value: string,
		cwd: string,
		action: import("./lib.js").PermissionAction,
		reason: string,
	): void {
		const logPath = join(getAgentDir(), "permissions.log.jsonl");
		try {
			mkdirSync(dirname(logPath), { recursive: true });
		} catch {}
		appendFileSync(logPath, formatLogLine(createLogEntry(toolName, value, cwd, action, reason)));
	}

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig(ctx.cwd);
		sessionApprovals.clear();
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_PROMPT_NOTICE}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		// --- External directory gate ---
		const resolvedPath = resolveToolPath(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		if (resolvedPath) {
			const extDirRoot = getExternalDirectoryRoot(resolvedPath, ctx.cwd);
			if (extDirRoot) {
				const extRules = config.rules.external_directory;
				const extPermission = resolvePermission(extRules, extDirRoot);

				if (extPermission === "deny") {
					logDecision(event.toolName, resolvedPath ?? "", ctx.cwd, "blocked", `external_directory deny: ${extDirRoot}`);
					return { block: true, reason: `External directory access denied by policy: ${event.toolName} \`${resolvedPath}\`. ${hardStop()}` };
				}

				if (extPermission === "ask" || extPermission === "cloak") {
					if (!ctx.hasUI) {
						logDecision(event.toolName, resolvedPath ?? "", ctx.cwd, "blocked-no-ui", "external_directory ask (no UI)");
						return { block: true, reason: `External directory access required (no UI): ${event.toolName} \`${resolvedPath}\`. ${hardStop()}` };
					}

					const extApprovalKey = buildSessionApprovalKey("external_directory", extDirRoot);
					if (!sessionApprovals.has(extApprovalKey)) {
						const description = formatToolDescription(event.toolName, event.input as Record<string, unknown>);
						const title = `External directory access\n\nThe agent wants to ${description}\n\nThis path is outside the current workspace:\n  ${ctx.cwd}\n\nTarget: ${resolvedPath}\n\nAllow leaving the workspace?`;

						const choice = await ctx.ui.select(title, ["Yes (one time)", "Yes (this session)", "No"]);

						if (choice === "No" || choice === undefined) {
							logDecision(event.toolName, resolvedPath ?? "", ctx.cwd, "prompt-denied", "external_directory: user denied");
							return { block: true, reason: `Blocked by user: external directory access denied. ${hardStop()}` };
						}

						if (choice === "Yes (this session)") {
							sessionApprovals.add(extApprovalKey);
						}
						// "Yes (one time)" proceeds without adding to sessionApprovals
					}
				}
				// If extPermission === "allow", proceed to normal tool rules
			}
		}

		// --- Normal tool-specific permission check ---
		const toolRules = config.rules[event.toolName];
		if (toolRules === undefined) {
			logDecision(event.toolName, getToolValue(event.toolName, event.input as Record<string, unknown>), ctx.cwd, "allowed", "no rules configured for tool");
			return undefined; // No rules for this tool -> allow
		}

		const value = getToolValue(event.toolName, event.input as Record<string, unknown>);
		const permission = resolvePermission(toolRules, value);

		if (permission === "allow") {
			logDecision(event.toolName, value, ctx.cwd, "allowed", "rule: allow");
			return undefined;
		}

		if (permission === "cloak") {
			logDecision(event.toolName, value, ctx.cwd, "cloaked", "rule: cloak");
			return undefined;
		}

		if (permission === "deny") {
			logDecision(event.toolName, value, ctx.cwd, "blocked", "rule: deny");
			return { block: true, reason: `Permission denied by policy: ${event.toolName} ${value}. ${hardStop()}` };
		}

		// permission === "ask"
		if (!ctx.hasUI) {
			logDecision(event.toolName, value, ctx.cwd, "blocked-no-ui", "ask (no UI)");
			return { block: true, reason: `Permission required (no UI): ${event.toolName} ${value}. ${hardStop()}` };
		}

		// Check session approvals
		const approvalKey = buildSessionApprovalKey(event.toolName, value);
		if (sessionApprovals.has(approvalKey)) {
			logDecision(event.toolName, value, ctx.cwd, "allowed-session-cache", `session approval: ${approvalKey}`);
			return undefined;
		}

		const description = formatToolDescription(event.toolName, event.input as Record<string, unknown>);
		const title = `Permission required\n\nThe agent wants to ${description}\n\nAllow this action?`;

		const choice = await ctx.ui.select(title, ["Yes", "Yes to session", "No", "Explain"]);

		if (choice === "Yes") {
			logDecision(event.toolName, value, ctx.cwd, "prompt-approved-once", "user approved");
			return undefined;
		}

		if (choice === "Yes to session") {
			sessionApprovals.add(approvalKey);
			logDecision(event.toolName, value, ctx.cwd, "prompt-approved-session", "user approved session");
			return undefined;
		}

		if (choice === "Explain") {
			// Block the tool and ask the agent to explain
			const explanationPrompt = `I see you want to ${description}. Can you explain why you need to do this before I approve it?`;
			// Use steer to interrupt the current turn with our question
			try {
				pi.sendUserMessage(explanationPrompt, { deliverAs: "steer" });
			} catch (e) {
				// If steer fails, fall back to blocking without explanation
				console.error(`[permissions] Failed to send explanation request: ${e}`);
			}
			logDecision(event.toolName, value, ctx.cwd, "prompt-explained", "user requested explanation");
			return { block: true, reason: `User requested explanation before approving. ${hardStop()}` };
		}

		// "No" or cancelled
			logDecision(event.toolName, value, ctx.cwd, "prompt-denied", "user denied");
		return { block: true, reason: `Blocked by user. ${hardStop()}` };
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "read") {
			return undefined;
		}

		const value = getToolValue("read", event.input as Record<string, unknown>);
		const maskResult = shouldMask("read", config, value);
		if (!maskResult) {
			return undefined;
		}

		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") {
				return part;
			}

			const maskedText = applyMask(part.text, maskResult.mask);
			if (maskedText === part.text) {
				return part;
			}

			changed = true;
			return {
				...part,
				text: maskedText,
			};
		});

		if (!changed) {
			return undefined;
		}
		return { content };
	});

	pi.registerCommand("permissions", {
		description: "Show current permission system status",
		handler: async (_args, ctx) => {
			const lines = ["Permission System Status:", ""];
			const ruleEntries = Object.entries(config.rules);

			if (ruleEntries.length === 0) {
				lines.push("No rules configured.");
			} else {
				lines.push("Rules:");
				for (const [toolName, rules] of ruleEntries) {
					if (typeof rules === "string") {
						lines.push(`  ${toolName}: ${rules}`);
					} else {
						lines.push(`  ${toolName}:`);
						for (const [pattern, perm] of Object.entries(rules)) {
							lines.push(`    ${pattern} -> ${perm}`);
						}
					}
				}
			}

			const maskEntries = Object.entries(config.masks);
			if (maskEntries.length > 0) {
				lines.push("");
				lines.push("Masks:");
				for (const [toolName, toolMasks] of maskEntries) {
					lines.push(`  ${toolName}:`);
					for (const [pattern, mask] of Object.entries(toolMasks)) {
						const replaceInfo = mask.replace ? ` replace="${mask.replace}"` : "";
						lines.push(`    ${pattern} -> /${mask.pattern}/${mask.flags ?? "g"}${replaceInfo}`);
					}
				}
			}

			if (sessionApprovals.size > 0) {
				lines.push("");
				lines.push(`Session approvals (${sessionApprovals.size}):`);
				for (const key of sessionApprovals) {
					lines.push(`  ${key}`);
				}
			}

			lines.push("");
			lines.push(`Log file: ${join(getAgentDir(), "permissions.log.jsonl")}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("permissions-log", {
		description: "Show recent permission decision log entries",
		handler: async (_args, ctx) => {
			const logPath = join(getAgentDir(), "permissions.log.jsonl");
			if (!existsSync(logPath)) {
				ctx.ui.notify("No permission log found.", "info");
				return;
			}

			const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
			const recent = lines.slice(-20); // Last 20 entries

			if (recent.length === 0) {
				ctx.ui.notify("Log file is empty.", "info");
				return;
			}

			const entries = recent.map((line) => {
				try {
					const entry = JSON.parse(line);
					return `[${entry.timestamp}] ${entry.action.padEnd(24)} ${entry.toolName.padEnd(10)} ${entry.value}`;
				} catch {
					return `[parse error] ${line.slice(0, 80)}`;
				}
			});

			ctx.ui.notify(["Recent permission decisions:", "", ...entries, "", `Total entries: ${lines.length}`].join("\n"), "info");
		},
	});

	pi.registerCommand("permissions-reload", {
		description: "Reload permissions from config files",
		handler: async (_args, ctx) => {
			reloadConfig(ctx.cwd);
			ctx.ui.notify("Permissions reloaded", "info");
		},
	});
}
