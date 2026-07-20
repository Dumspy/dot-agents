import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { EventEmitter } from "node:events";
import {
	BROKER_PROTOCOL_VERSION,
	BROKER_RECONNECT_GRACE_MS,
	BROKER_START_TIMEOUT_MS,
	encodeFrame,
	FrameBuffer,
	parseFrame,
	type ApprovalRequiredData,
	type BrokerApproveMountParams,
	type BrokerAttachParams,
	type BrokerCancelFrame,
	type BrokerClientFrame,
	type BrokerEventDataMap,
	type BrokerDenyApprovalParams,
	type BrokerEventFrame,
	type BrokerExecParams,
	type BrokerMountParams,
	type BrokerRequestFrame,
	type BrokerResolvePathParams,
	type BrokerResponseFrame,
	type BrokerResponsePayload,
	type BrokerServerFrame,
	type BrokerSetMountModeParams,
	type BrokerSnapshot,
	type BrokerToolParams,
	type BrokerUnmountParams,
} from "../protocol.js";
import { guestMountPath } from "../paths.js";
import { ExternalAccessRequiredError } from "../policy.js";
import { errorMessage } from "../utils.js";
import { BrokerWorkspace } from "./workspace.js";

type Lease = {
	token: string;
	pid: number;
	socket?: Socket;
	timer?: NodeJS.Timeout;
};

type ConnectionState = {
	buffer: FrameBuffer;
	leaseToken?: string;
	requests: Map<string, AbortController>;
};

type ApprovalReservation = {
	id: string;
	owner: string;
};

type ApprovalWaiter = {
	owner: string;
	signal: AbortSignal;
	resolve: (reservation: ApprovalReservation) => void;
	reject: (error: Error) => void;
	onAbort: () => void;
};

export class WorkspaceBrokerServer extends EventEmitter {
	readonly #server = net.createServer((socket) => this.#accept(socket));
	readonly #leases = new Map<string, Lease>();
	readonly #connections = new Map<Socket, ConnectionState>();
	readonly #approvalWaiters: ApprovalWaiter[] = [];
	#activeApproval: ApprovalReservation | undefined;
	#startupTimer: NodeJS.Timeout | undefined;
	#closing = false;

	constructor(
		readonly socketPath: string,
		readonly workspace: BrokerWorkspace,
		readonly reconnectGraceMs = BROKER_RECONNECT_GRACE_MS,
	) {
		super();
	}

	attachedProcesses(): number {
		return this.#leases.size;
	}

