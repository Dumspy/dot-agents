/**
 * Judge Gate — SystemOne judge invocation through Pi internals.
 *
 * No direct SDK dependency: models resolve via the extension model registry
 * (`findOfType('classifier', provider, id)`) and classify via
 * `registry.classify()`. Any provider/model pair speaking the SystemOne
 * protocol works — typesafe/jev, cloudflare/clef(-flash), openrouter
 * decide-models, or local llama-server through llama-cpp-classify.
 */

import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { redactSecrets } from "./floor.js";
import { SAFETY_QUESTION, SAFETY_QUESTION_ID } from "./questions.js";

export interface JudgeModelRef {
	readonly provider: string;
	readonly model: string;
}

export interface JudgeThresholdsInput {
	readonly t: number;
	readonly c: number;
}

export interface JudgeConfig extends JudgeModelRef {
	readonly t: number;
	readonly c: number;
	readonly timeoutMs: number;
	/** Per-model threshold profiles, keyed by `provider/model`. */
	readonly profiles?: Readonly<Record<string, JudgeThresholdsInput>>;
}

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
	provider: "typesafe",
	model: "jev-latest",
	t: 0.85,
	c: 0.7,
	timeoutMs: 4000,
	// Calibrated 2026-10-09 (see plans/judge-gate-design.md): clef-flash
	// hedges everything, so it runs prompt-first on relaxed thresholds.
	profiles: { "cloudflare/clef-flash": { t: 0.7, c: 0.4 } },
};

/** Max characters of tool value sent as judge state (backstop, not a target). */
export const MAX_STATE_CHARS = 8000;

export function modelKey(ref: JudgeModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

/** Effective thresholds: per-model profile wins, else the top-level t/c. */
export function resolveThresholds(config: JudgeConfig): JudgeThresholdsInput {
	return config.profiles?.[modelKey(config)] ?? { t: config.t, c: config.c };
}

export function truncateState(text: string, max: number = MAX_STATE_CHARS): string {
	return text.length > max ? text.slice(0, max) + "…[truncated]" : text;
}

/** Build the minimal judge state: the call, not the conversation. Never file contents. */
export function buildJudgeState(tool: string, value: string, cwd: string): ClassifierContext {
	return {
		state: {
			tool,
			value: truncateState(redactSecrets(value)),
			cwd,
		},
		questions: { [SAFETY_QUESTION_ID]: SAFETY_QUESTION },
	};
}

/** Minimal registry surface the judge needs (structurally satisfied by ctx.modelRegistry). */
export interface JudgeRegistry {
	findOfType(
		type: "classifier",
		provider: string,
		modelId: string,
	): ClassifierModel<ClassifierApi> | undefined;
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<ClassifierResult>;
}

export type JudgeOutcome =
	| {
			readonly status: "judged";
			readonly p: number;
			readonly confidence: number;
			readonly latencyMs: number;
			readonly model: string;
	  }
	| {
			readonly status: "unavailable";
			/** Stable reason id: unknown-model | aborted | error | malformed. */
			readonly reason: string;
			readonly detail: string;
			readonly latencyMs: number;
	  };

export async function runJudge(
	registry: JudgeRegistry,
	config: JudgeConfig,
	tool: string,
	value: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<JudgeOutcome> {
	const started = Date.now();
	const model = registry.findOfType("classifier", config.provider, config.model);
	if (!model) {
		return {
			status: "unavailable",
			reason: "unknown-model",
			detail: `Judge model not available: ${modelKey(config)}. Check provider auth.`,
			latencyMs: Date.now() - started,
		};
	}

	let result: ClassifierResult;
	try {
		result = await registry.classify(model, buildJudgeState(tool, value, cwd), {
			...(signal === undefined ? {} : { signal }),
			timeoutMs: config.timeoutMs,
		});
	} catch (error) {
		return {
			status: "unavailable",
			reason: "error",
			detail: `Judge request failed: ${error instanceof Error ? error.message : String(error)}`,
			latencyMs: Date.now() - started,
		};
	}
	const latencyMs = Date.now() - started;

	if (result.stopReason === "aborted") {
		return { status: "unavailable", reason: "aborted", detail: "Judge request aborted.", latencyMs };
	}
	if (result.stopReason !== "stop") {
		return {
			status: "unavailable",
			reason: "error",
			detail: `Judge error: ${result.errorMessage ?? "unknown"}`,
			latencyMs,
		};
	}
	const answer = result.answers[SAFETY_QUESTION_ID];
	if (!answer || answer.type !== "choice") {
		return {
			status: "unavailable",
			reason: "malformed",
			detail: "Judge response did not contain the expected safety answer.",
			latencyMs,
		};
	}
	const p = answer.probabilities["safe"];
	if (typeof p !== "number" || !Number.isFinite(p)) {
		return {
			status: "unavailable",
			reason: "malformed",
			detail: "Judge response had no usable safe probability.",
			latencyMs,
		};
	}
	return { status: "judged", p, confidence: answer.confidence, latencyMs, model: modelKey(config) };
}
