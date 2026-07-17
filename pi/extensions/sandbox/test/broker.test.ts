import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceBrokerServer } from "../broker/server.js";
import { WorkspaceScheduler } from "../broker/scheduler.js";
import { BrokerWorkspace } from "../broker/workspace.js";
import { BrokerApprovalRequiredError, BrokerClient } from "../client/broker-client.js";
import type {
	ExternalMount,
	SandboxBackendStatus,
	SandboxExecutionBackend,
	SandboxStartOptions,
	SandboxToolRequest,
	SandboxToolResult,
	SandboxToolUpdate,
} from "../types.js";

const roots: string[] = [];

class FakeBackend implements SandboxExecutionBackend<"gondolin"> {
	readonly name = "gondolin" as const;
	readonly mode = "gondolin" as const;
	readonly files = new Map<string, string>();
	readonly mounts = new Map<string, ExternalMount>();
	starts = 0;
	stops = 0;
	state: SandboxBackendStatus["state"] = "stopped";

	async start(_options: SandboxStartOptions): Promise<void> {
		this.starts++;
		this.state = "running";
	}
	async stop(): Promise<void> {
		this.stops++;
		this.state = "stopped";
	}
	status(): SandboxBackendStatus {
		return { name: this.name, mode: this.mode, state: this.state, id: "fake-vm" };
	}
	isAlive(): boolean {
		return this.state === "running";
	}
	markFailed(_error: Error): void {
		this.state = "failed";
	}
	async recover(): Promise<void> {
		this.state = "running";
	}
	async mountExternal(mount: ExternalMount): Promise<void> {
		this.mounts.set(mount.hostPath, { ...mount });
	}
	async updateExternalMount(mount: ExternalMount): Promise<void> {
		this.mounts.set(mount.hostPath, { ...mount });
	}
	async unmountExternal(guestPath: string): Promise<void> {
		const mount = [...this.mounts.values()].find((candidate) => candidate.guestPath === guestPath);
		if (mount) this.mounts.delete(mount.hostPath);
	}
	async executeTool(
		request: SandboxToolRequest,
		_signal?: AbortSignal,
		onUpdate?: SandboxToolUpdate,
	): Promise<SandboxToolResult> {
		if (request.name === "write") {
			this.files.set(request.params.path, request.params.content);
			return { content: [{ type: "text", text: "wrote" }], details: undefined };
		}
		if (request.name === "read") {
			return { content: [{ type: "text", text: this.files.get(request.params.path) ?? "" }], details: undefined };
		}
		onUpdate?.({ content: [{ type: "text", text: "update" }], details: undefined });
		return { content: [{ type: "text", text: request.name }], details: undefined };
	}
	async exec(
		command: string,
		_cwd: string,
		options: { signal?: AbortSignal; timeout?: number; onData: (data: Buffer) => void },
	): Promise<{ exitCode: number | null }> {
		options.onData(Buffer.from(command));
		return { exitCode: 0 };
	}
}

function startOptions(workspace: string): SandboxStartOptions {
	return {
		workspaceHostPath: workspace,
		workspaceGuestPath: "/workspace",
		backendConfig: {
			cpus: 1,
			memoryBytes: 1024 ** 3,
			rootfsBytes: 2 * 1024 ** 3,
			startupCommands: [],
		},
		protectedPaths: [],
	};
}

