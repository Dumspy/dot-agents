import {
	type WebFetchFormat,
	type WebToolsSettings,
} from "./types.ts";

const FETCH_DEFAULT_FORMAT_VALUES = ["markdown", "text", "html"] as const satisfies readonly WebFetchFormat[];

const DEFAULTS = {
	fetchDefaultFormat: "markdown",
	fetchTimeoutSeconds: 30,
	fetchMaxResponseMB: 5,
	fetchBlockPrivateHosts: true,
	fetchMaxRedirects: 5,
	fetchFallbackUserAgent: "opencode",
} as const;

export function parseOnOff(value: string | undefined, fallback: boolean): boolean {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === "on") return true;
	if (normalized === "off") return false;
	return fallback;
}

export function parseIntegerSetting(
	value: string | undefined,
	fallback: number,
	options: { min?: number; max?: number } = {},
): number {
	const parsed = Number.parseInt(value?.trim() ?? "", 10);
	if (!Number.isFinite(parsed)) return fallback;
	if (options.min !== undefined && parsed < options.min) return fallback;
	if (options.max !== undefined && parsed > options.max) return fallback;
	return parsed;
}

export function parseEnumSetting<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	fallback: T,
): T {
	if (!value) return fallback;
	const normalized = value.trim() as T;
	return allowed.includes(normalized) ? normalized : fallback;
}

export function getWebToolsSettings(): WebToolsSettings {
	const fetchDefaultFormat = parseEnumSetting(undefined, FETCH_DEFAULT_FORMAT_VALUES, DEFAULTS.fetchDefaultFormat);

	return {
		fetch: {
			defaultFormat: fetchDefaultFormat,
			timeoutSeconds: DEFAULTS.fetchTimeoutSeconds,
			maxResponseBytes: DEFAULTS.fetchMaxResponseMB * 1024 * 1024,
			blockPrivateHosts: DEFAULTS.fetchBlockPrivateHosts,
			maxRedirects: DEFAULTS.fetchMaxRedirects,
			fallbackUserAgent: DEFAULTS.fetchFallbackUserAgent,
		},
	};
}
