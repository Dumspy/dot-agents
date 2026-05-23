import { describe, expect, it } from "vitest";
import {
	parseEnumSetting,
	parseIntegerSetting,
	parseOnOff,
} from "../settings.ts";

describe("settings", () => {
	it("parses on/off and falls back safely", () => {
		expect(parseOnOff("on", false)).toBe(true);
		expect(parseOnOff("off", true)).toBe(false);
		expect(parseOnOff("bogus", true)).toBe(true);
		expect(parseOnOff(undefined, false)).toBe(false);
	});

	it("validates integer ranges", () => {
		expect(parseIntegerSetting("30", 10, { min: 1, max: 120 })).toBe(30);
		expect(parseIntegerSetting("0", 10, { min: 1, max: 120 })).toBe(10);
		expect(parseIntegerSetting("121", 10, { min: 1, max: 120 })).toBe(10);
		expect(parseIntegerSetting("not-a-number", 10, { min: 1, max: 120 })).toBe(10);
	});

	it("validates enum values", () => {
		expect(parseEnumSetting("markdown", ["markdown", "text", "html"], "text")).toBe("markdown");
		expect(parseEnumSetting("pdf", ["markdown", "text", "html"], "text")).toBe("text");
		expect(parseEnumSetting(undefined, ["markdown", "text", "html"], "text")).toBe("text");
	});
});
