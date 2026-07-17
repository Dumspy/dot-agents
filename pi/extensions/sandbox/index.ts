import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
	getAgentDir,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseMountArguments } from "./command-line.js";
import { BrokerApprovalRequiredError, BrokerClient } from "./client/broker-client.js";
import { loadSandboxConfig } from "./config.js";
import { assertHostPathAllowed, hostCommandDenial } from "./host-guards.js";
import type { BrokerEventFrame, BrokerSnapshot } from "./protocol.js";
import {
	GUEST_WORKSPACE,
	type AccessMode,
	type SandboxBackendName,
	type SandboxConfig,
	type SandboxToolInputMap,
	type SandboxToolName,
	type SandboxToolResultMap,
} from "./types.js";

const STATUS_KEY = "sandbox";

function brokerExecutablePath(): string {
	const installed = path.join(getAgentDir(), "libexec", "sandbox-broker", "broker", "main.js");
	if (existsSync(installed)) return installed;
	return fileURLToPath(new URL("../../dist/sandbox-broker/broker/main.js", import.meta.url));
}
const REQUEST_EXTERNAL_PARAMS = Type.Object({
	path: Type.String({ description: "Existing absolute host directory or file path to request" }),
	mode: StringEnum(["read-only", "read-write"] as const, { description: "Requested access level" }),
	reason: Type.Optional(Type.String({ description: "Short explanation shown to the user" })),
});

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function snapshotStatus(snapshot: BrokerSnapshot | undefined, hostMode: boolean, connectionError?: string): string {
	if (hostMode) return "SANDBOX: OFF";
	if (connectionError || !snapshot) return "SANDBOX: ERROR";
	const status = snapshot.backend;
	if (status.state === "running") return `SANDBOX: ${status.name.toUpperCase()}${status.id ? ` ${status.id.slice(0, 8)}` : ""}`;
	if (status.state === "failed") return "SANDBOX: ERROR";
	return `SANDBOX: ${status.state.toUpperCase()}`;
}

