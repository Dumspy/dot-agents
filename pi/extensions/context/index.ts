import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ContextOverlay } from "./overlay.ts";
import { buildBreakdown } from "./capture.ts";
import type { CapturedState } from "./types.ts";

export default function (pi: ExtensionAPI) {
	let capturedState: CapturedState | null = null;

	pi.on("before_agent_start", async (event) => {
		capturedState = {
			systemPrompt: event.systemPrompt,
			systemPromptOptions: event.systemPromptOptions,
		};
	});

	pi.on("session_start", async () => {
		// Reset captured state for new sessions
		capturedState = null;
	});

	pi.on("session_shutdown", async () => {
		capturedState = null;
	});

	pi.registerCommand("context", {
		description: "Show context window token breakdown",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/context requires TUI mode", "error");
				return;
			}

			// Build breakdown using captured state or fallbacks
			const breakdown = buildBreakdown(pi, ctx, capturedState);

			await ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
				const overlay = new ContextOverlay(breakdown, theme, tui, () => done(undefined));
				return {
					render: (width) => overlay.render(width),
					invalidate: () => overlay.invalidate(),
					handleInput: (data) => overlay.handleInput(data),
				};
			}, {
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "60%",
					minWidth: 50,
					margin: 2,
				},
			});
		},
	});
}
