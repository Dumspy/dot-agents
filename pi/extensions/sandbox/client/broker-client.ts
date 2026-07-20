import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { Socket } from "node:net";
import {
	BROKER_PROTOCOL_VERSION,
	encodeFrame,
	FrameBuffer,
	parseFrame,
	type ApprovalRequiredData,
	type BrokerApproveMountParams,
	type BrokerAttachParams,
	type BrokerEventFrame,
	type BrokerMountParams,
	type BrokerRequestPayload,
	type BrokerResolvedPath,
	type BrokerResponseFrame,
	type BrokerResponsePayload,
	type BrokerServerFrame,
	type BrokerSnapshot,
	type BrokerStreamFrame,
	type BrokerToolParams,
} from "../protocol.js";
import type {
	AccessMode,
	ExternalMount,
	SandboxBackendName,
	SandboxStartOptions,
	SandboxToolInputMap,
	SandboxToolName,
	SandboxToolRequestFor,
	SandboxToolResultMap,
} from "../types.js";
import { connectOrLaunchBroker } from "./runtime.js";

type PendingRequest = {
	resolve: (value: BrokerResponsePayload) => void;
	reject: (error: Error) => void;
	onStream?: (frame: BrokerStreamFrame) => void;
	signal?: AbortSignal;
	abort?: () => void;
};

const PROCESS_LEASE_KEY = Symbol.for("dot-agents.pi-sandbox.process-lease");

function processLeaseToken(): string {
	const globals = globalThis as typeof globalThis & { [PROCESS_LEASE_KEY]?: string };
	globals[PROCESS_LEASE_KEY] ??= randomUUID();
	return globals[PROCESS_LEASE_KEY];
}

type BrokerConnectOptions = {
	[TBackend in SandboxBackendName]: {
		workspace: string;
		backend: TBackend;
		startOptions: SandboxStartOptions<TBackend>;
	};
}[SandboxBackendName];

export class BrokerApprovalRequiredError extends Error {
	constructor(readonly approval: ApprovalRequiredData) {
		super(`External ${approval.requestedMode} access is required for ${approval.hostPath}`);
		this.name = "BrokerApprovalRequiredError";
	}
}

export class BrokerClient extends EventEmitter {
	readonly #pending = new Map<string, PendingRequest>();
	readonly #buffer = new FrameBuffer();
	#closed = false;

	get closed(): boolean {
		return this.#closed || this.socket.destroyed;
	}

	private constructor(
		readonly socket: Socket,
		readonly workspace: string,
		readonly leaseToken: string,
	) {
		super();
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.#data(chunk));
		socket.on("error", (error) => this.#failAll(error));
		socket.on("close", () => this.#failAll(new Error("Sandbox broker connection closed")));
	}

	static async connect(options: BrokerConnectOptions & { launcherPath: string }): Promise<{ client: BrokerClient; snapshot: BrokerSnapshot }> {
		const { socket } = await connectOrLaunchBroker({ workspace: options.workspace, launcherPath: options.launcherPath });
		return this.attachSocket(socket, { ...options, leaseToken: processLeaseToken(), pid: process.pid });
	}

	static async attachSocket(
		socket: Socket,
		options: BrokerConnectOptions & {
			leaseToken: string;
			pid: number;
		},
	): Promise<{ client: BrokerClient; snapshot: BrokerSnapshot }> {
		const client = new BrokerClient(socket, options.workspace, options.leaseToken);
		try {
			const snapshot = await client.request<BrokerSnapshot>("attach", {
				workspace: options.workspace,
				leaseToken: options.leaseToken,
				pid: options.pid,
				backend: options.backend,
				startOptions: options.startOptions,
			} satisfies BrokerAttachParams);
			return { client, snapshot };
		} catch (error) {
			socket.destroy();
			throw error;
		}
	}

	request<T extends BrokerResponsePayload>(
		method: string,
		params?: BrokerRequestPayload,
		options: { signal?: AbortSignal; onStream?: (frame: BrokerStreamFrame) => void } = {},
	): Promise<T> {
		if (this.#closed || this.socket.destroyed) return Promise.reject(new Error("Sandbox broker connection is closed"));
		if (options.signal?.aborted) return Promise.reject(new Error("aborted"));
		const id = randomUUID();
		return new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				resolve: resolve as (value: BrokerResponsePayload) => void,
				reject,
				onStream: options.onStream,
			};
			if (options.signal) {
				pending.signal = options.signal;
				pending.abort = () => {
					if (!this.socket.destroyed) {
						this.socket.write(encodeFrame({ version: BROKER_PROTOCOL_VERSION, type: "cancel", id }));
					}
				};
				options.signal.addEventListener("abort", pending.abort, { once: true });
			}
			this.#pending.set(id, pending);
			this.socket.write(
				encodeFrame({ version: BROKER_PROTOCOL_VERSION, type: "request", id, method, params }),
			);
		});
	}

