/**
 * Permission Gate for Pi.
 *
 * The shape both shipped prior arts converged on (OpenRouter Armor, Claude Code
 * auto mode, Vercel fx):
 *
 *   planner (deterministic, read-only)  → free
 *   floor   (deterministic, final)      → block
 *   reviewer (narrow questions)         → allow / hold / block
 *
 * The planner proves routine read-only shell work, so it never pays for a model
 * call. The floor owns crisp-bad shapes and paths. The reviewer only sees what
 * neither could decide, and it is asked three separate narrow questions
 * (injection, exfiltration, external effect) instead of one bundled safety
 * question, with the user's own words and the recorded environment attached.
 *
 * Config: ~/.pi/agent/gate.json
 * {
 *   "provider": "typesafe", "model": "jev-latest",
 *   "allowAt": 0.25, "denyAt": 0.6, "timeoutMs": 4000,
 *   "onUncertain": "hold",
 *   "profiles": { "cloudflare-workers-ai/@cf/cloudflare/clef-flash": { "allowAt": 0.2, "denyAt": 0.5 } }
 * }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BlockBuffer, describeBlocked, PendingApproval, type BlockedCall } from "./approvals.js";
import { decideReview, describeDecision, DEFAULT_THRESHOLDS, parseThresholds, type Thresholds } from "./decide.js";
import { clearEnvironmentCache, readEnvironmentFacts } from "./environment.js";
import { checkFloor, pathNeedsReview, type FloorHit } from "./floor.js";
import { buildIntentContext, userMessageText, type IntentContext } from "./intent.js";
import {
	createLogRow,
	formatLogRow,
	parseLogRow,
	renderLogRow,
	type GateLogRow,
	type LogVerdict,
	type ReviewSummary,
} from "./log.js";
import { planCommand } from "./plan.js";
import { POLICY_VERSION, questionsForTool } from "./policy.js";
import { buildReviewEvidence, modelKey, runReview, type ReviewOutcome } from "./review.js";

export interface GateConfig {
	readonly provider: string;
	readonly model: string;
	readonly allowAt: number;
	readonly denyAt: number;
	readonly timeoutMs: number;
	/** What to do with a mid-band review: refuse with guidance, or ask the human. */
	readonly onUncertain: "hold" | "ask";
	readonly profiles?: Readonly<Record<string, unknown>>;
}

export const DEFAULT_CONFIG: GateConfig = {
	provider: "typesafe",
	model: "jev-latest",
	...DEFAULT_THRESHOLDS,
	timeoutMs: 4000,
	onUncertain: "hold",
};

type Blocked = { readonly block: true; readonly reason: string };

function getAgentDir(): string {
	const home = process.env["HOME"] || process.env["USERPROFILE"] || "/tmp";
	return join(home, ".pi", "agent");
}

const str = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

function loadConfig(): GateConfig {
	const path = join(getAgentDir(), "gate.json");
	if (!existsSync(path)) return DEFAULT_CONFIG;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return DEFAULT_CONFIG;
		const record = parsed as Record<string, unknown>;
		const onUncertain = record["onUncertain"] === "ask" ? "ask" : "hold";
		const profiles = typeof record["profiles"] === "object" && record["profiles"] !== null ? record["profiles"] : undefined;
		return {
			provider: str(record["provider"], DEFAULT_CONFIG.provider),
			model: str(record["model"], DEFAULT_CONFIG.model),
			timeoutMs: typeof record["timeoutMs"] === "number" ? record["timeoutMs"] : DEFAULT_CONFIG.timeoutMs,
			onUncertain,
			...(profiles === undefined ? {} : { profiles: profiles as Record<string, unknown> }),
			...parseThresholds(record, DEFAULT_THRESHOLDS),
		};
	} catch (error) {
		console.error(`[permission-gate] Warning: could not parse ${path}: ${error}`);
		return DEFAULT_CONFIG;
	}
}

/** Effective thresholds: a valid per-model profile wins, else the top-level pair. */
export function resolveThresholds(config: GateConfig): Thresholds {
	return parseThresholds(config.profiles?.[modelKey(config)], {
		allowAt: config.allowAt,
		denyAt: config.denyAt,
	});
}

export interface ToolCall {
	/** Primary value as the model wrote it: command text, path, or URL. */
	readonly value: string;
	/** Same value with file paths resolved, for floor and planner checks. */
	readonly resolved: string;
	readonly description: string;
}

