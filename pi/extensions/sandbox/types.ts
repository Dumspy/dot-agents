export const GUEST_WORKSPACE = "/workspace" as const;
export const GUEST_EXTERNAL_ROOT = "/external" as const;

export type AccessMode = "read-only" | "read-write";
export type SandboxMode = "gondolin" | "host";
export type SandboxState = "stopped" | "starting" | "running" | "recovering" | "failed" | "stopping";

export interface ExternalMount {
	hostPath: string;
	guestPath: string;
	mode: AccessMode;
}

export interface SandboxResources {
	cpus: number;
	memoryBytes: number;
	rootfsBytes: number;
}

export interface GondolinConfig extends SandboxResources {
	image?: string;
	startupCommands: string[];
}

export interface SandboxConfig {
	version: 1;
	backend: "gondolin";
	gondolin: GondolinConfig;
	protectedPaths: string[];
}

export interface SandboxStartOptions {
	workspaceHostPath: string;
	workspaceGuestPath: typeof GUEST_WORKSPACE;
	gondolin: GondolinConfig;
	protectedPaths: string[];
}

export interface SandboxBackendStatus {
	name: string;
	mode: SandboxMode;
	state: SandboxState;
	id?: string;
	error?: string;
}

/**
 * Backend-neutral lifecycle and mount control plane.
 *
 * Filesystem and bash operation adapters intentionally live beside each backend,
 * where they can implement Pi's exported operations interfaces directly.
 */
export interface SandboxBackend {
	readonly name: string;
	readonly mode: SandboxMode;

	start(options: SandboxStartOptions): Promise<void>;
	stop(): Promise<void>;
	status(): SandboxBackendStatus;
	mountExternal(mount: ExternalMount): Promise<void>;
	updateExternalMount(mount: ExternalMount): Promise<void>;
	unmountExternal(guestPath: string): Promise<void>;
}
