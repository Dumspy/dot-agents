/**
 * Permission System — Pure Logic Library
 *
 * Testable functions extracted from the Pi extension.
 * No Pi APIs, no filesystem access, no side effects.
 */

import { isMatch } from "picomatch";
import { resolve, sep } from "node:path";

export type PermissionValue = "allow" | "deny" | "ask" | "cloak";

export interface ToolPermissions {
	[pattern: string]: PermissionValue;
}

export interface MaskPattern {
	pattern: string;
	replace?: string;
	flags?: string;
}

export interface ToolMasks {
	[pattern: string]: MaskPattern;
}

export interface PermissionsConfig {
	rules: {
		[toolName: string]: PermissionValue | ToolPermissions;
	};
	masks: {
		[toolName: string]: ToolMasks;
	};
}

export const EXTERNAL_DIRECTORY_TOOLS = ["read", "write", "edit"] as const;
export type ExternalDirectoryTool = (typeof EXTERNAL_DIRECTORY_TOOLS)[number];

export function isPathBasedTool(toolName: string): boolean {
	return EXTERNAL_DIRECTORY_TOOLS.includes(toolName as ExternalDirectoryTool);
}

export function resolveToolPath(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
	if (!isPathBasedTool(toolName)) return null;
	const rawPath = String(input.path ?? "");
	if (!rawPath) return null;
	return resolve(cwd, rawPath);
}

export function isExternalPath(resolvedPath: string, cwd: string): boolean {
	const normalizedCwd = resolve(cwd);
	const normalizedPath = resolve(resolvedPath);
	if (normalizedPath === normalizedCwd) return false;
	return !normalizedPath.startsWith(normalizedCwd + sep);
}

export function getExternalDirectoryRoot(resolvedPath: string, cwd: string): string | null {
	const normCwd = resolve(cwd);
	const normPath = resolve(resolvedPath);

	if (!isExternalPath(resolvedPath, cwd)) return null;

	const minLen = Math.min(normCwd.length, normPath.length);
	let lastSep = -1;
	for (let i = 0; i < minLen; i++) {
		if (normCwd[i] !== normPath[i]) break;
		if (normCwd[i] === sep) lastSep = i;
	}

	if (lastSep === -1) {
		// Different roots — return the root of the external path
		const firstSep = normPath.indexOf(sep, 1);
		return firstSep === -1 ? normPath : normPath.slice(0, firstSep);
	}

	const afterCommon = normPath.slice(lastSep + 1);
	const nextSep = afterCommon.indexOf(sep);
	if (nextSep === -1) {
		// We can't tell if this is a file or directory without stat.
		// Approve the exact path to stay safe.
		return normPath;
	}
	return normPath.slice(0, lastSep + 1 + nextSep);
}

// Note: **/ patterns match at any depth (including root). For example,
// "**/*.env" matches both ".env" and "packages/api/.env", so root-level
// variants like ".env" or "**/.env" are redundant.
export const DEFAULT_CONFIG: PermissionsConfig = {
	rules: {
		read: {
			"**": "allow",
			"**/*.env": "cloak",
			"**/*.env.*": "cloak",
			"**/*.envrc": "deny",
			"**/secrets/**": "deny",
			"**/.ssh/**": "deny",
			"**/.gnupg/**": "deny",
			"**/.config/1password/**": "deny",
			"**/*.key": "deny",
			"**/*.pem": "deny",
			"**/*.p12": "deny",
			"**/*.pfx": "deny",
			"**/.aws/**": "deny",
			"**/.docker/**": "deny",
			"**/.kube/**": "deny",
			"**/.git/**": "deny",
			"**/.gitmodules": "deny",
			// Pi docs live inside node_modules; allow reading them
			"**/node_modules/@earendil-works/pi-ai/**": "allow",
			"**/node_modules/@earendil-works/pi-coding-agent/**": "allow",
			"**/node_modules/@earendil-works/pi-tui/**": "allow",
			"**/node_modules/**": "deny",
			"**/.venv/**": "deny",
			"**/venv/**": "deny",
			"**/dist/**": "deny",
			"**/build/**": "deny",
			"**/target/**": "deny",
		},
		write: {
			"**": "allow",
			"**/*.env": "deny",
			"**/.git/**": "deny",
			"**/node_modules/**": "deny",
			"**/.venv/**": "deny",
			"**/venv/**": "deny",
		},
		edit: {
			"**": "allow",
			"**/*.env": "deny",
			"**/.git/**": "deny",
			"**/node_modules/**": "deny",
			"**/.venv/**": "deny",
			"**/venv/**": "deny",
		},
		bash: {
			"*": "ask",
			"ls*": "allow",
			"pwd": "allow",
			"git status*": "allow",
			"git diff*": "allow",
			"git log*": "allow",
			"git branch*": "allow",
			"rm -rf*": "deny",
			"sudo*": "deny",
			"eval*": "deny",
			"source*": "deny",
		},
		webfetch: "ask",
		external_directory: {
			"**": "ask",
		},
	},
	masks: {
		read: {
			".env": { pattern: "(=).+", replace: "$1" },
			"**/*.env": { pattern: "(=).+", replace: "$1" },
			"**/*.env.*": { pattern: "(=).+", replace: "$1" },
			"*.vars*": { pattern: "(=).+", replace: "$1" },
		},
	},
};

