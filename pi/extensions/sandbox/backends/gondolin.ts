import path from "node:path";
import { VM, createHttpHooks, type VirtualProvider } from "@earendil-works/gondolin";
import { GUEST_EXTERNAL_ROOT, type ExternalMount, type SandboxBackend, type SandboxBackendStatus, type SandboxStartOptions, type SandboxState } from "../types.js";
import { DynamicMountProvider } from "./dynamic-mount-provider.js";
import { createHostDirectoryProvider } from "./providers.js";

function bytesAsQemuSize(bytes: number): string {
	if (bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}G`;
	if (bytes % 1024 ** 2 === 0) return `${bytes / 1024 ** 2}M`;
	return String(bytes);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type VmFactory = (options: Parameters<typeof VM.create>[0]) => Promise<VM>;

export class GondolinBackend implements SandboxBackend {
	readonly name = "gondolin";
	readonly mode = "gondolin" as const;

	#vm: VM | undefined;
	#state: SandboxState = "stopped";
	#error: string | undefined;
	#shellPath = "/bin/sh";
	#options: SandboxStartOptions | undefined;
	#externalProvider = new DynamicMountProvider();
	readonly #mounts = new Map<string, ExternalMount>();
	#lifecycleTail: Promise<void> = Promise.resolve();

	constructor(private readonly createVm: VmFactory = VM.create) {}

	status(): SandboxBackendStatus {
		return {
			name: this.name,
			mode: this.mode,
			state: this.#state,
			id: this.#vm?.id,
			error: this.#error,
		};
	}

	get vm(): VM {
		if (!this.#vm || this.#state !== "running") throw new Error(`Gondolin is not running (state: ${this.#state})`);
		return this.#vm;
	}

	get shellPath(): string {
		return this.#shellPath;
	}

	isAlive(): boolean {
		return this.#state === "running" && this.#vm?.getHostPid() !== null;
	}

	start(options: SandboxStartOptions): Promise<void> {
		const savedOptions = structuredClone(options);
		return this.#enqueueLifecycle(async () => {
			if (this.#state === "running") return;
			await this.#startVm(savedOptions, this.#state === "failed" ? "recovering" : "starting");
		});
	}

	async #startVm(options: SandboxStartOptions, state: "starting" | "recovering"): Promise<void> {
		this.#options = structuredClone(options);
		this.#state = state;
		this.#error = undefined;
		this.#externalProvider = new DynamicMountProvider();
		for (const mount of this.#mounts.values()) this.#installExternalProvider(mount);

		const workspaceProvider = createHostDirectoryProvider({
			hostPath: options.workspaceHostPath,
			mode: "read-write",
			additionalProtectedPaths: options.protectedPaths,
		});
		const { httpHooks } = createHttpHooks();
		try {
			const vm = await this.createVm({
				sessionLabel: `pi ${path.basename(options.workspaceHostPath)}`,
				sandbox: options.gondolin.image ? { imagePath: options.gondolin.image } : undefined,
				cpus: options.gondolin.cpus,
				memory: bytesAsQemuSize(options.gondolin.memoryBytes),
				// The published alpine-base image does not include resize2fs, so its
				// native size must be used. Explicit project images may opt into the
				// configured size and must provide resize2fs themselves.
				rootfs: options.gondolin.image ? { size: options.gondolin.rootfsBytes } : undefined,
				httpHooks,
				vfs: {
					mounts: {
						[options.workspaceGuestPath]: workspaceProvider,
						[GUEST_EXTERNAL_ROOT]: this.#externalProvider,
					},
				},
			});
			this.#vm = vm;
			const probe = await vm.exec(["/bin/sh", "-lc", "command -v bash || true"]);
			this.#shellPath = probe.stdout.trim() || "/bin/sh";
			for (const command of options.gondolin.startupCommands) {
				const result = await vm.exec([this.#shellPath, "-lc", command], { cwd: options.workspaceGuestPath });
				if (result.exitCode !== 0) {
					throw new Error(`Guest startup command failed (${result.exitCode}): ${command}\n${result.stderr.trim()}`);
				}
			}
			this.#state = "running";
		} catch (error) {
			const failedVm = this.#vm;
			this.#vm = undefined;
			if (failedVm) await failedVm.close().catch(() => undefined);
			this.#state = "failed";
			this.#error = errorMessage(error);
			throw error;
		}
	}

	stop(): Promise<void> {
		return this.#enqueueLifecycle(async () => {
			if (!this.#vm) {
				this.#mounts.clear();
				this.#externalProvider = new DynamicMountProvider();
				this.#state = "stopped";
				return;
			}
			this.#state = "stopping";
			const vm = this.#vm;
			this.#vm = undefined;
			try {
				await vm.close();
			} finally {
				this.#mounts.clear();
				this.#externalProvider = new DynamicMountProvider();
				this.#state = "stopped";
			}
		});
	}

	markFailed(error: unknown): void {
		this.#error = errorMessage(error);
		this.#state = "failed";
	}

	recover(): Promise<void> {
		return this.#enqueueLifecycle(async () => {
			if (this.#state === "running" && this.isAlive()) return;
			if (!this.#options) throw new Error("Cannot recover Gondolin before initial startup");
			this.#state = "recovering";
			const oldVm = this.#vm;
			this.#vm = undefined;
			if (oldVm) await oldVm.close().catch(() => undefined);
			await this.#startVm(this.#options, "recovering");
		});
	}

	async mountExternal(mount: ExternalMount): Promise<void> {
		this.#mounts.set(mount.hostPath, { ...mount });
		this.#installExternalProvider(mount);
	}

	async updateExternalMount(mount: ExternalMount): Promise<void> {
		if (!this.#mounts.has(mount.hostPath)) throw new Error(`${mount.hostPath} is not mounted in Gondolin`);
		this.#mounts.set(mount.hostPath, { ...mount });
		this.#installExternalProvider(mount);
	}

	async unmountExternal(guestPath: string): Promise<void> {
		const mount = [...this.#mounts.values()].find((candidate) => candidate.guestPath === guestPath);
		if (!mount) throw new Error(`${guestPath} is not mounted in Gondolin`);
		this.#mounts.delete(mount.hostPath);
		this.#externalProvider.removeMount(this.#externalProviderPath(guestPath));
	}

	#externalProviderPath(guestPath: string): string {
		const relative = path.posix.relative(GUEST_EXTERNAL_ROOT, guestPath);
		if (!relative || relative.startsWith("..") || relative.includes("/")) {
			throw new Error(`Invalid external guest mount path: ${guestPath}`);
		}
		return `/${relative}`;
	}

	#installExternalProvider(mount: ExternalMount): void {
		const provider: VirtualProvider = createHostDirectoryProvider({
			hostPath: mount.hostPath,
			mode: mount.mode,
			additionalProtectedPaths: this.#options?.protectedPaths,
		});
		this.#externalProvider.setMount(this.#externalProviderPath(mount.guestPath), provider);
	}

	#enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
		const result = this.#lifecycleTail.then(operation, operation);
		this.#lifecycleTail = result.catch(() => undefined);
		return result;
	}
}
