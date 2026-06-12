import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CapturedState, ContextBreakdown, ToolUsageInfo, ToolCallInfo, ToolDefInfo, CategoryBreakdown } from "./types.ts";
import { estimateTokens, estimateTokensFromJson } from "./estimate.ts";

interface SessionEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		summary?: string;
		toolName?: string;
		toolCallId?: string;
		details?: unknown;
		isError?: boolean;
	};
	content?: unknown;
}

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof (part as { text: unknown }).text === "string");

const isImagePart = (part: unknown): part is { type: "image"; data: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "image" && "data" in part && typeof (part as { data: unknown }).data === "string");

const isToolCallPart = (part: unknown): part is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "toolCall" && "name" in part && "arguments" in part);

const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(isTextPart).map((p) => p.text).join("\n");
};

const extractImageCount = (content: unknown): number => {
	if (!Array.isArray(content)) return 0;
	return content.filter(isImagePart).length;
};

const estimateImageTokens = (content: unknown): number => {
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (isImagePart(part)) {
			// Rough estimate: base64 chars / 3.5 as a rough proxy
			total += estimateTokens(part.data);
		}
	}
	return total;
};

const truncateArgs = (args: string, maxLen = 60): string => {
	if (args.length <= maxLen) return args;
	return args.slice(0, maxLen - 1) + "…";
};

