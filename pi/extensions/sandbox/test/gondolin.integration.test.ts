import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GondolinBackend } from "../backends/gondolin.js";
import { guestMountPath } from "../paths.js";

const integration = process.env.RUN_GONDOLIN_TESTS === "1" ? describe : describe.skip;

integration("GondolinBackend integration", () => {
	let root: string;
	let workspace: string;
	let external: string;
	let backend: GondolinBackend;

	beforeAll(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "pi-gondolin-integration-"));
		workspace = path.join(root, "workspace");
		external = path.join(root, "external");
		const { mkdir } = await import("node:fs/promises");
		await Promise.all([mkdir(workspace), mkdir(external)]);
		await writeFile(path.join(workspace, "visible.txt"), "visible");
		await writeFile(path.join(workspace, ".env"), "TOKEN=host-secret");
		await symlink(".env", path.join(workspace, "env-alias"));
		await writeFile(path.join(external, "external.txt"), "external");
		await writeFile(path.join(root, "host-only.txt"), "host-only");
		backend = new GondolinBackend();
		await backend.start({
			workspaceHostPath: workspace,
			workspaceGuestPath: "/workspace",
			backendConfig: {
				cpus: 1,
				memoryBytes: 1024 ** 3,
				rootfsBytes: 2 * 1024 ** 3,
				startupCommands: [],
			},
			protectedPaths: [],
		});
	}, 180_000);

	afterAll(async () => {
		await backend?.stop();
		if (root) await rm(root, { recursive: true, force: true });
	}, 30_000);

	it("reads and writes the workspace while hiding protected files", async () => {
		expect(await backend.vm.fs.readFile("/workspace/visible.txt", { encoding: "utf8" })).toBe("visible");
		await backend.vm.fs.writeFile("/workspace/created.txt", "created", { encoding: "utf8" });
		expect(await readFile(path.join(workspace, "created.txt"), "utf8")).toBe("created");
		await expect(backend.vm.fs.readFile("/workspace/.env", { encoding: "utf8" })).rejects.toBeDefined();
		await expect(backend.vm.fs.readFile("/workspace/env-alias", { encoding: "utf8" })).rejects.toBeDefined();
	});

	it("cannot see unmounted host paths", async () => {
		const result = await backend.vm.exec(["/bin/sh", "-lc", `test ! -e '${path.join(root, "host-only.txt")}'`]);
		expect(result.exitCode).toBe(0);
	});

	it(
		"allows mediated public HTTPS",
		async () => {
			const result = await backend.vm.exec(["/bin/sh", "-lc", "wget -q -O /dev/null https://example.com"]);
			expect(result.exitCode, result.stderr).toBe(0);
		},
		30_000,
	);

	it("adds, upgrades, and removes an external mount at runtime", async () => {
		const guestPath = guestMountPath(external);
		await backend.mountExternal({ hostPath: external, guestPath, mode: "read-only" });
		expect(await backend.vm.fs.readFile(`${guestPath}/external.txt`, { encoding: "utf8" })).toBe("external");
		await expect(backend.vm.fs.writeFile(`${guestPath}/created.txt`, "nope", { encoding: "utf8" })).rejects.toBeDefined();
		await backend.updateExternalMount({ hostPath: external, guestPath, mode: "read-write" });
		await backend.vm.fs.writeFile(`${guestPath}/created.txt`, "created", { encoding: "utf8" });
		expect(await readFile(path.join(external, "created.txt"), "utf8")).toBe("created");
		await backend.unmountExternal(guestPath);
		await expect(backend.vm.fs.readFile(`${guestPath}/external.txt`, { encoding: "utf8" })).rejects.toBeDefined();
	});

	it(
		"recreates a crashed VM and restores approved mounts without replay",
		async () => {
			const guestPath = guestMountPath(external);
			await backend.mountExternal({ hostPath: external, guestPath, mode: "read-only" });
			const pid = backend.vm.getHostPid();
			expect(pid).not.toBeNull();
			process.kill(pid!, "SIGKILL");
			for (let attempt = 0; attempt < 100 && backend.isAlive(); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(backend.isAlive()).toBe(false);
			backend.markFailed(new Error("test VM crash"));
			await backend.recover();
			expect(await backend.vm.fs.readFile(`${guestPath}/external.txt`, { encoding: "utf8" })).toBe("external");
			await backend.unmountExternal(guestPath);
		},
		30_000,
	);
});
