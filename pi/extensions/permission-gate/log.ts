/**
 * Permission Gate — decision log rows (JSONL).
 *
 * This file is the calibration dataset: every threshold retune reads it. Each
 * row pins the model, both thresholds, every question's probability, and
 * whether the action was planned read-only, so history stays interpretable
 * without a schema migration.
 */

export type LogVerdict =
	| "free" // planner proved read-only; no review
	| "allowed" // reviewed, worst violation probability <= allowAt
	| "held" // reviewed, mid band; refused with guidance, no human prompt
	| "prompted" // human decided (onUncertain: ask, or reviewer unavailable)
	| "blocked" // reviewed, worst probability >= denyAt
	| "floor-blocked" // deterministic floor
	| "override"; // one-shot /allow approval

export interface GateLogRow {
	readonly ts: string;
	readonly tool: string;
	readonly value: string;
	readonly cwd: string;
	readonly verdict: LogVerdict;
	readonly reason: string;
	/** Planner refusal reason, or "read_only". */
	readonly plan?: string;
	/** Violation probability per question id. */
	readonly p?: Readonly<Record<string, number>>;
	readonly confidence?: number;
	readonly allowAt?: number;
	readonly denyAt?: number;
	readonly model?: string;
	readonly latencyMs?: number;
	/** True when user intent was attached to the review. */
	readonly contextual?: boolean;
	/** True when action evidence was truncated before review. */
	readonly evidenceIncomplete?: boolean;
}

export interface ReviewSummary {
	readonly p: Readonly<Record<string, number>>;
	readonly confidence: number;
	readonly allowAt: number;
	readonly denyAt: number;
	readonly model: string;
	readonly latencyMs: number;
	readonly contextual: boolean;
	readonly evidenceIncomplete: boolean;
}

export function createLogRow(
	tool: string,
	value: string,
	cwd: string,
	verdict: LogVerdict,
	reason: string,
	ts?: string,
): GateLogRow {
	return { ts: ts ?? new Date().toISOString(), tool, value, cwd, verdict, reason };
}

export function withReview(row: GateLogRow, review: ReviewSummary): GateLogRow {
	return { ...row, ...review };
}

export function withPlan(row: GateLogRow, plan: string): GateLogRow {
	return { ...row, plan };
}

export function formatLogRow(row: GateLogRow): string {
	return JSON.stringify(row) + "\n";
}

export function parseLogRow(line: string): GateLogRow | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (typeof record["tool"] !== "string" || typeof record["verdict"] !== "string") return null;
		return parsed as GateLogRow;
	} catch {
		return null;
	}
}

/** One-line human rendering for `/gate-log`. */
export function renderLogRow(row: GateLogRow): string {
	const parts = [`[${row.ts}]`, row.verdict.padEnd(13), row.tool.padEnd(9), truncate(row.value)];
	if (row.plan !== undefined && row.plan !== "read_only") parts.push(`plan=${row.plan}`);
	if (row.p !== undefined) {
		for (const [question, p] of Object.entries(row.p)) {
			parts.push(`${question.slice(0, 6)}=${p.toFixed(2)}`);
		}
	}
	if (row.model !== undefined) parts.push(row.model);
	return parts.join(" ");
}

function truncate(value: string, max: number = 72): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}
