import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function shouldExit(text: string): boolean {
	return text.trim() === "exit";
}

export default function exitExtension(pi: ExtensionAPI) {
	// Register /exit command
	pi.registerCommand("exit", {
		description: "Exit pi",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	// Catch raw "exit" messages before they enter the session
	pi.on("input", async (event, ctx) => {
		if (shouldExit(event.text)) {
			ctx.shutdown();
			return { action: "handled" };
		}
	});
}
