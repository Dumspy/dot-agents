import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const ACQUIA_PROVIDER_NAME = "acquia";
export const ACQUIA_PROVIDER_LABEL = "Acquia Gateway";
export const DEFAULT_ACQUIA_BASE_URL = "https://gateway-internal.ai.acquia.io/v1";
export const ACQUIA_API_KEY_ENV = "ACQUIAAIGATEWAY_API_KEY";
export const ACQUIA_BASE_URL_ENV = "ACQUIAAIGATEWAY_BASE_URL";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 4_096;

export interface RawModelListItem {
	id?: string;
}

export interface RawModelInfo {
	mode?: string;
	key?: string;
	litellm_model_name?: string;
	litellm_provider?: string;
	max_input_tokens?: number | string;
	max_output_tokens?: number | string;
	max_tokens?: number | string;
	input_cost_per_token?: number | string;
	output_cost_per_token?: number | string;
	cache_read_input_token_cost?: number | string;
	cache_creation_input_token_cost?: number | string;
	supports_reasoning?: boolean | string;
	supports_prompt_caching?: boolean | string;
	bedrock_converse_supports_strict_tools?: boolean | string;
	supports_function_calling?: boolean | string;
	supports_parallel_function_calling?: boolean | string;
	supports_vision?: boolean | string;
}

export interface RawModelInfoItem {
	model_name?: string;
	model_info?: RawModelInfo;
}

export function normalizeBaseUrl(value: string | undefined): string {
	return String(value || "").replace(/\/+$/, "");
}

function parseNumber(value: number | string | undefined): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseBoolean(value: boolean | string | undefined): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1") return true;
		if (normalized === "false" || normalized === "0") return false;
	}
	return undefined;
}

function perMillion(value: number | string | undefined): number | undefined {
	const parsed = parseNumber(value);
	return parsed === undefined ? undefined : parsed * 1_000_000;
}

function pickFirst<T>(...values: Array<T | undefined | null | "">): T | undefined {
	return values.find((value): value is T => value !== undefined && value !== null && value !== "");
}

function prettifyToken(token: string): string {
	const lower = token.toLowerCase();
	const exact: Record<string, string> = {
		ai: "AI",
		amazon: "Amazon",
		anthropic: "Anthropic",
		claude: "Claude",
		eu: "EU",
		haiku: "Haiku",
		instruct: "Instruct",
		kimi: "Kimi",
		meta: "Meta",
		micro: "Micro",
		mini: "Mini",
		moonshotai: "MoonshotAI",
		nova: "Nova",
		opus: "Opus",
		premier: "Premier",
		pro: "Pro",
		sonnet: "Sonnet",
		us: "US",
	};

	if (exact[lower]) return exact[lower];
	if (/^\d+b$/i.test(token)) return token.toUpperCase();
	if (/^k\d+(?:\.\d+)?$/i.test(token)) return `K${token.slice(1)}`;

	const llamaMatch = lower.match(/^llama(\d+(?:\.\d+)?)$/);
	if (llamaMatch) return `Llama ${llamaMatch[1]}`;

	return token.charAt(0).toUpperCase() + token.slice(1);
}

export function prettyDisplayName(modelName: string): string {
	const raw = String(modelName || "").trim();
	if (!raw) return raw;

	let provider = "";
	let rest = raw;
	if (raw.includes("/")) {
		const parts = raw.split("/");
		provider = parts.shift() || "";
		rest = parts.join("/");
	} else if (raw.includes(".")) {
		const index = raw.indexOf(".");
		provider = raw.slice(0, index);
		rest = raw.slice(index + 1);
	}

	const marked = [provider, rest]
		.filter(Boolean)
		.join(" ")
		.replace(/(\d)-(\d)/g, "$1.$2")
		.replace(/(\d)\.(\d)/g, "$1§$2")
		.replace(/[._:/-]+/g, " ")
		.replace(/§/g, ".");

	return marked
		.split(/\s+/)
		.filter(Boolean)
		.map(prettifyToken)
		.join(" ");
}

function isTextModel(mode: string | undefined): boolean {
	return mode === undefined || mode === null || ["chat", "completion", "responses", "response"].includes(mode.trim().toLowerCase());
}

function isAggregateAlias(modelName: string): boolean {
	const normalized = String(modelName || "").toLowerCase();
	return new Set(["all-proxy-models", "smart-router"]).has(normalized);
}

