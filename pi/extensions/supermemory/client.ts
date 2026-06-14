import Supermemory from "supermemory";
import { DEFAULTS, type MemoryType, type SupermemoryConfig } from "./config.ts";

const TIMEOUT_MS = DEFAULTS.timeoutMs;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
		),
	]);
}

export interface SearchResult {
	id: string;
	content: string;
	similarity: number;
}

export interface ListResult {
	id: string;
	content: string;
	createdAt: string;
}

export class SupermemoryClient {
	private client: Supermemory | null = null;
	private config: SupermemoryConfig;

	constructor(config: SupermemoryConfig) {
		this.config = config;
	}

	isConfigured(): boolean {
		return !!this.config.apiKey;
	}

	private getClient(): Supermemory {
		if (!this.client) {
			if (!this.config.apiKey) {
				throw new Error("SUPERMEMORY_API_KEY not set");
			}
			this.client = new Supermemory({
				apiKey: this.config.apiKey,
				baseURL: this.config.baseUrl,
				defaultHeaders: { "x-sm-source": "pi" },
			});
			this.client.settings
				.update({
					shouldLLMFilter: true,
					filterPrompt: DEFAULTS.filterPrompt,
				})
				.catch(() => {
					// Non-fatal: filtering will use server defaults.
				});
		}
		return this.client;
	}

	async addMemory(
		content: string,
		containerTag: string,
		metadata?: { type?: MemoryType; sm_capture_mode?: string },
	): Promise<{ success: true; id: string } | { success: false; error: string }> {
		try {
			const mergedMetadata: Record<string, string | number | boolean | string[]> = {
				sm_source: "pi",
				sm_capture_mode: metadata?.sm_capture_mode ?? "tool",
			};
			if (metadata?.type) {
				mergedMetadata.type = metadata.type;
			}
			const result = await withTimeout(
				this.getClient().add({
					content,
					containerTag,
					metadata: mergedMetadata,
				}),
				TIMEOUT_MS,
			);
			return { success: true, id: result.id };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async searchMemories(
		query: string,
		containerTag: string,
		limit: number = DEFAULTS.maxMemories,
	): Promise<{ success: true; results: SearchResult[] } | { success: false; error: string }> {
		try {
			const result = await withTimeout(
				this.getClient().search.memories({
					q: query,
					containerTag,
					threshold: DEFAULTS.similarityThreshold,
					limit,
					searchMode: "hybrid",
				}),
				TIMEOUT_MS,
			);
			const results: SearchResult[] = (result.results ?? []).map((r) => ({
				id: r.id,
				content: (r.memory ?? r.chunk ?? "").toString(),
				similarity: r.similarity ?? 0,
			}));
			return { success: true, results };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async getProfile(
		containerTag: string,
		query?: string,
	): Promise<
		| { success: true; static: string[]; dynamic: string[] }
		| { success: false; error: string }
	> {
		try {
			const result = await withTimeout(
				this.getClient().profile({
					containerTag,
					q: query,
					threshold: DEFAULTS.similarityThreshold,
				}),
				TIMEOUT_MS,
			);
			const profile = result.profile;
			return {
				success: true,
				static: (profile?.static ?? []).map((f) => String(f)),
				dynamic: (profile?.dynamic ?? []).map((f) => String(f)),
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async listMemories(
		containerTag: string,
		limit: number = DEFAULTS.maxProjectMemories,
	): Promise<{ success: true; results: ListResult[] } | { success: false; error: string }> {
		try {
			const result = await withTimeout(
				this.getClient().documents.list({
					containerTags: [containerTag],
					limit,
					order: "desc",
					sort: "createdAt",
					includeContent: true,
				}),
				TIMEOUT_MS,
			);
			const memories = result.memories ?? [];
			const results: ListResult[] = memories.map((m) => ({
				id: m.id,
				content: (m.summary ?? m.content ?? "").toString(),
				createdAt: m.createdAt,
			}));
			return { success: true, results };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async forgetMemory(
		memoryId: string,
		containerTag: string,
	): Promise<{ success: true } | { success: false; error: string }> {
		try {
			await withTimeout(
				this.getClient().memories.forget({
					containerTag,
					id: memoryId,
				}),
				TIMEOUT_MS,
			);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
