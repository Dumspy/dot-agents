import { describe, expect, it } from "vitest";
import { DEFAULT_KEYWORD_PATTERNS, loadConfig } from "../config.ts";

describe("loadConfig", () => {
	it("uses defaults when no env vars are set", () => {
		const config = loadConfig();
		expect(config.enabled).toBe(true);
		expect(config.baseUrl).toBe("http://master-node:6767");
		expect(config.injectProfile).toBe(true);
		expect(config.apiKey).toBeUndefined();
		expect(config.keywordPatterns).toEqual(DEFAULT_KEYWORD_PATTERNS);
	});

	it("reads SUPERMEMORY_API_KEY", () => {
		process.env.SUPERMEMORY_API_KEY = "test-key";
		const config = loadConfig();
		expect(config.apiKey).toBe("test-key");
		delete process.env.SUPERMEMORY_API_KEY;
	});

	it("reads SUPERMEMORY_API_BASE_URL", () => {
		process.env.SUPERMEMORY_API_BASE_URL = "http://example:8080";
		const config = loadConfig();
		expect(config.baseUrl).toBe("http://example:8080");
		delete process.env.SUPERMEMORY_API_BASE_URL;
	});

	it("disables when PI_SUPERMEMORY_ENABLED is false", () => {
		process.env.PI_SUPERMEMORY_ENABLED = "false";
		const config = loadConfig();
		expect(config.enabled).toBe(false);
		delete process.env.PI_SUPERMEMORY_ENABLED;
	});

	it("disables profile injection when PI_SUPERMEMORY_INJECT_PROFILE is false", () => {
		process.env.PI_SUPERMEMORY_INJECT_PROFILE = "false";
		const config = loadConfig();
		expect(config.injectProfile).toBe(false);
		delete process.env.PI_SUPERMEMORY_INJECT_PROFILE;
	});

	it("appends custom keyword patterns from PI_SUPERMEMORY_KEYWORD_PATTERNS", () => {
		process.env.PI_SUPERMEMORY_KEYWORD_PATTERNS = "custom1,custom\\s+two";
		const config = loadConfig();
		expect(config.keywordPatterns).toEqual([...DEFAULT_KEYWORD_PATTERNS, "custom1", "custom\\s+two"]);
		delete process.env.PI_SUPERMEMORY_KEYWORD_PATTERNS;
	});

	it("ignores invalid regex patterns in PI_SUPERMEMORY_KEYWORD_PATTERNS", () => {
		process.env.PI_SUPERMEMORY_KEYWORD_PATTERNS = "valid,[invalid";
		const config = loadConfig();
		expect(config.keywordPatterns).toEqual([...DEFAULT_KEYWORD_PATTERNS, "valid"]);
		delete process.env.PI_SUPERMEMORY_KEYWORD_PATTERNS;
	});
});
