import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveThresholds, type GateConfig } from "./index.js";

const config = (overrides: Partial<GateConfig> = {}): GateConfig => ({ ...DEFAULT_CONFIG, ...overrides });

describe("resolveThresholds", () => {
	it("uses the top-level pair when no profile matches", () => {
		expect(resolveThresholds(config({ profiles: {} }))).toEqual({ allowAt: 0.25, denyAt: 0.6 });
	});

	it("applies a profile keyed by the native provider/model pair", () => {
		const selected = config({
			provider: "cloudflare-workers-ai",
			model: "@cf/cloudflare/clef-flash",
			profiles: {
				"cloudflare-workers-ai/@cf/cloudflare/clef-flash": { allowAt: 0.2, denyAt: 0.5 },
			},
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.2, denyAt: 0.5 });
	});

	it("applies a profile keyed by the OpenRouter pair", () => {
		const selected = config({
			provider: "openrouter",
			model: "cloudflare/clef-flash",
			profiles: {
				"openrouter/cloudflare/clef-flash": { allowAt: 0.2, denyAt: 0.5 },
			},
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.2, denyAt: 0.5 });
	});

	it("does not match another provider's key", () => {
		// Regression: the example used "cloudflare/clef-flash", which is the
		// OpenRouter model id without its provider, so the profile never applied.
		const selected = config({
			provider: "cloudflare-workers-ai",
			model: "@cf/cloudflare/clef-flash",
			profiles: {
				"cloudflare/clef-flash": { allowAt: 0.2, denyAt: 0.5 },
			},
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.25, denyAt: 0.6 });
	});

	it("fills a missing profile field from the top-level pair", () => {
		const selected = config({
			profiles: { "typesafe/jev-latest": { allowAt: 0.1 } },
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.1, denyAt: 0.6 });
	});

	it("ignores a profile whose bands are crossed", () => {
		const selected = config({
			profiles: { "typesafe/jev-latest": { allowAt: 0.9, denyAt: 0.1 } },
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.25, denyAt: 0.6 });
	});
});
