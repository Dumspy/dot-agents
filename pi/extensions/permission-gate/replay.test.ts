import { describe, expect, it } from "vitest";
import { classifyOldAction, renderReplayReport, replayOutcome, replayStats, type ReplayRow } from "./replay.js";

const row = (toolName: string, value: string, action = "prompt-approved"): ReplayRow => ({
	toolName,
	value,
	cwd: "/work/app",
	action,
});

describe("classifyOldAction", () => {
	it("treats any allowed variant as free", () => {
		expect(classifyOldAction("allowed")).toBe("free");
		expect(classifyOldAction("allowed-session-cache")).toBe("free");
		expect(classifyOldAction("prompt-approved-session")).toBe("asked");
		expect(classifyOldAction("prompt-denied")).toBe("asked");
		expect(classifyOldAction("blocked")).toBe("asked");
		expect(classifyOldAction("cloaked")).toBe("asked");
	});
});

describe("replayOutcome", () => {
	it("frees proven read-only shell work without a model", () => {
		expect(replayOutcome(row("bash", "git status"))).toEqual({ kind: "free", via: "planner" });
		expect(replayOutcome(row("bash", "rg -n TODO"))).toEqual({ kind: "free", via: "planner" });
		expect(replayOutcome(row("bash", "ls -la src | grep -n test"))).toEqual({ kind: "free", via: "planner" });
	});

	it("sends unplanned shell work to review", () => {
		expect(replayOutcome(row("bash", "npm test"))).toEqual({ kind: "review", reason: "unknown_command" });
		expect(replayOutcome(row("bash", "git commit -m x"))).toEqual({ kind: "review", reason: "command_owned_input" });
	});

	it("keeps the floor in front of the reviewer", () => {
		const outcome = replayOutcome(row("bash", "sudo du -sh /"));
		expect(outcome.kind).toBe("floor");
	});

	it("never reviews writes or edits that pass the floor", () => {
		expect(replayOutcome(row("write", "/work/app/src/a.ts"))).toEqual({ kind: "free", via: "tool" });
		expect(replayOutcome(row("edit", "/work/app/src/a.ts"))).toEqual({ kind: "free", via: "tool" });
		expect(replayOutcome(row("write", "/work/app/.env")).kind).toBe("floor");
	});
});

describe("replayStats", () => {
	it("counts the nag reduction against the old action column", () => {
		const stats = replayStats([
			row("bash", "git status", "prompt-approved"),
			row("bash", "npm install", "prompt-approved"),
			row("bash", "sudo du", "blocked"),
			row("bash", "ls", "allowed"),
		]);
		expect(stats.rows).toBe(4);
		expect(stats.oldAsked).toBe(3);
		expect(stats.oldFree).toBe(1);
		expect(stats.askedNowFree).toBe(1);
		expect(stats.askedNowReview).toBe(1);
		expect(stats.askedNowFloor).toBe(1);
		expect(stats.freeNowReview).toBe(0);
	});

	it("renders a report with every section", () => {
		const report = renderReplayReport(
			replayStats([row("bash", "npm install"), row("bash", "git status", "allowed")]),
			"/tmp/log.jsonl",
		);
		expect(report).toContain("# Gate replay report");
		expect(report).toContain("now deterministic");
		expect(report).toContain("Reviewer reasons");
	});
});
