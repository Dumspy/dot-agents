import { ERRNO, MemoryProvider, ReadonlyProvider, type VirtualProvider } from "@earendil-works/gondolin";
import { describe, expect, it } from "vitest";
import { DynamicMountProvider } from "../backends/dynamic-mount-provider.js";

async function memoryWithFile(name: string, content: string): Promise<VirtualProvider> {
	const provider = new MemoryProvider();
	await provider.writeFile?.(`/${name}`, content);
	return provider;
}

describe("DynamicMountProvider", () => {
	it("adds and removes mounts without replacing the namespace provider", async () => {
		const dynamic = new DynamicMountProvider();
		const provider = await memoryWithFile("hello.txt", "hello");
		dynamic.setMount("/project", provider);
		expect(dynamic.listMountPaths()).toEqual(["/project"]);
		expect(await dynamic.readdir("/")).toEqual(["project"]);
		const handle = await dynamic.open("/project/hello.txt", "r");
		expect(await handle.readFile("utf8")).toBe("hello");
		await handle.close();
		dynamic.removeMount("/project");
		expect(() => dynamic.stat("/project/hello.txt")).toThrow(expect.objectContaining({ code: "ENOENT" }));
	});

	it("replaces a route to change access mode", async () => {
		const dynamic = new DynamicMountProvider();
		const provider = await memoryWithFile("hello.txt", "hello");
		dynamic.setMount("/project", new ReadonlyProvider(provider));
		await expect(dynamic.open("/project/new.txt", "w")).rejects.toMatchObject({ errno: ERRNO.EROFS });
		dynamic.setMount("/project", provider);
		const handle = await dynamic.open("/project/new.txt", "w");
		await handle.writeFile("created");
		await handle.close();
		expect((await provider.readFile?.("/new.txt", "utf8")) ?? "").toBe("created");
	});

	it("revokes open handles when a mount is changed or removed", async () => {
		const dynamic = new DynamicMountProvider();
		const provider = await memoryWithFile("hello.txt", "hello");
		dynamic.setMount("/project", provider);
		const handle = await dynamic.open("/project/hello.txt", "r+");
		dynamic.setMount("/project", new ReadonlyProvider(provider));
		expect(() => handle.writeFile("changed")).toThrow(expect.objectContaining({ code: "EACCES" }));
		await handle.close();
	});

	it("protects mount roots from guest mutation", async () => {
		const dynamic = new DynamicMountProvider();
		dynamic.setMount("/project", new MemoryProvider());
		expect(() => dynamic.rmdir("/project")).toThrow(expect.objectContaining({ code: "EBUSY" }));
		expect(() => dynamic.unlink("/project")).toThrow(expect.objectContaining({ code: "EBUSY" }));
		expect(() => dynamic.rename("/project", "/project-renamed")).toThrow();
	});

	it("rejects nested route declarations and cross-mount renames", async () => {
		const dynamic = new DynamicMountProvider();
		expect(() => dynamic.setMount("/nested/project", new MemoryProvider())).toThrow("one direct child");
		dynamic.setMount("/one", new MemoryProvider());
		dynamic.setMount("/two", new MemoryProvider());
		expect(() => dynamic.rename("/one/file", "/two/file")).toThrow(expect.objectContaining({ code: "EXDEV" }));
	});
});
