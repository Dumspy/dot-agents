import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import permissionGate, { DEFAULT_CONFIG, resolveThresholds, type GateConfig } from "./index.js";
import { parseLogRow, type GateLogRow } from "./log.js";

const config = (overrides: Partial<GateConfig> = {}): GateConfig => ({ ...DEFAULT_CONFIG, ...overrides });

describe("resolveThresholds", () => {
	it("uses the top-level pair when no profile matches", () => {
		expect(resolveThresholds(config({ profiles: {} }))).toEqual({ allowAt: 0.25, denyAt: 0.6 });
	});

	it("applies a profile keyed by the native provider/model pair", () => {
		const selected = config({
			provider: "cloudflare-workers-ai",
			model: "@cf/cloudflare/clef-flash",
			profiles: {
				"cloudflare-workers-ai/@cf/cloudflare/clef-flash": { allowAt: 0.2, denyAt: 0.5 },
			},
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.2, denyAt: 0.5 });
	});

	it("applies a profile keyed by the OpenRouter pair", () => {
		const selected = config({
			provider: "openrouter",
			model: "cloudflare/clef-flash",
			profiles: {
				"openrouter/cloudflare/clef-flash": { allowAt: 0.2, denyAt: 0.5 },
			},
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.2, denyAt: 0.5 });
	});

	it("does not match another provider's key", () => {
		// Regression: the example used "cloudflare/clef-flash", which is the
		// OpenRouter model id without its provider, so the profile never applied.
		const selected = config({
			provider: "cloudflare-workers-ai",
			model: "@cf/cloudflare/clef-flash",
			profiles: {
				"cloudflare/clef-flash": { allowAt: 0.2, denyAt: 0.5 },
			},
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.25, denyAt: 0.6 });
	});

	it("fills a missing profile field from the top-level pair", () => {
		const selected = config({
			profiles: { "typesafe/jev-latest": { allowAt: 0.1 } },
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.1, denyAt: 0.6 });
	});

	it("ignores a profile whose bands are crossed", () => {
		const selected = config({
			profiles: { "typesafe/jev-latest": { allowAt: 0.9, denyAt: 0.1 } },
		});
		expect(resolveThresholds(selected)).toEqual({ allowAt: 0.25, denyAt: 0.6 });
	});
});

const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
	vi.unstubAllEnvs();
});