export function deepMerge(base: PermissionsConfig, override: Partial<PermissionsConfig>): PermissionsConfig {
	const result: PermissionsConfig = {
		rules: { ...base.rules },
		masks: { ...base.masks },
	};

	for (const [toolName, toolRules] of Object.entries(override.rules ?? {})) {
		result.rules[toolName] = typeof toolRules === "string"
			? toolRules
			: { ...(typeof base.rules[toolName] === "object" && base.rules[toolName] != null ? (base.rules[toolName] as ToolPermissions) : {}), ...toolRules };
	}

	for (const [toolName, toolMasks] of Object.entries(override.masks ?? {})) {
		result.masks[toolName] = {
			...(typeof base.masks[toolName] === "object" && base.masks[toolName] != null ? (base.masks[toolName] as ToolMasks) : {}),
			...toolMasks,
		};
	}

	return result;
}

export function matchGlob(pattern: string, value: string, options?: { bash?: boolean }): boolean {
	return isMatch(value, pattern, { dot: true, ...options });
}

/**
 * Strip the git-interceptor env prefix so permission rules match the actual command.
 * The git-interceptor extension prepends this before permission-system sees the event.
 */
export const GIT_ENV_PREFIX = "export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";

function stripGitEnvPrefix(command: string): string {
	return command.startsWith(GIT_ENV_PREFIX) ? command.slice(GIT_ENV_PREFIX.length) : command;
}

function getBashCommand(input: Record<string, unknown>): string {
	const raw = String(input.command ?? "");
	return stripGitEnvPrefix(raw);
}

function findBestPatternMatch<T>(rules: Record<string, T> | undefined, value: string, options?: { bash?: boolean }): T | null {
	if (!rules) return null;

	let bestMatch: { pattern: string; value: T } | null = null;
	for (const [pattern, ruleValue] of Object.entries(rules)) {
		if (pattern === value) return ruleValue;
		if (matchGlob(pattern, value, options)) {
			if (!bestMatch || pattern.length > bestMatch.pattern.length) {
				bestMatch = { pattern, value: ruleValue };
			}
		}
	}
	return bestMatch?.value ?? null;
}

export function getToolValue(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return String(input.path ?? "");
		case "bash":
			return getBashCommand(input);
		case "webfetch":
			return String(input.url ?? "");
		default:
			return String(input.path ?? input.command ?? input.url ?? input.query ?? JSON.stringify(input));
	}
}

export function resolvePermission(
	rules: PermissionValue | ToolPermissions | undefined,
	value: string,
	options?: { bash?: boolean },
): PermissionValue {
	if (rules === undefined) return "ask";
	if (typeof rules === "string") return rules;
	return findBestPatternMatch(rules, value, options) ?? "ask";
}

export function resolveMask(toolMasks: ToolMasks | undefined, value: string): MaskPattern | null {
	return findBestPatternMatch(toolMasks, value);
}

export function applyMask(text: string, mask: MaskPattern): string {
	const flags = mask.flags ?? "g";
	const regex = new RegExp(mask.pattern, flags);
	const replacement = mask.replace;
	if (replacement !== undefined) {
		return text.replace(regex, replacement);
	}
	return text.replace(regex, (match) => "*".repeat(match.length));
}

export function shouldMask(
	toolName: string,
	config: PermissionsConfig,
	value: string,
): { mask: MaskPattern } | null {
	if (toolName !== "read") {
		return null;
	}

	const permission = resolvePermission(config.rules[toolName], value);
	if (permission !== "cloak") {
		return null;
	}

	const toolMasks = config.masks[toolName];
	const mask = resolveMask(toolMasks, value);
	if (!mask) {
		return null;
	}

	return { mask };
}

export function formatToolDescription(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return `${toolName} \`${input.path}\``;
		case "bash":
			return `run \`${getBashCommand(input)}\``;
		case "webfetch":
			return `fetch \`${input.url}\``;
		default:
			return `call ${toolName}`;
	}
}

/**
 * Hard stop suffix to append to denial reasons.
 * Prevents the LLM from trying workarounds.
 */
export function hardStop(): string {
	return "This permission denial is policy-enforced. Do not retry or investigate bypasses; report the block to the user.";
}

/**
 * Build a session approval key from a tool name and its resolved value.
 */
export function buildSessionApprovalKey(toolName: string, value: string): string {
	return `${toolName}:${value}`;
}

// ------------------------------------------------------------------
// Logging — Pure Logic
// ------------------------------------------------------------------

export type PermissionAction =
	| "allowed"
	| "cloaked"
	| "blocked"
	| "blocked-no-ui"
	| "allowed-session-cache"
	| "prompt-approved-once"
	| "prompt-approved-session"
	| "prompt-denied"
	| "prompt-denied-with-alternative"
	| "prompt-explained";

export interface LogEntry {
	timestamp: string;
	toolName: string;
	value: string;
	cwd: string;
	action: PermissionAction;
	reason: string;
}

export function createLogEntry(
	toolName: string,
	value: string,
	cwd: string,
	action: PermissionAction,
	reason: string,
	timestamp?: string,
): LogEntry {
	return {
		timestamp: timestamp ?? new Date().toISOString(),
		toolName,
		value,
		cwd,
		action,
		reason,
	};
}

export function formatLogLine(entry: LogEntry): string {
	return JSON.stringify(entry) + "\n";
}