export default function sandboxExtension(pi: ExtensionAPI) {
	const workspace = realpathSync(process.cwd());
	const homeDir = os.homedir();
	let hostMode = false;
	let config: SandboxConfig | undefined;
	let backendName: SandboxBackendName = "gondolin";
	let client: BrokerClient | undefined;
	let snapshot: BrokerSnapshot | undefined;
	let connectionError: string | undefined;
	let lastContext: ExtensionContext | undefined;
	let connectPromise: Promise<BrokerClient> | undefined;
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
	});
	pi.registerFlag("no-sandbox", {
		description: "Run agent tools directly on the host with best-effort guardrails",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx?: ExtensionContext): void {
		const activeContext = ctx ?? lastContext;
		if (!activeContext) return;
		const text = snapshotStatus(snapshot, hostMode, connectionError);
		const color = hostMode || connectionError || snapshot?.backend.state === "failed" ? "error" : "accent";
		activeContext.ui.setStatus(STATUS_KEY, activeContext.ui.theme.fg(color, text));
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

	function serialApproval<T>(operation: () => Promise<T>): Promise<T> {
		const previous = approvalTail;
		let release!: () => void;
		approvalTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		return previous.then(operation).finally(release);
	}

	function handleBrokerEvent(activeClient: BrokerClient, event: BrokerEventFrame): void {
		if (activeClient !== client) return;
		if (event.event === "mounts-changed" && snapshot) {
			snapshot = { ...snapshot, mounts: event.data };
			lastContext?.ui.notify("Shared sandbox mounts changed. Use /mounts to inspect them.", "info");
		} else if (event.event === "attached-processes-changed" && snapshot) {
			snapshot = { ...snapshot, attachedProcesses: event.data.attachedProcesses };
		} else if (event.event === "backend-recovered") {
			lastContext?.ui.notify("Sandbox backend recovered; guest-local state was lost.", "warning");
		} else if (event.event === "backend-failed") {
			lastContext?.ui.notify("Sandbox backend failed. The active operation was not replayed.", "error");
		}
		updateStatus();
	}

	async function connectBroker(ctx: ExtensionContext): Promise<BrokerClient> {
		if (hostMode) throw new Error("Sandbox broker requested while --no-sandbox is active");
		if (client && !client.closed) return client;
		if (!config) throw new Error("Sandbox configuration is not loaded");
		if (!connectPromise) {
			connectionError = undefined;
			updateStatus(ctx);
			connectPromise = BrokerClient.connect({
				workspace,
				launcherPath: brokerExecutablePath(),
				backend: backendName,
				startOptions: {
					workspaceHostPath: workspace,
					workspaceGuestPath: GUEST_WORKSPACE,
					backendConfig: config.gondolin,
					protectedPaths: config.protectedPaths,
				},
			})
				.then(({ client: connected, snapshot: attached }) => {
					client = connected;
					snapshot = attached;
					connected.on("event", (event: BrokerEventFrame) => handleBrokerEvent(connected, event));
					connected.on("disconnect", (error: Error) => {
						if (client !== connected) return;
						client = undefined;
						snapshot = undefined;
						connectionError = error.message;
						lastContext?.ui.notify(`Sandbox broker disconnected: ${error.message}`, "error");
						updateStatus();
					});
					updateStatus(ctx);
					return connected;
				})
				.catch((error) => {
					connectionError = errorMessage(error);
					updateStatus(ctx);
					throw error;
				})
				.finally(() => {
					connectPromise = undefined;
				});
		}
		return connectPromise;
	}

	async function withApproval<T>(operation: (active: BrokerClient) => Promise<T>, ctx: ExtensionContext, reason?: string): Promise<T> {
		const active = await connectBroker(ctx);
		try {
			return await operation(active);
		} catch (error) {
			if (!(error instanceof BrokerApprovalRequiredError)) throw error;
			return serialApproval(async () => {
				const current = await connectBroker(ctx);
				try {
					return await operation(current);
				} catch (retryError) {
					if (!(retryError instanceof BrokerApprovalRequiredError)) throw retryError;
					const approval = retryError.approval;
					if (!ctx.hasUI) {
						await current.denyApproval(approval.approvalId).catch(() => undefined);
						throw new Error(`External access requires interactive approval: ${approval.mountRoot}`);
					}
					let choice: string | undefined;
					try {
						choice = await ctx.ui.select(
							[
								approval.upgrade ? "Upgrade shared external directory access" : "External directory access",
								`Host path: ${approval.hostPath}`,
								`Directory: ${approval.mountRoot}`,
								`Requested: ${approval.requestedMode}`,
								`Guest path: ${approval.guestPath}`,
								reason ? `Reason: ${reason}` : "",
								approval.fileRequest ? `The file's parent directory will be exposed: ${approval.mountRoot}` : "",
								"This mount is shared by every sandboxed Pi process in this workspace.",
							]
								.filter(Boolean)
								.join("\n"),
							["Allow read-only", "Allow read-write", "Deny"],
						);
					} catch (uiError) {
						await current.denyApproval(approval.approvalId).catch(() => undefined);
						throw uiError;
					}
					if (choice === "Deny" || choice === undefined) {
						await current.denyApproval(approval.approvalId);
						throw new Error(`External directory access denied: ${approval.mountRoot}`);
					}
					const mode: AccessMode = choice === "Allow read-write" ? "read-write" : "read-only";
					const mount = await current.approveMount(approval.approvalId, approval.mountRoot, mode);
					snapshot = await current.status();
					ctx.ui.notify(`${mount.hostPath} mounted ${mount.mode} at ${mount.guestPath}`, "info");
					try {
						return await operation(current);
					} catch (postApprovalError) {
						if (postApprovalError instanceof BrokerApprovalRequiredError) {
							await current.denyApproval(postApprovalError.approval.approvalId).catch(() => undefined);
						}
						throw postApprovalError;
					}
				}
			});
		}
	}

	function startupNotice(attached: BrokerSnapshot): string {
		const lines = [
			`${attached.created ? "Created" : "Reusing"} ${attached.backend.name} sandbox${attached.backend.id ? ` ${attached.backend.id.slice(0, 8)}` : ""}`,
			`Workspace: ${workspace} -> ${GUEST_WORKSPACE}`,
			`Attached Pi processes: ${attached.attachedProcesses}`,
		];
		if (attached.mounts.length === 0) lines.push("External mounts: none");
		else {
			lines.push("Shared external mounts:");
			for (const mount of attached.mounts) lines.push(`  ${mount.hostPath} -> ${mount.guestPath} (${mount.mode})`);
		}
		return lines.join("\n");
	}

	async function brokerTool<TName extends SandboxToolName>(
		name: TName,
		id: string,
		params: SandboxToolInputMap[TName],
		signal: AbortSignal | undefined,
		onUpdate: ((update: SandboxToolResultMap[TName]) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<SandboxToolResultMap[TName]> {
		return withApproval((active) => active.tool(name, id, params, signal, onUpdate), ctx);
	}

	function brokerBashOperations(ctx: ExtensionContext): BashOperations {
		return {
			exec: async (command, _cwd, options) => {
				const active = await connectBroker(ctx);
				return active.exec(command, GUEST_WORKSPACE, options);
			},
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		hostMode = pi.getFlag("no-sandbox") === true;
		config = await loadSandboxConfig({ agentDir: getAgentDir(), workspace, projectTrusted: ctx.isProjectTrusted() });
		const selectedBackend = String(pi.getFlag("sandbox") ?? config.backend);
		if (hostMode) {
			snapshot = undefined;
			connectionError = undefined;
			updateStatus(ctx);
			ctx.ui.notify("Sandbox disabled. Host-mode protections are best-effort only.", "warning");
			return;
		}
		if (selectedBackend !== "gondolin") throw new Error(`Unknown sandbox backend: ${selectedBackend}`);
		backendName = selectedBackend;
		try {
			await connectBroker(ctx);
			ctx.ui.notify(startupNotice(snapshot!), "info");
		} catch (error) {
			ctx.ui.notify(`Sandbox startup failed: ${errorMessage(error)}`, "error");
			throw error;
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		lastContext = ctx;
		const active = client;
		client = undefined;
		snapshot = undefined;
		connectPromise = undefined;
		if (active) {
			active.removeAllListeners();
			await active.close(event.reason === "quit");
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", async (event) => {
		const modeNotice = hostMode
			? "SANDBOX IS OFF. Tools execute on the host with best-effort guardrails only."
			: [
					`Commands and filesystem tools execute in a shared ${backendName} sandbox. The host workspace ${workspace} is mounted at ${GUEST_WORKSPACE}.`,
					"External mounts are shared by sandboxed Pi processes in this workspace but are disclosed to this conversation only when referenced or requested.",
					"Use request_external_directory before bash needs another host directory, then use the returned /external path.",
					"Prefer webfetch over curl for ordinary web retrieval.",
				].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${modeNotice}` };
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			if (hostMode) {
				assertHostPath(params.path, "read-only");
				return localRead.execute(id, params, signal, onUpdate);
			}
			return brokerTool("read", id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			if (hostMode) {
				assertHostPath(params.path, "read-write");
				return localWrite.execute(id, params, signal, onUpdate);
			}
			return brokerTool("write", id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			if (hostMode) {
				assertHostPath(params.path, "read-write");
				return localEdit.execute(id, params, signal, onUpdate);
			}
			return brokerTool("edit", id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			if (hostMode) {
				const denial = hostCommandDenial(params.command, homeDir);
				if (denial) throw new Error(denial);
				return localBash.execute(id, params, signal, onUpdate);
			}
			return brokerTool("bash", id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			if (hostMode) {
				assertHostPath(params.path ?? ".", "read-only");
				return localLs.execute(id, params, signal, onUpdate);
			}
			return brokerTool("ls", id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			if (hostMode) {
				assertHostPath(params.path ?? ".", "read-only");
				return localFind.execute(id, params, signal, onUpdate);
			}
			return brokerTool("find", id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(id, params, signal, onUpdate, ctx) {
			if (hostMode) {
				assertHostPath(params.path ?? ".", "read-only");
				return localGrep.execute(id, params, signal, onUpdate);
			}
			return brokerTool("grep", id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "request_external_directory",
		label: "Request external directory",
		description: "Request workspace-shared access to an existing host directory for sandboxed bash workflows.",
		promptSnippet: "Request an external host directory and receive its /external guest path",
		parameters: REQUEST_EXTERNAL_PARAMS,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (hostMode) {
				return {
					content: [{ type: "text" as const, text: `Sandbox is off; use the host path directly: ${params.path}` }],
					details: undefined,
				};
			}
			const resolved = await withApproval((active) => active.resolvePath(params.path, params.mode), ctx, params.reason);
			return {
				content: [{ type: "text" as const, text: `${params.path} is available at ${resolved.guestPath} (${resolved.mode}).` }],
				details: {
					hostPath: params.path,
					guestPath: resolved.guestPath,
					mode: resolved.mode,
					requestedMode: params.mode,
					reason: params.reason,
				},
			};
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		lastContext = ctx;
		if (hostMode) return undefined;
		await connectBroker(ctx);
		return { operations: brokerBashOperations(ctx) };
	});

	pi.registerCommand("sandbox", {
		description: "Show shared sandbox status and active mounts",
		handler: async (args, ctx) => {
			if (hostMode) {
				ctx.ui.notify("SANDBOX: OFF\nHost-mode protections are best-effort only.", "warning");
				return;
			}
			const active = await connectBroker(ctx);
			if (args.trim() === "stop") {
				await active.request("stop");
				ctx.ui.notify("Workspace sandbox stopped.", "info");
				return;
			}
			snapshot = await active.status();
			ctx.ui.notify(
				[
					`Mode: ${snapshotStatus(snapshot, false)}`,
					`Workspace: ${workspace} -> ${GUEST_WORKSPACE}`,
					`Attached Pi processes: ${snapshot.attachedProcesses}`,
					...(snapshot.backend.error ? [`Error: ${snapshot.backend.error}`] : []),
					...snapshot.mounts.map((mount) => `${mount.hostPath} -> ${mount.guestPath} (${mount.mode})`),
				].join("\n"),
				snapshot.backend.state === "failed" ? "error" : "info",
			);
		},
	});

	pi.registerCommand("mount", {
		description: "Mount an existing absolute host directory into the shared workspace sandbox",
		handler: async (args, ctx) => {
			if (hostMode) throw new Error("/mount is unavailable because the sandbox is off");
			await ctx.waitForIdle();
			const parsed = parseMountArguments(args);
			const active = await connectBroker(ctx);
			const mount = await active.mount(parsed.path, parsed.mode);
			snapshot = await active.status();
			ctx.ui.notify(`${mount.hostPath} mounted ${mount.mode} at ${mount.guestPath}`, "info");
			pi.sendMessage(
				{
					customType: "sandbox-mount",
					content: `The user mounted ${mount.hostPath} at ${mount.guestPath} (${mount.mode}) in the shared workspace sandbox.`,
					display: false,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	pi.registerCommand("mounts", {
		description: "View and modify shared workspace sandbox mounts",
		handler: async (_args, ctx) => {
			if (hostMode) throw new Error("/mounts is unavailable because the sandbox is off");
			await ctx.waitForIdle();
			const active = await connectBroker(ctx);
			while (true) {
				const mounts = await active.listMounts();
				if (mounts.length === 0) {
					ctx.ui.notify("No external directories are mounted.", "info");
					return;
				}
				const choices = [...mounts.map((mount, index) => `${index + 1}. ${mount.hostPath} (${mount.mode})`), "Done"];
				const selected = await ctx.ui.select("Shared external mounts", choices);
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
					await active.removeMount(mount.hostPath);
					pi.sendMessage(
						{
							customType: "sandbox-mount",
							content: `The user removed the shared sandbox mount ${mount.hostPath} (${mount.guestPath}).`,
							display: false,
						},
						{ deliverAs: "nextTurn" },
					);
				} else if (action === "Upgrade to read-write" || action === "Downgrade to read-only") {
					const mode: AccessMode = action === "Upgrade to read-write" ? "read-write" : "read-only";
					await active.setMountMode(mount.hostPath, mode);
					pi.sendMessage(
						{
							customType: "sandbox-mount",
							content: `The user changed ${mount.hostPath} at ${mount.guestPath} to ${mode}.`,
							display: false,
						},
						{ deliverAs: "nextTurn" },
					);
				}
			}
		},
	});
}
