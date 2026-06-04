import { describe, expect, it } from "vitest";
import { buildProviderModels, prettyDisplayName } from "./lib.ts";

describe("prettyDisplayName", () => {
	it("formats provider-prefixed model identifiers", () => {
		expect(prettyDisplayName("anthropic.claude-sonnet-4-6")).toBe("Anthropic Claude Sonnet 4.6");
		expect(prettyDisplayName("moonshotai.kimi-k2.5")).toBe("MoonshotAI Kimi K2.5");
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
});
