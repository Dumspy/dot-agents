import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertMountAllowed,
	expandUserPath,
	guestMountPath,
	isInsidePath,
	isProtectedRelativePath,
	mountedHostPathToGuest,
	resolveMountTarget,
	resolveUserMountPath,
	workspaceHostPathToGuest,
} from "../paths.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-sandbox-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("sandbox paths", () => {
	it("checks containment without sibling-prefix confusion", () => {
		expect(isInsidePath("/work/project", "/work/project/file")).toBe(true);
		expect(isInsidePath("/work/project", "/work/project-other/file")).toBe(false);
	});

	it("expands home paths and rejects relative mounts", () => {
		expect(expandUserPath("~/src", "/home/test")).toBe(path.join("/home/test", "src"));
		expect(resolveUserMountPath("/tmp/example", "/home/test")).toBe(path.resolve("/tmp/example"));
		expect(() => resolveUserMountPath("relative/path", "/home/test")).toThrow("must be absolute");
	});

	it("uses directories directly and a file's immediate parent", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "directory");
		const file = path.join(directory, "file.txt");
		await mkdir(directory);
		await writeFile(file, "hello");
		expect(await resolveMountTarget(directory, root)).toEqual({ canonicalPath: directory, isFileRequest: false });
		expect(await resolveMountTarget(file, root)).toEqual({ canonicalPath: directory, isFileRequest: true });
	});

	it("canonicalizes symlink targets", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const link = path.join(root, "link");
		await mkdir(target);
		await symlink(target, link);
		expect((await resolveMountTarget(link, root)).canonicalPath).toBe(target);
	});

	it("rejects nonexistent and special paths", async () => {
		const root = await temporaryDirectory();
		expect(resolveMountTarget(path.join(root, "missing"), root)).rejects.toThrow("does not exist");
	});

	it("rejects broad, credential, and workspace-overlapping mounts", () => {
		expect(() => assertMountAllowed("/", "/work/project", "/home/test")).toThrow("prohibits mounting");
		expect(() => assertMountAllowed("/home/test", "/work/project", "/home/test")).toThrow("prohibits mounting");
		expect(() => assertMountAllowed("/home/test/.ssh", "/work/project", "/home/test")).toThrow("credential path");
		expect(() => assertMountAllowed("/home/test/.config/1password", "/work/project", "/home/test")).toThrow(
			"credential path",
		);
		expect(() => assertMountAllowed("/work", "/work/project", "/home/test")).toThrow("overlaps the workspace");
	});

	it("protects secrets but leaves conventional templates visible", () => {
		for (const protectedPath of [".env", ".env.local", "nested/.ssh/id_ed25519", "key.pem", ".config/1password/data"]) {
			expect(isProtectedRelativePath(protectedPath), protectedPath).toBe(true);
		}
		for (const visiblePath of [".env.example", ".env.sample", "src/main.ts", ".git/config"]) {
			expect(isProtectedRelativePath(visiblePath), visiblePath).toBe(false);
		}
		expect(isProtectedRelativePath("private/token.txt", ["private/**"])).toBe(true);
	});

	it("allocates stable guest names and translates paths", () => {
		const first = guestMountPath("/home/test/other-project");
		expect(guestMountPath("/home/test/other-project")).toBe(first);
		expect(first).toMatch(/^\/external\/other-project-[0-9a-f]{8}$/);
		expect(workspaceHostPathToGuest("/work/project", "/work/project/src/a.ts")).toBe("/workspace/src/a.ts");
		expect(mountedHostPathToGuest("/other", "/external/other-abcd", "/other/src/a.ts")).toBe(
			"/external/other-abcd/src/a.ts",
		);
	});
});