function canonicalModelIdentity(modelName: string, modelInfo: RawModelInfo | undefined): string {
	return pickFirst(
		typeof modelInfo?.litellm_model_name === "string" ? modelInfo.litellm_model_name : undefined,
		typeof modelInfo?.key === "string" ? modelInfo.key : undefined,
		modelName,
	) ?? modelName;
}

function shouldSkipFallbackModel(modelName: string): boolean {
	const normalized = String(modelName || "").toLowerCase();
	if (!normalized) return true;
	if (isAggregateAlias(normalized)) return true;

	const patternSkips = [
		/(?:^|[.-])embed(?:[.-]|$)/,
		/(?:^|[.-])embedding(?:[.-]|$)/,
		/(?:^|[.-])canvas(?:[.-]|$)/,
		/(?:^|[.-])image(?:[.-]|$)/,
		/(?:^|[.-])speech(?:[.-]|$)/,
		/(?:^|[.-])audio(?:[.-]|$)/,
		/(?:^|[.-])transcribe(?:[.-]|$)/,
		/(?:^|[.-])tts(?:[.-]|$)/,
		/(?:^|[.-])rerank(?:[.-]|$)/,
		/(?:^|[.-])moderation(?:[.-]|$)/,
	];

	return patternSkips.some((pattern) => pattern.test(normalized));
}

function canonicalFallbackModels(modelNames: string[]): string[] {
	const names = new Set(modelNames);
	return modelNames.filter((modelName) => {
		if (modelName.includes(".")) return true;
		for (const candidate of names) {
			if (candidate.endsWith(`.${modelName}`)) return false;
		}
		return true;
	});
}

function canonicalDiscoveredModels(modelNames: string[], infoByName: Map<string, RawModelInfo>): string[] {
	return modelNames.filter((modelName) => {
		if (modelName.includes(".")) return true;

		const qualifiedAlias = modelNames.find(
			(candidate) => candidate !== modelName && candidate.endsWith(`.${modelName}`),
		);
		if (!qualifiedAlias) return true;

		// Collapse only a direct qualified/unqualified alias pair. Do not collapse every
		// model with the same LiteLLM routing key: gateways can expose intentional aliases
		// (such as cache-control variants) with distinct behavior.
		const identity = canonicalModelIdentity(modelName, infoByName.get(modelName) ?? infoByName.get(qualifiedAlias));
		return identity !== canonicalModelIdentity(qualifiedAlias, infoByName.get(qualifiedAlias));
	});
}

export function buildProviderModel(
	modelName: string,
	modelInfo: RawModelInfo | undefined,
	hasModelInfo: boolean = false,
): ProviderModelConfig | undefined {
	if (isAggregateAlias(modelName)) return undefined;
	if (!isTextModel(modelInfo?.mode)) return undefined;

	const supportsFunctionCalling = parseBoolean(modelInfo?.supports_function_calling);
	const supportsParallelFunctionCalling = parseBoolean(modelInfo?.supports_parallel_function_calling);
	const supportsTools =
		supportsFunctionCalling === true || supportsParallelFunctionCalling === true
			? true
			: supportsFunctionCalling === false && supportsParallelFunctionCalling === false
				? false
				: undefined;
	if (hasModelInfo ? supportsTools !== true : supportsTools === false) return undefined;

	const contextWindow = pickFirst(
		parseNumber(modelInfo?.max_input_tokens),
		parseNumber(modelInfo?.max_tokens),
		DEFAULT_CONTEXT_WINDOW,
	);
	const maxTokens = pickFirst(
		parseNumber(modelInfo?.max_output_tokens),
		parseNumber(modelInfo?.max_tokens),
		DEFAULT_MAX_TOKENS,
	);
	const inputCost = perMillion(modelInfo?.input_cost_per_token) ?? 0;
	const outputCost = perMillion(modelInfo?.output_cost_per_token) ?? 0;
	const cacheRead = perMillion(modelInfo?.cache_read_input_token_cost) ?? 0;
	const cacheWrite = perMillion(modelInfo?.cache_creation_input_token_cost) ?? 0;
	const supportsReasoning = parseBoolean(modelInfo?.supports_reasoning) ?? false;
	const supportsVision = parseBoolean(modelInfo?.supports_vision) ?? false;

	// LiteLLM reports cache support and upstream routing in /model/info. Use that
	// metadata rather than the public model name, which may be an arbitrary alias.
	const routingIdentity = [modelInfo?.litellm_provider, modelInfo?.litellm_model_name, modelInfo?.key, modelName]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase();
	const isAnthropicBacked = /(?:^|[^a-z])anthropic(?:[^a-z]|$)/.test(routingIdentity);
	const supportsPromptCaching = parseBoolean(modelInfo?.supports_prompt_caching);
	const fallbackClaudeModel = !modelInfo && /claude/i.test(modelName);
	const usesAnthropicCacheControl =
		(isAnthropicBacked && supportsPromptCaching === true) || fallbackClaudeModel;
	const routesThroughBedrockConverse = modelInfo?.litellm_provider?.trim().toLowerCase() === "bedrock_converse";
	const supportsStrictMode =
		parseBoolean(modelInfo?.bedrock_converse_supports_strict_tools) ?? !(isAnthropicBacked && routesThroughBedrockConverse);

	return {
		id: modelName,
		name: prettyDisplayName(modelName),
		reasoning: supportsReasoning,
		input: supportsVision ? ["text", "image"] : ["text"],
		cost: {
			input: inputCost,
			output: outputCost,
			cacheRead,
			cacheWrite,
		},
		contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
		...(usesAnthropicCacheControl || !supportsStrictMode
			? {
				compat: {
					...(usesAnthropicCacheControl
						? {
							cacheControlFormat: "anthropic" as const,
							sendSessionAffinityHeaders: true,
						}
						: {}),
					...(supportsStrictMode ? {} : { supportsStrictMode: false }),
				},
			}
			: {}),
	};
}

