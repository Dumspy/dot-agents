import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolDetails,
	BashToolInput,
	EditToolDetails,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";

export const GUEST_WORKSPACE = "/workspace" as const;
export const GUEST_EXTERNAL_ROOT = "/external" as const;

export type AccessMode = "read-only" | "read-write";
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
	backend: SandboxBackendName;
	gondolin: GondolinConfig;
	protectedPaths: string[];
}

/** Extend this map when a reviewed backend is added to the built-in registry. */
export interface SandboxBackendConfigMap {
	gondolin: GondolinConfig;
}

export type SandboxBackendName = keyof SandboxBackendConfigMap;

export interface SandboxStartOptions<TBackend extends SandboxBackendName = SandboxBackendName> {
	workspaceHostPath: string;
	workspaceGuestPath: typeof GUEST_WORKSPACE;
	backendConfig: SandboxBackendConfigMap[TBackend];
	protectedPaths: string[];
}

export interface SandboxBackendStatus {
	name: string;
	state: SandboxState;
	id?: string;
	error?: string;
}

export interface SandboxToolInputMap {
	read: ReadToolInput;
	write: WriteToolInput;
	edit: EditToolInput;
	bash: BashToolInput;
	grep: GrepToolInput;
	find: FindToolInput;
	ls: LsToolInput;
}

export interface SandboxToolResultMap {
	read: AgentToolResult<ReadToolDetails | undefined>;
	write: AgentToolResult<undefined>;
	edit: AgentToolResult<EditToolDetails | undefined>;
	bash: AgentToolResult<BashToolDetails | undefined>;
	grep: AgentToolResult<GrepToolDetails | undefined>;
	find: AgentToolResult<FindToolDetails | undefined>;
	ls: AgentToolResult<LsToolDetails | undefined>;
}

export type SandboxToolName = keyof SandboxToolInputMap;
export type SandboxToolResult = SandboxToolResultMap[SandboxToolName];
export type SandboxToolUpdate = AgentToolUpdateCallback<
	| ReadToolDetails
	| EditToolDetails
	| BashToolDetails
	| GrepToolDetails
	| FindToolDetails
	| LsToolDetails
	| undefined
>;
export interface SandboxToolRequestFor<TName extends SandboxToolName> {
	name: TName;
	toolCallId: string;
	params: SandboxToolInputMap[TName];
}
export type SandboxToolRequest = {
	[TName in SandboxToolName]: SandboxToolRequestFor<TName>;
}[SandboxToolName];

/**
 * Backend-neutral lifecycle, mount control plane, and tool execution contract.
 *
 * The backend is selected from the reviewed compile-time registry. Host mode is
 * deliberately separate and never implements this broker contract.
 */
export interface SandboxExecutionBackend<TBackend extends SandboxBackendName = SandboxBackendName> {
	readonly name: TBackend;

	start(options: SandboxStartOptions<TBackend>): Promise<void>;
	stop(): Promise<void>;
	status(): SandboxBackendStatus;
	mountExternal(mount: ExternalMount): Promise<void>;
	updateExternalMount(mount: ExternalMount): Promise<void>;
	unmountExternal(guestPath: string): Promise<void>;
	isAlive(): boolean;
	markFailed(error: Error): void;
	recover(): Promise<void>;
	executeTool(
		request: SandboxToolRequest,
		signal?: AbortSignal,
		onUpdate?: SandboxToolUpdate,
	): Promise<SandboxToolResult>;
	exec(
		command: string,
		cwd: string,
		options: {
			signal?: AbortSignal;
			timeout?: number;
			onData: (data: Buffer) => void;
		},
	): Promise<{ exitCode: number | null }>;
}