async function connect(socketPath: string) {
	return new Promise<net.Socket>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace broker", () => {
	it("shares one backend across independent clients until the final lease detaches", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-broker-test-"));
		roots.push(root);
		const socketPath = path.join(root, "broker.sock");
		const backend = new FakeBackend();
		let server: WorkspaceBrokerServer | undefined;
		const workspace = new BrokerWorkspace(root, (event, data) => server?.broadcast(event, data), {
			gondolin: () => backend,
		});
		server = new WorkspaceBrokerServer(socketPath, workspace, 10);
		await server.listen();
		const options = { workspace: root, backend: "gondolin" as const, startOptions: startOptions(root) };
		const first = await BrokerClient.attachSocket(await connect(socketPath), {
			...options,
			leaseToken: "lease-one",
			pid: 1001,
		});
		const second = await BrokerClient.attachSocket(await connect(socketPath), {
			...options,
			leaseToken: "lease-two",
			pid: 1002,
		});

		expect(first.snapshot.created).toBe(true);
		expect(second.snapshot.created).toBe(false);
		expect(first.snapshot.backend.id).toBe(second.snapshot.backend.id);
		expect(backend.starts).toBe(1);
		await first.client.tool("write", "write-1", { path: "shared.txt", content: "shared" });
		const read = await second.client.tool("read", "read-1", { path: "shared.txt" });
		expect(read.content[0]?.text).toBe("shared");

		await first.client.close(false);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect((await second.client.status()).attachedProcesses).toBe(1);
		expect(backend.stops).toBe(0);
		const closed = once(server, "closed");
		await second.client.close(true);
		await closed;
		expect(backend.stops).toBe(1);
	});

	it("reconnects one Pi-process lease across extension replacement", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-broker-test-"));
		roots.push(root);
		const socketPath = path.join(root, "broker.sock");
		const backend = new FakeBackend();
		let server: WorkspaceBrokerServer | undefined;
		const workspace = new BrokerWorkspace(root, (event, data) => server?.broadcast(event, data), {
			gondolin: () => backend,
		});
		server = new WorkspaceBrokerServer(socketPath, workspace, 100);
		await server.listen();
		const options = {
			workspace: root,
			backend: "gondolin" as const,
			startOptions: startOptions(root),
			leaseToken: "reconnecting-lease",
			pid: 1500,
		};
		const initial = await BrokerClient.attachSocket(await connect(socketPath), options);
		await initial.client.close(false);
		const reconnected = await BrokerClient.attachSocket(await connect(socketPath), options);
		expect(reconnected.snapshot.created).toBe(false);
		expect(reconnected.snapshot.attachedProcesses).toBe(1);
		expect(backend.starts).toBe(1);
		const closed = once(server, "closed");
		await reconnected.client.close(true);
		await closed;
	});

	it("serializes approval prompts across attached clients", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-broker-test-"));
		roots.push(root);
		const socketPath = path.join(root, "broker.sock");
		const workspacePath = path.join(root, "workspace");
		const external = path.join(root, "external");
		await Promise.all([mkdir(workspacePath), mkdir(external)]);
		const backend = new FakeBackend();
		let server: WorkspaceBrokerServer | undefined;
		const workspace = new BrokerWorkspace(workspacePath, (event, data) => server?.broadcast(event, data), {
			gondolin: () => backend,
		});
		server = new WorkspaceBrokerServer(socketPath, workspace, 10);
		await server.listen();
		const options = { workspace: workspacePath, backend: "gondolin" as const, startOptions: startOptions(workspacePath) };
		const first = await BrokerClient.attachSocket(await connect(socketPath), {
			...options,
			leaseToken: "approval-one",
			pid: 2001,
		});
		const second = await BrokerClient.attachSocket(await connect(socketPath), {
			...options,
			leaseToken: "approval-two",
			pid: 2002,
		});

		const firstError = await first.client.tool("read", "approval-read-1", { path: external }).catch((error: Error) => error);
		expect(firstError).toBeInstanceOf(BrokerApprovalRequiredError);
		let secondSettled = false;
		const secondErrorPromise = second.client
			.tool("read", "approval-read-2", { path: external })
			.catch((error: Error) => error)
			.finally(() => {
				secondSettled = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(secondSettled).toBe(false);
		if (!(firstError instanceof BrokerApprovalRequiredError)) throw new Error("Expected first approval request");
		await first.client.approveMount(firstError.approval.approvalId, external, "read-only");
		const secondResult = await secondErrorPromise;
		expect(secondResult).not.toBeInstanceOf(Error);

		await first.client.close(true);
		const closed = once(server, "closed");
		await second.client.close(true);
		await closed;
	});

	it("rejects a conflicting specification for an active workspace", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-broker-test-"));
		roots.push(root);
		const backend = new FakeBackend();
		const workspace = new BrokerWorkspace(root, () => undefined, { gondolin: () => backend });
		await workspace.attach(
			{ workspace: root, leaseToken: "one", pid: 1, backend: "gondolin", startOptions: startOptions(root) },
			1,
		);
		const changed = startOptions(root);
		(changed.backendConfig as { cpus: number }).cpus = 2;
		await expect(
			workspace.attach({ workspace: root, leaseToken: "two", pid: 2, backend: "gondolin", startOptions: changed }, 2),
		).rejects.toThrow("does not match");
		await workspace.stop();
	});

	it("shares mounts and only upgrades access through a more permissive request", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-broker-test-"));
		roots.push(root);
		const external = path.join(root, "external");
		const workspacePath = path.join(root, "workspace");
		await Promise.all([mkdir(external), mkdir(workspacePath)]);
		const backend = new FakeBackend();
		const workspace = new BrokerWorkspace(workspacePath, () => undefined, { gondolin: () => backend });
		await workspace.attach(
			{ workspace: workspacePath, leaseToken: "one", pid: 1, backend: "gondolin", startOptions: startOptions(workspacePath) },
			1,
		);
		const readOnly = await workspace.approveMount(external, "read-only");
		expect(readOnly.mode).toBe("read-only");
		const reused = await workspace.approveMount(external, "read-only");
		expect(reused).toEqual(readOnly);
		const upgraded = await workspace.approveMount(external, "read-write");
		expect(upgraded.mode).toBe("read-write");
		expect(workspace.listMounts()[0]?.mode).toBe("read-write");
		await workspace.stop();
	});
});

describe("WorkspaceScheduler", () => {
	it("queues later readers behind a pending exclusive mount change", async () => {
		const scheduler = new WorkspaceScheduler();
		const order: string[] = [];
		let releaseReader!: () => void;
		const readerGate = new Promise<void>((resolve) => {
			releaseReader = resolve;
		});
		const first = scheduler.runShared(async () => {
			order.push("reader-start");
			await readerGate;
			order.push("reader-end");
		});
		await Promise.resolve();
		const writer = scheduler.runExclusive(async () => {
			order.push("writer");
		});
		const laterReader = scheduler.runShared(async () => {
			order.push("later-reader");
		});
		releaseReader();
		await Promise.all([first, writer, laterReader]);
		expect(order).toEqual(["reader-start", "reader-end", "writer", "later-reader"]);
	});

	it("uses a queue timeout distinct from backend execution timeout", async () => {
		const scheduler = new WorkspaceScheduler(10);
		let releaseWriter!: () => void;
		const writerGate = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});
		const writer = scheduler.runExclusive(() => writerGate);
		await Promise.resolve();
		await expect(scheduler.runShared(async () => undefined)).rejects.toThrow("queue timed out");
		releaseWriter();
		await writer;
	});

	it("removes a cancelled operation while it waits behind a mount change", async () => {
		const scheduler = new WorkspaceScheduler();
		let releaseWriter!: () => void;
		const writerGate = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});
		const writer = scheduler.runExclusive(() => writerGate);
		await Promise.resolve();
		const controller = new AbortController();
		const queued = scheduler.runShared(async () => undefined, controller.signal);
		controller.abort();
		await expect(queued).rejects.toThrow("aborted");
		releaseWriter();
		await writer;
	});
});
