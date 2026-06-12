import { describe, expect, it } from "vitest";
import { buildBreakdown } from "../capture.ts";
import type { ExtensionAPI, ExtensionCommandContext, ToolInfo } from "@earendil-works/pi-coding-agent";

const makeMockCtx = (
	opts: {
		model?: { provider: string; id: string; contextWindow: number };
		usage?: { tokens: number; contextWindow: number };
		systemPrompt?: string;
		branch?: unknown[];
	},
): ExtensionCommandContext => {
	return {
		hasUI: true,
		cwd: "/test",
		model: opts.model as unknown as ExtensionCommandContext["model"],
		getContextUsage: () =>
			opts.usage
				? ({
						tokens: opts.usage.tokens,
						contextWindow: opts.usage.contextWindow,
						percent: (opts.usage.tokens / opts.usage.contextWindow) * 100,
					} as unknown as ReturnType<ExtensionCommandContext["getContextUsage"] | undefined>)
				: undefined,
		getSystemPrompt: () => opts.systemPrompt ?? "",
		sessionManager: {
			getBranch: () => opts.branch ?? [],
		} as unknown as ExtensionCommandContext["sessionManager"],
		ui: {} as unknown as ExtensionCommandContext["ui"],
		modelRegistry: {} as unknown as ExtensionCommandContext["modelRegistry"],
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		compact: () => {},
		waitForIdle: () => Promise.resolve(),
		newSession: () => Promise.resolve({ cancelled: false }),
		fork: () => Promise.resolve({ cancelled: false }),
		navigateTree: () => Promise.resolve({ cancelled: false }),
		switchSession: () => Promise.resolve({ cancelled: false }),
		reload: () => Promise.resolve(),
	} as unknown as ExtensionCommandContext;
};

const makeCaptured = (promptOptions?: Record<string, unknown>) => {
	return {
		systemPrompt: "",
		systemPromptOptions: {
			cwd: "/test",
			selectedTools: ["read", "bash"],
			...promptOptions,
		},
	};
};

const makeMockPi = (tools: ToolInfo[]): ExtensionAPI => {
	return {
		getAllTools: () => tools,
	} as unknown as ExtensionAPI;
};

