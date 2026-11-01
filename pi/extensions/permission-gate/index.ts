/**
 * Permission Gate for Pi.
 *
 * Replaces the pattern-based permission system with the shape both shipped
 * prior arts converged on (OpenRouter Armor, Claude Code auto mode, Vercel fx):
 *
 *   planner (deterministic, read-only)  → free
 *   floor   (deterministic, final)      → block
 *   reviewer (narrow questions)         → allow / hold / block
 *
 * The planner proves routine read-only shell work, so it never pays for a
 * model call. The floor owns crisp-bad shapes and paths. The reviewer only sees
 * what neither could decide, and it is asked three separate narrow questions
 * (injection, exfiltration, external effect) instead of one bundled safety
 * question, with the user's own words and the recorded environment attached.
 *
 * Config: ~/.pi/agent/gate.json
 * {
 *   "provider": "typesafe", "model": "jev-latest",
 *   "allowAt": 0.25, "denyAt": 0.6, "timeoutMs": 4000,
 *   "onUncertain": "hold",
 *   "profiles": { "cloudflare/clef-flash": { "allowAt": 0.2, "denyAt": 0.5 } }
 * }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	withPlan,
	withReview,
	type GateLogRow,
	type LogVerdict,
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
	readonly profiles?: Readonly<Record<string, Partial<Thresholds>>>;
}

export const DEFAULT_CONFIG: GateConfig = {
	provider: "typesafe",
	model: "jev-latest",
	...DEFAULT_THRESHOLDS,
	timeoutMs: 4000,
	onUncertain: "hold",
};

function getAgentDir(): string {
	const home = process.env["HOME"] || process.env["USERPROFILE"] || "/tmp";
	return join(home, ".pi", "agent");
}

function loadConfig(): GateConfig {
	const path = join(getAgentDir(), "gate.json");
	if (!existsSync(path)) return DEFAULT_CONFIG;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return DEFAULT_CONFIG;
		const record = parsed as Record<string, unknown>;
		let config: GateConfig = { ...DEFAULT_CONFIG };
		if (typeof record["provider"] === "string") config = { ...config, provider: record["provider"] };
		if (typeof record["model"] === "string") config = { ...config, model: record["model"] };
		const thresholds = parseThresholds(record, { allowAt: config.allowAt, denyAt: config.denyAt });
		config = { ...config, ...thresholds };
		if (typeof record["timeoutMs"] === "number") config = { ...config, timeoutMs: record["timeoutMs"] };
		if (record["onUncertain"] === "hold" || record["onUncertain"] === "ask") {
			config = { ...config, onUncertain: record["onUncertain"] };
		}
		if (typeof record["profiles"] === "object" && record["profiles"] !== null) {
			config = { ...config, profiles: record["profiles"] as GateConfig["profiles"] };
		}
		return config;
	} catch (error) {
		console.error(`[permission-gate] Warning: could not parse ${path}: ${error}`);
		return DEFAULT_CONFIG;
	}
}

/** Effective thresholds: a valid per-model profile wins, else the top-level pair. */
export function resolveThresholds(config: GateConfig): Thresholds {
	const base = { allowAt: config.allowAt, denyAt: config.denyAt };
	return parseThresholds(config.profiles?.[modelKey(config)], base);
}

/** Primary value per tool: command text, file path, or URL. */
function getToolValue(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return String(input["path"] ?? "");
		case "bash":
			return String(input["command"] ?? "");
		case "webfetch":
			return String(input["url"] ?? "");
		default:
			return String(input["path"] ?? input["command"] ?? input["url"] ?? input["query"] ?? JSON.stringify(input));
	}
}

/** Resolve file-tool paths against the workspace so the floor sees absolute paths. */
function resolveValue(toolName: string, value: string, cwd: string): string {
	if ((toolName === "read" || toolName === "write" || toolName === "edit") && value) {
		return resolve(cwd, value);
	}
	return value;
}

