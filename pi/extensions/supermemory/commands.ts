import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import type { SupermemoryClient } from "./client.ts";
import { isFullyPrivate, stripPrivateContent } from "./privacy.ts";
import type { SupermemoryConfig } from "./config.ts";
import { buildInitMessage } from "./init.ts";

export function registerSupermemoryCommands(
	pi: ExtensionAPI,
	config: SupermemoryConfig,
	client: SupermemoryClient,
	getTags: (ctx: ExtensionContext) => { user: string; project: string },
) {
	pi.registerCommand("supermemory", {
		description: "SuperMemory commands: status, save-file, init",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0];

			if (!subcommand || subcommand === "status") {
				return handleStatus(config, client, getTags, ctx);
			}

			if (subcommand === "save-file") {
				const path = parts[1];
				const containerTag = parts[2];
				return handleSaveFile(path, containerTag, client, getTags, ctx);
			}

			if (subcommand === "init") {
				return handleInit(pi, ctx);
			}

			ctx.ui.notify(`Unknown /supermemory subcommand: ${subcommand}`, "error");
		},
	});
}

async function handleStatus(
	config: SupermemoryConfig,
	client: SupermemoryClient,
	getTags: (ctx: ExtensionContext) => { user: string; project: string },
	ctx: ExtensionCommandContext,
) {
	const tags = getTags(ctx);
	let connectionState = "unknown";

	if (!client.isConfigured()) {
		connectionState = "missing API key";
	} else {
		const result = await client.getProfile(tags.user);
		connectionState = result.success ? "connected" : `error: ${result.error}`;
	}

	const lines = [
		"SuperMemory status:",
		`  enabled: ${config.enabled}`,
		`  baseUrl: ${config.baseUrl}`,
		`  apiKey: ${client.isConfigured() ? "set" : "not set"}`,
		`  injectProfile: ${config.injectProfile}`,
		`  userContainer: ${tags.user}`,
		`  projectContainer: ${tags.project}`,
		`  connection: ${connectionState}`,
	];

	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleSaveFile(
	path: string | undefined,
	containerTagArg: string | undefined,
	client: SupermemoryClient,
	getTags: (ctx: ExtensionContext) => { user: string; project: string },
	ctx: ExtensionCommandContext,
) {
	if (!path) {
		ctx.ui.notify("Usage: /supermemory save-file <path> [containerTag]", "error");
		return;
	}

	if (!client.isConfigured()) {
		ctx.ui.notify("SUPERMEMORY_API_KEY is not set.", "error");
		return;
	}

	const tags = getTags(ctx);
	const containerTag = containerTagArg ?? tags.project;

	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (error) {
		ctx.ui.notify(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	if (isFullyPrivate(content)) {
		ctx.ui.notify("Cannot save fully private content.", "error");
		return;
	}

	const sanitized = stripPrivateContent(content);
	const result = await client.addMemory(sanitized, containerTag, {
		sm_capture_mode: "command",
	});

	if (!result.success) {
		ctx.ui.notify(`Failed to save file: ${result.error}`, "error");
		return;
	}

	ctx.ui.notify(`Saved ${path} to ${containerTag} (id: ${result.id})`, "info");
}

async function handleInit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
) {
	const message = await buildInitMessage(ctx.cwd);

	pi.sendMessage(
		{
			customType: "supermemory-init",
			content: message,
			display: true,
		},
		{ triggerTurn: true },
	);
}
