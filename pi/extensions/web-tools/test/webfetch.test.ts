import { describe, expect, it } from "vitest";
import {
	createWebFetchHeaders,
	OPENCODE_WEBFETCH_DEFAULT_USER_AGENT,
	shouldRetryWithFallbackUserAgent,
} from "../webfetch.ts";

describe("webfetch", () => {
	it("uses the OpenCode browser-like default user agent", () => {
		const headers = createWebFetchHeaders("text/html");
		expect(headers["User-Agent"]).toBe(OPENCODE_WEBFETCH_DEFAULT_USER_AGENT);
		expect(headers.Accept).toBe("text/html");
		expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
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
