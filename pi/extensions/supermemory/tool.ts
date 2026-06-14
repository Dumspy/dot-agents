import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { SupermemoryClient } from "./client.ts";
import { isFullyPrivate, stripPrivateContent } from "./privacy.ts";
import type { MemoryScope, MemoryType, SupermemoryConfig } from "./config.ts";

interface ToolParams {
	mode: "add" | "search" | "profile" | "list" | "forget";
	content?: string;
	query?: string;
	type?: MemoryType;
	scope?: MemoryScope;
	memoryId?: string;
	limit?: number;
}

function text(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

export function registerSupermemoryTool(
	pi: ExtensionAPI,
	config: SupermemoryConfig,
	client: SupermemoryClient,
	getTags: (ctx: ExtensionContext) => { user: string; project: string },
) {
	pi.registerTool({
		name: "supermemory",
		label: "SuperMemory",
		description: "Manage and query the Supermemory persistent memory system.",
		promptSnippet: "Search or save persistent memories across sessions",
		parameters: Type.Object({
			mode: StringEnum(["add", "search", "profile", "list", "forget"] as const),
			content: Type.Optional(Type.String()),
			query: Type.Optional(Type.String()),
			type: Type.Optional(
				StringEnum([
					"project-config",
					"architecture",
					"error-solution",
					"preference",
					"learned-pattern",
					"conversation",
				] as const),
			),
			scope: Type.Optional(StringEnum(["user", "project"] as const)),
			memoryId: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!config.enabled) {
				return { content: [text("SuperMemory is disabled.")], details: {} };
			}
			if (!client.isConfigured()) {
				throw new Error("SUPERMEMORY_API_KEY is not set.");
			}

			const tags = getTags(ctx);
			const toolParams = params as ToolParams;
			const mode = toolParams.mode;

			switch (mode) {
				case "add":
					return handleAdd(toolParams, client, tags);
				case "search":
					return handleSearch(toolParams, client, tags);
				case "profile":
					return handleProfile(toolParams, client, tags);
				case "list":
					return handleList(toolParams, client, tags);
				case "forget":
					return handleForget(toolParams, client, tags);
			}

			throw new Error(`Unknown mode: ${toolParams.mode}`);
		},
	});
}

async function handleAdd(
	params: ToolParams,
	client: SupermemoryClient,
	tags: { user: string; project: string },
): Promise<AgentToolResult<unknown>> {
	if (!params.content) {
		throw new Error("Content is required for add mode.");
	}
	if (isFullyPrivate(params.content)) {
		throw new Error("Cannot store fully private content.");
	}

	const scope = params.scope ?? "project";
	const containerTag = scope === "user" ? tags.user : tags.project;
	const sanitizedContent = stripPrivateContent(params.content);

	const result = await client.addMemory(sanitizedContent, containerTag, {
		type: params.type,
		sm_capture_mode: "tool",
	});

	if (!result.success) {
		throw new Error(`Failed to add memory: ${result.error}`);
	}

	return {
		content: [text(`Memory added to ${scope} scope (id: ${result.id})`)],
		details: {},
	};
}

async function handleSearch(
	params: ToolParams,
	client: SupermemoryClient,
	tags: { user: string; project: string },
): Promise<AgentToolResult<unknown>> {
	if (!params.query) {
		throw new Error("Query is required for search mode.");
	}

	const limit = params.limit ?? 10;
	const scope = params.scope;

	if (scope === "user") {
		const result = await client.searchMemories(params.query, tags.user, limit);
		return formatSearchResult(params.query, scope, result, limit);
	}

	if (scope === "project") {
		const result = await client.searchMemories(params.query, tags.project, limit);
		return formatSearchResult(params.query, scope, result, limit);
	}

	const [userResult, projectResult] = await Promise.all([
		client.searchMemories(params.query, tags.user, limit),
		client.searchMemories(params.query, tags.project, limit),
	]);

	const error = !userResult.success ? userResult.error : !projectResult.success ? projectResult.error : null;
	if (error) {
		throw new Error(`Search failed: ${error}`);
	}

	const combined = [
		...(userResult.success ? userResult.results : []),
		...(projectResult.success ? projectResult.results : []),
	].sort((a, b) => b.similarity - a.similarity);

	return {
		content: [text(JSON.stringify({
			success: true,
			query: params.query,
			count: combined.length,
			results: combined.slice(0, limit),
		}))],
		details: {},
	};
}

function formatSearchResult(
	query: string,
	scope: MemoryScope | undefined,
	result: { success: true; results: { id: string; content: string; similarity: number }[] } | { success: false; error: string },
	limit: number,
): AgentToolResult<unknown> {
	if (!result.success) {
		throw new Error(`Search failed: ${result.error}`);
	}

	return {
		content: [text(JSON.stringify({
			success: true,
			query,
			scope,
			count: result.results.length,
			results: result.results.slice(0, limit),
		}))],
		details: {},
	};
}

async function handleProfile(
	params: ToolParams,
	client: SupermemoryClient,
	tags: { user: string; project: string },
): Promise<AgentToolResult<unknown>> {
	const result = await client.getProfile(tags.user, params.query);

	if (!result.success) {
		throw new Error(`Failed to fetch profile: ${result.error}`);
	}

	return {
		content: [text(JSON.stringify({
			success: true,
			profile: {
				static: result.static,
				dynamic: result.dynamic,
			},
		}))],
		details: {},
	};
}

async function handleList(
	params: ToolParams,
	client: SupermemoryClient,
	tags: { user: string; project: string },
): Promise<AgentToolResult<unknown>> {
	const scope = params.scope ?? "project";
	const limit = params.limit ?? 20;
	const containerTag = scope === "user" ? tags.user : tags.project;

	const result = await client.listMemories(containerTag, limit);

	if (!result.success) {
		throw new Error(`Failed to list memories: ${result.error}`);
	}

	return {
		content: [text(JSON.stringify({
			success: true,
			scope,
			count: result.results.length,
			memories: result.results,
		}))],
		details: {},
	};
}

async function handleForget(
	params: ToolParams,
	client: SupermemoryClient,
	tags: { user: string; project: string },
): Promise<AgentToolResult<unknown>> {
	if (!params.memoryId) {
		throw new Error("memoryId is required for forget mode.");
	}

	const scope = params.scope ?? "project";
	const containerTag = scope === "user" ? tags.user : tags.project;

	const result = await client.forgetMemory(params.memoryId, containerTag);

	if (!result.success) {
		throw new Error(`Failed to forget memory: ${result.error}`);
	}

	return {
		content: [text(`Memory ${params.memoryId} forgotten from ${scope} scope.`)],
		details: {},
	};
}
