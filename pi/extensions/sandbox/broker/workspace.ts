import os from "node:os";
import { GondolinBackend } from "../backends/gondolin.js";
import { parseSandboxConfig } from "../config.js";
import { assertMountAllowed, resolveMountTarget } from "../paths.js";
import { ExternalAccessRequiredError, SandboxPolicy } from "../policy.js";
import type {
	BrokerAttachParams,
	BrokerEventDataMap,
	BrokerResolvedPath,
	BrokerSnapshot,
	BrokerToolParams,
} from "../protocol.js";
import {
	GUEST_WORKSPACE,
	type AccessMode,
	type ExternalMount,
	type SandboxBackendName,
	type SandboxExecutionBackend,
	type SandboxToolName,
	type SandboxToolRequest,
	type SandboxToolResult,
	type SandboxToolUpdate,
} from "../types.js";
import { WorkspaceScheduler } from "./scheduler.js";

/** Tools that take a path and the access mode the broker must guarantee for it. */
const TOOL_PATH_MODES: Record<Exclude<SandboxToolName, "bash">, AccessMode> = {
	read: "read-only",
	write: "read-write",
	edit: "read-write",
	grep: "read-only",
	find: "read-only",
	ls: "read-only",
};

type BackendFactory = () => SandboxExecutionBackend<"gondolin">;
type WorkspaceEvent = <TEvent extends keyof BrokerEventDataMap>(event: TEvent, data: BrokerEventDataMap[TEvent]) => void;

function backendFactory(name: SandboxBackendName): BackendFactory {
	if (name === "gondolin") return () => new GondolinBackend();
	return name satisfies never;
}

function normalizeAttachment(params: BrokerAttachParams, workspace: string): BrokerAttachParams {
	if (params.workspace !== workspace || params.startOptions.workspaceHostPath !== workspace) {
		throw new Error(`Broker workspace mismatch: expected ${workspace}`);
	}
	if (params.startOptions.workspaceGuestPath !== GUEST_WORKSPACE) {
		throw new Error(`Broker workspace guest path must be ${GUEST_WORKSPACE}`);
	}
	const config = parseSandboxConfig(
		{
			version: 1,
			backend: params.backend,
			gondolin: params.startOptions.backendConfig,
			protectedPaths: params.startOptions.protectedPaths,
		},
		"broker attachment",
	);
	return {
		...params,
		startOptions: {
			workspaceHostPath: workspace,
			workspaceGuestPath: GUEST_WORKSPACE,
			backendConfig: config.gondolin,
			protectedPaths: config.protectedPaths,
		},
	};
}

function specificationFingerprint(params: BrokerAttachParams): string {
	return JSON.stringify({ backend: params.backend, startOptions: params.startOptions });
}

function specificationMismatch(active: BrokerAttachParams, requested: BrokerAttachParams): string {
	const differences: string[] = [];
	if (active.backend !== requested.backend) differences.push(`backend ${active.backend} != ${requested.backend}`);
	if (JSON.stringify(active.startOptions.backendConfig) !== JSON.stringify(requested.startOptions.backendConfig)) {
		differences.push("backend configuration differs");
	}
	if (JSON.stringify(active.startOptions.protectedPaths) !== JSON.stringify(requested.startOptions.protectedPaths)) {
		differences.push("protected paths differ");
	}
	return differences.join(", ") || "normalized options differ";
}

export class BrokerWorkspace {
	readonly policy: SandboxPolicy;
	readonly scheduler = new WorkspaceScheduler();
	#backend: SandboxExecutionBackend<"gondolin"> | undefined;
	#fingerprint: string | undefined;
	#specification: BrokerAttachParams | undefined;
	#startup: Promise<void> | undefined;
	#recovery: Promise<void> | undefined;

	constructor(
		readonly workspace: string,
		private readonly emit: WorkspaceEvent,
		private readonly factories: Partial<Record<SandboxBackendName, BackendFactory>> = {},
	) {
		this.policy = new SandboxPolicy(workspace, os.homedir());
	}

	async attach(params: BrokerAttachParams, attachedProcesses: number): Promise<BrokerSnapshot> {
		const normalized = normalizeAttachment(params, this.workspace);
		const fingerprint = specificationFingerprint(normalized);
		const created = !this.#backend;
		if (this.#fingerprint !== undefined && this.#fingerprint !== fingerprint) {
			const activeSpecification = this.#specification;
			if (!activeSpecification) throw new Error("Active sandbox specification is unavailable");
			throw new Error(
				`Sandbox specification does not match the active workspace sandbox: ${specificationMismatch(activeSpecification, normalized)}`,
			);
		}
		if (!this.#backend) {
			const factory = this.factories[normalized.backend] ?? backendFactory(normalized.backend);
			const backend = factory();
			this.#backend = backend;
			this.#fingerprint = fingerprint;
			this.#specification = normalized;
			this.#startup = backend
				.start(normalized.startOptions)
				.catch(async (error) => {
					this.#backend = undefined;
					this.#fingerprint = undefined;
					this.#specification = undefined;
					await backend.stop().catch(() => undefined);
					throw error;
				})
				.finally(() => {
					this.#startup = undefined;
				});
		}
		await this.#startup;
		return this.snapshot(attachedProcesses, created);
	}

