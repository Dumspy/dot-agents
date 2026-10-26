import { describe, expect, it } from "vitest";
import { decideSafety, validateThresholds } from "./decide.js";

describe("decideSafety", () => {
	const th = { t: 0.85, c: 0.7 };

	it("allows clear safe answers", () => {
		expect(decideSafety({ p: 0.97, confidence: 0.9 }, th)).toEqual({
			verdict: "allow",
			reason: "p-allow",
		});
		expect(decideSafety({ p: 0.85, confidence: 0.7 }, th).verdict).toBe("allow");
	});

	it("blocks clear unsafe answers", () => {
		expect(decideSafety({ p: 0.03, confidence: 0.95 }, th)).toEqual({
			verdict: "block",
			reason: "p-block",
		});
		expect(decideSafety({ p: 0.15, confidence: 0.7 }, th).verdict).toBe("block");
	});

	it("prompts the middle band", () => {
		expect(decideSafety({ p: 0.5, confidence: 0.9 }, th)).toEqual({
			verdict: "prompt",
			reason: "p-uncertain",
		});
		expect(decideSafety({ p: 0.84, confidence: 0.9 }, th).verdict).toBe("prompt");
		expect(decideSafety({ p: 0.16, confidence: 0.9 }, th).verdict).toBe("prompt");
	});

	it("forces prompt on low confidence regardless of probability", () => {
		expect(decideSafety({ p: 0.99, confidence: 0.2 }, th)).toEqual({
			verdict: "prompt",
			reason: "low-confidence",
		});
		expect(decideSafety({ p: 0.01, confidence: 0.2 }, th).verdict).toBe("prompt");
	});
});

describe("validateThresholds", () => {
	it("accepts valid thresholds", () => {
		expect(validateThresholds({ t: 0.85, c: 0.7 })).toEqual([]);
		expect(validateThresholds({ t: 1, c: 0 })).toEqual([]);
		expect(validateThresholds({ t: 0.51, c: 1 })).toEqual([]);
	});

	it("rejects degenerate thresholds", () => {
		expect(validateThresholds({ t: 0.5, c: 0.7 })).toHaveLength(1);
		expect(validateThresholds({ t: 1.5, c: 0.7 })).toHaveLength(1);
		expect(validateThresholds({ t: 0.85, c: -0.1 })).toHaveLength(1);
		expect(validateThresholds({ t: 0.4, c: 2 })).toHaveLength(2);
	});
});
