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
 *       ".ssh/*": "deny"
 *     },
 *     "bash": {
 *       "*": "ask",
 *       "ls*": "allow",
 *       "git status*": "allow"
 *     },
 *     "webfetch": "ask"
 *   },
 *   "masks": {
 *     "read": {
 *       ".env": { "pattern": "(=).+", "replace": "$1" }
 *     }
 *   }
 * }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	applyMask,
	deepMerge,
	formatToolDescription,
	getToolValue,
	resolvePermission,
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

export default function permissionSystem(pi: ExtensionAPI) {
	let config = DEFAULT_CONFIG;

	function reloadConfig(cwd: string) {
		config = loadConfig(cwd);
	}

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig(ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		const toolRules = config.rules[event.toolName];
		if (toolRules === undefined) {
			return undefined; // No rules for this tool -> allow
		}

		const value = getToolValue(event.toolName, event.input as Record<string, unknown>);
		const permission = resolvePermission(toolRules, value);

		if (permission === "allow" || permission === "cloak") {
			return undefined;
		}

		if (permission === "deny") {
			return { block: true, reason: `Permission denied by policy: ${event.toolName} ${value}` };
		}

		// permission === "ask"
		if (!ctx.hasUI) {
			return { block: true, reason: `Permission required (no UI): ${event.toolName} ${value}` };
		}

		const description = formatToolDescription(event.toolName, event.input as Record<string, unknown>);
		const title = `Permission required\n\nThe agent wants to ${description}\n\nAllow this action?`;

		const choice = await ctx.ui.select(title, ["Yes", "No", "Explain"]);

		if (choice === "Yes") {
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
			return { block: true, reason: "User requested explanation before approving" };
		}

		// "No" or cancelled
		return { block: true, reason: "Blocked by user" };
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

			ctx.ui.notify(lines.join("\n"), "info");
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