	async listen(): Promise<void> {
		await rm(this.socketPath, { force: true }).catch(() => undefined);
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			this.#server.once("error", onError);
			this.#server.listen(this.socketPath, () => {
				this.#server.off("error", onError);
				resolve();
			});
		});
		await chmod(this.socketPath, 0o600);
		this.#startupTimer = setTimeout(() => {
			if (this.#leases.size === 0) void this.close();
		}, BROKER_START_TIMEOUT_MS);
		this.#startupTimer.unref();
	}

	broadcast<TEvent extends keyof BrokerEventDataMap>(event: TEvent, data: BrokerEventDataMap[TEvent]): void {
		const frame = { version: BROKER_PROTOCOL_VERSION, type: "event", event, data } as BrokerEventFrame;
		for (const socket of this.#connections.keys()) this.#send(socket, frame);
	}

	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		if (this.#startupTimer) clearTimeout(this.#startupTimer);
		this.#startupTimer = undefined;
		for (const lease of this.#leases.values()) if (lease.timer) clearTimeout(lease.timer);
		this.#leases.clear();
		this.#activeApproval = undefined;
		for (const waiter of this.#approvalWaiters.splice(0)) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error("Sandbox broker is shutting down"));
		}
		for (const state of this.#connections.values()) {
			for (const controller of state.requests.values()) controller.abort();
		}
		await this.workspace.stop().catch(() => undefined);
		for (const socket of this.#connections.keys()) socket.destroy();
		this.#connections.clear();
		await new Promise<void>((resolve) => {
			if (!this.#server.listening) return resolve();
			this.#server.close(() => resolve());
		});
		await rm(this.socketPath, { force: true }).catch(() => undefined);
		this.emit("closed");
	}

	#accept(socket: Socket): void {
		if (this.#closing) {
			socket.destroy();
			return;
		}
		socket.setEncoding("utf8");
		const state: ConnectionState = { buffer: new FrameBuffer(), requests: new Map() };
		this.#connections.set(socket, state);
		socket.on("data", (chunk: string) => this.#data(socket, state, chunk));
		socket.on("error", () => undefined);
		socket.on("close", () => this.#disconnect(socket, state));
	}

	#data(socket: Socket, state: ConnectionState, chunk: string): void {
		let lines: string[];
		try {
			lines = state.buffer.push(chunk);
		} catch (error) {
			socket.destroy(error as Error);
			return;
		}
		for (const line of lines) {
			let frame: BrokerClientFrame;
			try {
				frame = parseFrame(line) as BrokerClientFrame;
			} catch (error) {
				socket.destroy(new Error(errorMessage(error)));
				return;
			}
			if (frame.type === "cancel") this.#cancel(state, frame);
			else if (frame.type === "request") void this.#request(socket, state, frame);
			else {
				socket.destroy(new Error(`Unexpected broker frame type: ${(frame as { type: string }).type}`));
				return;
			}
		}
	}

	#cancel(state: ConnectionState, frame: BrokerCancelFrame): void {
		state.requests.get(frame.id)?.abort();
	}

	async #request(socket: Socket, state: ConnectionState, frame: BrokerRequestFrame): Promise<void> {
		if (state.requests.has(frame.id)) {
			this.#respond(socket, frame.id, false, undefined, new Error(`Duplicate request id: ${frame.id}`));
			return;
		}
		const controller = new AbortController();
		state.requests.set(frame.id, controller);
		try {
			const result = await this.#dispatch(socket, state, frame, controller.signal);
			this.#respond(socket, frame.id, true, result);
		} catch (error) {
			if (error instanceof ExternalAccessRequiredError && state.leaseToken) {
				await this.#retryWithApproval(socket, state, frame, controller.signal);
			} else {
				this.#respond(socket, frame.id, false, undefined, error);
			}
		} finally {
			state.requests.delete(frame.id);
		}
	}

	/**
	 * Retry a request while holding the workspace-wide approval slot. When the
	 * retry still needs approval, the reservation stays active so the client can
	 * explicitly approve or deny it.
	 */
	async #retryWithApproval(
		socket: Socket,
		state: ConnectionState,
		frame: BrokerRequestFrame,
		signal: AbortSignal,
	): Promise<void> {
		const leaseToken = state.leaseToken!;
		let reservation: ApprovalReservation;
		try {
			reservation = await this.#acquireApproval(leaseToken, signal);
		} catch (queueError) {
			this.#respond(socket, frame.id, false, undefined, queueError);
			return;
		}
		try {
			const result = await this.#dispatch(socket, state, frame, signal);
			this.#releaseApproval(reservation.id, leaseToken);
			this.#respond(socket, frame.id, true, result);
		} catch (retryError) {
			if (retryError instanceof ExternalAccessRequiredError) {
				this.#respond(socket, frame.id, false, undefined, retryError, reservation.id);
			} else {
				this.#releaseApproval(reservation.id, leaseToken);
				this.#respond(socket, frame.id, false, undefined, retryError);
			}
		}
	}

	async #dispatch(
		socket: Socket,
		state: ConnectionState,
		frame: BrokerRequestFrame,
		signal: AbortSignal,
	): Promise<BrokerResponsePayload> {
		if (frame.method === "attach") return this.#attach(socket, state, frame.params as BrokerAttachParams);
		if (!state.leaseToken) throw new Error("Client must attach before using the sandbox broker");
		switch (frame.method) {
			case "detach":
				this.#removeLease(state.leaseToken);
				state.leaseToken = undefined;
				return undefined;
			case "status":
				return this.workspace.snapshot(this.attachedProcesses());
			case "tool": {
				const params = frame.params as BrokerToolParams;
				return this.workspace.executeTool(params, signal, (update) => {
					this.#send(socket, {
						version: BROKER_PROTOCOL_VERSION,
						type: "stream",
						id: frame.id,
						event: "tool-update",
						data: update,
					});
				});
			}
			case "exec": {
				const params = frame.params as BrokerExecParams;
				return this.workspace.exec(params.command, params.cwd, {
					signal,
					timeout: params.timeout,
					onData: (data) => {
						this.#send(socket, {
							version: BROKER_PROTOCOL_VERSION,
							type: "stream",
							id: frame.id,
							event: "exec-data",
							data: data.toString("base64"),
						});
					},
				});
			}
			case "resolvePath": {
				const params = frame.params as BrokerResolvePathParams;
				return this.workspace.resolvePath(params.path, params.mode);
			}
			case "approveMount": {
				const params = frame.params as BrokerApproveMountParams;
				try {
					this.#assertApprovalOwner(params.approvalId, state.leaseToken);
					return await this.workspace.approveMount(params.path, params.mode);
				} finally {
					this.#releaseApproval(params.approvalId, state.leaseToken);
				}
			}
			case "denyApproval": {
				const params = frame.params as BrokerDenyApprovalParams;
				this.#assertApprovalOwner(params.approvalId, state.leaseToken);
				this.#releaseApproval(params.approvalId, state.leaseToken);
				return undefined;
			}
			case "mount": {
				const params = frame.params as BrokerMountParams;
				return this.workspace.mount(params.path, params.mode);
			}
			case "listMounts":
				return this.workspace.listMounts();
			case "setMountMode": {
				const params = frame.params as BrokerSetMountModeParams;
				return this.workspace.setMountMode(params.hostPath, params.mode);
			}
			case "removeMount": {
				const params = frame.params as BrokerUnmountParams;
				return this.workspace.removeMount(params.hostPath);
			}
			case "stop":
				if (this.attachedProcesses() !== 1) throw new Error("Sandbox stop requires the sole active Pi process lease");
				setImmediate(() => void this.close());
				return undefined;
			default:
				throw new Error(`Unknown sandbox broker method: ${frame.method}`);
		}
	}

	async #attach(socket: Socket, state: ConnectionState, params: BrokerAttachParams): Promise<BrokerSnapshot> {
		if (!params || typeof params.leaseToken !== "string" || !params.leaseToken) throw new Error("Invalid broker attachment");
		if (state.leaseToken && state.leaseToken !== params.leaseToken) throw new Error("Connection is already attached");
		const existing = this.#leases.get(params.leaseToken);
		if (existing?.socket && existing.socket !== socket) throw new Error("Pi process lease is already attached");
		if (existing?.timer) clearTimeout(existing.timer);
		const lease: Lease = existing ?? { token: params.leaseToken, pid: params.pid };
		lease.pid = params.pid;
		lease.socket = socket;
		lease.timer = undefined;
		this.#leases.set(params.leaseToken, lease);
		state.leaseToken = params.leaseToken;
		try {
			const snapshot = await this.workspace.attach(params, this.attachedProcesses());
			if (this.#startupTimer) clearTimeout(this.#startupTimer);
			this.#startupTimer = undefined;
			this.broadcast("attached-processes-changed", { attachedProcesses: this.attachedProcesses() });
			return snapshot;
		} catch (error) {
			this.#leases.delete(params.leaseToken);
			state.leaseToken = undefined;
			if (this.#leases.size === 0) setImmediate(() => void this.close());
			throw error;
		}
	}

	#disconnect(socket: Socket, state: ConnectionState): void {
		this.#connections.delete(socket);
		for (const controller of state.requests.values()) controller.abort();
		const token = state.leaseToken;
		if (!token) return;
		this.#cancelApprovals(token);
		const lease = this.#leases.get(token);
		if (!lease || lease.socket !== socket) return;
		lease.socket = undefined;
		lease.timer = setTimeout(() => this.#removeLease(token), this.reconnectGraceMs);
		lease.timer.unref();
	}

	#removeLease(token: string): void {
		const lease = this.#leases.get(token);
		if (!lease) return;
		if (lease.timer) clearTimeout(lease.timer);
		this.#leases.delete(token);
		this.broadcast("attached-processes-changed", { attachedProcesses: this.attachedProcesses() });
		if (this.#leases.size === 0) setImmediate(() => void this.close());
	}

	#respond(
		socket: Socket,
		id: string,
		ok: boolean,
		result?: BrokerResponsePayload,
		error?: unknown,
		approvalId?: string,
	): void {
		const frame: BrokerResponseFrame = { version: BROKER_PROTOCOL_VERSION, type: "response", id, ok };
		if (ok) frame.result = result;
		else {
			frame.error = { message: errorMessage(error) };
			if (error instanceof ExternalAccessRequiredError && approvalId) {
				const data: ApprovalRequiredData = {
					kind: "approval-required",
					approvalId,
					hostPath: error.hostPath,
					mountRoot: error.mountRoot,
					guestPath:
						this.workspace.policy.mounts.findByHostPath(error.mountRoot)?.guestPath ??
						guestMountPath(
							error.mountRoot,
							this.workspace.policy.mounts.list().map((mount) => mount.guestPath),
						),
					requestedMode: error.requestedMode,
					fileRequest: error.fileRequest,
					upgrade: error.upgrade,
				};
				frame.error.data = data;
			}
		}
		this.#send(socket, frame);
	}

	#removeApprovalWaiter(waiter: ApprovalWaiter): void {
		const index = this.#approvalWaiters.indexOf(waiter);
		if (index >= 0) this.#approvalWaiters.splice(index, 1);
		waiter.signal.removeEventListener("abort", waiter.onAbort);
	}

	#acquireApproval(owner: string, signal: AbortSignal): Promise<ApprovalReservation> {
		if (signal.aborted) return Promise.reject(new Error("aborted"));
		if (!this.#activeApproval) {
			const reservation = { id: randomUUID(), owner };
			this.#activeApproval = reservation;
			return Promise.resolve(reservation);
		}
		return new Promise((resolve, reject) => {
			const waiter: ApprovalWaiter = {
				owner,
				signal,
				resolve,
				reject,
				onAbort: () => {
					this.#removeApprovalWaiter(waiter);
					reject(new Error("aborted"));
				},
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.#approvalWaiters.push(waiter);
		});
	}

	#assertApprovalOwner(id: string, owner: string): void {
		if (this.#activeApproval?.id !== id || this.#activeApproval.owner !== owner) {
			throw new Error("External mount approval is no longer active for this Pi process");
		}
	}

	#releaseApproval(id: string, owner: string): void {
		if (this.#activeApproval?.id !== id || this.#activeApproval.owner !== owner) return;
		this.#activeApproval = undefined;
		while (this.#approvalWaiters.length > 0) {
			const waiter = this.#approvalWaiters.shift()!;
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal.aborted) continue;
			const reservation = { id: randomUUID(), owner: waiter.owner };
			this.#activeApproval = reservation;
			waiter.resolve(reservation);
			break;
		}
	}

	#cancelApprovals(owner: string): void {
		if (this.#activeApproval?.owner === owner) {
			this.#releaseApproval(this.#activeApproval.id, owner);
		}
		for (const waiter of [...this.#approvalWaiters]) {
			if (waiter.owner !== owner) continue;
			this.#removeApprovalWaiter(waiter);
			waiter.reject(new Error("Approval requester disconnected"));
		}
	}

	#send(socket: Socket, frame: BrokerServerFrame): void {
		if (!socket.destroyed) socket.write(encodeFrame(frame));
	}
}
