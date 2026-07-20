import { describe, expect, it } from "vitest";
import { MountRegistry } from "../mounts.js";

describe("MountRegistry", () => {
	it("adds and lists mounts deterministically", () => {
		const registry = new MountRegistry();
		const beta = registry.add("/tmp/beta", "read-only");
		const alpha = registry.add("/tmp/alpha", "read-write");
		expect(beta.guestPath).toMatch(/^\/external\/beta-/);
		expect(registry.list()).toEqual([alpha, beta]);
	});

	it("reuses a containing mount without upgrading it", () => {
		const registry = new MountRegistry();
		const parent = registry.add("/tmp/project", "read-only");
		expect(registry.add("/tmp/project/src", "read-write")).toEqual(parent);
		expect(registry.findContaining("/tmp/project/src/file.ts")?.mode).toBe("read-only");
	});

	it("rejects mounting a parent of an existing mount", () => {
		const registry = new MountRegistry();
		registry.add("/tmp/project/src", "read-only");
		expect(() => registry.add("/tmp/project", "read-only")).toThrow("overlaps existing mount");
	});

	it("requires explicit mode changes", () => {
		const registry = new MountRegistry();
		registry.add("/tmp/project", "read-only");
		expect(() => registry.add("/tmp/project", "read-write")).toThrow("change it through /mounts");
		expect(registry.setMode("/tmp/project", "read-write").mode).toBe("read-write");
	});

	it("removes and clears mounts", () => {
		const registry = new MountRegistry();
		const mount = registry.add("/tmp/project", "read-only");
		expect(registry.remove("/tmp/project")).toEqual(mount);
		expect(registry.list()).toEqual([]);
		registry.add("/tmp/again", "read-only");
		registry.clear();
		expect(registry.list()).toEqual([]);
	});
});
