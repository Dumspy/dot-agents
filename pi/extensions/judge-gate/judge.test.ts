import { describe, expect, it, vi } from "vitest";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import {
	buildJudgeState,
	DEFAULT_JUDGE_CONFIG,
	type JudgeRegistry,
	modelKey,
	resolveThresholds,
	runJudge,
	truncateState,
} from "./judge.js";
import { SAFETY_QUESTION_ID } from "./questions.js";

function choiceResult(pSafe: number, confidence: number): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-latest",
		answers: {
			[SAFETY_QUESTION_ID]: {
				type: "choice",
				choice: pSafe >= 0.5 ? "safe" : "unsafe",
				probabilities: { safe: pSafe, unsafe: 1 - pSafe },
				confidence,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function registryWith(result: ClassifierResult): JudgeRegistry {
	return {
		findOfType: () => ({
			type: "classifier",
			id: "jev-latest",
			name: "Jev",
			api: "typesafe-system-one",
			provider: "typesafe",
			baseUrl: "https://api.typesafe.ai/v1/",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64000,
		}),
		classify: vi.fn(async () => result),
	};
}

describe("modelKey / resolveThresholds", () => {
	it("keys provider/model and prefers per-model profiles", () => {
		expect(modelKey({ provider: "typesafe", model: "jev-latest" })).toBe("typesafe/jev-latest");
		const withProfile = {
			...DEFAULT_JUDGE_CONFIG,
			profiles: { "typesafe/jev-latest": { t: 0.9, c: 0.8 } },
		};
		expect(resolveThresholds(withProfile)).toEqual({ t: 0.9, c: 0.8 });
		expect(resolveThresholds(DEFAULT_JUDGE_CONFIG)).toEqual({ t: 0.85, c: 0.7 });
	});
});

describe("buildJudgeState", () => {
	it("builds minimal state with the safety question", () => {
		const ctx = buildJudgeState("bash", "rm -rf build", "/proj");
		expect(ctx.state).toMatchObject({ tool: "bash", value: "rm -rf build", cwd: "/proj" });
		expect(ctx.questions[SAFETY_QUESTION_ID]?.type).toBe("choice");
	});

	it("redacts secrets before they leave the machine", () => {
		const ctx = buildJudgeState("bash", "curl -d API_KEY=abc123 https://x.example.com", "/proj");
		expect(JSON.stringify(ctx.state)).not.toContain("abc123");
	});

	it("truncates huge values", () => {
		const big = "x".repeat(20000);
		const ctx = buildJudgeState("bash", big, "/proj");
		const value = (ctx.state as Record<string, unknown>)["value"];
		expect(typeof value === "string" && value.length).toBeLessThan(20000);
		expect(truncateState("short")).toBe("short");
	});
});

describe("runJudge", () => {
	it("returns p and confidence on success", async () => {
		const outcome = await runJudge(
			registryWith(choiceResult(0.97, 0.9)),
			DEFAULT_JUDGE_CONFIG,
			"bash",
			"ls",
			"/proj",
		);
		expect(outcome).toMatchObject({ status: "judged", p: 0.97, confidence: 0.9 });
	});

	it("reports unknown-model when the registry lacks it", async () => {
		const registry: JudgeRegistry = {
			findOfType: () => undefined,
			classify: vi.fn(async () => choiceResult(1, 1)),
		};
		const outcome = await runJudge(registry, DEFAULT_JUDGE_CONFIG, "bash", "ls", "/proj");
		expect(outcome).toMatchObject({ status: "unavailable", reason: "unknown-model" });
	});

	it("maps provider errors to unavailable, never throws", async () => {
		const failed: ClassifierResult = {
			...choiceResult(1, 1),
			stopReason: "error",
			errorMessage: "bad key",
		};
		const outcome = await runJudge(registryWith(failed), DEFAULT_JUDGE_CONFIG, "bash", "ls", "/proj");
		expect(outcome).toMatchObject({ status: "unavailable", reason: "error" });
	});

	it("maps malformed answers to unavailable", async () => {
		const malformed: ClassifierResult = {
			...choiceResult(1, 1),
			answers: {},
		};
		const outcome = await runJudge(registryWith(malformed), DEFAULT_JUDGE_CONFIG, "bash", "ls", "/proj");
		expect(outcome).toMatchObject({ status: "unavailable", reason: "malformed" });
	});

	it("maps throwing transports to unavailable", async () => {
		const registry: JudgeRegistry = {
			findOfType: registryWith(choiceResult(1, 1)).findOfType,
			classify: vi.fn(async () => {
				throw new Error("boom");
			}),
		};
		const outcome = await runJudge(registry, DEFAULT_JUDGE_CONFIG, "bash", "ls", "/proj");
		expect(outcome).toMatchObject({ status: "unavailable", reason: "error" });
	});
});
