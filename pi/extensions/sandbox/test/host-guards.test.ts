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