function reviewed(probabilities: Record<string, number>, confidence = 0.9): ClassifierResult {
	const answers: Record<string, ClassifierAnswer> = {};
	for (const [id, violation] of Object.entries(probabilities)) {
		answers[id] = {
			type: "choice",
			choice: violation <= 0.5 ? "clear" : "violation",
			probabilities: { clear: 1 - violation, violation },
			confidence,
		};
	}
	return {
		api: "typesafe-system-one" as ClassifierApi,
		provider: "typesafe",
		model: "jev-latest",
		answers,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface HarnessOptions {
	readonly config?: unknown;
	readonly hasUI?: boolean;
	readonly trusted?: boolean;
	readonly messages?: readonly unknown[];
	readonly modelAvailable?: boolean;
	readonly classify?: (context: ClassifierContext) => Promise<ClassifierResult>;
	readonly select?: (prompt: string, choices: readonly string[]) => Promise<string | undefined>;
}

interface Harness {
	readonly home: string;
	readonly ctx: ExtensionContext;
	readonly events: Array<{ name: string; payload: unknown }>;
	readonly messages: Array<{ text: string; options: unknown }>;
	readonly classifyCalls: ClassifierContext[];
	readonly commands: Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	readonly call: (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
	readonly rows: () => GateLogRow[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
	const home = mkdtempSync(join(tmpdir(), "gate-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "gate-cwd-"));
	cleanup.push(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	vi.stubEnv("HOME", home);
	if (options.config !== undefined) {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "gate.json"), JSON.stringify(options.config));
	}

	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const events: Array<{ name: string; payload: unknown }> = [];
	const messages: Array<{ text: string; options: unknown }> = [];
	const commands = new Map<
		string,
		{ description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }
	>();
	const classifyCalls: ClassifierContext[] = [];

	const model = {
		type: "classifier",
		id: "jev-latest",
		name: "Jev",
		api: "typesafe-system-one",
		provider: "typesafe",
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	} as unknown as ClassifierModel<ClassifierApi>;

	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		events: { emit: (name: string, payload: unknown) => events.push({ name, payload }) },
		registerCommand: (name: string, definition: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, definition),
		sendUserMessage: (text: string, options: unknown) => messages.push({ text, options }),
	} as unknown as ExtensionAPI;

	const registry = {
		findOfType: () => (options.modelAvailable === false ? undefined : model),
		classify: async (_model: unknown, context: ClassifierContext) => {
			classifyCalls.push(context);
			return options.classify
				? options.classify(context)
				: reviewed({ injection: 0.05, exfiltration: 0.05, external_effect: 0.05 });
		},
	};

	const select = options.select ?? (async (_prompt: string, choices: readonly string[]) => choices[0]);
	const ctx = {
		cwd,
		hasUI: options.hasUI ?? false,
		ui: { select, notify: () => {} },
		modelRegistry: registry,
		sessionManager: {
			getEntries: () => [],
			buildSessionProjection: () => ({ messages: options.messages ?? [] }),
		},
		signal: undefined,
		isProjectTrusted: () => options.trusted ?? true,
	} as unknown as ExtensionContext;

	permissionGate(pi);
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);

	const call = async (toolName: string, input: Record<string, unknown>): Promise<unknown> => {
		const handler = handlers.get("tool_call")?.[0];
		if (!handler) throw new Error("no tool_call handler registered");
		return handler({ toolName, input }, ctx);
	};

	const rows = (): GateLogRow[] => {
		const path = join(home, ".pi", "agent", "gate.log.jsonl");
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => parseLogRow(line))
			.filter((row): row is GateLogRow => row !== null);
	};

	return { home, ctx, events, messages, classifyCalls, commands, call, rows };
}

describe("tool_call orchestration", () => {
	it("passes planner-proven read-only bash without a model call", async () => {
		const h = makeHarness();
		expect(await h.call("bash", { command: "ls -la" })).toBeUndefined();
		expect(h.classifyCalls).toHaveLength(0);
		expect(h.rows().at(-1)).toMatchObject({ verdict: "free", plan: "read_only" });
	});

	it("blocks the floor without a model call", async () => {
		const h = makeHarness();
		const result = (await h.call("bash", { command: "sudo ls" })) as { block: true; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("Privilege escalation");
		expect(h.classifyCalls).toHaveLength(0);
		expect(h.rows().at(-1)).toMatchObject({ verdict: "floor-blocked", reason: "sudo" });
	});

	it("allows a low-probability review", async () => {
		const h = makeHarness();
		expect(await h.call("bash", { command: "npm test" })).toBeUndefined();
		expect(h.classifyCalls).toHaveLength(1);
		expect(h.rows().at(-1)).toMatchObject({ verdict: "allowed" });
	});

	it("blocks a high-probability review", async () => {
		const h = makeHarness({
			classify: async () => reviewed({ injection: 0.1, exfiltration: 0.9, external_effect: 0.1 }),
		});
		const result = (await h.call("bash", { command: "npm test" })) as { block: true; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("Blocked");
		expect(h.rows().at(-1)).toMatchObject({ verdict: "blocked", reason: "deny:exfiltration" });
	});

	it("holds the mid band with guidance and no prompt by default", async () => {
		const h = makeHarness({
			classify: async () => reviewed({ injection: 0.1, exfiltration: 0.4, external_effect: 0.1 }),
		});
		const result = (await h.call("bash", { command: "npm test" })) as { block: true; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("narrower call");
		expect(h.rows().at(-1)).toMatchObject({ verdict: "held", reason: "hold:exfiltration" });
	});

	it("asks the human on the mid band when onUncertain is ask", async () => {
		const h = makeHarness({
			config: { ...DEFAULT_CONFIG, onUncertain: "ask" },
			hasUI: true,
			classify: async () => reviewed({ injection: 0.1, exfiltration: 0.4, external_effect: 0.1 }),
			select: async () => "Yes",
		});
		expect(await h.call("bash", { command: "npm test" })).toBeUndefined();
		expect(h.events.filter((event) => event.name === "herdr:blocked").map((event) => event.payload)).toEqual([
			{ active: true, label: "Review held: run `npm test`" },
			{ active: false },
		]);
		expect(h.rows().at(-1)).toMatchObject({ verdict: "allowed", reason: "prompt-approved" });
	});

	it("keeps the block when the human says no", async () => {
		const h = makeHarness({
			config: { ...DEFAULT_CONFIG, onUncertain: "ask" },
			hasUI: true,
			classify: async () => reviewed({ injection: 0.1, exfiltration: 0.4, external_effect: 0.1 }),
			select: async () => "No",
		});
		const result = (await h.call("bash", { command: "npm test" })) as { block: true };
		expect(result.block).toBe(true);
		expect(h.rows().at(-1)).toMatchObject({ verdict: "held" });
	});

	it("falls back to a prompt when the reviewer is unavailable with UI", async () => {
		const h = makeHarness({
			hasUI: true,
			classify: async () => {
				throw new Error("boom");
			},
			select: async () => "Yes",
		});
		expect(await h.call("bash", { command: "npm test" })).toBeUndefined();
		expect(h.rows().at(-1)).toMatchObject({ verdict: "allowed", reason: "review-unavailable-approved: error" });
	});

	it("fails closed when the reviewer is unavailable headless", async () => {
		const h = makeHarness({
			classify: async () => {
				throw new Error("boom");
			},
		});
		const result = (await h.call("bash", { command: "npm test" })) as { block: true; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("Reviewer unavailable");
		expect(h.rows().at(-1)).toMatchObject({ verdict: "blocked", reason: "review-unavailable: error" });
	});

	it("fails closed when the model is unknown", async () => {
		const h = makeHarness({ modelAvailable: false });
		const result = (await h.call("bash", { command: "npm test" })) as { block: true; reason: string };
		expect(result.block).toBe(true);
		expect(h.rows().at(-1)).toMatchObject({ verdict: "blocked", reason: "review-unavailable: unknown-model" });
	});

	it("passes trusted user turns to the reviewer", async () => {
		const h = makeHarness({ messages: [{ role: "user", content: "delete the drafts folder" }] });
		await h.call("bash", { command: "npm test" });
		const state = h.classifyCalls[0]!.state as {
			review_context_kind: string;
			trusted_user_intent: { current_request: string };
		};
		expect(state.review_context_kind).toBe("contextual");
		expect(state.trusted_user_intent.current_request).toBe("delete the drafts folder");
	});

	it("/allow arms one exact call and consumes it once", async () => {
		const h = makeHarness();
		const blocked = (await h.call("bash", { command: "sudo ls" })) as { block: true };
		expect(blocked.block).toBe(true);
		const allow = h.commands.get("allow");
		if (!allow) throw new Error("no /allow command");
		await allow.handler("", h.ctx);
		expect(h.messages.at(-1)).toMatchObject({
			text: "Approved one-shot: bash. Retry it now.",
			options: { deliverAs: "steer" },
		});
		expect(await h.call("bash", { command: "sudo ls" })).toBeUndefined();
		const again = (await h.call("bash", { command: "sudo ls" })) as { block: true };
		expect(again.block).toBe(true);
		expect(h.rows().map((row) => row.verdict)).toEqual([
			"floor-blocked",
			"override",
			"override",
			"floor-blocked",
		]);
	});
});