function formatToolDescription(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return `${toolName} \`${input["path"]}\``;
		case "bash":
			return `run \`${input["command"]}\``;
		case "webfetch":
			return `fetch \`${input["url"]}\``;
		default:
			return `call ${toolName}`;
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

/**
 * Trusted user turns from the session, oldest first. Only `role: "user"`
 * messages count: assistant prose, tool results, and compaction summaries are
 * never authorization.
 */
export function readUserTurns(ctx: SessionLike): string[] {
	const collect = (messages: readonly unknown[]): string[] => {
		const turns: string[] = [];
		for (const message of messages) {
			if (typeof message !== "object" || message === null) continue;
			const record = message as Record<string, unknown>;
			if (record["role"] !== "user") continue;
			const text = userMessageText(record["content"]);
			if (text.trim().length > 0) turns.push(text);
		}
		return turns;
	};

	try {
		const projection = ctx.sessionManager.buildSessionProjection?.();
		if (projection && projection.messages.length > 0) {
			const turns = collect(projection.messages);
			if (turns.length > 0) return turns;
		}
	} catch {}

	try {
		const entries = ctx.sessionManager.getEntries?.() ?? [];
		const messages: unknown[] = [];
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			if (record["type"] === "message" && typeof record["message"] === "object") messages.push(record["message"]);
		}
		return collect(messages);
	} catch {
		return [];
	}
}

export function readIntent(ctx: SessionLike): IntentContext | null {
	const turns = readUserTurns(ctx);
	if (turns.length === 0) return null;
	// Compaction hides earlier turns; the earliest surviving turn is not the
	// first thing the user asked, and the reviewer must be told that.
	let historyComplete = true;
	try {
		const entries = ctx.sessionManager.getEntries?.() ?? [];
		historyComplete = !entries.some((entry) => {
			if (typeof entry !== "object" || entry === null) return false;
			return (entry as Record<string, unknown>)["type"] === "compaction";
		});
	} catch {}
	return buildIntentContext(turns, { historyComplete });
}

