/**
 * Judge Gate — verdict logic for the single safety question.
 *
 * One noul ("safe to execute autonomously") returns a probability `p` of
 * "yes" plus a `confidence`. Threshold `t` (0.5 < t <= 1) splits probability
 * into allow / uncertain / block; confidence floor `c` forces a prompt when
 * the model itself is unsure, regardless of `p`.
 */

export type SafetyVerdict = "allow" | "prompt" | "block";

export interface SafetyJudgment {
	/** Probability that the call is safe to execute autonomously. */
	readonly p: number;
	/** Model-reported confidence in the answer. */
	readonly confidence: number;
}

export interface JudgeThresholds {
	/** Probability required to count as safe. 0.5 < t <= 1. */
	readonly t: number;
	/** Minimum confidence to act without prompting. 0 <= c <= 1. */
	readonly c: number;
}

export interface SafetyDecision {
	readonly verdict: SafetyVerdict;
	/** Short stable reason id for log rows, e.g. "p-allow", "low-confidence". */
	readonly reason: string;
}

export const DEFAULT_THRESHOLDS: JudgeThresholds = { t: 0.85, c: 0.7 };

/** Validate thresholds. Returns error strings; empty means valid. */
export function validateThresholds(th: JudgeThresholds): string[] {
	const errors: string[] = [];
	if (!(th.t > 0.5 && th.t <= 1)) {
		errors.push(`t must satisfy 0.5 < t <= 1, got ${th.t}`);
	}
	if (!(th.c >= 0 && th.c <= 1)) {
		errors.push(`c must satisfy 0 <= c <= 1, got ${th.c}`);
	}
	return errors;
}

export function decideSafety(judgment: SafetyJudgment, thresholds: JudgeThresholds): SafetyDecision {
	if (judgment.confidence < thresholds.c) {
		return { verdict: "prompt", reason: "low-confidence" };
	}
	if (judgment.p >= thresholds.t) {
		return { verdict: "allow", reason: "p-allow" };
	}
	if (judgment.p <= 1 - thresholds.t) {
		return { verdict: "block", reason: "p-block" };
	}
	return { verdict: "prompt", reason: "p-uncertain" };
}
