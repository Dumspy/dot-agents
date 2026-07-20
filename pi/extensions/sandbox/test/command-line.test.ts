import { describe, expect, it } from "vitest";
import { parseMountArguments, tokenizeCommandLine } from "../command-line.js";

describe("mount command parsing", () => {
	it("tokenizes quotes and escapes", () => {
		expect(tokenizeCommandLine('"/path/with spaces"')).toEqual(["/path/with spaces"]);
		expect(tokenizeCommandLine("'/another path'")).toEqual(["/another path"]);
		expect(tokenizeCommandLine("/escaped\\ path")).toEqual(["/escaped path"]);
	});

	it("defaults to read-only", () => {
		expect(parseMountArguments("/tmp/project")).toEqual({ path: "/tmp/project", mode: "read-only" });
	});

	it("accepts either access mode", () => {
		expect(parseMountArguments('--read-write "/tmp/my project"')).toEqual({
			path: "/tmp/my project",
			mode: "read-write",
		});
	});

	it("rejects ambiguous or invalid input", () => {
		expect(() => parseMountArguments("")).toThrow("Usage");
		expect(() => parseMountArguments("--read-only --read-write /tmp/project")).toThrow("only one");
		expect(() => parseMountArguments("--other /tmp/project")).toThrow("Unknown");
		expect(() => tokenizeCommandLine("'/tmp/project")).toThrow("Unterminated");
	});
});