	tool<TName extends SandboxToolName>(
		name: TName,
		toolCallId: string,
		params: SandboxToolInputMap[TName],
		signal?: AbortSignal,
		onUpdate?: (update: SandboxToolResultMap[TName]) => void,
	): Promise<SandboxToolResultMap[TName]> {
		const request: SandboxToolRequestFor<TName> = { name, toolCallId, params };
		return this.request<SandboxToolResultMap[TName]>("tool", request as BrokerToolParams, {
			signal,
			onStream: (frame) => {
				if (frame.event === "tool-update") onUpdate?.(frame.data as SandboxToolResultMap[TName]);
			},
		});
	}

	exec(
		command: string,
		cwd: string,
		options: { signal?: AbortSignal; timeout?: number; onData: (data: Buffer) => void },
	): Promise<{ exitCode: number | null }> {
		return this.request("exec", { command, cwd, timeout: options.timeout }, {
			signal: options.signal,
			onStream: (frame) => {
				if (frame.event === "exec-data" && typeof frame.data === "string") {
					options.onData(Buffer.from(frame.data, "base64"));
				}
			},
		});
	}

	resolvePath(path: string, mode: AccessMode): Promise<BrokerResolvedPath> {
		return this.request("resolvePath", { path, mode });
	}

	approveMount(approvalId: string, path: string, mode: AccessMode): Promise<ExternalMount> {
		return this.request("approveMount", { approvalId, path, mode } satisfies BrokerApproveMountParams);
	}

	async denyApproval(approvalId: string): Promise<void> {
		await this.request<undefined>("denyApproval", { approvalId });
	}

	mount(path: string, mode: AccessMode): Promise<ExternalMount> {
		return this.request("mount", { path, mode } satisfies BrokerMountParams);
	}

	listMounts(): Promise<ExternalMount[]> {
		return this.request("listMounts");
	}

	setMountMode(hostPath: string, mode: AccessMode): Promise<ExternalMount> {
		return this.request("setMountMode", { hostPath, mode });
	}

	removeMount(hostPath: string): Promise<ExternalMount> {
		return this.request("removeMount", { hostPath });
	}

	status(): Promise<BrokerSnapshot> {
		return this.request("status");
	}

	async close(final: boolean): Promise<void> {
		if (this.#closed) return;
		if (final && !this.socket.destroyed) await this.request("detach").catch(() => undefined);
		this.#closed = true;
		const closed = this.socket.destroyed ? Promise.resolve() : once(this.socket, "close").then(() => undefined);
		this.socket.end();
		this.socket.destroy();
		this.#failAll(new Error("Sandbox broker client closed"));
		await closed;
	}

	#data(chunk: string): void {
		let lines: string[];
		try {
			lines = this.#buffer.push(chunk);
		} catch (error) {
			this.socket.destroy(error as Error);
			return;
		}
		for (const line of lines) {
			let frame: BrokerServerFrame;
			try {
				frame = parseFrame(line) as BrokerServerFrame;
			} catch (error) {
				this.socket.destroy(error as Error);
				return;
			}
			if (frame.type === "response") this.#response(frame);
			else if (frame.type === "stream") this.#pending.get(frame.id)?.onStream?.(frame);
			else if (frame.type === "event") this.emit("event", frame as BrokerEventFrame);
		}
	}

	#response(frame: BrokerResponseFrame): void {
		const pending = this.#pending.get(frame.id);
		if (!pending) return;
		this.#pending.delete(frame.id);
		if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
		if (frame.ok) pending.resolve(frame.result);
		else if (frame.error?.data?.kind === "approval-required") {
			pending.reject(new BrokerApprovalRequiredError(frame.error.data));
		} else pending.reject(new Error(frame.error?.message ?? "Sandbox broker request failed"));
	}

	#failAll(error: Error): void {
		if (this.#closed && this.#pending.size === 0) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
			pending.reject(error);
		}
		this.#pending.clear();
		super.emit("disconnect", error);
	}
}
