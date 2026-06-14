import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInitMessage } from "../init.ts";

describe("buildInitMessage", () => {
	it("includes a file tree and detected key files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "supermemory-init-test-"));
		try {
			writeFileSync(join(dir, "README.md"), "# Test");
			writeFileSync(join(dir, "package.json"), "{}");
			mkdirSync(join(dir, "src"));
			writeFileSync(join(dir, "src", "index.ts"), "// code");

			const message = await buildInitMessage(dir);

			expect(message).toContain("File tree:");
			expect(message).toContain("README.md");
			expect(message).toContain("package.json");
			expect(message).toContain("src");
			expect(message).toContain("Key files detected:");
			expect(message).toContain("- README.md");
			expect(message).toContain("- package.json");
			expect(message).toContain("scope: \"project\"");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("handles an empty directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "supermemory-init-empty-"));
		try {
			const message = await buildInitMessage(dir);
			expect(message).toContain("(empty directory)");
			expect(message).toContain("(no common key files detected)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
