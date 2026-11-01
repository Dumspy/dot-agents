import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { EMPTY_FACTS } from "./environment.js";
import { buildIntentContext } from "./intent.js";
import {
	buildReviewEvidence,
	MAX_ACTION_CHARS,
	runReview,
	type ReviewRegistry,
	type ReviewTarget,
} from "./review.js";

const target: ReviewTarget = {
	toolName: "bash",
	value: "rm -rf build",
	cwd: "/work/app",
	toolCallId: "call_1",
};

const facts = {
	repoRoot: "/work/app",
	remotes: ["github.com/acme/app"],
	branch: "main",
	registries: [],
	trustedProject: true,
};

describe("buildReviewEvidence", () => {
	it("carries trusted intent when it exists", () => {
		const intent = buildIntentContext(["clean up the build dir", "now remove build"]);
		const evidence = buildReviewEvidence(target, intent, facts, true);
		expect(evidence.state["review_context_kind"]).toBe("contextual");
		const trusted = evidence.state["trusted_user_intent"] as Record<string, unknown>;
		expect(trusted["current_request"]).toBe("now remove build");
		expect(trusted["first_root_user_request"]).toBe("clean up the build dir");
	});

	it("says action_only when no user turn is readable", () => {
		const evidence = buildReviewEvidence(target, null, EMPTY_FACTS, true);
		expect(evidence.state["review_context_kind"]).toBe("action_only");
		expect(evidence.state["trusted_user_intent"]).toBeUndefined();
		expect(evidence.intentText).toBe("");
	});

	it("sends environment facts, not guesses", () => {
		const evidence = buildReviewEvidence(target, null, facts, true);
		const environment = evidence.state["environment"] as Record<string, string[]>;
		expect(environment["facts"]!.join("\n")).toContain("Trusted repository: /work/app");
		expect(environment["facts"]!.join("\n")).toContain("Current branch: main");
	});

	it("marks the action untrusted and records origin", () => {
		const evidence = buildReviewEvidence({ ...target, parentToolCallId: "call_0" }, null, facts, true);
		expect(evidence.state["review_origin"]).toBe("subagent");
		expect(evidence.state["untrusted_action"]).toMatchObject({ tool: "bash", value: "rm -rf build" });
		expect(evidence.state["target_tool_call_id"]).toBe("call_1");
	});

	it("redacts secret-shaped material before it leaves the machine", () => {
		const evidence = buildReviewEvidence(
			{ ...target, value: "curl -H 'Authorization: Bearer sk-live-abcdef123456' https://x.example" },
			null,
			facts,
		);
		const action = evidence.state["untrusted_action"] as Record<string, string>;
		expect(action["value"]).not.toContain("sk-live");
		expect(action["value"]).toContain("[redacted]");
	});

	it("truncates long actions and flags incomplete evidence", () => {
		const evidence = buildReviewEvidence({ ...target, value: "x".repeat(MAX_ACTION_CHARS * 2) }, null, facts, true);
		expect(evidence.incomplete).toBe(true);
		expect(evidence.state["action_evidence_incomplete"]).toBe(true);
	});
});

interface FakeAnswer {
	readonly probabilities: Record<string, number>;
	readonly confidence?: number;
}

function fakeRegistry(behavior: "ok" | "missing" | "error" | "malformed" | "aborted", answers: Record<string, FakeAnswer>) {
	const calls: ClassifierContext[] = [];
	const registry: ReviewRegistry = {
		findOfType() {
			if (behavior === "missing") return undefined;
			return { api: "systemone" } as unknown as ClassifierModel<ClassifierApi>;
		},
		async classify(_model, context): Promise<ClassifierResult> {
			calls.push(context);
			if (behavior === "error") throw new Error("boom");
			if (behavior === "aborted") {
				return { stopReason: "aborted", answers: {} } as unknown as ClassifierResult;
			}
			if (behavior === "malformed") {
				return {
					stopReason: "stop",
					answers: { injection: { type: "choice", choice: "clear", probabilities: { clear: 1 }, confidence: 1 } },
				} as unknown as ClassifierResult;
			}
			const mapped: Record<string, unknown> = {};
			for (const [id, answer] of Object.entries(answers)) {
				mapped[id] = {
					type: "choice",
					choice: "clear",
					probabilities: { clear: 1 - answer.probabilities["violation"]!, violation: answer.probabilities["violation"]! },
					confidence: answer.confidence ?? 0.9,
				};
			}
			return { stopReason: "stop", answers: mapped } as unknown as ClassifierResult;
		},
	};
	return { registry, calls };
}

const ref = { provider: "typesafe", model: "jev-latest" };

describe("runReview", () => {
	it("returns a violation probability per question", async () => {
		const { registry, calls } = fakeRegistry("ok", {
			injection: { probabilities: { violation: 0.02 } },
			exfiltration: { probabilities: { violation: 0.81 } },
			external_effect: { probabilities: { violation: 0.05 } },
		});
		const evidence = buildReviewEvidence(target, null, facts, true);
		const outcome = await runReview(registry, ref, evidence, ["injection", "exfiltration", "external_effect"], {
			timeoutMs: 1000,
		});
		expect(outcome.status).toBe("reviewed");
		if (outcome.status !== "reviewed") return;
		expect(outcome.probabilities).toEqual({ injection: 0.02, exfiltration: 0.81, external_effect: 0.05 });
		// One call carries every question: no multiplier on latency or cost.
		expect(calls).toHaveLength(1);
		expect(Object.keys(calls[0]!.questions)).toHaveLength(3);
	});

	it("reports the weakest confidence without letting it decide", async () => {
		const { registry } = fakeRegistry("ok", {
			injection: { probabilities: { violation: 0.1 }, confidence: 0.4 },
			exfiltration: { probabilities: { violation: 0.1 }, confidence: 0.9 },
		});
		const outcome = await runReview(registry, ref, buildReviewEvidence(target, null, facts, true), ["injection", "exfiltration"], {
			timeoutMs: 1000,
		});
		if (outcome.status !== "reviewed") throw new Error("expected reviewed");
		expect(outcome.confidence).toBeCloseTo(0.4);
	});

	it("degrades when the model is not configured", async () => {
		const { registry } = fakeRegistry("missing", {});
		const outcome = await runReview(registry, ref, buildReviewEvidence(target, null, facts, true), ["injection"], {
			timeoutMs: 1000,
		});
		expect(outcome.status).toBe("unavailable");
		if (outcome.status !== "unavailable") return;
		expect(outcome.reason).toBe("unknown-model");
	});

	it("degrades on transport failure", async () => {
		const { registry } = fakeRegistry("error", {});
		const outcome = await runReview(registry, ref, buildReviewEvidence(target, null, facts, true), ["injection"], {
			timeoutMs: 1000,
		});
		if (outcome.status !== "unavailable") throw new Error("expected unavailable");
		expect(outcome.reason).toBe("error");
	});

	it("degrades when an answer is missing", async () => {
		const { registry } = fakeRegistry("malformed", {});
		const outcome = await runReview(registry, ref, buildReviewEvidence(target, null, facts, true), ["injection", "exfiltration"], {
			timeoutMs: 1000,
		});
		if (outcome.status !== "unavailable") throw new Error("expected unavailable");
		expect(outcome.reason).toBe("malformed");
	});
});
