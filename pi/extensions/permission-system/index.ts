/**
 * Permission System Extension for Pi
 *
 * Policy gates for Pi tools (read, write, edit, bash, external_directory).
 *
 * Design: a sandbox extension (bubblewrap always-on, Gondolin via --sandbox)
 * owns general bash and path-tool isolation at the OS layer. This extension
 * owns *policy* on top: a credential/path deny list, per-repo bash denies
 * (only `deny` is meaningful for bash; allow/ask/cloak are ignored so bash
 * never prompts and subagents never hard-block), and the one surviving
 * interactive prompt — `external_directory: ask` ("leaving the workspace?").
 * webfetch is GET-only and is allowed by default (no rule). Bash sandboxing
 * and credential un-mounting are handled by the sandbox extension, not here.
 * Supports secret masking ("cloak") for the read tool via regex patterns.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/permissions.json (global)
 * - <cwd>/.pi/permissions.json (project-local)
 * - Schema: pi/extensions/permission-system/schema.json ($schema field)
 *
 * Example permissions.json:
 * {
 *   "$schema": "https://raw.githubusercontent.com/Dumspy/dot-agents/main/pi/extensions/permission-system/schema.json",
 *   "rules": {
 *     "read": {
 *       "**": "allow",
 *       ".env": "cloak",
 *       ".ssh/**": "deny"
 *     },
 *     "bash": {
 *       "git push --force*": "deny"
 *     },
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
	type PermissionAction,
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

const SYSTEM_PROMPT_NOTICE = `Bash runs sandboxed. Credential paths (~/.ssh, keys, .env) and paths outside the workspace are gated. If a tool call is blocked, stop and report the restriction to the user — never use another tool as a workaround.`;

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
		action: PermissionAction,
		reason: string,
	): void {
		const logPath = join(getAgentDir(), "permissions.log.jsonl");
		try {
			mkdirSync(dirname(logPath), { recursive: true });
		} catch {}
		appendFileSync(logPath, formatLogLine(createLogEntry(toolName, value, cwd, action, reason)));
	}

	function logAndAllow(
		toolName: string,
		value: string,
		cwd: string,
		action: PermissionAction,
		reason: string,
	): undefined {
		logDecision(toolName, value, cwd, action, reason);
		return undefined;
	}

	function logAndBlock(
		toolName: string,
		value: string,
		cwd: string,
		action: PermissionAction,
		logReason: string,
		userReason: string,
	): { block: true; reason: string } {
		logDecision(toolName, value, cwd, action, logReason);
		return { block: true, reason: `${userReason} ${hardStop()}` };
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
		const input = event.input as Record<string, unknown>;
		const toolName = event.toolName;
		const value = getToolValue(toolName, input);

		// --- External directory gate ---
		const resolvedPath = resolveToolPath(toolName, input, ctx.cwd);
		if (resolvedPath) {
			const extDirRoot = getExternalDirectoryRoot(resolvedPath, ctx.cwd);
			if (extDirRoot) {
				const extPermission = resolvePermission(config.rules.external_directory, extDirRoot);

				if (extPermission === "deny") {
					return logAndBlock(
						toolName, resolvedPath, ctx.cwd, "blocked",
						`external_directory deny: ${extDirRoot}`,
						`External directory access denied by policy: ${toolName} \`${resolvedPath}\`.`,
					);
				}

				if (extPermission === "ask" || extPermission === "cloak") {
					if (!ctx.hasUI) {
						return logAndBlock(
							toolName, resolvedPath, ctx.cwd, "blocked-no-ui",
							"external_directory auto-deny (no UI)",
							`External directory access is not available in non-interactive sessions. The agent is limited to the current workspace${toolName !== "bash" ? `: ${toolName} \`${resolvedPath}\`` : ""}.`,
						);
					}

					const extApprovalKey = buildSessionApprovalKey("external_directory", extDirRoot);
					if (!sessionApprovals.has(extApprovalKey)) {
						const description = formatToolDescription(toolName, input);
						const title = `External directory access\n\nThe agent wants to ${description}\n\nThis path is outside the current workspace:\n  ${ctx.cwd}\n\nTarget: ${resolvedPath}\n\nAllow leaving the workspace?`;
						const choice = await ctx.ui.select(title, ["Yes", "No"]);

						if (choice === "No" || choice === undefined) {
							const alternative = await ctx.ui.input("What should I do instead? (Leave empty to just block)", "e.g. use a different path, explain why it's needed...");
							if (alternative) {
								try {
									pi.sendUserMessage(`I denied ${description}. Instead: ${alternative}`, { deliverAs: "steer" });
								} catch (e) {
									console.error(`[permissions] Failed to send alternative action: ${e}`);
								}
								return logAndBlock(
									toolName, resolvedPath, ctx.cwd, "prompt-denied-with-alternative",
									`external_directory: user denied with alternative: ${alternative}`,
									`Blocked by user (alternative suggested): ${alternative}.`,
								);
							}
							return logAndBlock(
								toolName, resolvedPath, ctx.cwd, "prompt-denied",
								"external_directory: user denied",
								"Blocked by user: external directory access denied.",
							);
						}

						sessionApprovals.add(extApprovalKey);
					}
				}
				// If extPermission === "allow", proceed to normal tool rules below
			}
		}

		// --- Normal tool-specific permission check ---
		const toolRules = config.rules[toolName];
		if (toolRules === undefined) {
			return logAndAllow(toolName, value, ctx.cwd, "allowed", "no rules configured for tool");
		}

		const permission = resolvePermission(toolRules, value, toolName === "bash" ? { bash: true } : undefined);

		// Bash: only `deny` is meaningful. The sandbox (bubblewrap/Gondolin)
		// owns general bash gating; allow/ask/cloak are ignored so bash never
		// prompts and subagents never hard-block on bash. Per-repo `bash.deny`
		// is pure policy refinement that survives across all tiers including
		// --no-sandbox (where the sandbox is unavailable and static-only runs).
		if (toolName === "bash") {
			if (permission === "deny") {
				return logAndBlock(
					toolName, value, ctx.cwd, "blocked",
					"rule: deny",
					`Permission denied by policy: bash \`${value}\`.`,
				);
			}
			return logAndAllow(
				toolName, value, ctx.cwd, "allowed",
				permission === "allow" ? "rule: allow" : "bash: non-deny rule ignored (sandbox owns bash)",
			);
		}

		if (permission === "allow") {
			return logAndAllow(toolName, value, ctx.cwd, "allowed", "rule: allow");
		}

		if (permission === "cloak") {
			return logAndAllow(toolName, value, ctx.cwd, "cloaked", "rule: cloak");
		}

		if (permission === "deny") {
			return logAndBlock(
				toolName, value, ctx.cwd, "blocked",
				"rule: deny",
				`Permission denied by policy: ${toolName} ${value}.`,
			);
		}

		// permission === "ask" — only reachable for non-bash tools via explicit
		// config (read/write/edit/webfetch have no `ask` defaults). Subagents
		// (no UI) are blocked here; this is intentional for path/web tools.
		if (!ctx.hasUI) {
			return logAndBlock(
				toolName, value, ctx.cwd, "blocked-no-ui",
				"ask (no UI)",
				`Permission required (no UI): ${toolName} ${value}.`,
			);
		}

		const approvalKey = buildSessionApprovalKey(toolName, value);
		if (sessionApprovals.has(approvalKey)) {
			return logAndAllow(toolName, value, ctx.cwd, "allowed-session-cache", `session approval: ${approvalKey}`);
		}

		const description = formatToolDescription(toolName, input);
		const title = `Permission required\n\nThe agent wants to ${description}\n\nAllow this action?`;
		const choice = await ctx.ui.select(title, ["Yes", "No"]);

		if (choice === "Yes") {
			sessionApprovals.add(approvalKey);
			return logAndAllow(toolName, value, ctx.cwd, "prompt-approved-session", "user approved session");
		}

		// "No" or cancelled
		const alternative = await ctx.ui.input("What should I do instead? (Leave empty to just block)", "e.g. use a different path, explain why it's needed...");
		if (alternative) {
			try {
				pi.sendUserMessage(`I denied ${description}. Instead: ${alternative}`, { deliverAs: "steer" });
			} catch (e) {
				console.error(`[permissions] Failed to send alternative action: ${e}`);
			}
			return logAndBlock(
				toolName, value, ctx.cwd, "prompt-denied-with-alternative",
				`user denied with alternative: ${alternative}`,
				`Blocked by user (alternative suggested): ${alternative}.`,
			);
		}
		return logAndBlock(
			toolName, value, ctx.cwd, "prompt-denied",
			"user denied",
			"Blocked by user.",
		);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;

		const value = getToolValue("read", event.input as Record<string, unknown>);
		const maskResult = shouldMask("read", config, value);
		if (!maskResult) return undefined;

		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;

			const maskedText = applyMask(part.text, maskResult.mask);
			if (maskedText === part.text) return part;

			changed = true;
			return { ...part, text: maskedText };
		});

		if (!changed) return undefined;
		logDecision("read", value, ctx.cwd, "cloaked", "mask applied");
		return { content };
	});

	pi.registerCommand("permissions", {
		description: "Show current permission system status",
		handler: async (_args, ctx) => {
			const lines: string[] = ["Permission System Status:", ""];

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
				lines.push("", "Masks:");
				for (const [toolName, toolMasks] of maskEntries) {
					lines.push(`  ${toolName}:`);
					for (const [pattern, mask] of Object.entries(toolMasks)) {
						const replaceInfo = mask.replace ? ` replace="${mask.replace}"` : "";
						lines.push(`    ${pattern} -> /${mask.pattern}/${mask.flags ?? "g"}${replaceInfo}`);
					}
				}
			}

			if (sessionApprovals.size > 0) {
				lines.push("", `Session approvals (${sessionApprovals.size}):`);
				for (const key of sessionApprovals) {
					lines.push(`  ${key}`);
				}
			}

			lines.push("", `Log file: ${join(getAgentDir(), "permissions.log.jsonl")}`);
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
			const recent = lines.slice(-20);

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

			ctx.ui.notify(
				["Recent permission decisions:", "", ...entries, "", `Total entries: ${lines.length}`].join("\n"),
				"info",
			);
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
