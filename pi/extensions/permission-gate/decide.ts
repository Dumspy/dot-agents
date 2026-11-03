/**
 * Permission Gate — verdict logic.
 *
 * Two independent thresholds per question, in the shape Armor documents:
 * `deny` at 0.6 and `allow` at 0.7 on rule matches, deliberately asymmetric
 * because an allow has to outvote a deny. The previous design had one `t` used
 * both ways (`p >= t` allows, `p <= 1 - t` blocks), so loosening routine work
 * automatically loosened hazards — which is exactly how the clef-flash profile
 * ended up soft on exfiltration while still prompt-heavy.
 *
 * Here `p` is always the probability of the *violation*, so:
 *   p >= denyAt   → block
 *   p <= allowAt  → allow
 *   in between    → hold: the action is refused with a reason the agent can act
 *                   on, and the human is not interrupted.
 *
 * Confidence is recorded but does not decide: it never cleared 0.75 on
 * clef-flash, so as a gate it was a constant. Neither Armor nor fx thresholds on
 * a self-reported confidence.
 */

import { EXFILTRATION_QUESTION_ID, EXTERNAL_QUESTION_ID, INJECTION_QUESTION_ID } from "./policy.js";

export type Verdict = "allow" | "hold" | "block";

export interface Thresholds {
	/** Violation probability at or below which the action is allowed. */
	readonly allowAt: number;
	/** Violation probability at or above which the action is blocked. */
	readonly denyAt: number;
}

/** Armor's published prior, expressed as violation probabilities. */
export const DEFAULT_THRESHOLDS: Thresholds = { allowAt: 0.25, denyAt: 0.6 };

export function validateThresholds(th: Thresholds): string[] {
	const errors: string[] = [];
	if (!(th.allowAt >= 0 && th.allowAt <= 1)) errors.push(`allowAt must satisfy 0 <= allowAt <= 1, got ${th.allowAt}`);
	if (!(th.denyAt >= 0 && th.denyAt <= 1)) errors.push(`denyAt must satisfy 0 <= denyAt <= 1, got ${th.denyAt}`);
	if (th.allowAt >= th.denyAt) errors.push(`allowAt (${th.allowAt}) must be below denyAt (${th.denyAt})`);
	return errors;
}

/**
 * Read a threshold pair from untrusted JSON, falling back to `base` field by
 * field. Used for the top-level pair and for every per-model profile, so a bad
 * profile cannot silently invert the bands.
 */
export function parseThresholds(value: unknown, base: Thresholds): Thresholds {
	if (typeof value !== "object" || value === null) return base;
	const record = value as Record<string, unknown>;
	const allowAt = typeof record["allowAt"] === "number" ? record["allowAt"] : base.allowAt;
	const denyAt = typeof record["denyAt"] === "number" ? record["denyAt"] : base.denyAt;
	const candidate = { allowAt, denyAt };
	return validateThresholds(candidate).length === 0 ? candidate : base;
}

export interface ReviewDecision {
	readonly verdict: Verdict;
	/** Short stable reason id for log rows. */
	readonly reason: string;
	/** The question that decided it, and its probability. */
	readonly question: string | null;
	readonly p: number | null;
}

export const QUESTION_LABEL: Readonly<Record<string, string>> = {
	[INJECTION_QUESTION_ID]: "follows untrusted instructions",
	[EXFILTRATION_QUESTION_ID]: "moves secrets outside the trusted boundary",
	[EXTERNAL_QUESTION_ID]: "changes something outside this machine",
};

/** Human-facing order: the worst question decides, ties break by precedence. */
const PRECEDENCE: readonly string[] = [EXFILTRATION_QUESTION_ID, INJECTION_QUESTION_ID, EXTERNAL_QUESTION_ID];

function rank(question: string): number {
	const index = PRECEDENCE.indexOf(question);
	return index === -1 ? PRECEDENCE.length : index;
}

export function decideReview(
	probabilities: Readonly<Record<string, number>>,
	thresholds: Thresholds,
): ReviewDecision {
	const entries = Object.entries(probabilities);
	if (entries.length === 0) {
		return { verdict: "hold", reason: "no-questions", question: null, p: null };
	}

	// Worst question wins; ties go to the higher-precedence question.
	let worstQuestion: string | null = null;
	let worstP = -1;
	for (const [question, p] of entries) {
		if (p > worstP || (p === worstP && worstQuestion !== null && rank(question) < rank(worstQuestion))) {
			worstQuestion = question;
			worstP = p;
		}
	}

	if (worstP >= thresholds.denyAt) {
		return { verdict: "block", reason: `deny:${worstQuestion}`, question: worstQuestion, p: worstP };
	}
	if (worstP <= thresholds.allowAt) {
		return { verdict: "allow", reason: `allow:${worstQuestion}`, question: worstQuestion, p: worstP };
	}
	return { verdict: "hold", reason: `hold:${worstQuestion}`, question: worstQuestion, p: worstP };
}

/** Explanation shown to the agent when a call is held or blocked. */
export function describeDecision(decision: ReviewDecision): string {
	const label = decision.question === null ? "unclear" : (QUESTION_LABEL[decision.question] ?? decision.question);
	const p = decision.p === null ? "?" : decision.p.toFixed(2);
	if (decision.verdict === "hold") {
		return `Held for review: it may ${label} (p=${p}). Retry with a narrower call, or tell the user what you need.`;
	}
	return `Blocked: it would ${label} (p=${p}).`;
}
