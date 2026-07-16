import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HostBackend } from "./backends/host.js";
import { GondolinBackend } from "./backends/gondolin.js";
import { parseMountArguments } from "./command-line.js";
import { loadSandboxConfig } from "./config.js";
import { assertHostPathAllowed, hostCommandDenial } from "./host-guards.js";
import {
	createGondolinBashOps,
	createGondolinEditOps,
	createGondolinFindOps,
	createGondolinLsOps,
	createGondolinReadOps,
	createGondolinWriteOps,
	executeGondolinGrep,
} from "./operations.js";
import { ExternalAccessRequiredError, SandboxPolicy } from "./policy.js";
import { guestMountPath } from "./paths.js";
import {
	GUEST_WORKSPACE,
	type AccessMode,
	type SandboxBackend,
	type SandboxConfig,
} from "./types.js";

const STATUS_KEY = "sandbox";
const REQUEST_EXTERNAL_PARAMS = Type.Object({
	path: Type.String({ description: "Existing absolute host directory or file path to request" }),
	mode: StringEnum(["read-only", "read-write"] as const, { description: "Requested access level" }),
	reason: Type.Optional(Type.String({ description: "Short explanation shown to the user" })),
});

function agentDirectory(): string {
	return path.join(os.homedir(), ".pi", "agent");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function statusText(backend: SandboxBackend): string {
	const status = backend.status();
	if (backend.mode === "host") return "SANDBOX: OFF";
	if (status.state === "running") return `SANDBOX: GONDOLIN${status.id ? ` ${status.id.slice(0, 8)}` : ""}`;
	if (status.state === "failed") return "SANDBOX: ERROR";
	return `SANDBOX: ${status.state.toUpperCase()}`;
}

export default function sandboxExtension(pi: ExtensionAPI) {
	const workspace = realpathSync(process.cwd());
	const homeDir = os.homedir();
	const policy = new SandboxPolicy(workspace, homeDir);
	const gondolin = new GondolinBackend();
	const host = new HostBackend();
	let backend: SandboxBackend = gondolin;
	let config: SandboxConfig | undefined;
	let lastContext: ExtensionContext | undefined;
	let approvalTail: Promise<void> = Promise.resolve();

	const localRead = createReadTool(workspace);
	const localWrite = createWriteTool(workspace);
	const localEdit = createEditTool(workspace);
	const localBash = createBashTool(workspace);
	const localGrep = createGrepTool(workspace);
	const localFind = createFindTool(workspace);
	const localLs = createLsTool(workspace);

	pi.registerFlag("sandbox", {
		description: "Sandbox backend (gondolin)",
		type: "string",
		default: "gondolin",
	});
	pi.registerFlag("no-sandbox", {
		description: "Run agent tools directly on the host with best-effort guardrails",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx?: ExtensionContext): void {
		const activeContext = ctx ?? lastContext;
		if (!activeContext) return;
		const text = statusText(backend);
		const color = backend.mode === "host" || backend.status().state === "failed" ? "error" : "accent";
		activeContext.ui.setStatus(STATUS_KEY, activeContext.ui.theme.fg(color, text));
	}

	async function serialApproval<T>(operation: () => Promise<T>): Promise<T> {
		const previous = approvalTail;
		let release!: () => void;
		approvalTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async function approveToolPath(
		input: string,
		requestedMode: AccessMode,
		ctx: ExtensionContext,
		reason?: string,
	): Promise<string> {
		try {
			return await policy.prepareToolPath(input, requestedMode);
		} catch (error) {
			if (!(error instanceof ExternalAccessRequiredError)) throw error;
			return serialApproval(async () => {
				try {
					return await policy.prepareToolPath(input, requestedMode);
				} catch (currentError) {
					if (!(currentError instanceof ExternalAccessRequiredError)) throw currentError;
					if (!ctx.hasUI) throw new Error(`External access requires interactive approval: ${currentError.mountRoot}`);
					const broader = currentError.fileRequest ? `The file's parent directory will be exposed: ${currentError.mountRoot}` : "";
					const proposedGuestPath = guestMountPath(
						currentError.mountRoot,
						policy.mounts.list().map((mount) => mount.guestPath),
					);
					const choice = await ctx.ui.select(
						[
							"External directory access",
							`Host path: ${currentError.hostPath}`,
							`Directory: ${currentError.mountRoot}`,
							`Requested: ${currentError.requestedMode}`,
							`Guest path: ${proposedGuestPath}`,
							reason ? `Reason: ${reason}` : "",
							broader,
						].filter(Boolean).join("\n"),
						["Allow read-only", "Allow read-write", "Deny"],
					);
					if (choice === "Deny" || choice === undefined) throw new Error(`External directory access denied: ${currentError.mountRoot}`);
					const approvedMode: AccessMode = choice === "Allow read-write" ? "read-write" : "read-only";
					const mount = policy.approveExternal(currentError, approvedMode);
					await backend.mountExternal(mount);
					ctx.ui.notify(`${mount.hostPath} mounted ${mount.mode} at ${mount.guestPath}`, "info");
					return policy.prepareToolPath(input, requestedMode);
				}
			});
		}
	}

	async function ensureGondolin(ctx: ExtensionContext): Promise<GondolinBackend> {
		if (backend !== gondolin) throw new Error("Gondolin operations requested while sandbox is off");
		if (gondolin.status().state === "running" && !gondolin.isAlive()) {
			gondolin.markFailed(new Error("Gondolin VM process exited"));
		}
		if (gondolin.status().state === "failed") {
			ctx.ui.notify("Recreating Gondolin VM; guest-local state was lost.", "warning");
			updateStatus(ctx);
			await gondolin.recover();
			updateStatus(ctx);
		}
		if (gondolin.status().state !== "running") throw new Error(`Gondolin is not available (${gondolin.status().state})`);
		return gondolin;
	}

	function assertHostPath(value: string, mode: AccessMode): void {
		assertHostPathAllowed({
			value,
			workspace,
			homeDir,
			operation: mode === "read-only" ? "read" : "write",
			additionalProtectedPaths: config?.protectedPaths,
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		policy.mounts.clear();
		const noSandbox = pi.getFlag("no-sandbox") === true;
		const selected = pi.getFlag("sandbox");
		if (!noSandbox && selected !== undefined && selected !== "gondolin") {
			throw new Error(`Unsupported sandbox backend: ${String(selected)}`);
		}
		backend = noSandbox ? host : gondolin;
		config = await loadSandboxConfig({ agentDir: agentDirectory(), workspace, projectTrusted: ctx.isProjectTrusted() });
		updateStatus(ctx);
		try {
			await backend.start({
				workspaceHostPath: workspace,
				workspaceGuestPath: GUEST_WORKSPACE,
				gondolin: config.gondolin,
				protectedPaths: config.protectedPaths,
			});
			updateStatus(ctx);
			if (backend.mode === "host") ctx.ui.notify("Sandbox disabled. Host-mode protections are best-effort only.", "warning");
		} catch (error) {
			updateStatus(ctx);
			ctx.ui.notify(`Sandbox startup failed: ${errorMessage(error)}`, "error");
			throw error;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lastContext = ctx;
		await backend.stop();
		policy.mounts.clear();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastContext = ctx;
		const modeNotice = backend.mode === "host"
			? "SANDBOX IS OFF. Tools execute on the host with best-effort guardrails only."
			: [
					`Commands and filesystem tools execute in a Gondolin VM. The host workspace ${workspace} is mounted at ${GUEST_WORKSPACE}.`,
					"Use request_external_directory before bash needs another host directory, then use the returned /external path.",
					"Prefer webfetch over curl for ordinary web retrieval.",
				].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${modeNotice}` };
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			if (backend.mode === "host") {
				assertHostPath(params.path, "read-only");
				return localRead.execute(id, params, signal, onUpdate);
			}
			const active = await ensureGondolin(ctx);
			const guestPath = await approveToolPath(params.path, "read-only", ctx);
			return createReadTool(GUEST_WORKSPACE, { operations: createGondolinReadOps(() => active.vm) }).execute(
				id,
				{ ...params, path: guestPath },
				signal,
				onUpdate,
			);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			if (backend.mode === "host") {
				assertHostPath(params.path, "read-write");
				return localWrite.execute(id, params, signal, onUpdate);
			}
			const active = await ensureGondolin(ctx);
			const guestPath = await approveToolPath(params.path, "read-write", ctx);
			return createWriteTool(GUEST_WORKSPACE, { operations: createGondolinWriteOps(() => active.vm) }).execute(
				id,
				{ ...params, path: guestPath },
				signal,
				onUpdate,
			);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			if (backend.mode === "host") {
				assertHostPath(params.path, "read-write");
				return localEdit.execute(id, params, signal, onUpdate);
			}
			const active = await ensureGondolin(ctx);
			const guestPath = await approveToolPath(params.path, "read-write", ctx);
			return createEditTool(GUEST_WORKSPACE, { operations: createGondolinEditOps(() => active.vm) }).execute(
				id,
				{ ...params, path: guestPath },
				signal,
				onUpdate,
			);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			if (backend.mode === "host") {
				const denial = hostCommandDenial(params.command, homeDir);
				if (denial) throw new Error(denial);
				return localBash.execute(id, params, signal, onUpdate);
			}
			const active = await ensureGondolin(ctx);
			return createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(() => active.vm, () => active.shellPath),
			}).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			if (backend.mode === "host") {
				assertHostPath(params.path ?? ".", "read-only");
				return localLs.execute(id, params, signal, onUpdate);
			}
			const active = await ensureGondolin(ctx);
			const guestPath = await approveToolPath(params.path ?? ".", "read-only", ctx);
			return createLsTool(GUEST_WORKSPACE, { operations: createGondolinLsOps(() => active.vm) }).execute(
				id,
				{ ...params, path: guestPath },
				signal,
				onUpdate,
			);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			if (backend.mode === "host") {
				assertHostPath(params.path ?? ".", "read-only");
				return localFind.execute(id, params, signal, onUpdate);
			}
			const active = await ensureGondolin(ctx);
			const guestPath = await approveToolPath(params.path ?? ".", "read-only", ctx);
			return createFindTool(GUEST_WORKSPACE, { operations: createGondolinFindOps(() => active.vm) }).execute(
				id,
				{ ...params, path: guestPath },
				signal,
				onUpdate,
			);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (backend.mode === "host") {
				assertHostPath(params.path ?? ".", "read-only");
				return localGrep.execute(_id, params, signal, _onUpdate);
			}
			const active = await ensureGondolin(ctx);
			const guestPath = await approveToolPath(params.path ?? ".", "read-only", ctx);
			return executeGondolinGrep(() => active.vm, { ...params, path: guestPath }, signal);
		},
	});

	pi.registerTool({
		name: "request_external_directory",
		label: "Request external directory",
		description: "Request session-scoped access to an existing host directory for sandboxed bash workflows.",
		promptSnippet: "Request an external host directory and receive its /external guest path",
		parameters: REQUEST_EXTERNAL_PARAMS,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (backend.mode === "host") {
				return {
					content: [{ type: "text", text: `Sandbox is off; use the host path directly: ${params.path}` }],
					details: undefined,
				};
			}
			const guestPath = await approveToolPath(params.path, params.mode, ctx, params.reason);
			return {
				content: [{ type: "text", text: `${params.path} is available at ${guestPath} (${params.mode}).` }],
				details: { hostPath: params.path, guestPath, mode: params.mode, reason: params.reason },
			};
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		lastContext = ctx;
		if (backend.mode === "host") return undefined;
		const active = await ensureGondolin(ctx);
		return { operations: createGondolinBashOps(() => active.vm, () => active.shellPath) };
	});

	pi.registerCommand("sandbox", {
		description: "Show sandbox status and active mounts",
		handler: async (_args, ctx) => {
			const status = backend.status();
			ctx.ui.notify(
				[
					`Mode: ${statusText(backend)}`,
					`Workspace: ${workspace} -> ${GUEST_WORKSPACE}`,
					...(status.error ? [`Error: ${status.error}`] : []),
					...policy.mounts.list().map((mount) => `${mount.hostPath} -> ${mount.guestPath} (${mount.mode})`),
				].join("\n"),
				status.state === "failed" ? "error" : "info",
			);
		},
	});

	pi.registerCommand("mount", {
		description: "Mount an existing absolute host directory into the sandbox",
		handler: async (args, ctx) => {
			if (backend.mode === "host") throw new Error("/mount is unavailable because the sandbox is off");
			await ctx.waitForIdle();
			const parsed = parseMountArguments(args);
			const mount = await policy.addExplicitMount(parsed.path, parsed.mode);
			await backend.mountExternal(mount);
			ctx.ui.notify(`${mount.hostPath} mounted ${mount.mode} at ${mount.guestPath}`, "info");
		},
	});

	pi.registerCommand("mounts", {
		description: "View and modify session external mounts",
		handler: async (_args, ctx) => {
			if (backend.mode === "host") throw new Error("/mounts is unavailable because the sandbox is off");
			await ctx.waitForIdle();
			while (true) {
				const mounts = policy.mounts.list();
				if (mounts.length === 0) {
					ctx.ui.notify("No external directories are mounted.", "info");
					return;
				}
				const choices = [...mounts.map((mount, index) => `${index + 1}. ${mount.hostPath} (${mount.mode})`), "Done"];
				const selected = await ctx.ui.select("External mounts", choices);
				if (!selected || selected === "Done") return;
				const index = Number.parseInt(selected.split(".", 1)[0] ?? "", 10) - 1;
				const mount = mounts[index];
				if (!mount) continue;
				const action = await ctx.ui.select(`${mount.hostPath}\n${mount.guestPath}\n${mount.mode}`, [
					mount.mode === "read-only" ? "Upgrade to read-write" : "Downgrade to read-only",
					"Remove",
					"Back",
				]);
				if (action === "Remove") {
					await backend.unmountExternal(mount.guestPath);
					policy.mounts.remove(mount.hostPath);
				} else if (action === "Upgrade to read-write" || action === "Downgrade to read-only") {
					const mode: AccessMode = action === "Upgrade to read-write" ? "read-write" : "read-only";
					const updated = { ...mount, mode };
					await backend.updateExternalMount(updated);
					policy.mounts.setMode(mount.hostPath, mode);
				}
			}
		},
	});
}