describe("buildBreakdown", () => {
	it("returns defaults with no model and no data", () => {
		const ctx = makeMockCtx({});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.modelName).toBe("unknown");
		expect(result.contextWindow).toBe(200_000);
		expect(result.actualTokens).toBe(0);
		expect(result.estimatedTokens).toBe(0);
		// Only free space should be present
		expect(result.categories).toHaveLength(1);
		expect(result.categories[0]?.id).toBe("free");
	});

	it("includes system prompt tokens when captured", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
		});
		const captured = {
			systemPrompt: "You are an expert coding assistant. " + "a".repeat(100),
			systemPromptOptions: { cwd: "/test", selectedTools: [] },
		};
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, captured);

		const systemCat = result.categories.find((c) => c.id === "system");
		expect(systemCat).toBeDefined();
		expect(systemCat!.tokens).toBeGreaterThan(0);
	});

	it("counts tool definitions from active tools", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
		});
		const captured = makeCaptured({
			selectedTools: ["read", "bash"],
		});
		const pi = makeMockPi([
			{
				name: "read",
				description: "Read file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				sourceInfo: { path: "builtin", source: "builtin", scope: "temporary", origin: "top-level" },
			},
			{
				name: "bash",
				description: "Run bash",
				parameters: { type: "object", properties: { command: { type: "string" } } },
				sourceInfo: { path: "builtin", source: "builtin", scope: "temporary", origin: "top-level" },
			},
		] as unknown as ToolInfo[]);
		const result = buildBreakdown(pi, ctx, captured);

		const toolsCat = result.categories.find((c) => c.id === "tools");
		expect(toolsCat).toBeDefined();
		expect(toolsCat!.tokens).toBeGreaterThan(0);
		expect(result.toolDefinitions).toHaveLength(2);
	});

	it("counts skills from systemPromptOptions", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
		});
		const captured = makeCaptured({
			selectedTools: [],
			skills: [
				{ name: "test-skill", description: "This is a test skill description. " + "b".repeat(100) },
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, captured);

		const skillsCat = result.categories.find((c) => c.id === "skills");
		expect(skillsCat).toBeDefined();
		expect(skillsCat!.tokens).toBeGreaterThan(0);
	});

	it("counts context files from systemPromptOptions", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
		});
		const captured = makeCaptured({
			selectedTools: [],
			contextFiles: [
				{ path: "AGENTS.md", content: "# Test\n\n" + "c".repeat(200) },
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, captured);

		const contextCat = result.categories.find((c) => c.id === "context");
		expect(contextCat).toBeDefined();
		expect(contextCat!.tokens).toBeGreaterThan(0);
	});

	it("counts messages from session branch", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: "Hello world! " + "x".repeat(100),
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Hi there! " + "y".repeat(100) }],
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		const messagesCat = result.categories.find((c) => c.id === "messages");
		expect(messagesCat).toBeDefined();
		expect(messagesCat!.tokens).toBeGreaterThan(0);
		expect(result.messageBreakdown.userTokens).toBeGreaterThan(0);
		expect(result.messageBreakdown.agentTokens).toBeGreaterThan(0);
	});

	it("counts tool usage from assistant tool calls and results", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "call_1",
								name: "bash",
								arguments: { command: "echo hello" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "bash",
						content: [{ type: "text", text: "hello\n" }],
						isError: false,
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		const toolUseCat = result.categories.find((c) => c.id === "tooluse");
		expect(toolUseCat).toBeDefined();
		expect(toolUseCat!.tokens).toBeGreaterThan(0);
		expect(result.toolUsage).toHaveLength(1);
		expect(result.toolUsage[0]?.toolName).toBe("bash");
		expect(result.toolUsage[0]?.totalCalls).toBe(1);
	});

	it("counts images from image content blocks", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "Describe this:" },
							{ type: "image", data: "a".repeat(1000) },
						],
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.imageCount).toBe(1);
		expect(result.imageTokens).toBeGreaterThan(0);
		const imagesCat = result.categories.find((c) => c.id === "images");
		expect(imagesCat).toBeDefined();
		expect(imagesCat!.tokens).toBeGreaterThan(0);
	});

	it("counts compaction summaries", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					type: "message",
					message: {
						role: "compactionSummary",
						summary: "Previous conversation was about testing. " + "z".repeat(100),
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.compactionTokens).toBeGreaterThan(0);
		const compactionCat = result.categories.find((c) => c.id === "compaction");
		expect(compactionCat).toBeDefined();
	});

	it("counts custom_messages from session branch", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					type: "custom_message",
					content: "Custom injected message. " + "w".repeat(100),
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		const messagesCat = result.categories.find((c) => c.id === "messages");
		expect(messagesCat).toBeDefined();
		expect(messagesCat!.tokens).toBeGreaterThan(0);
	});

	it("always adds free space as the last category", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: "Hello",
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		const lastCat = result.categories[result.categories.length - 1];
		expect(lastCat?.id).toBe("free");
		expect(lastCat!.tokens).toBeGreaterThan(0);
		expect(lastCat!.percentage).toBeGreaterThan(0);
	});

	it("sorts categories by token count descending", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: "Hello world! " + "a".repeat(5000),
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "call_1",
								name: "bash",
								arguments: { command: "echo hello" + "b".repeat(5000) },
							},
						],
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		const interactive = result.categories.filter((c) => c.id !== "free");
		for (let i = 1; i < interactive.length; i++) {
			expect(interactive[i - 1]!.tokens).toBeGreaterThanOrEqual(interactive[i]!.tokens);
		}
	});

	it("uses contextWindow from model when available", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 50_000 },
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.contextWindow).toBe(50_000);
	});

	it("does NOT count tool results in messages tokens", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: "Hello",
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "call_1",
								name: "bash",
								arguments: { command: "echo hello" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "bash",
						content: [{ type: "text", text: "hello world this is a long result" }],
						isError: false,
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		// Messages category should only include user message, not tool result
		const messagesCat = result.categories.find((c) => c.id === "messages");
		const toolUseCat = result.categories.find((c) => c.id === "tooluse");
		expect(messagesCat).toBeDefined();
		expect(toolUseCat).toBeDefined();
		// Tool result tokens should be in toolUse, not messages
		expect(toolUseCat!.tokens).toBeGreaterThan(messagesCat!.tokens);
		// Messages should be small (just the user message)
		expect(messagesCat!.tokens).toBeLessThan(10);
		// Tool result should still be counted in tool usage
		expect(toolUseCat!.tokens).toBeGreaterThan(0);
	});

	it("populates messages array with individual user and agent messages", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					id: "entry1",
					type: "message",
					message: {
						role: "user",
						content: "Hello world",
						timestamp: 1000,
					},
				},
				{
					id: "entry2",
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Hi there! " + "y".repeat(100) }],
						timestamp: 2000,
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.messages).toHaveLength(2);
		const userMsg = result.messages.find((m) => m.role === "user");
		const agentMsg = result.messages.find((m) => m.role === "agent");
		expect(userMsg).toBeDefined();
		expect(userMsg!.entryId).toBe("entry1");
		expect(userMsg!.preview).toContain("Hello world");
		expect(userMsg!.tokens).toBeGreaterThan(0);
		expect(agentMsg).toBeDefined();
		expect(agentMsg!.entryId).toBe("entry2");
		expect(agentMsg!.preview).toContain("Hi there!");
		expect(agentMsg!.tokens).toBeGreaterThan(0);
	});

	it("populates messages array with custom_messages", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					id: "entry1",
					type: "custom_message",
					content: "Custom injected message",
					timestamp: "2024-01-01T00:00:00.000Z",
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.role).toBe("custom");
		expect(result.messages[0]!.entryId).toBe("entry1");
		expect(result.messages[0]!.preview).toBe("Custom injected message");
	});

	it("sorts messages array by token count descending", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					id: "entry1",
					type: "message",
					message: {
						role: "user",
						content: "Hello",
					},
				},
				{
					id: "entry2",
					type: "message",
					message: {
						role: "user",
						content: "Hello world! " + "a".repeat(500),
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.messages[0]!.entryId).toBe("entry2");
		expect(result.messages[1]!.entryId).toBe("entry1");
		expect(result.messages[0]!.tokens).toBeGreaterThan(result.messages[1]!.tokens);
	});

	it("respects compaction entries and skips messages before firstKeptEntryId", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					id: "old1",
					type: "message",
					message: {
						role: "user",
						content: "Old compacted message. " + "a".repeat(500),
					},
				},
				{
					id: "keep1",
					type: "message",
					message: {
						role: "user",
						content: "Kept message. " + "b".repeat(100),
					},
				},
				{
					id: "compact1",
					type: "compaction",
					summary: "Previous conversation was about testing. " + "c".repeat(100),
					firstKeptEntryId: "keep1",
					tokensBefore: 1000,
				},
				{
					id: "new1",
					type: "message",
					message: {
						role: "user",
						content: "New message after compaction.",
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		// The old compacted message should NOT be counted
		expect(result.messages.find((m) => m.entryId === "old1")).toBeUndefined();

		// The kept message should be counted
		expect(result.messages.find((m) => m.entryId === "keep1")).toBeDefined();

		// The new message should be counted
		expect(result.messages.find((m) => m.entryId === "new1")).toBeDefined();

		// The compaction summary should be counted
		expect(result.compactionTokens).toBeGreaterThan(0);
		const compactionCat = result.categories.find((c) => c.id === "compaction");
		expect(compactionCat).toBeDefined();
		expect(compactionCat!.tokens).toBeGreaterThan(0);
	});

	it("counts compaction summary from compaction entry type", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					id: "keep1",
					type: "message",
					message: {
						role: "user",
						content: "Hello",
					},
				},
				{
					id: "compact1",
					type: "compaction",
					summary: "Compacted summary text. " + "z".repeat(100),
					firstKeptEntryId: "keep1",
					tokensBefore: 500,
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.compactionTokens).toBeGreaterThan(0);
		expect(result.categories.find((c) => c.id === "compaction")).toBeDefined();
	});

	it("extracts thinking content from assistant messages", () => {
		const ctx = makeMockCtx({
			model: { provider: "anthropic", id: "claude-test", contextWindow: 100_000 },
			branch: [
				{
					id: "entry1",
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Let me think about this. " + "t".repeat(100) },
							{ type: "text", text: "Here is my answer. " + "a".repeat(50) },
						],
					},
				},
			],
		});
		const pi = makeMockPi([]);
		const result = buildBreakdown(pi, ctx, null);

		expect(result.messageBreakdown.thinkingTokens).toBeGreaterThan(0);
		const agentMsg = result.messages.find((m) => m.role === "agent");
		expect(agentMsg).toBeDefined();
		expect(agentMsg!.thinking).toBeDefined();
		expect(agentMsg!.thinkingTokens).toBeGreaterThan(0);
		// Thinking should be counted in agent tokens too
		expect(result.messageBreakdown.agentTokens).toBeGreaterThan(agentMsg!.thinkingTokens);
	});
});
