import type { ExternalMount, SandboxBackend, SandboxBackendStatus, SandboxStartOptions } from "../types.js";

export class HostBackend implements SandboxBackend {
	readonly name = "host";
	readonly mode = "host" as const;
	#running = false;

	async start(_options: SandboxStartOptions): Promise<void> {
		this.#running = true;
	}

	async stop(): Promise<void> {
		this.#running = false;
	}

	status(): SandboxBackendStatus {
		return {
			name: this.name,
			mode: this.mode,
			state: this.#running ? "running" : "stopped",
		};
	}

	async mountExternal(_mount: ExternalMount): Promise<void> {
		throw new Error("External mounts are not used in --no-sandbox mode");
	}

	async updateExternalMount(_mount: ExternalMount): Promise<void> {
		throw new Error("External mounts are not used in --no-sandbox mode");
	}

	async unmountExternal(_guestPath: string): Promise<void> {
		throw new Error("External mounts are not used in --no-sandbox mode");
	}
}
