import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertHostPathAllowed, hostCommandDenial } from "../host-guards.js";

describe("host mode guardrails", () => {
	it("denies protected paths and git-internal writes", () => {
		expect(() =>
			assertHostPathAllowed({ value: ".env", workspace: "/work/project", homeDir: "/home/test", operation: "read" }),
		).toThrow("protected path");
		expect(() =>
			assertHostPathAllowed({
				value: "/home/test/.ssh/id_ed25519",
				workspace: "/work/project",
				homeDir: "/home/test",
				operation: "read",
			}),
		).toThrow("credential path");
		expect(() =>
			assertHostPathAllowed({ value: ".git/config", workspace: "/work/project", homeDir: "/home/test", operation: "write" }),
		).toThrow("Git internals");
	});

	it("allows ordinary project files", () => {
		expect(() =>
			assertHostPathAllowed({ value: "src/main.ts", workspace: "/work/project", homeDir: "/home/test", operation: "write" }),
		).not.toThrow();
	});

	it("denies protected paths reached through workspace symlinks", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-host-guards-"));
		const homeDir = path.join(root, "home");
		const workspace = path.join(root, "workspace");
		try {
			await Promise.all([
				mkdir(path.join(homeDir, ".ssh"), { recursive: true }),
				mkdir(path.join(workspace, ".git"), { recursive: true }),
			]);
			await writeFile(path.join(homeDir, ".ssh", "id_ed25519"), "secret");
			await writeFile(path.join(workspace, ".git", "config"), "config");
			await symlink(path.join(homeDir, ".ssh"), path.join(workspace, "ssh-link"));
			await symlink(path.join(workspace, ".git"), path.join(workspace, "git-link"));

			expect(() =>
				assertHostPathAllowed({ value: "ssh-link/id_ed25519", workspace, homeDir, operation: "read" }),
			).toThrow("credential path");
			expect(() =>
				assertHostPathAllowed({ value: "ssh-link/new-key", workspace, homeDir, operation: "write" }),
			).toThrow("credential path");
			expect(() =>
				assertHostPathAllowed({ value: "git-link/config", workspace, homeDir, operation: "write" }),
			).toThrow("Git internals");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["sudo apt install qemu", "sudo"],
		["  sudo apt install qemu", "sudo"],
		["echo ok; sudo id", "sudo"],
		["shutdown -h now", "power"],
		["mkfs.ext4 /dev/sdb", "formatting"],
		["dd if=/dev/zero of=/dev/sda", "block devices"],
		[":(){ :|:& };:", "fork bombs"],
		["rm -rf /", "recursive deletion"],
		["rm -fr $HOME/*", "recursive deletion"],
	])("denies %s", (command, reason) => {
		expect(hostCommandDenial(command, "/home/test")).toContain(reason);
	});

	it.each(["rm -rf ./dist", "npm install", "git reset --hard", "source ./scripts/env.sh", "eval 'echo ok'"])(
		"allows ordinary command %s",
		(command) => expect(hostCommandDenial(command, "/home/test")).toBeUndefined(),
	);
});
