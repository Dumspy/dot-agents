import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export interface CategoryBreakdown {
	id: string;
	name: string;
	tokens: number;
	percentage: number;
	color: string;
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

export interface ContextBreakdown {
	modelName: string;
	contextWindow: number;
	actualTokens: number;
	estimatedTokens: number;
	categories: CategoryBreakdown[];
	toolUsage: ToolUsageInfo[];
	toolDefinitions: ToolDefInfo[];
	compactionTokens: number;
	imageCount: number;
	imageTokens: number;
}

export interface CapturedState {
	systemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions;
}

export type Screen = "main" | "toolUsage" | "toolCalls" | "toolDefs";
