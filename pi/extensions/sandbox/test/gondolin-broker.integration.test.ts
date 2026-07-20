import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerClient } from "../client/broker-client.js";
import { connectOrLaunchBroker } from "../client/runtime.js";
import type { SandboxStartOptions } from "../types.js";

const integration = process.env.RUN_GONDOLIN_TESTS === "1" ? describe : describe.skip;

integration("Gondolin workspace broker integration", () => {
	let root: string;
	let workspacePath: string;
	let external: string;
	let first: BrokerClient;
	let second: BrokerClient;

	beforeAll(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "pi-gondolin-broker-"));
		workspacePath = path.join(root, "workspace");
		external = path.join(root, "external");
		await Promise.all([mkdir(workspacePath), mkdir(external)]);
		await writeFile(path.join(workspacePath, ".env"), "TOKEN=secret");
		await writeFile(path.join(external, "shared.txt"), "external-shared");
		const launcherPath = fileURLToPath(new URL("../../../dist/sandbox-broker/broker/main.js", import.meta.url));
		const startOptions: SandboxStartOptions<"gondolin"> = {
			workspaceHostPath: workspacePath,
			workspaceGuestPath: "/workspace",
			backendConfig: {
				cpus: 1,
				memoryBytes: 1024 ** 3,
				rootfsBytes: 2 * 1024 ** 3,
				startupCommands: [],
			},
			protectedPaths: [],
		};
		first = (
			await BrokerClient.attachSocket((await connectOrLaunchBroker({ workspace: workspacePath, launcherPath })).socket, {
				workspace: workspacePath,
				backend: "gondolin",
				startOptions,
				leaseToken: "gondolin-one",
				pid: 3001,
			})
		).client;
		second = (
			await BrokerClient.attachSocket((await connectOrLaunchBroker({ workspace: workspacePath, launcherPath })).socket, {
				workspace: workspacePath,
				backend: "gondolin",
				startOptions,
				leaseToken: "gondolin-two",
				pid: 3002,
			})
		).client;
	}, 180_000);

	afterAll(async () => {
		await first?.close(true).catch(() => undefined);
		await second?.close(true).catch(() => undefined);
		if (root) await rm(root, { recursive: true, force: true });
	}, 30_000);

	it("shares VM identity, guest-local state, and workspace files", async () => {
		const firstStatus = await first.status();
		const secondStatus = await second.status();
		expect(firstStatus.backend.id).toBe(secondStatus.backend.id);
		await first.tool("bash", "bash-write", { command: "printf shared-guest > /tmp/pi-broker-shared" });
		const guestRead = await second.tool("bash", "bash-read", { command: "cat /tmp/pi-broker-shared" });
		expect(guestRead.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("shared-guest") })]));
		await first.tool("write", "workspace-write", { path: "shared-workspace.txt", content: "workspace-shared" });
		const workspaceRead = await second.tool("read", "workspace-read", { path: "shared-workspace.txt" });
		expect(workspaceRead.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("workspace-shared") })]),
		);
	});

	it("shares approved mounts while retaining protected-path enforcement", async () => {
		const mount = await first.mount(external, "read-only");
		const externalRead = await second.tool("read", "external-read", { path: path.join(external, "shared.txt") });
		expect(externalRead.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("external-shared") })]),
		);
		await expect(second.tool("write", "external-write", { path: `${mount.guestPath}/created.txt`, content: "no" })).rejects.toBeDefined();
		await expect(first.tool("read", "protected-read", { path: ".env" })).rejects.toBeDefined();
	});

	it("keeps the broker alive until the final explicit detach", async () => {
		await first.close(true);
		expect((await second.status()).attachedProcesses).toBe(1);
		expect((await second.status()).backend.state).toBe("running");
	});
});
