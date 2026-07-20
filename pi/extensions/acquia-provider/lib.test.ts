import { describe, expect, it } from "vitest";
import { buildProviderModels, fetchAcquiaProviderModels, normalizeBaseUrl, prettyDisplayName } from "./lib.ts";

describe("normalizeBaseUrl", () => {
	it("strips trailing slashes and handles empty input", () => {
		expect(normalizeBaseUrl("https://example.com/v1/")).toBe("https://example.com/v1");
		expect(normalizeBaseUrl("https://example.com/v1///")).toBe("https://example.com/v1");
		expect(normalizeBaseUrl(undefined)).toBe("");
		expect(normalizeBaseUrl("")).toBe("");
	});
});

describe("prettyDisplayName", () => {
	it("formats provider-prefixed model identifiers", () => {
		expect(prettyDisplayName("anthropic.claude-sonnet-4-6")).toBe("Anthropic Claude Sonnet 4.6");
		expect(prettyDisplayName("moonshotai.kimi-k2.5")).toBe("MoonshotAI Kimi K2.5");
	});

	it("converts digit-dash-digit sequences to dots", () => {
		expect(prettyDisplayName("model-4-6")).toBe("Model 4.6");
		expect(prettyDisplayName("version-1-2")).toBe("Version 1.2");
	});
});

describe("buildProviderModels", () => {
	it("deduplicates aliases and maps rich model info into pi provider models", () => {
		const models = buildProviderModels(
			[{ id: "claude-sonnet-4-6" }, { id: "anthropic.claude-sonnet-4-6" }],
			[
				{
					model_name: "anthropic.claude-sonnet-4-6",
					model_info: {
						litellm_provider: "bedrock_converse",
						key: "us.anthropic.claude-sonnet-4-6",
						supports_reasoning: true,
						supports_prompt_caching: true,
						supports_function_calling: true,
						supports_vision: true,
						max_input_tokens: 1_000_000,
						max_output_tokens: 64_000,
						input_cost_per_token: 0.000003,
						output_cost_per_token: 0.000015,
						cache_read_input_token_cost: 0.0000003,
						cache_creation_input_token_cost: 0.00000375,
					},
				},
			],
		);

		expect(models).toEqual([
			{
				id: "anthropic.claude-sonnet-4-6",
				name: "Anthropic Claude Sonnet 4.6",
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: 3,
					output: 15,
					cacheRead: 0.3,
					cacheWrite: 3.75,
				},
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				compat: {
					cacheControlFormat: "anthropic",
					sendSessionAffinityHeaders: true,
					supportsStrictMode: false,
				},
			},
		]);
	});

	it("falls back to /models-only discovery and skips obvious non-chat models", () => {
		const models = buildProviderModels(
			[
				{ id: "all-proxy-models" },
				{ id: "text-embedding-3-large" },
				{ id: "amazon.nova-pro" },
			],
			[],
		);

		expect(models).toEqual([
			{
				id: "amazon.nova-pro",
				name: "Amazon Nova Pro",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: 128_000,
				maxTokens: 4_096,
			},
		]);
	});

	it("drops models that explicitly do not support tool calling or are non-text modes", () => {
		const models = buildProviderModels(
			[{ id: "vision-only-model" }, { id: "no-tools" }, { id: "okay-model" }],
			[
				{
					model_name: "vision-only-model",
					model_info: { mode: "image_generation", supports_function_calling: true },
				},
				{
					model_name: "no-tools",
					model_info: { mode: "chat", supports_function_calling: false },
				},
				{
					model_name: "okay-model",
					model_info: { mode: "chat", supports_parallel_function_calling: true },
				},
			],
		);

		expect(models.map((model) => model.id)).toEqual(["okay-model"]);
	});

	it("drops models with empty metadata since tool support is unknown", () => {
		const models = buildProviderModels(
			[{ id: "some-model" }],
			[{ model_name: "some-model", model_info: {} }],
		);
		expect(models).toEqual([]);
	});

	it("uses LiteLLM cache capability and routing metadata instead of a Claude model-name heuristic", () => {
		const models = buildProviderModels(
			[{ id: "team-cache-alias" }],
			[
				{
					model_name: "team-cache-alias",
					model_info: {
						key: "us.anthropic.claude-sonnet-4-6",
						litellm_provider: "bedrock_converse",
						supports_prompt_caching: true,
						supports_function_calling: true,
					},
				},
			],
		);

		expect(models[0]?.compat).toEqual({
			cacheControlFormat: "anthropic",
			sendSessionAffinityHeaders: true,
			supportsStrictMode: false,
		});
	});

	it("accepts a model when parallel function calling is supported", () => {
		const models = buildProviderModels(
			[{ id: "parallel-only" }],
			[
				{
					model_name: "parallel-only",
					model_info: {
						supports_function_calling: false,
						supports_parallel_function_calling: true,
					},
				},
			],
		);
		expect(models.map((model) => model.id)).toEqual(["parallel-only"]);
	});

	it("keeps intentional aliases that share a LiteLLM routing key", () => {
		const models = buildProviderModels(
			[{ id: "anthropic.claude-sonnet-4-6" }, { id: "claude-sonnet-4-6-cache-control-system" }],
			[
				{
					model_name: "anthropic.claude-sonnet-4-6",
					model_info: { key: "us.anthropic.claude-sonnet-4-6", supports_function_calling: true },
				},
				{
					model_name: "claude-sonnet-4-6-cache-control-system",
					model_info: { key: "us.anthropic.claude-sonnet-4-6", supports_function_calling: true },
				},
			],
		);
		expect(models.map((model) => model.id)).toEqual([
			"anthropic.claude-sonnet-4-6",
			"claude-sonnet-4-6-cache-control-system",
		]);
	});

	it("keeps /models entries that have no metadata when model info is partial", () => {
		const models = buildProviderModels(
			[{ id: "metadata-model" }, { id: "models-only-model" }],
			[
				{
					model_name: "metadata-model",
					model_info: { supports_function_calling: true },
				},
			],
		);
		expect(models.map((model) => model.id)).toEqual(["metadata-model", "models-only-model"]);
	});
});

describe("fetchAcquiaProviderModels", () => {
	it("discovers models via mock fetch without duplicating an existing /v1 path", async () => {
		const requestedUrls: string[] = [];
		const mockFetch = (url: string, _init: RequestInit) => {
			requestedUrls.push(url);
			if (url.endsWith("/models")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					json: () => Promise.resolve({ data: [{ id: "gpt-4" }] }),
					text: () => Promise.resolve(""),
				} as Response);
			}
			if (url.endsWith("/model/info") || url.endsWith("/v1/model/info")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					json: () =>
						Promise.resolve({
							data: [
								{
									model_name: "gpt-4",
									model_info: {
										mode: "chat",
										supports_function_calling: true,
										max_input_tokens: 8_192,
										max_output_tokens: 4_096,
									},
								},
							],
						}),
					text: () => Promise.resolve(""),
				} as Response);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};

		const models = await fetchAcquiaProviderModels("https://example.com/v1", "key", mockFetch);
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe("gpt-4");
		expect(requestedUrls).toEqual(["https://example.com/v1/models", "https://example.com/v1/model/info"]);
		expect(models[0].contextWindow).toBe(8_192);
		expect(models[0].maxTokens).toBe(4_096);
	});
});
