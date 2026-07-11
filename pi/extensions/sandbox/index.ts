/**
 * Sandbox extension — flag loader and tier selector.
 *
 * Three tiers, mutually exclusive at the loader level:
 *
 *  - default (no flag): bubblewrap always-on. Wraps `bash` only; path tools
 *    (read/write/edit) run host-side gated by the permission-system extension.
 *    Lowest overhead; the always-on floor.
 *  - `--sandbox`: Gondolin micro-VM. Wraps *all* path tools + bash; ~/.ssh and
 *    credentials are simply not mounted. Strongest containment; opt-in
 *    escalation for untrusted repos or unmonitored subagents.
 *  - `--no-sandbox`: neither sandbox loaded; the permission-system extension
 *    runs alone with static denies + external_directory ask. Explicit escape
 *    hatch for machines where even bubblewrap is undesired.
 *
 * Subagents inherit the parent's flag: a subagent extension reads
 * `pi.getFlag("sandbox")` / `pi.getFlag("no-sandbox")` and forwards the same
 * flag to the child `pi` invocation. Children then load this extension and
 * engage the matching tier automatically.
 *
 * Mutual exclusivity: `--sandbox` and `--no-sandbox` together resolves to
 * `--no-sandbox` with a warning.
 *
 * Degradation: when the selected tier cannot engage (missing bubblewrap binary,
 * unsupported platform, nested container, Gondolin dep missing, QEMU absent),
 * the loader degrades LOUDLY — a startup warning plus a persistent footer
 * status slot — and continues with the next-strongest available tier, ending
 * at static-only (permission-system extension alone, which still enforces the
 * curated global bash denies + path deny list + external_directory ask).
 *
 * Runtime status is shown in a footer slot via `ctx.ui.setStatus("sandbox", ...)`
 * alongside the model and thinking-level indicators:
 *   🔒 bwrap                       — bubblewrap engaged (default)
 *   ocia Gondolin VM               — Gondolin VM engaged (--sandbox)
 *   ⚠ no-sandbox                   — explicit escape hatch (--no-sandbox)
 *   ⚠ static-only (bwrap unavail.) — bubblewrap couldn't engage; static layer only
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SandboxMode = "bwrap" | "gondolin" | "none" | "static-only";

export default function sandboxExtension(pi: ExtensionAPI) {
	pi.registerFlag("sandbox", {
		description: "Run with full Gondolin micro-VM isolation (all tools VM-backed; escalation tier)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-sandbox", {
		description: "Disable the always-on sandbox; run with the static permission layer only",
		type: "boolean",
		default: false,
	});

	let mode: SandboxMode = "bwrap";

	function setFooter(ctx: ExtensionContext, mode: SandboxMode) {
		const label =
			mode === "bwrap"
				? ctx.ui.theme.fg("accent", "🔒 bwrap")
				: mode === "gondolin"
					? ctx.ui.theme.fg("accent", "ocia Gondolin VM")
					: mode === "none"
						? ctx.ui.theme.fg("warning", "⚠ no-sandbox")
						: ctx.ui.theme.fg("warning", "⚠ static-only (bwrap unavailable)");
		ctx.ui.setStatus("sandbox", label);
	}

	pi.on("session_start", async (_event, ctx) => {
		const sandboxFlag = Boolean(pi.getFlag("sandbox"));
		const noSandboxFlag = Boolean(pi.getFlag("no-sandbox"));

		if (sandboxFlag && noSandboxFlag) {
			ctx.ui.notify("--sandbox and --no-sandbox are mutually exclusive; honoring --no-sandbox.", "warning");
		}

		// Explicit escape hatch.
		if (noSandboxFlag) {
			mode = "none";
			setFooter(ctx, mode);
			return;
		}

		// Escalation tier: try Gondolin, fall back to bubblewrap if unavailable.
		if (sandboxFlag) {
			try {
				const { setupGondolin } = await import("./gondolin.ts");
				const engaged = await setupGondolin(pi, ctx);
				if (engaged) {
					mode = "gondolin";
					setFooter(ctx, mode);
					return;
				}
				// setupGondolin returned false (config disabled or VM failed) — fall through.
			} catch (err) {
				ctx.ui.notify(
					`⚠ Gondolin unavailable (${err instanceof Error ? err.message : err}). Requires @earendil-works/gondolin + QEMU + Node >= 23.6. Falling back to bubblewrap.`,
					"warning",
				);
			}
			// Fall through to bubblewrap as the next-strongest tier.
		}

		// Default always-on tier: bubblewrap.
		try {
			const { setupBwrap } = await import("./bwrap.ts");
			const engaged = await setupBwrap(pi, ctx);
			if (engaged) {
				mode = "bwrap";
				setFooter(ctx, mode);
				return;
			}
		} catch (err) {
			ctx.ui.notify(
				`⚠ Bubblewrap sandbox failed to load: ${err instanceof Error ? err.message : err}.`,
				"warning",
			);
		}

		// Nothing engaged — degrade loudly to static-only.
		mode = "static-only";
		setFooter(ctx, mode);
		ctx.ui.notify(
			[
				"⚠ Sandbox unavailable: running with the static permission layer only.",
				"  - bash commands run unsandboxed; the curated global denies (sudo,",
				"    nixos-rebuild, shutdown, reboot, mkfs, ...) still apply via the",
				"    permission-system extension.",
				"  - Install bubblewrap (bwrap) to enable the always-on sandbox, or",
				"    pass --no-sandbox to silence this warning.",
			].join("\n"),
			"warning",
		);
	});

	pi.registerCommand("sandbox", {
		description: "Show the active sandbox tier and config pointers",
		handler: async (_args, cmdCtx) => {
			const label =
				mode === "bwrap"
					? "bubblewrap (always-on default) — bash sandboxed; path tools host-side with permission-system rules"
					: mode === "gondolin"
						? "Gondolin micro-VM (--sandbox) — all path tools + bash run in the VM; ~/.ssh un-mounted"
						: mode === "none"
							? "no sandbox (--no-sandbox) — static permission layer only"
							: "static-only (bubblewrap unavailable) — static permission layer only";
			cmdCtx.ui.notify(
				[
					`Active sandbox tier: ${label}`,
					"",
					"Config files:",
					"  bubblewrap: ~/.pi/agent/extensions/sandbox.json or <cwd>/.pi/sandbox.json",
					"  gondolin:   ~/.pi/agent/extensions/sandbox-gondolin.json or <cwd>/.pi/sandbox-gondolin.json",
					"",
					"Flags:",
					"  --sandbox     engage Gondolin micro-VM (escalation tier)",
					"  --no-sandbox  disable sandbox (static layer only)",
					"",
					"Subagents inherit the parent's flag automatically.",
				].join("\n"),
				"info",
			);
		},
	});
}