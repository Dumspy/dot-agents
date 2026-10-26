/**
 * Judge Gate — decision log rows (JSONL).
 *
 * This file is the future calibration dataset: every retune of t/c reads it.
 * Rows are complete at write time (thresholds + model pinned per row) so no
 * migration is ever needed to interpret history.
 */

export type LogVerdict = "allowed" | "blocked" | "prompted" | "floor-blocked" | "override";

export interface JudgeLogRow {
	readonly ts: string;
	readonly tool: string;
	readonly value: string;
	readonly cwd: string;
	readonly verdict: LogVerdict;
	readonly reason: string;
	readonly p?: number;
	readonly confidence?: number;
	readonly t?: number;
	readonly c?: number;
	readonly model?: string;
	readonly latencyMs?: number;
}

export function createLogRow(
	tool: string,
	value: string,
	cwd: string,
	verdict: LogVerdict,
	reason: string,
	ts?: string,
): JudgeLogRow {
	return {
		ts: ts ?? new Date().toISOString(),
		tool,
		value,
		cwd,
		verdict,
		reason,
	};
}

export function withJudgment(
	row: JudgeLogRow,
	judgment: {
		p: number;
		confidence: number;
		t: number;
		c: number;
		model: string;
		latencyMs: number;
	},
): JudgeLogRow {
	return { ...row, ...judgment };
}

export function formatLogRow(row: JudgeLogRow): string {
	return JSON.stringify(row) + "\n";
}

export function parseLogRow(line: string): JudgeLogRow | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (typeof record["tool"] !== "string" || typeof record["verdict"] !== "string") return null;
		return parsed as JudgeLogRow;
	} catch {
		return null;
	}
}

/** One-line human rendering for /judge-log. */
export function renderLogRow(row: JudgeLogRow): string {
	const parts = [`[${row.ts}]`, row.verdict.padEnd(12), row.tool.padEnd(10), truncate(row.value)];
	if (row.p !== undefined) {
		parts.push(`p=${row.p.toFixed(2)}`);
	}
	if (row.confidence !== undefined) {
		parts.push(`conf=${row.confidence.toFixed(2)}`);
	}
	if (row.model !== undefined) {
		parts.push(row.model);
	}
	return parts.join(" ");
}

function truncate(value: string, max: number = 80): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}
