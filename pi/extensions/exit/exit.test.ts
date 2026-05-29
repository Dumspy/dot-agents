import { describe, expect, it } from "vitest";
import { shouldExit } from "./index.ts";

describe("shouldExit", () => {
	it("matches exact 'exit'", () => {
		expect(shouldExit("exit")).toBe(true);
	});

	it("matches 'exit' with surrounding whitespace", () => {
		expect(shouldExit("  exit  ")).toBe(true);
		expect(shouldExit("\texit\n")).toBe(true);
	});

	it("does not match other messages", () => {
		expect(shouldExit("exit now")).toBe(false);
		expect(shouldExit("please exit")).toBe(false);
		expect(shouldExit("exit()")).toBe(false);
		expect(shouldExit("")).toBe(false);
		expect(shouldExit("quit")).toBe(false);
	});
});