/** One switch instead of three parallel ones over the same tool names. */
export function describeToolCall(toolName: string, input: Record<string, unknown>, cwd: string): ToolCall {
	const path = String(input["path"] ?? "");
	const command = String(input["command"] ?? "");
	const url = String(input["url"] ?? "");
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return { value: path, resolved: path ? resolve(cwd, path) : path, description: `${toolName} \`${path}\`` };
		case "bash":
			return { value: command, resolved: command, description: `run \`${command}\`` };
		case "webfetch":
			return { value: url, resolved: url, description: `fetch \`${url}\`` };
		default:
			return {
				value: String(input["query"] ?? JSON.stringify(input)),
				resolved: String(input["query"] ?? JSON.stringify(input)),
				description: `call ${toolName}`,
			};
	}
}

function hardStop(): string {
	return "This denial is policy-enforced. Do not retry or investigate bypasses; report the block to the user.";
}

/** .env output redaction (survives from the old cloak masks as pure redaction, not a gate). */
function maskEnvContent(text: string): string {
	return text.replace(/(=).+/g, "$1");
}

function isEnvPath(path: string): boolean {
	return /(^|\/)\.env[^/]*$/.test(path);
}

interface SessionLike {
	sessionManager: {
		buildSessionProjection?: () => { messages: readonly unknown[] };
		getEntries?: () => readonly unknown[];
	};
}

function userTurnsFrom(messages: readonly unknown[]): string[] {
	const turns: string[] = [];
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const record = message as Record<string, unknown>;
		if (record["role"] !== "user") continue;
		const text = userMessageText(record["content"]);
		if (text.trim().length > 0) turns.push(text);
	}
	return turns;
}

/** Trusted user turns, oldest first, from the session projection or its entries. */
export function readUserTurns(ctx: SessionLike): string[] {
	const entriesOf = (): readonly unknown[] => {
		try {
			return ctx.sessionManager.getEntries?.() ?? [];
		} catch {
			return [];
		}
	};
	try {
		const projection = ctx.sessionManager.buildSessionProjection?.();
		const turns = projection ? userTurnsFrom(projection.messages) : [];
		if (turns.length > 0) return turns;
	} catch {}
	return userTurnsFrom(
		entriesOf().flatMap((entry) => {
			if (typeof entry !== "object" || entry === null) return [];
			const record = entry as Record<string, unknown>;
			return record["type"] === "message" && typeof record["message"] === "object" ? [record["message"]] : [];
		}),
	);
}

