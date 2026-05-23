/**
 * Permission System — Pure Logic Library
 *
 * Testable functions extracted from the Pi extension.
 * No Pi APIs, no filesystem access, no side effects.
 */

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

export const DEFAULT_CONFIG: PermissionsConfig = {
	rules: {
		read: {
			"*": "allow",
			".env": "cloak",
			".env.*": "cloak",
			"*.env": "cloak",
			"*.env.*": "cloak",
			"*.envrc": "deny",
			"secrets/*": "deny",
			".ssh/*": "deny",
			".gnupg/*": "deny",
			".config/1password/*": "deny",
			"*.key": "deny",
			"*.pem": "deny",
			"*.p12": "deny",
			"*.pfx": "deny",
			".aws/*": "deny",
			".docker/*": "deny",
			".kube/*": "deny",
			".git/*": "deny",
			".gitmodules": "deny",
			"node_modules/*": "deny",
			".venv/*": "deny",
			"venv/*": "deny",
			"dist/*": "deny",
			"build/*": "deny",
			"target/*": "deny",
		},
		write: {
			"*": "ask",
			".env": "deny",
			".git/*": "deny",
			"node_modules/*": "deny",
			".venv/*": "deny",
			"venv/*": "deny",
		},
		edit: {
			"*": "ask",
			".env": "deny",
			".git/*": "deny",
			"node_modules/*": "deny",
			".venv/*": "deny",
			"venv/*": "deny",
		},
		bash: {
			"*": "ask",
			"ls*": "allow",
			"pwd": "allow",
			"git status*": "allow",
			"git diff*": "allow",
			"git log*": "allow",
			"dex *": "allow",
		},
		webfetch: "ask",
	},
	masks: {
		read: {
			".env": { pattern: "(=).+", replace: "$1" },
			".env.*": { pattern: "(=).+", replace: "$1" },
			"*.env": { pattern: "(=).+", replace: "$1" },
			"*.env.*": { pattern: "(=).+", replace: "$1" },
			"*.vars*": { pattern: "(=).+", replace: "$1" },
		},
	},
};

export function deepMerge(base: PermissionsConfig, override: Partial<PermissionsConfig>): PermissionsConfig {
	const result: PermissionsConfig = {
		rules: { ...base.rules },
		masks: { ...base.masks },
	};

	if (override.rules) {
		for (const [toolName, toolRules] of Object.entries(override.rules)) {
			if (typeof toolRules === "string") {
				result.rules[toolName] = toolRules;
			} else if (typeof toolRules === "object" && toolRules !== null) {
				const baseRules = typeof base.rules[toolName] === "object" && base.rules[toolName] !== null
					? (base.rules[toolName] as ToolPermissions)
					: {};
				result.rules[toolName] = { ...baseRules, ...toolRules };
			}
		}
	}

	if (override.masks) {
		for (const [toolName, toolMasks] of Object.entries(override.masks)) {
			const baseMasks = typeof base.masks[toolName] === "object" && base.masks[toolName] !== null
				? (base.masks[toolName] as ToolMasks)
				: {};
			result.masks[toolName] = { ...baseMasks, ...toolMasks };
		}
	}

	return result;
}

/**
 * Simple glob matcher.
 * - `*` matches any sequence of characters except `/`
 * - `?` matches any single character except `/`
 */
export function globToRegex(pattern: string): RegExp {
	let regex = "^";
	let i = 0;
	while (i < pattern.length) {
		if (pattern[i] === "*") {
			regex += "[^/]*";
			i += 1;
		} else if (pattern[i] === "?") {
			regex += "[^/]";
			i += 1;
		} else {
			// Escape regex special characters
			const c = pattern[i]!;
			if (/[.+^${}()|[\]\\]/.test(c)) {
				regex += "\\" + c;
			} else {
				regex += c;
			}
			i += 1;
		}
	}
	regex += "$";
	return new RegExp(regex);
}

export function matchGlob(pattern: string, value: string): boolean {
	return globToRegex(pattern).test(value);
}

export function getToolValue(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return String(input.path ?? "");
		case "bash":
			return String(input.command ?? "");
		case "webfetch":
			return String(input.url ?? "");
		default:
			// For custom tools, try common value fields
			return String(input.path ?? input.command ?? input.url ?? input.query ?? JSON.stringify(input));
	}
}

export function resolvePermission(
	rules: PermissionValue | ToolPermissions | undefined,
	value: string,
): PermissionValue {
	if (rules === undefined) {
		return "ask"; // Default to ask if no rules defined
	}

	if (typeof rules === "string") {
		return rules;
	}

	// Find the best matching pattern
	// Priority: exact match > longest matching pattern > "*" fallback
	let bestMatch: { pattern: string; value: PermissionValue } | null = null;

	for (const [pattern, perm] of Object.entries(rules)) {
		if (pattern === value) {
			// Exact match wins immediately
			return perm;
		}
		if (matchGlob(pattern, value)) {
			if (!bestMatch || pattern.length > bestMatch.pattern.length) {
				bestMatch = { pattern, value: perm };
			}
		}
	}

	return bestMatch?.value ?? "ask";
}

export function resolveMask(toolMasks: ToolMasks | undefined, value: string): MaskPattern | null {
	if (toolMasks === undefined) {
		return null;
	}

	let bestMatch: { pattern: string; mask: MaskPattern } | null = null;

	for (const [pattern, mask] of Object.entries(toolMasks)) {
		if (pattern === value) {
			return mask;
		}
		if (matchGlob(pattern, value)) {
			if (!bestMatch || pattern.length > bestMatch.pattern.length) {
				bestMatch = { pattern, mask };
			}
		}
	}

	return bestMatch?.mask ?? null;
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
			return `run \`${input.command}\``;
		case "webfetch":
			return `fetch \`${input.url}\``;
		default:
			return `call ${toolName}`;
	}
}
