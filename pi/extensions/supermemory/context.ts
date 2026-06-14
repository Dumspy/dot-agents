import { DEFAULTS } from "./config.ts";
import type { SearchResult } from "./client.ts";

export function formatContextForPrompt(
	profile: { static: string[]; dynamic: string[] } | null,
	projectMemories: { results: SearchResult[] },
	userMemories: { results: SearchResult[] },
	maxProfileItems = DEFAULTS.maxProfileItems,
): string {
	const parts: string[] = ["[SUPERMEMORY]"];

	if (profile) {
		if (profile.static.length > 0) {
			parts.push("\nUser Profile:");
			for (const fact of profile.static.slice(0, maxProfileItems)) {
				parts.push(`- ${fact}`);
			}
		}
		if (profile.dynamic.length > 0) {
			parts.push("\nRecent Context:");
			for (const fact of profile.dynamic.slice(0, maxProfileItems)) {
				parts.push(`- ${fact}`);
			}
		}
	}

	if (projectMemories.results.length > 0) {
		parts.push("\nProject Knowledge:");
		for (const mem of projectMemories.results) {
			const similarity = Math.round(mem.similarity * 100);
			parts.push(`- [${similarity}%] ${mem.content}`);
		}
	}

	if (userMemories.results.length > 0) {
		parts.push("\nRelevant User Memories:");
		for (const mem of userMemories.results) {
			const similarity = Math.round(mem.similarity * 100);
			parts.push(`- [${similarity}%] ${mem.content}`);
		}
	}

	if (parts.length === 1) {
		return "";
	}

	return parts.join("\n");
}
