import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { truncateTextOutput } from "../truncation.ts";

describe("truncation", () => {
	it("writes the full output to a temp file when truncated", async () => {
		const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const truncated = await truncateTextOutput(output, {
			maxLines: 5,
			maxBytes: 10_000,
			tempPrefix: "pi-web-tools-test-",
			fileName: "output.txt",
		});

		expect(truncated.truncated).toBe(true);
		expect(truncated.fullOutputPath).toBeTruthy();
		expect(truncated.text).toMatch(/Output truncated:/);
		const saved = await readFile(truncated.fullOutputPath!, "utf8");
		expect(saved).toBe(output);
	});
});
