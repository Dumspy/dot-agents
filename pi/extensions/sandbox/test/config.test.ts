import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SANDBOX_CONFIG,
	loadSandboxConfig,
	mergeSandboxConfig,
	parseByteSize,
	parseProjectSandboxConfig,
	parseSandboxConfig,
} from "../config.js";

describe("sandbox config", () => {
	it("parses byte sizes", () => {
		expect(parseByteSize("4GiB", "memory")).toBe(4 * 1024 ** 3);
		expect(parseByteSize("1.5 GB", "memory")).toBe(1_500_000_000);
		expect(() => parseByteSize("nope", "memory")).toThrow("invalid size");
	});

	it("applies defaults and validates ceilings", () => {
		const config = parseSandboxConfig({ version: 1, gondolin: { cpus: 4, memory: "8GiB" } });
		expect(config.gondolin.cpus).toBe(4);
		expect(config.gondolin.memoryBytes).toBe(8 * 1024 ** 3);
		expect(config.gondolin.rootfsBytes).toBe(8 * 1024 ** 3);
		expect(() => parseSandboxConfig({ gondolin: { cpus: 17 } })).toThrow("between 1 and 16");
		expect(() => parseSandboxConfig({ gondolin: { memory: "33GiB" } })).toThrow("exceeds 32 GiB");
	});

	it("rejects unsupported security-affecting keys", () => {
		expect(() => parseSandboxConfig({ mounts: ["/tmp"] })).toThrow("unsupported key");
		expect(() => parseSandboxConfig({ backend: "host" })).toThrow('must be "gondolin"');
		expect(() => parseProjectSandboxConfig({ backend: "host" })).toThrow("unsupported key");
	});

	it("merges project config without replacing unspecified global values", () => {
		const global = parseSandboxConfig({
			gondolin: { image: "global-image", cpus: 6, startupCommands: ["global-init"] },
			protectedPaths: ["global/**"],
		});
		const project = parseProjectSandboxConfig({ gondolin: { memory: "6GiB" }, protectedPaths: ["project/**"] });
		const merged = mergeSandboxConfig(global, project);
		expect(merged.gondolin.image).toBe("global-image");
		expect(merged.gondolin.cpus).toBe(6);
		expect(merged.gondolin.memoryBytes).toBe(6 * 1024 ** 3);
		expect(merged.gondolin.startupCommands).toEqual(["global-init"]);
		expect(merged.protectedPaths).toEqual(["global/**", "project/**"]);
	});

	it("does not mutate defaults", () => {
		const merged = mergeSandboxConfig(DEFAULT_SANDBOX_CONFIG, { protectedPaths: ["extra"] });
		merged.gondolin.startupCommands.push("changed");
		expect(DEFAULT_SANDBOX_CONFIG.gondolin.startupCommands).toEqual([]);
	});

	it("loads global and trusted project config from Pi's configured directory names", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-sandbox-config-"));
		const agentDir = path.join(root, "custom-agent-dir");
		const workspace = path.join(root, "workspace");
		try {
			await Promise.all([mkdir(agentDir), mkdir(path.join(workspace, CONFIG_DIR_NAME), { recursive: true })]);
			await writeFile(path.join(agentDir, "sandbox.json"), JSON.stringify({ gondolin: { cpus: 3 } }));
			await writeFile(
				path.join(workspace, CONFIG_DIR_NAME, "sandbox.json"),
				JSON.stringify({ protectedPaths: ["project-private/**"] }),
			);

			const config = await loadSandboxConfig({ agentDir, workspace, projectTrusted: true });
			expect(config.gondolin.cpus).toBe(3);
			expect(config.protectedPaths).toEqual(["project-private/**"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
