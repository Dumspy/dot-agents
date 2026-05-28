import { describe, expect, it } from "vitest";
import {
	createWebFetchHeaders,
	getFallbackUserAgent,
	OPENCODE_WEBFETCH_DEFAULT_USER_AGENT,
	OPENCODE_WEBFETCH_FALLBACK_USER_AGENT,
	shouldRetryWithFallbackUserAgent,
} from "../webfetch.ts";

describe("webfetch", () => {
	it("uses the OpenCode browser-like default user agent", () => {
		const headers = createWebFetchHeaders("text/html");
		expect(headers["User-Agent"]).toBe(OPENCODE_WEBFETCH_DEFAULT_USER_AGENT);
		expect(headers.Accept).toBe("text/html");
		expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
	});

	it("prefers the configured fallback user agent and otherwise falls back to opencode", () => {
		expect(getFallbackUserAgent("my-agent/1.0")).toBe("my-agent/1.0");
		expect(getFallbackUserAgent("  custom-agent  ")).toBe("custom-agent");
		expect(getFallbackUserAgent("")).toBe(OPENCODE_WEBFETCH_FALLBACK_USER_AGENT);
		expect(getFallbackUserAgent("   ")).toBe(OPENCODE_WEBFETCH_FALLBACK_USER_AGENT);
		expect(getFallbackUserAgent(undefined)).toBe(OPENCODE_WEBFETCH_FALLBACK_USER_AGENT);
	});

	it("only retries the Cloudflare challenge case", () => {
		expect(
			shouldRetryWithFallbackUserAgent({
				status: 403,
				headers: new Headers({ "cf-mitigated": "challenge" }),
			}),
		).toBe(true);
		expect(
			shouldRetryWithFallbackUserAgent({
				status: 403,
				headers: new Headers(),
			}),
		).toBe(false);
		expect(
			shouldRetryWithFallbackUserAgent({
				status: 429,
				headers: new Headers({ "cf-mitigated": "challenge" }),
			}),
		).toBe(false);
	});
});
