import { describe, expect, it } from "vitest";
import { decideReview, describeDecision, DEFAULT_THRESHOLDS, validateThresholds } from "./decide.js";

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
