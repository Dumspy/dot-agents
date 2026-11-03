import { describe, expect, it } from "vitest";
import { decideReview, describeDecision, DEFAULT_THRESHOLDS, parseThresholds, validateThresholds } from "./decide.js";

const th = { allowAt: 0.25, denyAt: 0.6 };

describe("validateThresholds", () => {
	it("accepts the shipped defaults", () => {
		expect(validateThresholds(DEFAULT_THRESHOLDS)).toEqual([]);
	});

	it("rejects a crossed pair", () => {
		expect(validateThresholds({ allowAt: 0.7, denyAt: 0.6 })).not.toEqual([]);
		expect(validateThresholds({ allowAt: 0.5, denyAt: 0.5 })).not.toEqual([]);
	});

	it("rejects out-of-range values", () => {
		expect(validateThresholds({ allowAt: -0.1, denyAt: 0.6 })).not.toEqual([]);
		expect(validateThresholds({ allowAt: 0.2, denyAt: 1.2 })).not.toEqual([]);
	});
});

describe("decideReview bands", () => {
	it("allows when every question is at or below allowAt", () => {
		const decision = decideReview({ injection: 0.05, exfiltration: 0.1, external_effect: 0.2 }, th);
		expect(decision.verdict).toBe("allow");
		expect(decision.p).toBeCloseTo(0.2);
	});

	it("blocks when any question reaches denyAt", () => {
		const decision = decideReview({ injection: 0.02, exfiltration: 0.9, external_effect: 0.01 }, th);
		expect(decision.verdict).toBe("block");
		expect(decision.question).toBe("exfiltration");
	});

	it("holds in the middle band instead of prompting", () => {
		const decision = decideReview({ injection: 0.02, exfiltration: 0.4, external_effect: 0.01 }, th);
		expect(decision.verdict).toBe("hold");
		expect(decision.reason).toBe("hold:exfiltration");
	});

	it("lets one bad question win over several clean ones", () => {
		const decision = decideReview({ injection: 0.0, exfiltration: 0.0, external_effect: 0.95 }, th);
		expect(decision.verdict).toBe("block");
	});

	it("decoupling matters: a hazard blocks even when routine work is loose", () => {
		const loose = { allowAt: 0.45, denyAt: 0.6 };
		const decision = decideReview({ injection: 0.1, exfiltration: 0.55, external_effect: 0.1 }, loose);
		expect(decision.verdict).toBe("hold");
		const tight = decideReview({ injection: 0.1, exfiltration: 0.65, external_effect: 0.1 }, loose);
		expect(tight.verdict).toBe("block");
	});

	it("holds when no questions were answered", () => {
		expect(decideReview({}, th).verdict).toBe("hold");
	});
});

describe("describeDecision", () => {
	it("tells the agent to narrow the call on hold", () => {
		const text = describeDecision(decideReview({ exfiltration: 0.4 }, th));
		expect(text).toContain("Held for review");
		expect(text).toContain("narrower call");
	});

	it("names the risk on block", () => {
		const text = describeDecision(decideReview({ exfiltration: 0.9 }, th));
		expect(text).toContain("Blocked");
		expect(text).toContain("secrets");
	});
});

describe("parseThresholds", () => {
	it("reads a valid pair", () => {
		expect(parseThresholds({ allowAt: 0.3, denyAt: 0.7 }, { allowAt: 0.25, denyAt: 0.6 })).toEqual({ allowAt: 0.3, denyAt: 0.7 });
	});

	it("refuses an inverted or out-of-range pair instead of trusting it", () => {
		const base = { allowAt: 0.25, denyAt: 0.6 };
		expect(parseThresholds({ allowAt: 0.9, denyAt: 0.2 }, base)).toEqual(base);
		expect(parseThresholds({ allowAt: -1, denyAt: 0.6 }, base)).toEqual(base);
		expect(parseThresholds({ allowAt: 0.3 }, base)).toEqual({ allowAt: 0.3, denyAt: 0.6 });
	});

	it("falls back on junk", () => {
		const base = { allowAt: 0.25, denyAt: 0.6 };
		expect(parseThresholds(null, base)).toEqual(base);
		expect(parseThresholds("nope", base)).toEqual(base);
		expect(parseThresholds({ allowAt: "0.1" }, base)).toEqual(base);
	});
});