export function readIntent(ctx: SessionLike): IntentContext | null {
	const turns = readUserTurns(ctx);
	if (turns.length === 0) return null;
	// Compaction hides earlier turns; the earliest survivor is not the first
	// thing the user asked, and the reviewer must be told that.
	let historyComplete = true;
	try {
		historyComplete = !(ctx.sessionManager.getEntries?.() ?? []).some(
			(entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["type"] === "compaction",
		);
	} catch {}
	return buildIntentContext(turns, { historyComplete });
}

export default function permissionGate(pi: ExtensionAPI) {
	let config = DEFAULT_CONFIG;
	const blocks = new BlockBuffer();
	const pending = new PendingApproval();

	const log = (
		tool: string,
		call: ToolCall,
		cwd: string,
		verdict: LogVerdict,
		reason: string,
		extra?: (row: GateLogRow) => GateLogRow,
	): void => {
		let row = createLogRow(tool, call.value, cwd, verdict, reason);
		if (extra) row = extra(row);
		try {
			const logPath = join(getAgentDir(), "gate.log.jsonl");
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, formatLogRow(row));
		} catch {}
	};

	const pushBlock = (
		tool: string,
		call: ToolCall,
		cwd: string,
		kind: BlockedCall["kind"],
		reason: string,
		detail: string,
	): void => {
		blocks.push({ tool, description: call.description, value: call.value, cwd, kind, reason, detail, ts: new Date().toISOString() });
	};

	const emitBlocked = (active: boolean, label?: string): void => {
		try {
			pi.events.emit("herdr:blocked", active ? { active: true, label } : { active: false });
		} catch {}
	};

	/** One prompt flow for every human decision; the caller decides the verdict. */
	async function askHuman(
		ctx: ExtensionContext,
		title: string,
		call: ToolCall,
		body?: string,
	): Promise<boolean> {
		emitBlocked(true, `${title}: ${call.description}`);
		try {
			const choice = await ctx.ui.select(
				`${title}\n\n${body === undefined ? "" : `${body}\n\n`}The agent wants to ${call.description}\n\nAllow this action?`,
				["Yes", "No"],
			);
			return choice === "Yes";
		} finally {
			emitBlocked(false);
		}
	}

	pi.on("session_start", () => {
		config = loadConfig();
		blocks.clear();
		pending.clear();
		clearEnvironmentCache();
	});

	pi.on("tool_call", async (event, ctx): Promise<Blocked | undefined> => {
		const call = describeToolCall(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		const toolName = event.toolName;

		// 1. One-shot /allow approval (the only override path, floor included).
		if (pending.consume(toolName, call.resolved)) {
			log(toolName, call, ctx.cwd, "override", "pending-approval-consumed");
			return undefined;
		}

		// 2. Deterministic hard floor — final.
		const hit: FloorHit | null = checkFloor(toolName, call.resolved);
		if (hit) {
			pushBlock(toolName, call, ctx.cwd, "floor", hit.reason, hit.detail);
			log(toolName, call, ctx.cwd, "floor-blocked", hit.reason);
			return { block: true, reason: `${hit.detail} Use /allow to approve this specific call. ${hardStop()}` };
		}

		// 3. Writes/edits inside the workspace are floor-checked only: highest
		// volume, lowest regret. Outside it they are how persistence gets
		// installed (`~/.zshrc`, cron, another repo), so they get reviewed.
		// Reads likewise only when the target is worth a second opinion.
		if (toolName === "write" || toolName === "edit" || toolName === "read") {
			if (!pathNeedsReview(call.resolved, ctx.cwd)) return undefined;
		}

		// 4. Planner: proven read-only shell work needs no model at all.
		let planReason = "not_applicable";
		let planDetail: string | undefined;
		if (toolName === "bash") {
			const plan = planCommand(call.value, { cwd: ctx.cwd, repoRoot: readEnvironmentFacts(ctx.cwd).repoRoot });
			if (plan.kind === "read_only") {
				log(toolName, call, ctx.cwd, "free", "read_only", (row) => ({ ...row, plan: "read_only" }));
				return undefined;
			}
			planReason = plan.reason;
			planDetail = `not proven read-only: ${plan.reason}`;
		}

		// 5. Review: narrow questions, trusted intent, environment facts.
		const thresholds = resolveThresholds(config);
		const evidence = buildReviewEvidence(
			{
				toolName,
				value: call.resolved,
				cwd: ctx.cwd,
				...(planDetail === undefined ? {} : { detail: planDetail }),
				...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
			},
			readIntent(ctx),
			readEnvironmentFacts(ctx.cwd),
			ctx.isProjectTrusted?.() ?? true,
		);
		const review: ReviewOutcome = await runReview(ctx.modelRegistry, config, evidence, questionsForTool(toolName), {
			signal: ctx.signal,
			timeoutMs: config.timeoutMs,
		});
		const planMeta = (row: GateLogRow): GateLogRow => ({ ...row, plan: planReason });

		if (review.status === "unavailable") {
			if (review.reason === "aborted") return { block: true, reason: "Aborted." };
			pushBlock(toolName, call, ctx.cwd, "review", review.reason, review.detail);
			const detail = `Reviewer unavailable (${review.detail}).`;
			if (ctx.hasUI && (await askHuman(ctx, "Reviewer unavailable", call, review.detail))) {
				log(toolName, call, ctx.cwd, "allowed", `review-unavailable-approved: ${review.reason}`, planMeta);
				return undefined;
			}
			log(toolName, call, ctx.cwd, ctx.hasUI ? "prompted" : "blocked", `review-unavailable: ${review.reason}`, planMeta);
			return { block: true, reason: `${detail} ${ctx.hasUI ? "" : "No UI to confirm. "}${hardStop()}` };
		}

		const decision = decideReview(review.probabilities, thresholds);
		const summary: ReviewSummary = {
			p: review.probabilities,
			confidence: review.confidence,
			allowAt: thresholds.allowAt,
			denyAt: thresholds.denyAt,
			model: review.model,
			latencyMs: review.latencyMs,
			contextual: evidence.intentText.length > 0,
			evidenceIncomplete: evidence.incomplete,
		};
		const withMeta = (row: GateLogRow): GateLogRow => ({ ...row, ...summary, plan: planReason });
		const detail = describeDecision(decision);

		if (decision.verdict === "allow") {
			log(toolName, call, ctx.cwd, "allowed", decision.reason, withMeta);
			return undefined;
		}

		if (decision.verdict === "block") {
			pushBlock(toolName, call, ctx.cwd, "review", decision.reason, detail);
			log(toolName, call, ctx.cwd, "blocked", decision.reason, withMeta);
			return { block: true, reason: `${detail} Use /allow to approve this specific call. ${hardStop()}` };
		}

		// Mid band. Default: refuse with guidance so the agent can adapt — the
		// posture Armor and fx both take. A human prompt is opt-in (onUncertain:
		// "ask") because it is the outcome this gate exists to remove.
		pushBlock(toolName, call, ctx.cwd, "review", decision.reason, detail);
		if (config.onUncertain === "ask" && ctx.hasUI && (await askHuman(ctx, "Review held", call))) {
			log(toolName, call, ctx.cwd, "allowed", "prompt-approved", withMeta);
			return undefined;
		}
		log(toolName, call, ctx.cwd, "held", decision.reason, withMeta);
		return {
			block: true,
			reason: `${detail} Make a narrower call, or ask the user. Use /allow to approve this exact call.`,
		};
	});

	// 6. .env output masking (redaction of read results, not a gate).
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read") return undefined;
		if (!isEnvPath(String((event.input as Record<string, unknown>)["path"] ?? ""))) return undefined;
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const masked = maskEnvContent(part.text);
			if (masked === part.text) return part;
			changed = true;
			return { ...part, text: masked };
		});
		return changed ? { content } : undefined;
	});

	pi.registerCommand("judge", {
		description: "Show the permission gate's reviewer, thresholds, and pending approval",
		handler: async (_args, ctx) => {
			const thresholds = resolveThresholds(config);
			ctx.ui.notify(
				[
					`policy: v${POLICY_VERSION}`,
					`reviewer: ${modelKey(config)}`,
					`thresholds: allow <= ${thresholds.allowAt}, deny >= ${thresholds.denyAt}`,
					`mid band: ${config.onUncertain === "hold" ? "hold (agent gets guidance)" : "ask the user"}`,
					`pending approval: ${pending.has() ? "yes" : "no"}`,
					`recent blocks: ${blocks.list().length}`,
					...blocks.list().map((block) => `  ${describeBlocked(block)}`),
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("gate-log", {
		description: "Show the most recent permission gate decisions",
		handler: async (_args, ctx) => {
			const path = join(getAgentDir(), "gate.log.jsonl");
			if (!existsSync(path)) return ctx.ui.notify("No gate log yet.", "info");
			const rows = readFileSync(path, "utf-8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.slice(-15)
				.map((line) => parseLogRow(line))
				.filter((row): row is GateLogRow => row !== null);
			ctx.ui.notify(rows.map((row) => renderLogRow(row)).join("\n") || "Log file is empty.", "info");
		},
	});

	pi.registerCommand("allow", {
		description: "Approve one recent block for this exact call (one shot)",
		handler: async (_args, ctx) => {
			const candidates = blocks.list();
			if (candidates.length === 0) return ctx.ui.notify("Nothing to approve.", "info");
			const choice = await ctx.ui.select("Approve which call?", candidates.map(describeBlocked));
			const picked = candidates.find((call) => describeBlocked(call) === choice);
			if (!picked) return;
			pending.set(
				picked.tool,
				describeToolCall(picked.tool, { path: picked.value, command: picked.value, url: picked.value }, ctx.cwd).resolved,
			);
			log(
				picked.tool,
				{ value: picked.value, resolved: picked.value, description: picked.description },
				picked.cwd,
				"override",
				`approved-via-allow: ${picked.reason}`,
			);
			try {
				pi.sendUserMessage(`Approved one-shot: ${picked.tool}. Retry it now.`, { deliverAs: "steer" });
			} catch (error) {
				console.error(`[permission-gate] Failed to send retry nudge: ${error}`);
			}
			ctx.ui.notify(`Approved: ${describeBlocked(picked)} — the agent has been asked to retry it.`, "info");
		},
	});
}
