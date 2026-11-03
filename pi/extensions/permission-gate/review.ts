/**
 * Permission Gate — review evidence and the classifier call.
 *
 * Ported from fx's `serializeEvidence()` / `buildReviewRequest()`: the reviewer
 * gets the exact action, the trusted user intent, recorded environment facts,
 * and explicit completeness flags — never a guess about why the action exists.
 * Unlike fx, no prior tool-result excerpts are attached: we do not need to
 * detect injection by text match, and omitting them keeps tool output out of
 * a second provider's request entirely.
 *
 * The previous design was stateless (tool + cwd only). That is why every
 * context-dependent call — delete a build directory, push a branch — landed in
 * the middle band: the reviewer had no way to tell "the user asked for this"
 * from "the agent invented it".
 */

import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { describeEnvironment, type EnvironmentFacts } from "./environment.js";
import { redactSecrets } from "./floor.js";
import { boundTurn, renderIntentContext, type IntentContext } from "./intent.js";
import { buildQuestions } from "./policy.js";

/** Max characters of the action value sent as evidence. */
export const MAX_ACTION_CHARS = 4000;
export const MAX_DETAIL_CHARS = 400;

export interface ReviewTarget {
	readonly toolName: string;
	/** Command text, resolved path, or URL. */
	readonly value: string;
	readonly cwd: string;
	/** Extra normalized facts, e.g. the plan refusal reason or resolved plan. */
	readonly detail?: string;
	/** Tool call id, so a blocked call can be matched to its log row. */
	readonly toolCallId?: string;
	/** Set when another tool issued this call. */
	readonly parentToolCallId?: string;
}

export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + " [... omitted ...]" : text;
}

export interface ReviewEvidence {
	readonly state: ClassifierContext["state"];
	/** Action evidence was cut; the reviewer must not assume it saw everything. */
	readonly incomplete: boolean;
	/** Rendering of the trusted intent lines, for the log and tests. */
	readonly intentText: string;
}

/**
 * Build the classifier state for one action. `intent` may be null when no user
 * turn is readable; the review then runs action-only, which the reviewer is
 * told is a weaker basis.
 */
export function buildReviewEvidence(
	target: ReviewTarget,
	intent: IntentContext | null,
	facts: EnvironmentFacts,
	trustedProject: boolean,
): ReviewEvidence {
	const redacted = redactSecrets(target.value);
	const boundedValue = truncate(redacted, MAX_ACTION_CHARS);
	const incomplete = boundedValue !== redacted;

	const intentText = intent === null ? "" : renderIntentContext(intent);
	const contextual = intentText.length > 0;

	const trustedIntent: Record<string, string | string[] | number> = {};
	if (intent !== null) {
		if (intent.currentRequest !== null) trustedIntent["current_request"] = boundTurn(intent.currentRequest);
		if (intent.firstRootRequest !== null) trustedIntent["first_root_user_request"] = boundTurn(intent.firstRootRequest);
		if (intent.recentRootRequests.length > 0) {
			trustedIntent["recent_root_user_request"] = intent.recentRootRequests.map((turn) => boundTurn(turn));
		}
		if (intent.omittedRootTurns > 0) trustedIntent["omitted_proven_root_user_turns"] = intent.omittedRootTurns;
	}

	const state: ClassifierContext["state"] = {
		review_context_kind: contextual ? "contextual" : "action_only",
		review_origin: target.parentToolCallId === undefined ? "agent" : "subagent",
		target_tool_call_id: target.toolCallId ?? "",
		environment: { facts: describeEnvironment(facts, target.cwd, trustedProject) },
		untrusted_action: {
			tool: target.toolName,
			value: boundedValue,
			cwd: target.cwd,
			detail: target.detail === undefined ? "" : truncate(target.detail, MAX_DETAIL_CHARS),
		},
		action_evidence_incomplete: incomplete,
	};
	if (contextual) state["trusted_user_intent"] = trustedIntent;

	return { state, incomplete, intentText };
}

export interface ReviewModelRef {
	readonly provider: string;
	readonly model: string;
}

/** Minimal registry surface the review needs (structurally satisfied by ctx.modelRegistry). */
export interface ReviewRegistry {
	findOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<ClassifierResult>;
}

export type ReviewOutcome =
	| {
			readonly status: "reviewed";
			/** Violation probability per question id. */
			readonly probabilities: Readonly<Record<string, number>>;
			readonly confidence: number;
			readonly latencyMs: number;
			readonly model: string;
	  }
	| {
			readonly status: "unavailable";
			/** Stable id: unknown-model | aborted | error | malformed. */
			readonly reason: string;
			readonly detail: string;
			readonly latencyMs: number;
	  };

export function modelKey(ref: ReviewModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

/** One classify call carries every question for this action. */
export async function runReview(
	registry: ReviewRegistry,
	ref: ReviewModelRef,
	evidence: ReviewEvidence,
	questionIds: readonly string[],
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ReviewOutcome> {
	const started = Date.now();
	const fail = (reason: string, detail: string): ReviewOutcome => ({
		status: "unavailable",
		reason,
		detail,
		latencyMs: Date.now() - started,
	});

	const model = registry.findOfType("classifier", ref.provider, ref.model);
	if (!model) return fail("unknown-model", `Review model not available: ${modelKey(ref)}. Check provider auth.`);

	const questions = buildQuestions(questionIds);
	const context: ClassifierContext = { state: evidence.state, questions };

	let result: ClassifierResult;
	try {
		result = await registry.classify(model, context, {
			...(options.signal === undefined ? {} : { signal: options.signal }),
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		return fail("error", `Review request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const latencyMs = Date.now() - started;

	if (result.stopReason === "aborted") return fail("aborted", "Review request aborted.");
	if (result.stopReason !== "stop") return fail("error", `Review error: ${result.errorMessage ?? "unknown"}`);

	const probabilities: Record<string, number> = {};
	let confidence = 1;
	for (const id of Object.keys(questions)) {
		const answer = result.answers[id];
		if (!answer || answer.type !== "choice") return fail("malformed", `Review response missing the "${id}" answer.`);
		const p = answer.probabilities["violation"];
		if (typeof p !== "number" || !Number.isFinite(p)) {
			return fail("malformed", `Review answer "${id}" had no usable violation probability.`);
		}
		probabilities[id] = p;
		confidence = Math.min(confidence, answer.confidence);
	}

	return { status: "reviewed", probabilities, confidence, latencyMs, model: modelKey(ref) };
}
