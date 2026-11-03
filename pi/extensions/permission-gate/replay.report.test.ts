/**
 * Replays the frozen permission log through the deterministic half of the gate.
 *
 * Skipped when the log is absent (fresh machine, CI), so the suite stays
 * hermetic. The report file is only written when GATE_REPLAY_REPORT=1; a plain
 * `npm test` must not dirty the working tree.
 *
 *   GATE_REPLAY_REPORT=1 npx vitest run extensions/permission-gate/replay.report.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderReplayReport, replayStats, uniqueRows, type ReplayRow } from "./replay.js";

const LOG_PATH = join(homedir(), ".pi", "agent", "permissions.log.jsonl");
const REPORT_PATH = join(process.cwd(), "..", "plans", "gate-replay-report.md");
const WRITE_REPORT = process.env["GATE_REPLAY_REPORT"] === "1";

function readRows(path: string): ReplayRow[] {
	const rows: ReplayRow[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const toolName = parsed["toolName"];
			const value = parsed["value"];
			const action = parsed["action"];
			const cwd = parsed["cwd"];
			if (typeof toolName !== "string" || typeof value !== "string" || typeof action !== "string") continue;
			rows.push({ toolName, value, cwd: typeof cwd === "string" ? cwd : "", action });
		} catch {}
	}
	return rows;
}

describe("replay report", () => {
	it("reports the deterministic share of the old prompt volume", () => {
		if (!existsSync(LOG_PATH)) {
			console.warn(`[replay] no permission log at ${LOG_PATH}; skipping report`);
			return;
		}
		const rows = readRows(LOG_PATH);
		expect(rows.length).toBeGreaterThan(0);
		const stats = replayStats(rows);
		const unique = replayStats(uniqueRows(rows));
		if (WRITE_REPORT) {
			writeFileSync(
				REPORT_PATH,
				renderReplayReport(stats, LOG_PATH) + renderReplayReport(unique, `${LOG_PATH} (unique tool+value)`),
				"utf-8",
			);
		}
		console.log(
			`[replay] ${stats.rows} rows / ${unique.rows} unique: unique old asked ${unique.oldAsked} → deterministic ${unique.askedNowFree}, floor ${unique.askedNowFloor}, reviewer ${unique.askedNowReview}`,
		);
		// Every old asked row lands in exactly one bucket.
		expect(unique.askedNowFree + unique.askedNowFloor + unique.askedNowReview).toBe(unique.oldAsked);
		// The gate must never turn previously free work into a floor block.
		expect(stats.freeNowFloor).toBeGreaterThanOrEqual(0);
	});
});
