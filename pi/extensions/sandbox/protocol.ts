import type {
	AccessMode,
	ExternalMount,
	SandboxBackendName,
	SandboxBackendStatus,
	SandboxStartOptions,
	SandboxToolRequest,
	SandboxToolResult,
} from "./types.js";

export const BROKER_PROTOCOL_VERSION = 1 as const;
export const BROKER_RECONNECT_GRACE_MS = 5_000;
export const BROKER_START_TIMEOUT_MS = 30_000;
export const BROKER_QUEUE_TIMEOUT_MS = 5 * 60_000;

export type BrokerAttachParams = {
	[TBackend in SandboxBackendName]: {
		workspace: string;
		leaseToken: string;
		pid: number;
		backend: TBackend;
		startOptions: SandboxStartOptions<TBackend>;
	};
}[SandboxBackendName];

export interface BrokerResolvedPath {
	guestPath: string;
	mode: AccessMode;
}

export interface BrokerSnapshot {
	workspace: string;
	workspaceGuestPath: "/workspace";
	backend: SandboxBackendStatus;
	attachedProcesses: number;
	mounts: ExternalMount[];
	created: boolean;
}

export interface ApprovalRequiredData {
	kind: "approval-required";
	approvalId: string;
	hostPath: string;
	mountRoot: string;
	guestPath: string;
	requestedMode: AccessMode;
	fileRequest: boolean;
	upgrade: boolean;
}

export interface BrokerErrorData {
	kind: "broker-error";
	code?: string;
}

export interface BrokerExecParams {
	command: string;
	cwd: string;
	timeout?: number;
}

export interface BrokerResolvePathParams {
	path: string;
	mode: AccessMode;
}

export interface BrokerMountParams {
	path: string;
	mode: AccessMode;
}

export interface BrokerApproveMountParams extends BrokerMountParams {
	approvalId: string;
}

export interface BrokerDenyApprovalParams {
	approvalId: string;
}

export interface BrokerSetMountModeParams {
	hostPath: string;
	mode: AccessMode;
}

export interface BrokerUnmountParams {
	hostPath: string;
}

export type BrokerToolParams = SandboxToolRequest;
export type BrokerRequestPayload =
	| BrokerAttachParams
	| BrokerToolParams
	| BrokerExecParams
	| BrokerResolvePathParams
	| BrokerMountParams
	| BrokerApproveMountParams
	| BrokerDenyApprovalParams
	| BrokerSetMountModeParams
	| BrokerUnmountParams;
export type BrokerResponsePayload =
	| BrokerSnapshot
	| SandboxToolResult
	| { exitCode: number | null }
	| BrokerResolvedPath
	| ExternalMount
	| ExternalMount[]
	| undefined;

export interface BrokerRequestFrame {
	version: typeof BROKER_PROTOCOL_VERSION;
	type: "request";
	id: string;
	method: string;
	params?: BrokerRequestPayload;
}

export interface BrokerCancelFrame {
	version: typeof BROKER_PROTOCOL_VERSION;
	type: "cancel";
	id: string;
}

export interface BrokerResponseFrame {
	version: typeof BROKER_PROTOCOL_VERSION;
	type: "response";
	id: string;
	ok: boolean;
	result?: BrokerResponsePayload;
	error?: {
		message: string;
		data?: ApprovalRequiredData | BrokerErrorData;
	};
}

export type BrokerStreamFrame =
	| {
			version: typeof BROKER_PROTOCOL_VERSION;
			type: "stream";
			id: string;
			event: "tool-update";
			data: SandboxToolResult;
	  }
	| {
			version: typeof BROKER_PROTOCOL_VERSION;
			type: "stream";
			id: string;
			event: "exec-data";
			data: string;
	  };

export interface BrokerEventDataMap {
	"mounts-changed": ExternalMount[];
	"backend-recovered": SandboxBackendStatus;
	"backend-failed": SandboxBackendStatus;
	"attached-processes-changed": { attachedProcesses: number };
}

export type BrokerEventFrame = {
	[TEvent in keyof BrokerEventDataMap]: {
		version: typeof BROKER_PROTOCOL_VERSION;
		type: "event";
		event: TEvent;
		data: BrokerEventDataMap[TEvent];
	};
}[keyof BrokerEventDataMap];

export type BrokerClientFrame = BrokerRequestFrame | BrokerCancelFrame;
export type BrokerServerFrame = BrokerResponseFrame | BrokerStreamFrame | BrokerEventFrame;

export function encodeFrame(frame: BrokerClientFrame | BrokerServerFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

export function parseFrame(line: string): BrokerClientFrame | BrokerServerFrame {
	const parsed: unknown = JSON.parse(line);
	if (!parsed || typeof parsed !== "object") throw new Error("Sandbox broker frame must be an object");
	const value = parsed as { version?: unknown; type?: unknown };
	if (value.version !== BROKER_PROTOCOL_VERSION) {
		throw new Error(`Unsupported sandbox broker protocol version: ${String(value.version)}`);
	}
	if (typeof value.type !== "string") throw new Error("Sandbox broker frame is missing a type");
	return value as BrokerClientFrame | BrokerServerFrame;
}
