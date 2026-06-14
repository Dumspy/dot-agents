import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { SupermemoryClient } from "./client.ts";
import { getTags } from "./tags.ts";
import { formatContextForPrompt } from "./context.ts";
import { registerSupermemoryTool } from "./tool.ts";
import { registerSupermemoryCommands } from "./commands.ts";

interface CustomMessage {
	role: "custom";
	customType: string;
	content: string | Array<{ type: "text"; text: string }>;
	display: boolean;
	timestamp: number;
}

const MEMORY_NUDGE_MESSAGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. You MUST use the \`supermemory\` tool with \`mode: "add"\` to save this information.

Extract the key information the user wants remembered and save it as a concise, searchable memory.
- Use \`scope: "project"\` for project-specific preferences (e.g., "run lint with tests")
- Use \`scope: "user"\` for cross-project preferences (e.g., "prefers concise responses")
- Choose an appropriate \`type\`: "preference", "project-config", "learned-pattern", etc.

DO NOT skip this step. The user explicitly asked you to remember.`;

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const client = new SupermemoryClient(config);
	let tags: { user: string; project: string } | null = null;
	let firstUserQuery: string | null = null;
	let shouldNudge = false;
	const injectedSessions = new Set<string>();

	const keywordPattern = new RegExp(
		`\\b(${config.keywordPatterns.join("|")})\\b`,
		"i",
	);

	function resolveTags(ctx: ExtensionContext): { user: string; project: string } {
		if (!tags) {
			tags = getTags(ctx.cwd);
		}
		return tags;
	}

	registerSupermemoryTool(pi, config, client, resolveTags);
	registerSupermemoryCommands(pi, config, client, resolveTags);

	pi.on("input", async (event) => {
		if (!config.enabled || !client.isConfigured()) {
			return { action: "continue" };
		}

		const text = event.text;
		if (firstUserQuery === null) {
			firstUserQuery = text;
		}

		const textWithoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
		if (keywordPattern.test(textWithoutCode)) {
			shouldNudge = true;
		}

		return { action: "continue" };
	});

	pi.on("before_agent_start", async () => {
		if (!shouldNudge) {
			return {};
		}
		shouldNudge = false;
		return {
			message: {
				role: "custom",
				customType: "supermemory-nudge",
				content: MEMORY_NUDGE_MESSAGE,
				display: false,
				timestamp: Date.now(),
			},
		};
	});

	pi.on("context", async (event, ctx) => {
		if (!config.enabled || !client.isConfigured() || !config.injectProfile) {
			return { messages: event.messages };
		}

		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || injectedSessions.has(sessionFile)) {
			return { messages: event.messages };
		}

		const query = firstUserQuery ?? "";
		const tags = resolveTags(ctx);

		try {
			const [profileResult, projectResult, userResult] = await Promise.all([
				client.getProfile(tags.user),
				client.listMemories(tags.project, 10),
				query ? client.searchMemories(query, tags.user, 5) : null,
			]);

			const profile = profileResult.success ? profileResult : null;
			const projectMemories = projectResult.success
				? { results: projectResult.results.map((m) => ({ ...m, similarity: 1 })) }
				: { results: [] };
			const userMemories = userResult?.success ? userResult : { results: [] };

			const contextText = formatContextForPrompt(
				profile,
				projectMemories,
				userMemories,
				5,
			);

			if (contextText) {
				const injectedMessage: CustomMessage = {
					role: "custom",
					customType: "supermemory",
					content: [{ type: "text", text: contextText }],
					display: false,
					timestamp: Date.now(),
				};
				const messages = [...event.messages];
				messages.push(injectedMessage);
				injectedSessions.add(sessionFile);
				return { messages };
			}
		} catch {
			// Fail open: return original messages.
		}

		return { messages: event.messages };
	});

	pi.on("session_start", async () => {
		firstUserQuery = null;
		shouldNudge = false;
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!config.enabled || !client.isConfigured()) {
			return;
		}

		const tags = resolveTags(ctx);
		const summary = event.compactionEntry?.summary ?? "";
		if (!summary) {
			return;
		}

		const result = await client.addMemory(
			`[Session Summary]\n${summary}`,
			tags.project,
			{
				type: "conversation",
				sm_capture_mode: "compaction",
			},
		);

		if (!result.success) {
			ctx.ui.notify(`SuperMemory compaction save failed: ${result.error}`, "error");
		}
	});
}
