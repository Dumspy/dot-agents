export const DEFAULT_KEYWORD_PATTERNS = [
	"remember",
	"memorize",
	"save\\s+this",
	"note\\s+this",
	"keep\\s+in\\s+mind",
	"don'?t\\s+forget",
	"learn\\s+this",
	"store\\s+this",
	"record\\s+this",
	"make\\s+a\\s+note",
	"take\\s+note",
	"commit\\s+to\\s+memory",
	"remember\\s+that",
	"never\\s+forget",
	"always\\s+remember",
];

export const DEFAULTS = {
	baseUrl: "http://master-node:6767",
	similarityThreshold: 0.6,
	maxMemories: 5,
	maxProjectMemories: 10,
	maxProfileItems: 5,
	injectProfile: true,
	timeoutMs: 30_000,
	filterPrompt:
		"You are a stateful coding agent. Remember all the information, including but not limited to user's coding preferences, tech stack, behaviours, workflows, and any other relevant details.",
} as const;

export type MemoryScope = "user" | "project";

export type MemoryType =
	| "project-config"
	| "architecture"
	| "error-solution"
	| "preference"
	| "learned-pattern"
	| "conversation";

export interface SupermemoryConfig {
	enabled: boolean;
	apiKey: string | undefined;
	baseUrl: string;
	injectProfile: boolean;
	keywordPatterns: string[];
}

function isValidRegex(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

function commaSeparatedRegexes(value: string): string[] {
	return value
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
		.filter(isValidRegex);
}

export function loadConfig(): SupermemoryConfig {
	const extraPatterns = process.env.PI_SUPERMEMORY_KEYWORD_PATTERNS
		? commaSeparatedRegexes(process.env.PI_SUPERMEMORY_KEYWORD_PATTERNS)
		: [];

	return {
		enabled: process.env.PI_SUPERMEMORY_ENABLED !== "false",
		apiKey: process.env.SUPERMEMORY_API_KEY,
		baseUrl: process.env.SUPERMEMORY_API_BASE_URL ?? DEFAULTS.baseUrl,
		injectProfile: process.env.PI_SUPERMEMORY_INJECT_PROFILE !== "false",
		keywordPatterns: [...DEFAULT_KEYWORD_PATTERNS, ...extraPatterns],
	};
}
