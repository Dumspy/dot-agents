import type { BuildSystemPromptOptions, ThemeColor } from "@earendil-works/pi-coding-agent";

export interface CategoryBreakdown {
	id: string;
	name: string;
	tokens: number;
	percentage: number;
	color: ThemeColor;
}

export interface ToolCallInfo {
	toolCallId: string;
	args: string;
	result?: string;
	estimatedTokens: number;
}

export interface ToolUsageInfo {
	toolName: string;
	totalTokens: number;
	totalCalls: number;
	calls: ToolCallInfo[];
}

export interface ToolDefInfo {
	toolName: string;
	schemaTokens: number;
}

export interface MessageInfo {
	entryId: string;
	role: "user" | "agent" | "custom";
	tokens: number;
	preview: string;
	thinking?: string;
	thinkingTokens?: number;
	timestamp: number;
}

export interface MessageBreakdown {
	userTokens: number;
	agentTokens: number;
	thinkingTokens: number;
}

export interface ContextBreakdown {
	modelName: string;
	contextWindow: number;
	actualTokens: number;
	estimatedTokens: number;
	categories: CategoryBreakdown[];
	toolUsage: ToolUsageInfo[];
	toolDefinitions: ToolDefInfo[];
	messageBreakdown: MessageBreakdown;
	messages: MessageInfo[];
	compactionTokens: number;
	imageCount: number;
	imageTokens: number;
}

export interface CapturedState {
	systemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions;
}

export type Screen = "main" | "toolUsage" | "toolCalls" | "toolDefs" | "messages" | "userMessages" | "agentMessages" | "messagePreview";
