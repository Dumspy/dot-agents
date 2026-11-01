/**
 * Permission Gate — offline replay statistics.
 *
 * The previous benchmark measured model choice (probability/confidence on 20
 * fixtures × 3 models), which answers the wrong question: it says nothing
 * about what the gate does with real traffic. This module replays the frozen
 * permission log through the *deterministic* half of the pipeline — planner
 * then floor — and reports how much of the old prompt volume now resolves
 * without any model at all.
 *
 * fx's eval harness is the model for the live half (`tests/evals/...`): named
 * scenarios with expected decisions against a fake gateway. The split is
 * deliberate: anything provable without a model is measured without one, so
 * the number is stable, free, and re-runnable on every commit.
 */

import { homedir } from "node:os";
import { readEnvironmentFacts } from "./environment.js";
import { checkFloor } from "./floor.js";
import { planCommand, type PlanOptions } from "./plan.js";

export type OldAction = "asked" | "free";

export interface ReplayRow {
	readonly toolName: string;
	readonly value: string;
	readonly cwd: string;
	readonly action: string;
}

export type ReplayOutcome =
	| { readonly kind: "free"; readonly via: "planner" | "tool" }
	| { readonly kind: "floor"; readonly reason: string }
	| { readonly kind: "review"; readonly reason: string };

/** Old permission actions that cost the user a prompt or a denial. */
export function classifyOldAction(action: string): OldAction {
	return action.startsWith("allowed") ? "free" : "asked";
}

/** Tools that never reach the reviewer once the floor passes. */
const FLOOR_ONLY_TOOLS = new Set(["write", "edit"]);

export function replayOutcome(row: ReplayRow, options: PlanOptions = { cwd: row.cwd }): ReplayOutcome {
	if (FLOOR_ONLY_TOOLS.has(row.toolName)) {
		const hit = checkFloor(row.toolName, row.value);
		return hit ? { kind: "floor", reason: hit.reason } : { kind: "free", via: "tool" };
	}

	if (row.toolName === "bash") {
		const plan = planCommand(row.value, options);
		if (plan.kind === "read_only") return { kind: "free", via: "planner" };
		const hit = checkFloor(row.toolName, row.value);
		if (hit) return { kind: "floor", reason: hit.reason };
		return { kind: "review", reason: plan.reason };
	}

	const hit = checkFloor(row.toolName, row.value);
	if (hit) return { kind: "floor", reason: hit.reason };
	return { kind: "review", reason: row.toolName };
}

export interface ReplayStats {
	readonly rows: number;
	readonly oldAsked: number;
	readonly oldFree: number;
	/** Old prompt/deny rows that now resolve deterministically. */
	readonly askedNowFree: number;
	/** Old prompt/deny rows that reach the reviewer (a model call, but no prompt). */
	readonly askedNowReview: number;
	readonly askedNowFloor: number;
	/** Old auto-allowed rows that would now need the reviewer. */
	readonly freeNowReview: number;
	readonly freeNowFloor: number;
	readonly reviewByReason: Readonly<Record<string, number>>;
	readonly reviewTop: ReadonlyArray<{ readonly command: string; readonly reason: string }>;
}

function firstWord(value: string): string {
	const trimmed = value.trim().replace(/^\S*\/\s*/, "");
	const match = trimmed.match(/^[A-Za-z0-9_.-]+/);
	return match ? match[0]! : trimmed.slice(0, 20);
}

/** Deduplicate on (tool, value): the log repeats the same commands a lot. */
export function uniqueRows(rows: readonly ReplayRow[]): ReplayRow[] {
	const seen = new Set<string>();
	const out: ReplayRow[] = [];
	for (const row of rows) {
		const key = `${row.toolName}\u0000${row.value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(row);
	}
	return out;
}

export function replayStats(rows: readonly ReplayRow[]): ReplayStats {
	let oldAsked = 0;
	let oldFree = 0;
	let askedNowFree = 0;
	let askedNowReview = 0;
	let askedNowFloor = 0;
	let freeNowReview = 0;
	let freeNowFloor = 0;
	const reviewByReason: Record<string, number> = {};
	const reviewTop: Array<{ command: string; reason: string }> = [];

	// Path bounds need the repository root; read it once per working directory.
	const scopes = new Map<string, PlanOptions>();
	const scopeFor = (cwd: string): PlanOptions => {
		const cached = scopes.get(cwd);
		if (cached) return cached;
		const scope: PlanOptions = { cwd, repoRoot: readEnvironmentFacts(cwd).repoRoot };
		scopes.set(cwd, scope);
		return scope;
	};

	for (const row of rows) {
		const old = classifyOldAction(row.action);
		if (old === "asked") oldAsked += 1;
		else oldFree += 1;

		const outcome = replayOutcome(row, scopeFor(row.cwd));
		if (old === "asked") {
			if (outcome.kind === "free") askedNowFree += 1;
			else if (outcome.kind === "floor") askedNowFloor += 1;
			else {
				askedNowReview += 1;
				reviewByReason[outcome.reason] = (reviewByReason[outcome.reason] ?? 0) + 1;
				if (reviewTop.length < 25) reviewTop.push({ command: firstWord(row.value), reason: outcome.reason });
			}
		} else if (outcome.kind === "review") {
			freeNowReview += 1;
		} else if (outcome.kind === "floor") {
			freeNowFloor += 1;
		}
	}

	return {
		rows: rows.length,
		oldAsked,
		oldFree,
		askedNowFree,
		askedNowReview,
		askedNowFloor,
		freeNowReview,
		freeNowFloor,
		reviewByReason,
		reviewTop,
	};
}

const pct = (part: number, whole: number): string => (whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`);

export function renderReplayReport(stats: ReplayStats, source: string): string {
	const lines: string[] = [];
	lines.push(`# Gate replay report`);
	lines.push("");
	lines.push(`Source: \`${source.replace(homedir(), "~")}\` — ${stats.rows} rows.`);
	lines.push("");
	lines.push(`Old system: ${stats.oldAsked} rows cost a prompt or a denial, ${stats.oldFree} ran free.`);
	lines.push("");
	lines.push(`| old prompt/deny rows (${stats.oldAsked}) | count | share |`);
	lines.push(`|---|---|---|`);
	lines.push(`| now deterministic (planner or floor-only tool) | ${stats.askedNowFree} | ${pct(stats.askedNowFree, stats.oldAsked)} |`);
	lines.push(`| now floor-blocked | ${stats.askedNowFloor} | ${pct(stats.askedNowFloor, stats.oldAsked)} |`);
	lines.push(`| now one reviewer call (no prompt) | ${stats.askedNowReview} | ${pct(stats.askedNowReview, stats.oldAsked)} |`);
	lines.push("");
	lines.push(`Old free rows (${stats.oldFree}): ${stats.freeNowReview} now need the reviewer, ${stats.freeNowFloor} now hit the floor.`);
	lines.push("");
	lines.push(`## Reviewer reasons (old prompt/deny rows)`);
	lines.push("");
	const reasons = Object.entries(stats.reviewByReason).sort((a, b) => b[1] - a[1]);
	if (reasons.length === 0) lines.push(`_none_`);
	for (const [reason, count] of reasons) lines.push(`- \`${reason}\`: ${count}`);
	lines.push("");
	lines.push(`## Sample of remaining reviewer volume`);
	lines.push("");
	for (const item of stats.reviewTop.slice(0, 20)) lines.push(`- \`${item.command}\` (${item.reason})`);
	return lines.join("\n") + "\n";
}