export function buildProviderModels(rawModels: RawModelListItem[], rawModelInfo: RawModelInfoItem[]): ProviderModelConfig[] {
	const hasModelInfo = rawModelInfo.length > 0;
	const infoByName = new Map<string, RawModelInfo>();
	for (const item of rawModelInfo) {
		if (!item || typeof item !== "object") continue;
		if (typeof item.model_name !== "string" || item.model_name.length === 0) continue;
		infoByName.set(item.model_name, item.model_info || {});
	}

	const discovered = new Set<string>();
	for (const item of rawModels) {
		if (!item || typeof item !== "object") continue;
		if (typeof item.id === "string" && item.id.length > 0) discovered.add(item.id);
	}
	for (const modelName of infoByName.keys()) discovered.add(modelName);

	const modelNames = Array.from(discovered).sort();
	const filteredNames = hasModelInfo
		? canonicalDiscoveredModels(modelNames, infoByName)
		: canonicalFallbackModels(modelNames);

	return filteredNames
		.filter((modelName) => (infoByName.has(modelName) ? true : !shouldSkipFallbackModel(modelName)))
		.map((modelName) => buildProviderModel(modelName, infoByName.get(modelName), infoByName.has(modelName)))
		.filter((model): model is ProviderModelConfig => model !== undefined);
}

export async function getJson<T>(url: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<T> {
	const response = await fetchImpl(url, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${apiKey}`,
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`);
	}

	return (await response.json()) as T;
}

export async function loadModelInfo(
	baseUrl: string,
	apiKey: string,
	fetchImpl: typeof fetch = fetch,
): Promise<RawModelInfoItem[]> {
	const candidates = baseUrl.endsWith("/v1") ? ["/model/info"] : ["/v1/model/info", "/model/info"];
	let lastError: Error | undefined;

	for (const candidate of candidates) {
		try {
			const result = await getJson<{ data?: RawModelInfoItem[] }>(`${baseUrl}${candidate}`, apiKey, fetchImpl);
			return Array.isArray(result?.data) ? result.data : [];
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	if (lastError) {
		console.warn(
			`[${ACQUIA_PROVIDER_NAME}-provider] falling back to /models only because model info could not be loaded.\n${lastError.message}`,
		);
	}

	return [];
}

export async function fetchAcquiaProviderModels(
	baseUrl: string,
	apiKey: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelConfig[]> {
	const modelsResponse = await getJson<{ data?: RawModelListItem[] }>(`${baseUrl}/models`, apiKey, fetchImpl);
	const rawModels = Array.isArray(modelsResponse?.data) ? modelsResponse.data : [];
	const rawModelInfo = await loadModelInfo(baseUrl, apiKey, fetchImpl);
	return buildProviderModels(rawModels, rawModelInfo);
}
