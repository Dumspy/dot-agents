import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { GondolinConfig, SandboxConfig } from "./types.js";

export interface SandboxConfigOverlay {
	gondolin?: Partial<GondolinConfig>;
	protectedPaths?: string[];
}

export const RESOURCE_LIMITS = {
	cpus: 16,
	memoryBytes: 32 * 1024 ** 3,
	rootfsBytes: 100 * 1024 ** 3,
} as const;

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	version: 1,
	backend: "gondolin",
	gondolin: {
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
		rootfsBytes: 8 * 1024 ** 3,
		startupCommands: [],
	},
	protectedPaths: [],
};

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(b|kib|kb|mib|mb|gib|gb|tib|tb)?$/i;
const SIZE_MULTIPLIERS: Record<string, number> = {
	b: 1,
	kb: 1000,
	kib: 1024,
	mb: 1000 ** 2,
	mib: 1024 ** 2,
	gb: 1000 ** 3,
	gib: 1024 ** 3,
	tb: 1000 ** 4,
	tib: 1024 ** 4,
};

export function parseByteSize(value: unknown, fieldName: string): number {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${fieldName} must be a positive integer`);
		return value;
	}
	if (typeof value !== "string") throw new Error(`${fieldName} must be a byte count or size string`);
	const match = SIZE_PATTERN.exec(value.trim());
	if (!match) throw new Error(`${fieldName} has invalid size ${JSON.stringify(value)}`);
	const magnitude = Number(match[1]);
	const unit = (match[2] ?? "b").toLowerCase();
	const result = Math.round(magnitude * (SIZE_MULTIPLIERS[unit] ?? 1));
	if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${fieldName} is outside the supported range`);
	return result;
}

function asObject(value: unknown, fieldName: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${fieldName} must be an object`);
	return value as Record<string, unknown>;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${fieldName} must be a non-empty string`);
	return value;
}

function stringArray(value: unknown, fieldName: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
		throw new Error(`${fieldName} must be an array of non-empty strings`);
	}
	return [...value];
}

function boundedInteger(value: unknown, fallback: number, maximum: number, fieldName: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
		throw new Error(`${fieldName} must be an integer between 1 and ${maximum}`);
	}
	return value as number;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], fieldName: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new Error(`${fieldName} contains unsupported key(s): ${unknown.join(", ")}`);
}

const GONDOLIN_KEYS = ["image", "startupCommands", "cpus", "memoryBytes", "memory", "rootfsBytes", "rootfsSize"] as const;

/** Validate a gondolin config section, returning only the fields it explicitly sets. */
function parseGondolinSection(value: unknown, source: string): Partial<GondolinConfig> {
	const gondolin = asObject(value, source);
	rejectUnknownKeys(gondolin, GONDOLIN_KEYS, source);
	if (gondolin.memory !== undefined && gondolin.memoryBytes !== undefined) {
		throw new Error(`${source} cannot specify both memory and memoryBytes`);
	}
	if (gondolin.rootfsSize !== undefined && gondolin.rootfsBytes !== undefined) {
		throw new Error(`${source} cannot specify both rootfsSize and rootfsBytes`);
	}
	const overlay: Partial<GondolinConfig> = {};
	if (gondolin.image !== undefined) overlay.image = optionalString(gondolin.image, `${source}.image`);
	if (gondolin.startupCommands !== undefined) {
		overlay.startupCommands = stringArray(gondolin.startupCommands, `${source}.startupCommands`);
	}
	if (gondolin.cpus !== undefined) {
		overlay.cpus = boundedInteger(gondolin.cpus, 1, RESOURCE_LIMITS.cpus, `${source}.cpus`);
	}
	if (gondolin.memory !== undefined || gondolin.memoryBytes !== undefined) {
		overlay.memoryBytes = parseByteSize(gondolin.memory ?? gondolin.memoryBytes, `${source}.memory`);
		if (overlay.memoryBytes > RESOURCE_LIMITS.memoryBytes) throw new Error(`${source}.memory exceeds 32 GiB`);
	}
	if (gondolin.rootfsSize !== undefined || gondolin.rootfsBytes !== undefined) {
		overlay.rootfsBytes = parseByteSize(gondolin.rootfsSize ?? gondolin.rootfsBytes, `${source}.rootfsSize`);
		if (overlay.rootfsBytes > RESOURCE_LIMITS.rootfsBytes) throw new Error(`${source}.rootfsSize exceeds 100 GiB`);
	}
	return overlay;
}

export function parseSandboxConfig(value: unknown, source = "sandbox config"): SandboxConfig {
	const root = asObject(value, source);
	rejectUnknownKeys(root, ["version", "backend", "gondolin", "protectedPaths"], source);
	if (root.version !== undefined && root.version !== 1) throw new Error(`${source}.version must be 1`);
	if (root.backend !== undefined && root.backend !== "gondolin") throw new Error(`${source}.backend must be "gondolin"`);

	const overlay = root.gondolin === undefined ? {} : parseGondolinSection(root.gondolin, `${source}.gondolin`);
	return {
		version: 1,
		backend: "gondolin",
		gondolin: {
			...DEFAULT_SANDBOX_CONFIG.gondolin,
			...overlay,
			startupCommands: [...(overlay.startupCommands ?? DEFAULT_SANDBOX_CONFIG.gondolin.startupCommands)],
		},
		protectedPaths: stringArray(root.protectedPaths, `${source}.protectedPaths`),
	};
}

export function parseProjectSandboxConfig(value: unknown, source = "project sandbox config"): SandboxConfigOverlay {
	const root = asObject(value, source);
	rejectUnknownKeys(root, ["version", "gondolin", "protectedPaths"], source);
	if (root.version !== undefined && root.version !== 1) throw new Error(`${source}.version must be 1`);
	return {
		gondolin: root.gondolin === undefined ? undefined : parseGondolinSection(root.gondolin, `${source}.gondolin`),
		protectedPaths: stringArray(root.protectedPaths, `${source}.protectedPaths`),
	};
}

/** Project configuration is additive for protected paths but may select bounded guest resources. */
export function mergeSandboxConfig(globalConfig: SandboxConfig, projectConfig?: SandboxConfigOverlay): SandboxConfig {
	if (!projectConfig) return structuredClone(globalConfig);
	return {
		version: 1,
		backend: "gondolin",
		gondolin: {
			...globalConfig.gondolin,
			...projectConfig.gondolin,
			startupCommands: [...(projectConfig.gondolin?.startupCommands ?? globalConfig.gondolin.startupCommands)],
		},
		protectedPaths: [...new Set([...globalConfig.protectedPaths, ...(projectConfig.protectedPaths ?? [])])],
	};
}

async function loadOptionalJson(filePath: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Could not load ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function loadSandboxConfig(options: {
	agentDir: string;
	workspace: string;
	projectTrusted: boolean;
}): Promise<SandboxConfig> {
	const globalPath = path.join(options.agentDir, "sandbox.json");
	const projectPath = path.join(options.workspace, CONFIG_DIR_NAME, "sandbox.json");
	const globalValue = await loadOptionalJson(globalPath);
	const projectValue = options.projectTrusted ? await loadOptionalJson(projectPath) : undefined;
	const globalConfig = globalValue === undefined ? structuredClone(DEFAULT_SANDBOX_CONFIG) : parseSandboxConfig(globalValue, globalPath);
	const projectConfig = projectValue === undefined ? undefined : parseProjectSandboxConfig(projectValue, projectPath);
	return mergeSandboxConfig(globalConfig, projectConfig);
}