	snapshot(attachedProcesses: number, created = false): BrokerSnapshot {
		if (!this.#backend) throw new Error("Workspace sandbox has not started");
		return {
			workspace: this.workspace,
			workspaceGuestPath: GUEST_WORKSPACE,
			backend: this.#backend.status(),
			attachedProcesses,
			mounts: this.policy.mounts.list(),
			created,
		};
	}

	async executeTool(request: BrokerToolParams, signal: AbortSignal, onUpdate: SandboxToolUpdate): Promise<SandboxToolResult> {
		return this.scheduler.runShared(async () => {
			const backend = await this.#ensureBackend();
			const translated = await this.#translateToolRequest(request);
			return backend.executeTool(translated, signal, onUpdate);
		}, signal);
	}

	async exec(
		command: string,
		cwd: string,
		options: { signal: AbortSignal; timeout?: number; onData: (data: Buffer) => void },
	): Promise<{ exitCode: number | null }> {
		return this.scheduler.runShared(async () => {
			const backend = await this.#ensureBackend();
			return backend.exec(command, cwd, options);
		}, options.signal);
	}

	resolvePath(path: string, mode: AccessMode): Promise<BrokerResolvedPath> {
		return this.scheduler.runShared(async () => {
			const guestPath = await this.policy.prepareToolPath(path, mode);
			const mount = this.policy.mounts
				.list()
				.find((candidate) => guestPath === candidate.guestPath || guestPath.startsWith(`${candidate.guestPath}/`));
			return { guestPath, mode: mount?.mode ?? "read-write" };
		});
	}

	approveMount(path: string, mode: AccessMode): Promise<ExternalMount> {
		return this.scheduler.runExclusive(() =>
			this.#mountDirectory(path, mode, `External mount approval requires a directory: ${path}`),
		);
	}

	mount(path: string, mode: AccessMode): Promise<ExternalMount> {
		return this.scheduler.runExclusive(() =>
			this.#mountDirectory(path, mode, "/mount requires a directory path, not a file"),
		);
	}

	setMountMode(hostPath: string, mode: AccessMode): Promise<ExternalMount> {
		return this.scheduler.runExclusive(async () => {
			const current = this.policy.mounts.findByHostPath(hostPath);
			if (!current) throw new Error(`${hostPath} is not mounted`);
			if (current.mode === mode) return current;
			return this.#setMountMode(current, mode);
		});
	}

	removeMount(hostPath: string): Promise<ExternalMount> {
		return this.scheduler.runExclusive(async () => {
			const current = this.policy.mounts.findByHostPath(hostPath);
			if (!current) throw new Error(`${hostPath} is not mounted`);
			await (await this.#ensureBackend()).unmountExternal(current.guestPath);
			this.policy.mounts.remove(hostPath);
			this.#emitMountsChanged();
			return current;
		});
	}

	listMounts(): ExternalMount[] {
		return this.policy.mounts.list();
	}

	async stop(): Promise<void> {
		const backend = this.#backend;
		this.#backend = undefined;
		this.#fingerprint = undefined;
		this.#specification = undefined;
		this.#startup = undefined;
		this.policy.mounts.clear();
		if (backend) await backend.stop();
	}

	async #translateToolRequest(request: BrokerToolParams): Promise<SandboxToolRequest> {
		if (request.name === "bash") return request;
		const path = await this.policy.prepareToolPath(request.params.path ?? ".", TOOL_PATH_MODES[request.name]);
		// Every non-bash tool input has a path, so overwriting it preserves the union member.
		return { ...request, params: { ...request.params, path } } as SandboxToolRequest;
	}

	async #mountDirectory(path: string, mode: AccessMode, fileRequestError: string): Promise<ExternalMount> {
		const target = await resolveMountTarget(path, this.policy.homeDir);
		if (target.isFileRequest) throw new Error(fileRequestError);
		return this.#mountCanonicalDirectory(target.canonicalPath, mode);
	}

	async #mountCanonicalDirectory(canonicalPath: string, mode: AccessMode): Promise<ExternalMount> {
		assertMountAllowed(canonicalPath, this.workspace, this.policy.homeDir);
		const containing = this.policy.mounts.findContaining(canonicalPath);
		if (containing) {
			if (mode === "read-write" && containing.mode === "read-only") {
				return this.#setMountMode(containing, mode);
			}
			return containing;
		}
		const mount = this.policy.mounts.add(canonicalPath, mode);
		try {
			await (await this.#ensureBackend()).mountExternal(mount);
		} catch (error) {
			this.policy.mounts.remove(mount.hostPath);
			throw error;
		}
		this.#emitMountsChanged();
		return mount;
	}

	async #setMountMode(current: ExternalMount, mode: AccessMode): Promise<ExternalMount> {
		const updated = { ...current, mode };
		await (await this.#ensureBackend()).updateExternalMount(updated);
		this.policy.mounts.setMode(current.hostPath, mode);
		this.#emitMountsChanged();
		return updated;
	}

	#emitMountsChanged(): void {
		this.emit("mounts-changed", this.policy.mounts.list());
	}

	async #ensureBackend(): Promise<SandboxExecutionBackend<"gondolin">> {
		const backend = this.#backend;
		if (!backend) throw new Error("Workspace sandbox has not started");
		if (backend.status().state === "running" && !backend.isAlive()) {
			backend.markFailed(new Error("Sandbox backend process exited"));
			this.emit("backend-failed", backend.status());
		}
		if (backend.status().state === "failed" || backend.status().state === "recovering") {
			if (!this.#recovery) {
				this.#recovery = backend
					.recover()
					.then(() => this.emit("backend-recovered", backend.status()))
					.finally(() => {
						this.#recovery = undefined;
					});
			}
			await this.#recovery;
		}
		if (backend.status().state !== "running") {
			throw new Error(`Sandbox backend is not available (${backend.status().state})`);
		}
		return backend;
	}
}

export { ExternalAccessRequiredError };
