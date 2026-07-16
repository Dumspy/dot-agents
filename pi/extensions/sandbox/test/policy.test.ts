import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalAccessRequiredError, SandboxPolicy } from "../policy.js";

const roots: string[] = [];
async function fixture(): Promise<{ root: string; workspace: string; external: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-sandbox-policy-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	const external = path.join(root, "external");
	await Promise.all([mkdir(workspace), mkdir(external)]);
	return { root, workspace, external };
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("SandboxPolicy", () => {
	it("maps existing and nonexistent workspace paths", async () => {
		const { root, workspace } = await fixture();
		const policy = new SandboxPolicy(workspace, root);
		await writeFile(path.join(workspace, "existing.txt"), "hello");
		expect(await policy.prepareToolPath("existing.txt", "read-only")).toBe("/workspace/existing.txt");
		expect(await policy.prepareToolPath("new/directory/file.txt", "read-write")).toBe(
			"/workspace/new/directory/file.txt",
		);
	});

	it("requests external access and maps it after approval", async () => {
		const { root, workspace, external } = await fixture();
		const policy = new SandboxPolicy(workspace, root);
		const file = path.join(external, "file.txt");
		await writeFile(file, "hello");
		let request: ExternalAccessRequiredError | undefined;
		try {
			await policy.prepareToolPath(file, "read-only");
		} catch (error) {
			expect(error).toBeInstanceOf(ExternalAccessRequiredError);
			request = error as ExternalAccessRequiredError;
		}
		expect(request?.mountRoot).toBe(external);
		const mount = policy.approveExternal(request!, "read-only");
		expect(await policy.prepareToolPath(file, "read-only")).toBe(`${mount.guestPath}/file.txt`);
	});

	it("does not silently upgrade a read-only mount", async () => {
		const { root, workspace, external } = await fixture();
		const policy = new SandboxPolicy(workspace, root);
		policy.mounts.add(external, "read-only");
		await expect(policy.prepareToolPath(path.join(external, "new.txt"), "read-write")).rejects.toThrow("read-only");
	});

	it("detects workspace symlink escapes", async () => {
		const { root, workspace, external } = await fixture();
		const policy = new SandboxPolicy(workspace, root);
		await symlink(external, path.join(workspace, "escape"));
		await writeFile(path.join(external, "secret.txt"), "secret");
		await expect(policy.prepareToolPath("escape/secret.txt", "read-only")).rejects.toBeInstanceOf(
			ExternalAccessRequiredError,
		);
	});

	it("accepts only active guest external paths", async () => {
		const { root, workspace, external } = await fixture();
		const policy = new SandboxPolicy(workspace, root);
		const mount = policy.mounts.add(external, "read-write");
		expect(await policy.prepareToolPath(`${mount.guestPath}/file`, "read-write")).toBe(`${mount.guestPath}/file`);
		await expect(policy.prepareToolPath("/external/not-mounted/file", "read-only")).rejects.toThrow("not mounted");
	});
});
