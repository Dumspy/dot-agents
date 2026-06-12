import { describe, expect, it } from "vitest";
import { estimateTokens, estimateTokensFromJson, formatTokens, formatPercentage } from "../estimate.ts";

const DIVISOR = 3.5;

describe("estimateTokens", () => {
	it("returns 0 for undefined", () => {
		expect(estimateTokens(undefined)).toBe(0);
	});

	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("estimates via ceil(len / 3.5)", () => {
		expect(estimateTokens("a")).toBe(1);         // ceil(1/3.5) = 1
		expect(estimateTokens("1234")).toBe(2);    // ceil(4/3.5) = 2
		expect(estimateTokens("12345")).toBe(2);   // ceil(5/3.5) = 2
		expect(estimateTokens("1234567")).toBe(2);  // ceil(7/3.5) = 2
		expect(estimateTokens("12345678")).toBe(3); // ceil(8/3.5) = 3
	});

	it("handles large strings", () => {
		const text = "a".repeat(1000);
		expect(estimateTokens(text)).toBe(Math.ceil(1000 / DIVISOR));
	});
});

describe("estimateTokensFromJson", () => {
	it("returns 0 for null/undefined", () => {
		expect(estimateTokensFromJson(null)).toBe(0);
		expect(estimateTokensFromJson(undefined)).toBe(0);
	});

	it("estimates stringified JSON", () => {
		const obj = { a: 1, b: "test" };
		const json = JSON.stringify(obj);
		expect(estimateTokensFromJson(obj)).toBe(Math.ceil(json.length / DIVISOR));
	});

	it("handles circular refs gracefully", () => {
		const obj: Record<string, unknown> = {};
		obj.self = obj;
		expect(estimateTokensFromJson(obj)).toBe(0);
	});
});

describe("formatTokens", () => {
	it("formats under 1k as raw number", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats 1k+ with k suffix", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(999_499)).toBe("999.5k");
	});

	it("formats 1M+ with M suffix", () => {
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatTokens(2_500_000)).toBe("2.5M");
	});
});

describe("formatPercentage", () => {
	it("shows <0.1% for tiny values", () => {
		expect(formatPercentage(0)).toBe("<0.1%");
		expect(formatPercentage(0.05)).toBe("<0.1%");
	});

	it("shows one decimal for normal values", () => {
		expect(formatPercentage(1.23)).toBe("1.2%");
		expect(formatPercentage(50)).toBe("50.0%");
		expect(formatPercentage(99.99)).toBe("100.0%");
	});
});
