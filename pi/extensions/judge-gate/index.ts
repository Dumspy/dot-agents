/**
 * Judge Gate extension for Pi.
 *
 * Replaces pattern-based permissions with: deterministic hard floor (final)
 * + one SystemOne safety question per ambiguous call (allow / prompt / block).
 *
 * Config: ~/.pi/agent/judge.json (global only in v1; project-local
 * tighten-only comes later):
 * {
 *   "provider": "typesafe", "model": "jev-latest",
 *   "t": 0.85, "c": 0.7, "timeoutMs": 4000,
 *   "profiles": { "typesafe/jev-latest": { "t": 0.85, "c": 0.7 } }
 * }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BlockBuffer, describeBlocked, PendingApproval, type BlockedCall } from "./approvals.js";
import { decideSafety } from "./decide.js";
import { checkFloor, type FloorHit } from "./floor.js";
import {
	DEFAULT_JUDGE_CONFIG,
	modelKey,
	resolveThresholds,
	runJudge,
	type JudgeConfig,
} from "./judge.js";
import {
	createLogRow,
	formatLogRow,
	parseLogRow,
	renderLogRow,
	withJudgment,
	type LogVerdict,
} from "./log.js";

function getAgentDir(): string {
	const home = process.env["HOME"] || process.env["USERPROFILE"] || "/tmp";
	return join(home, ".pi", "agent");
}

function loadConfig(): JudgeConfig {
	const path = join(getAgentDir(), "judge.json");
	if (!existsSync(path)) return DEFAULT_JUDGE_CONFIG;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return DEFAULT_JUDGE_CONFIG;
		const record = parsed as Record<string, unknown>;
		let config: JudgeConfig = { ...DEFAULT_JUDGE_CONFIG };
		if (typeof record["provider"] === "string") {
			config = { ...config, provider: record["provider"] };
		}
		if (typeof record["model"] === "string") {
			config = { ...config, model: record["model"] };
		}
		if (typeof record["t"] === "number") {
			config = { ...config, t: record["t"] };
		}
		if (typeof record["c"] === "number") {
			config = { ...config, c: record["c"] };
		}
		if (typeof record["timeoutMs"] === "number") {
			config = { ...config, timeoutMs: record["timeoutMs"] };
		}
		if (typeof record["profiles"] === "object" && record["profiles"] !== null) {
			config = { ...config, profiles: record["profiles"] as JudgeConfig["profiles"] };
		}
		return config;
	} catch (error) {
		console.error(`[judge-gate] Warning: could not parse ${path}: ${error}`);
		return DEFAULT_JUDGE_CONFIG;
	}
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
			return String(
				input["path"] ?? input["command"] ?? input["url"] ?? input["query"] ?? JSON.stringify(input),
			);
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

export default function judgeGate(pi: ExtensionAPI) {
	let config = DEFAULT_JUDGE_CONFIG;
	const blocks = new BlockBuffer();
	const pending = new PendingApproval();

	function log(
		tool: string,
		value: string,
		cwd: string,
		verdict: LogVerdict,
		reason: string,
		judgment?: { p: number; confidence: number; t: number; c: number; model: string; latencyMs: number },
	): void {
		const base = createLogRow(tool, value, cwd, verdict, reason);
		const row = judgment ? withJudgment(base, judgment) : base;
		try {
			const logPath = join(getAgentDir(), "judge.log.jsonl");
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

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		blocks.clear();
		pending.clear();
		if (!ctx.hasUI) return;
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

		// 3. Reads are floor-checked only, never judged.
		if (toolName === "read") {
			return undefined;
		}

		// 4. Semantic judge.
		const thresholds = resolveThresholds(config);
		const outcome = await runJudge(ctx.modelRegistry, config, toolName, value, ctx.cwd, ctx.signal);

		if (outcome.status === "unavailable") {
			if (outcome.reason === "aborted") {
				return { block: true as const, reason: "Aborted." };
			}
			// Degrade to the ask path: prompt when UI, block when headless.
			pushBlock(toolName, rawValue, ctx.cwd, "judge", outcome.reason, outcome.detail);
			if (!ctx.hasUI) {
				log(toolName, value, ctx.cwd, "blocked", `judge-unavailable-no-ui: ${outcome.reason}`);
				return {
					block: true as const,
					reason: `Judge unavailable (${outcome.detail}). No UI to confirm. ${hardStop()}`,
				};
			}
			const description = formatToolDescription(toolName, input);
			emitHerdrBlocked(true, `Judge unavailable: ${description}`);
			try {
				const choice = await ctx.ui.select(
					`Judge unavailable\n\n${outcome.detail}\n\nThe agent wants to ${description}\n\nAllow this action?`,
					["Yes", "No"],
				);
				if (choice === "Yes") {
					log(toolName, value, ctx.cwd, "allowed", `judge-unavailable-approved: ${outcome.reason}`);
					return undefined;
				}
				return blockResult(toolName, value, ctx.cwd, "prompt-denied", "Blocked by user.");
			} finally {
				emitHerdrBlocked(false);
			}
		}

		const judgment = {
			p: outcome.p,
			confidence: outcome.confidence,
			t: thresholds.t,
			c: thresholds.c,
			model: outcome.model,
			latencyMs: outcome.latencyMs,
		};
		const decision = decideSafety({ p: outcome.p, confidence: outcome.confidence }, thresholds);

		if (decision.verdict === "allow") {
			log(toolName, value, ctx.cwd, "allowed", decision.reason, judgment);
			return undefined;
		}
		if (decision.verdict === "block") {
			pushBlock(toolName, rawValue, ctx.cwd, "judge", decision.reason, `Judge blocked (p=${outcome.p.toFixed(2)}).`);
			log(toolName, value, ctx.cwd, "blocked", decision.reason, judgment);
			return {
				block: true as const,
				reason: `Judge blocked this call (p=${outcome.p.toFixed(2)} unsafe). Use /allow to approve this specific call. ${hardStop()}`,
			};
		}

		// Uncertain (or low confidence) → prompt when UI, block when headless.
		pushBlock(toolName, rawValue, ctx.cwd, "judge", decision.reason, `Judge uncertain (p=${outcome.p.toFixed(2)}, conf=${outcome.confidence.toFixed(2)}).`);
		if (!ctx.hasUI) {
			log(toolName, value, ctx.cwd, "blocked", `judge-uncertain-no-ui: ${decision.reason}`, judgment);
			return {
				block: true as const,
				reason: `Judge uncertain (p=${outcome.p.toFixed(2)}). No UI to confirm. ${hardStop()}`,
			};
		}
		const description = formatToolDescription(toolName, input);
		emitHerdrBlocked(true, `Judge uncertain: ${description}`);
		try {
			const choice = await ctx.ui.select(
				`Judge uncertain (p=${outcome.p.toFixed(2)}, confidence=${outcome.confidence.toFixed(2)}, model=${outcome.model})\n\nThe agent wants to ${description}\n\nAllow this action?`,
				["Yes", "No"],
			);
			if (choice === "Yes") {
				log(toolName, value, ctx.cwd, "allowed", "prompt-approved", judgment);
				return undefined;
			}
			return blockResult(toolName, value, ctx.cwd, "prompt-denied", "Blocked by user.");
		} finally {
			emitHerdrBlocked(false);
		}
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = String((event.input as Record<string, unknown>)["path"] ?? "");
		if (!isEnvPath(rawPath)) return undefined;
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
		description: "Show judge gate status (model, thresholds, floor, pending approval)",
		handler: async (_args, ctx) => {
			const thresholds = resolveThresholds(config);
			const found = ctx.modelRegistry.findOfType("classifier", config.provider, config.model);
			const lines = [
				"Judge Gate Status:",
				"",
				`Model: ${modelKey(config)} ${found ? "(available)" : "(NOT FOUND — check provider auth)"}`,
				`Thresholds: t=${thresholds.t} c=${thresholds.c} (per-model profile: ${config.profiles?.[modelKey(config)] ? "yes" : "default"})`,
				`Timeout: ${config.timeoutMs}ms`,
				"Floor: enabled (non-configurable)",
				`Pending approval: ${pending.has() ? "yes" : "none"}`,
				`Recent blocks: ${blocks.list().length}`,
				"",
				`Log file: ${join(getAgentDir(), "judge.log.jsonl")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("judge-log", {
		description: "Show recent judge decision log entries",
		handler: async (_args, ctx) => {
			const logPath = join(getAgentDir(), "judge.log.jsonl");
			if (!existsSync(logPath)) {
				ctx.ui.notify("No judge log found.", "info");
				return;
			}
			const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
			const recent = lines.slice(-20);
			if (recent.length === 0) {
				ctx.ui.notify("Log file is empty.", "info");
				return;
			}
			const entries = recent.map((line) => {
				const row = parseLogRow(line);
				return row ? renderLogRow(row) : `[parse error] ${line.slice(0, 80)}`;
			});
			ctx.ui.notify(
				["Recent judge decisions:", "", ...entries, "", `Total entries: ${lines.length}`].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("allow", {
		description: "Approve one of the recent blocked calls (one-shot)",
		handler: async (_args, ctx) => {
			const recent = blocks.list();
			if (recent.length === 0) {
				ctx.ui.notify("No blocked calls to approve.", "info");
				return;
			}
			const options = recent.map(describeBlocked);
			const picked = await ctx.ui.select("Approve a blocked call (one-shot, consumed on next match):", options);
			if (picked === undefined) return;
			const idx = options.indexOf(picked);
			const call = recent[idx];
			if (!call) return;
			pending.set(call.tool, resolveValue(call.tool, call.value, ctx.cwd));
			log(call.tool, call.value, call.cwd, "override", `approved-via-allow: ${call.reason}`);
			try {
				pi.sendUserMessage(
					`Approved one-shot: ${formatToolDescription(call.tool, { path: call.value, command: call.value, url: call.value })}. Retry it now.`,
					{ deliverAs: "steer" },
				);
			} catch (error) {
				console.error(`[judge-gate] Failed to send retry nudge: ${error}`);
			}
			ctx.ui.notify(`Approved: ${describeBlocked(call)} — the agent has been asked to retry it.`, "info");
		},
	});
}
