import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VM, VirtualProvider } from "@earendil-works/gondolin";
import { afterEach, describe, expect, it } from "vitest";
import { GondolinBackend } from "../backends/gondolin.js";

const roots: string[] = [];

function fakeVm(id: string, closeDelayMs = 0): VM {
	let closed = false;
	return {
		id,
		getHostPid: () => (closed ? null : 1234),
		exec: async () => ({ exitCode: 0, stdout: "/bin/sh\n", stderr: "" }),
		close: async () => {
			if (closeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, closeDelayMs));
			closed = true;
		},
	} as unknown as VM;
}

function startOptions(workspace: string, protectedPaths: string[] = []) {
	return {
		workspaceHostPath: workspace,
		workspaceGuestPath: "/workspace" as const,
		gondolin: {
			cpus: 1,
			memoryBytes: 1024 ** 3,
			rootfsBytes: 2 * 1024 ** 3,
			startupCommands: [],
		},
		protectedPaths,
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GondolinBackend", () => {
	it("serializes concurrent recovery into one replacement VM", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-gondolin-backend-"));
		roots.push(workspace);
		let createCount = 0;
		const backend = new GondolinBackend(async () => {
			createCount++;
			return fakeVm(`vm-${createCount}`, createCount === 1 ? 20 : 0);
		});
		await backend.start(startOptions(workspace));
		backend.markFailed(new Error("crashed"));

		await Promise.all([backend.recover(), backend.recover()]);

		expect(createCount).toBe(2);
		expect(backend.status()).toMatchObject({ state: "running", id: "vm-2" });
		await backend.stop();
	});

	it("applies configured protected paths to external mounts", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-gondolin-backend-"));
		roots.push(root);
		const workspace = path.join(root, "workspace");
		const external = path.join(root, "external");
		await Promise.all([mkdir(workspace), mkdir(path.join(external, "private"), { recursive: true })]);
		await writeFile(path.join(external, "visible.txt"), "visible");
		await writeFile(path.join(external, "private", "secret.txt"), "secret");
		let externalProvider: VirtualProvider | undefined;
		const backend = new GondolinBackend(async (options) => {
			externalProvider = options?.vfs?.mounts?.["/external"] as VirtualProvider | undefined;
			return fakeVm("vm-1");
		});
		await backend.start(startOptions(workspace, ["private/**"]));
		await backend.mountExternal({
			hostPath: external,
			guestPath: "/external/external-12345678",
			mode: "read-only",
		});

		const visible = await externalProvider!.open("/external-12345678/visible.txt", "r");
		expect(await visible.readFile("utf8")).toBe("visible");
		await visible.close();
		await expect(externalProvider!.open("/external-12345678/private/secret.txt", "r")).rejects.toBeDefined();
		await backend.stop();
	});
});
