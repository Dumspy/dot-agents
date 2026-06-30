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
			[{ id: "claude-sonnet-4-5" }, { id: "anthropic.claude-sonnet-4-5" }],
			[
				{
					model_name: "anthropic.claude-sonnet-4-5",
					model_info: {
						supports_reasoning: true,
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
				id: "anthropic.claude-sonnet-4-5",
				name: "Anthropic Claude Sonnet 4.5",
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
				compat: { cacheControlFormat: "anthropic" },
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

	it("disables reasoning for claude 4-series models that require adaptive thinking", () => {
		const models = buildProviderModels(
			[],
			[
				// opus 4.6, 4.7, 4.8 — all require adaptive thinking on Bedrock
				{
					model_name: "anthropic.claude-opus-4-6",
					model_info: { mode: "chat", supports_reasoning: true, supports_function_calling: true },
				},
				{
					model_name: "anthropic.claude-opus-4-7",
					model_info: { mode: "chat", supports_reasoning: true, supports_function_calling: true },
				},
				{
					model_name: "anthropic.claude-opus-4-8",
					model_info: { mode: "chat", supports_reasoning: true, supports_function_calling: true },
				},
				// sonnet 4.6 — also requires adaptive thinking
				{
					model_name: "anthropic.claude-sonnet-4-6",
					model_info: { mode: "chat", supports_reasoning: true, supports_function_calling: true },
				},
				// sonnet 4.5 — does NOT require adaptive thinking, reasoning passes through
				{
					model_name: "anthropic.claude-sonnet-4-5",
					model_info: { mode: "chat", supports_reasoning: true, supports_function_calling: true },
				},
			],
		);

		const byId = Object.fromEntries(models.map((m) => [m.id, m]));
		expect(byId["anthropic.claude-opus-4-6"]?.reasoning).toBe(false);
		expect(byId["anthropic.claude-opus-4-7"]?.reasoning).toBe(false);
		expect(byId["anthropic.claude-opus-4-8"]?.reasoning).toBe(false);
		expect(byId["anthropic.claude-sonnet-4-6"]?.reasoning).toBe(false);
		expect(byId["anthropic.claude-sonnet-4-5"]?.reasoning).toBe(true);
	});

	it("drops models with empty metadata since tool support is unknown", () => {
		const models = buildProviderModels(
			[{ id: "some-model" }],
			[{ model_name: "some-model", model_info: {} }],
		);
		expect(models).toEqual([]);
	});
});

describe("fetchAcquiaProviderModels", () => {
	it("discovers models via mock fetch", async () => {
		const mockFetch = (url: string, _init: RequestInit) => {
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
		expect(models[0].contextWindow).toBe(8_192);
		expect(models[0].maxTokens).toBe(4_096);
	});
});