export function buildBreakdown(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	captured: CapturedState | null,
): ContextBreakdown {
	const model = ctx.model;
	const modelName = model ? `${model.provider}/${model.id}` : "unknown";
	const contextWindow = model?.contextWindow ?? 200_000;

	const usage = ctx.getContextUsage();
	const actualTokens = usage?.tokens ?? 0;

	// Fallback to getSystemPromptOptions if no captured state
	const options = captured?.systemPromptOptions ?? ctx.getSystemPromptOptions?.() ?? { cwd: ctx.cwd };
	const systemPrompt = captured?.systemPrompt ?? ctx.getSystemPrompt?.() ?? "";

	// 1. System prompt
	const systemPromptTokens = estimateTokens(systemPrompt);

	// 2. Tool definitions
	const allTools = pi.getAllTools();
	const activeToolNames = new Set(options.selectedTools ?? []);
	const toolDefinitions: ToolDefInfo[] = [];
	let toolDefTokens = 0;

	for (const tool of allTools) {
		if (!activeToolNames.has(tool.name)) continue;
		const schemaTokens = estimateTokensFromJson(tool.parameters);
		toolDefinitions.push({ toolName: tool.name, schemaTokens });
		toolDefTokens += schemaTokens;
	}

	// 3. Skills
	let skillsTokens = 0;
	for (const skill of options.skills ?? []) {
		skillsTokens += estimateTokens(skill.description);
	}

	// 4. Context files
	let contextFilesTokens = 0;
	for (const file of options.contextFiles ?? []) {
		contextFilesTokens += estimateTokens(file.content);
	}

	// 5. Messages + tool usage + images + compaction
	let messagesTokens = 0;
	let userTokens = 0;
	let agentTokens = 0;
	let imageTokens = 0;
	let imageCount = 0;
	let compactionTokens = 0;

	const toolCallsMap = new Map<string, ToolCallInfo>();
	const toolUsageMap = new Map<string, ToolUsageInfo>();

	const branch = ctx.sessionManager.getBranch();

	let branchTokens = 0;

	for (const entry of branch as SessionEntry[]) {
		if (entry.type === "custom_message" && entry.content) {
			// Extension-injected messages that participate in LLM context
			const text = extractText(entry.content);
			const tokens = estimateTokens(text);
			messagesTokens += tokens;
			agentTokens += tokens; // Custom messages are from the agent side
			imageCount += extractImageCount(entry.content);
			imageTokens += estimateImageTokens(entry.content);
			continue;
		}

		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;

		// Compaction summary
		if (msg.role === "compactionSummary" && typeof msg.summary === "string") {
			compactionTokens += estimateTokens(msg.summary);
			continue;
		}

		// Branch summary
		if (msg.role === "branchSummary" && typeof msg.summary === "string") {
			branchTokens += estimateTokens(msg.summary);
			continue;
		}

		// User messages, assistant messages, custom messages
		if (msg.role === "user" || msg.role === "custom" || msg.role === "assistant") {
			const text = extractText(msg.content);
			const tokens = estimateTokens(text);
			messagesTokens += tokens;
			if (msg.role === "user") {
				userTokens += tokens;
			} else {
				agentTokens += tokens;
			}
			imageCount += extractImageCount(msg.content);
			imageTokens += estimateImageTokens(msg.content);
		}

		// Extract tool calls from assistant messages
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (isToolCallPart(part)) {
					const argsStr = JSON.stringify(part.arguments);
					const callTokens = estimateTokens(argsStr);
					toolCallsMap.set(part.id, {
						toolCallId: part.id,
						args: truncateArgs(argsStr),
						estimatedTokens: callTokens,
					});
					// Add to tool usage map
					const info = toolUsageMap.get(part.name) ?? {
						toolName: part.name,
						totalTokens: 0,
						totalCalls: 0,
						calls: [],
					};
					info.totalTokens += callTokens;
					info.totalCalls += 1;
					info.calls.push(toolCallsMap.get(part.id)!);
					toolUsageMap.set(part.name, info);
				}
			}
		}

		// Tool results
		if (msg.role === "toolResult") {
			const resultText = extractText(msg.content);
			const resultTokens = estimateTokens(resultText);
			messagesTokens += resultTokens;

			// Attribute to tool usage
			const callInfo = toolCallsMap.get(msg.toolCallId ?? "");
			if (callInfo && msg.toolName) {
				callInfo.result = resultText;
				callInfo.estimatedTokens += resultTokens;
				const info = toolUsageMap.get(msg.toolName);
				if (info) {
					info.totalTokens += resultTokens;
				}
			}
		}
	}

	const toolUsage = Array.from(toolUsageMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);
	let toolUsageTokens = 0;
	for (const tu of toolUsage) {
		toolUsageTokens += tu.totalTokens;
	}

	// Build categories
	const categories: CategoryBreakdown[] = [
		{ id: "tooluse", name: "Tool use & results", tokens: toolUsageTokens, percentage: 0, color: "warning" },
		{ id: "system", name: "System prompt", tokens: systemPromptTokens, percentage: 0, color: "accent" },
		{ id: "tools", name: "Tool definitions", tokens: toolDefTokens, percentage: 0, color: "muted" },
		{ id: "skills", name: "Skills", tokens: skillsTokens, percentage: 0, color: "error" },
		{ id: "context", name: "Context files", tokens: contextFilesTokens, percentage: 0, color: "success" },
		{ id: "messages", name: "Messages", tokens: messagesTokens, percentage: 0, color: "toolTitle" },
		{ id: "images", name: "Images", tokens: imageTokens, percentage: 0, color: "warning" },
		{ id: "compaction", name: "Compaction summaries", tokens: compactionTokens, percentage: 0, color: "dim" },
		{ id: "branch", name: "Branch summaries", tokens: branchTokens, percentage: 0, color: "dim" },
	];

	// Remove empty categories
	const nonEmpty = categories.filter((c) => c.tokens > 0);
	// Sort by token count descending
	nonEmpty.sort((a, b) => b.tokens - a.tokens);

	// Calculate percentages based on context window
	for (const cat of nonEmpty) {
		cat.percentage = contextWindow > 0 ? (cat.tokens / contextWindow) * 100 : 0;
	}

	const estimatedTokens = nonEmpty.reduce((sum, c) => sum + c.tokens, 0);
	const freeSpace = Math.max(0, contextWindow - estimatedTokens);

	// Add free space as last category
	nonEmpty.push({
		id: "free",
		name: "Free space",
		tokens: freeSpace,
		percentage: contextWindow > 0 ? (freeSpace / contextWindow) * 100 : 0,
		color: "dim",
	});

	return {
		modelName,
		contextWindow,
		actualTokens,
		estimatedTokens,
		categories: nonEmpty,
		toolUsage,
		toolDefinitions: toolDefinitions.sort((a, b) => b.schemaTokens - a.schemaTokens),
		messageBreakdown: { userTokens, agentTokens },
		compactionTokens,
		imageCount,
		imageTokens,
	};
}