export default function permissionGate(pi: ExtensionAPI) {
	let config = DEFAULT_CONFIG;
	const blocks = new BlockBuffer();
	const pending = new PendingApproval();

	function log(
		tool: string,
		value: string,
		cwd: string,
		verdict: LogVerdict,
		reason: string,
		extra?: (row: GateLogRow) => GateLogRow,
	): void {
		let row = createLogRow(tool, value, cwd, verdict, reason);
		if (extra) row = extra(row);
		try {
			const logPath = join(getAgentDir(), "gate.log.jsonl");
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, formatLogRow(row));
		} catch {}
	}

	function pushBlock(
		tool: string,
		value: string,
		cwd: string,
		kind: BlockedCall["kind"],
		reason: string,
		detail: string,
	): void {
		blocks.push({ tool, value, cwd, kind, reason, detail, ts: new Date().toISOString() });
	}

	function blockResult(
		tool: string,
		value: string,
		cwd: string,
		reason: string,
		detail: string,
	): { block: true; reason: string } {
		log(tool, value, cwd, "blocked", reason);
		return { block: true as const, reason: `${detail} ${hardStop()}` };
	}

	function emitHerdrBlocked(active: boolean, label?: string): void {
		try {
			pi.events.emit("herdr:blocked", active ? { active: true, label } : { active: false });
		} catch {}
	}

	pi.on("session_start", () => {
		config = loadConfig();
		blocks.clear();
		pending.clear();
		clearEnvironmentCache();
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const toolName = event.toolName;
		const rawValue = getToolValue(toolName, input);
		const value = resolveValue(toolName, rawValue, ctx.cwd);

		// 1. One-shot /allow approval (the only override path, floor included).
		if (pending.consume(toolName, value)) {
			log(toolName, value, ctx.cwd, "override", "pending-approval-consumed");
			return undefined;
		}

		// 2. Deterministic hard floor — final.
		const hit: FloorHit | null = checkFloor(toolName, value);
		if (hit) {
			pushBlock(toolName, rawValue, ctx.cwd, "floor", hit.reason, hit.detail);
			log(toolName, value, ctx.cwd, "floor-blocked", hit.reason);
			return {
				block: true as const,
				reason: `${hit.detail} Use /allow to approve this specific call. ${hardStop()}`,
			};
		}

		// 3. Writes/edits inside the workspace are floor-checked only: highest
		// volume, lowest regret. Outside it they are how persistence gets
		// installed (`~/.zshrc`, cron, another repo), so they get reviewed.
		if ((toolName === "write" || toolName === "edit") && !pathNeedsReview(value, ctx.cwd)) {
			return undefined;
		}

		// 4. Reads go to review only when the target is worth a second opinion.
		if (toolName === "read" && !pathNeedsReview(value, ctx.cwd)) {
			return undefined;
		}

		// 5. Planner: proven read-only shell work needs no model at all.
		let planReason = "not_applicable";
		let planDetail: string | undefined;
		if (toolName === "bash") {
			const plan = planCommand(rawValue);
			if (plan.kind === "read_only") {
				log(toolName, value, ctx.cwd, "free", "read_only", (row) => withPlan(row, "read_only"));
				return undefined;
			}
			planReason = plan.reason;
			planDetail = `not proven read-only: ${plan.reason}`;
		}

		// 6. Review: three narrow questions, trusted intent, environment facts.
		const thresholds = resolveThresholds(config);
		const intent = readIntent(ctx);
		const facts = readEnvironmentFacts(ctx.cwd, ctx.isProjectTrusted?.() ?? true);
		const evidence = buildReviewEvidence(
			{
				toolName,
				value,
				cwd: ctx.cwd,
				...(planDetail === undefined ? {} : { detail: planDetail }),
				...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
			},
			intent,
			facts,
		);

		const review: ReviewOutcome = await runReview(ctx.modelRegistry, config, evidence, questionsForTool(toolName), {
			signal: ctx.signal,
			timeoutMs: config.timeoutMs,
		});

		if (review.status === "unavailable") {
			if (review.reason === "aborted") {
				return { block: true as const, reason: "Aborted." };
			}
			pushBlock(toolName, rawValue, ctx.cwd, "review", review.reason, review.detail);
			log(toolName, value, ctx.cwd, "prompted", `review-unavailable: ${review.reason}`, (row) => withPlan(row, planReason));
			if (!ctx.hasUI) {
				log(toolName, value, ctx.cwd, "blocked", `review-unavailable-no-ui: ${review.reason}`, (row) =>
					withPlan(row, planReason),
				);
				return {
					block: true as const,
					reason: `Reviewer unavailable (${review.detail}). No UI to confirm. ${hardStop()}`,
				};
			}
			const description = formatToolDescription(toolName, input);
			emitHerdrBlocked(true, `Reviewer unavailable: ${description}`);
			try {
				const choice = await ctx.ui.select(
					`Reviewer unavailable\n\n${review.detail}\n\nThe agent wants to ${description}\n\nAllow this action?`,
					["Yes", "No"],
				);
				if (choice === "Yes") {
					log(toolName, value, ctx.cwd, "allowed", `review-unavailable-approved: ${review.reason}`);
					return undefined;
				}
				return blockResult(toolName, value, ctx.cwd, "prompt-denied", "Blocked by user.");
			} finally {
				emitHerdrBlocked(false);
			}
		}

		const decision = decideReview(review.probabilities, thresholds);
		const summary = {
			p: review.probabilities,
			confidence: review.confidence,
			allowAt: thresholds.allowAt,
			denyAt: thresholds.denyAt,
			model: review.model,
			latencyMs: review.latencyMs,
			contextual: evidence.intentText.length > 0,
			evidenceIncomplete: evidence.incomplete,
		};
		const withMeta = (row: GateLogRow): GateLogRow => withReview(withPlan(row, planReason), summary);

		if (decision.verdict === "allow") {
			log(toolName, value, ctx.cwd, "allowed", decision.reason, withMeta);
			return undefined;
		}

		if (decision.verdict === "block") {
			pushBlock(toolName, rawValue, ctx.cwd, "review", decision.reason, describeDecision(decision));
			log(toolName, value, ctx.cwd, "blocked", decision.reason, withMeta);
			return {
				block: true as const,
				reason: `${describeDecision(decision)} Use /allow to approve this specific call. ${hardStop()}`,
			};
		}

		// Mid band. Default: refuse with guidance so the agent can adapt — the
		// posture Armor and fx both take. A human prompt is opt-in (onUncertain:
		// "ask") because it is the outcome this gate exists to remove.
		pushBlock(toolName, rawValue, ctx.cwd, "review", decision.reason, describeDecision(decision));
		if (config.onUncertain === "hold" || !ctx.hasUI) {
			log(toolName, value, ctx.cwd, "held", decision.reason, withMeta);
			return {
				block: true as const,
				reason: `${describeDecision(decision)} Make a narrower call, or ask the user. Use /allow to approve this exact call.`,
			};
		}

		const description = formatToolDescription(toolName, input);
		emitHerdrBlocked(true, `Review held: ${description}`);
		try {
			const choice = await ctx.ui.select(
				`Review held (${decision.reason})\n\nThe agent wants to ${description}\n\nAllow this action?`,
				["Yes", "No"],
			);
			if (choice === "Yes") {
				log(toolName, value, ctx.cwd, "allowed", "prompt-approved", withMeta);
				return undefined;
			}
			return blockResult(toolName, value, ctx.cwd, "prompt-denied", "Blocked by user.");
		} finally {
			emitHerdrBlocked(false);
		}
	});

	// 7. .env output masking (redaction of read results, not a gate).
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read") return undefined;
		const path = String((event.input as Record<string, unknown>)["path"] ?? "");
		if (!isEnvPath(path)) return undefined;
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const masked = maskEnvContent(part.text);
			if (masked === part.text) return part;
			changed = true;
			return { ...part, text: masked };
		});
		if (!changed) return undefined;
		return { content };
	});

	pi.registerCommand("judge", {
		description: "Show the permission gate's reviewer, thresholds, and pending approval",
		handler: async (_args, ctx) => {
			const thresholds = resolveThresholds(config);
			const lines = [
				`policy: v${POLICY_VERSION}`,
				`reviewer: ${config.provider}/${config.model}`,
				`thresholds: allow <= ${thresholds.allowAt}, deny >= ${thresholds.denyAt}`,
				`mid band: ${config.onUncertain === "hold" ? "hold (agent gets guidance)" : "ask the user"}`,
				`pending approval: ${pending.has() ? "yes" : "no"}`,
				`recent blocks: ${blocks.list().length}`,
			];
			for (const block of blocks.list()) lines.push(`  ${describeBlocked(block)}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("gate-log", {
		description: "Show the most recent permission gate decisions",
		handler: async (_args, ctx) => {
			const path = join(getAgentDir(), "gate.log.jsonl");
			if (!existsSync(path)) {
				ctx.ui.notify("No gate log yet.", "info");
				return;
			}
			const lines = readFileSync(path, "utf-8").trimEnd().split("\n").slice(-15);
			const rows = lines.map((line) => parseLogRow(line)).filter((row): row is GateLogRow => row !== null);
			ctx.ui.notify(rows.map((row) => renderLogRow(row)).join("\n"), "info");
		},
	});

	pi.registerCommand("allow", {
		description: "Approve one recent block for this exact call (one shot)",
		handler: async (_args, ctx) => {
			const candidates = blocks.list();
			if (candidates.length === 0) {
				ctx.ui.notify("Nothing to approve.", "info");
				return;
			}
			const choice = await ctx.ui.select(
				"Approve which call?",
				candidates.map((call) => describeBlocked(call)),
			);
			const picked = candidates.find((call) => describeBlocked(call) === choice);
			if (!picked) return;
			pending.set(picked.tool, resolveValue(picked.tool, picked.value, ctx.cwd));
			log(picked.tool, picked.value, picked.cwd, "override", `approved-via-allow: ${picked.reason}`);
			try {
				pi.sendUserMessage(
					`Approved one-shot: ${formatToolDescription(picked.tool, {
						path: picked.value,
						command: picked.value,
						url: picked.value,
					})}. Retry it now.`,
					{ deliverAs: "steer" },
				);
			} catch (error) {
				console.error(`[permission-gate] Failed to send retry nudge: ${error}`);
			}
			ctx.ui.notify(`Approved: ${describeBlocked(picked)} — the agent has been asked to retry it.`, "info");
		},
	});
}
