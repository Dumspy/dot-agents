import { describe, expect, it } from "vitest";
import { createLogRow, formatLogRow, parseLogRow, renderLogRow, withJudgment } from "./log.js";

describe("log rows", () => {
	it("round-trips through JSONL", () => {
		const row = withJudgment(createLogRow("bash", "rm -rf build", "/proj", "blocked", "p-block"), {
			p: 0.1,
			confidence: 0.9,
			t: 0.85,
			c: 0.7,
			model: "typesafe/jev-latest",
			latencyMs: 312,
		});
		const parsed = parseLogRow(formatLogRow(row));
		expect(parsed).toEqual(row);
	});

	it("rejects garbage lines", () => {
		expect(parseLogRow("not json")).toBeNull();
		expect(parseLogRow('{"tool":1}')).toBeNull();
	});

	it("renders compact human lines", () => {
		const row = withJudgment(createLogRow("bash", "ls", "/proj", "allowed", "p-allow"), {
			p: 0.97,
			confidence: 0.9,
			t: 0.85,
			c: 0.7,
			model: "typesafe/jev-latest",
			latencyMs: 200,
		});
		const line = renderLogRow(row);
		expect(line).toContain("allowed");
		expect(line).toContain("p=0.97");
		expect(line).toContain("typesafe/jev-latest");
	});
});
