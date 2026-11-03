import { describe, expect, it } from "vitest";
import { scanShellSegments } from "./shell.js";

describe("scanShellSegments", () => {
	it("splits on sequencing and pipeline operators, keeping raw whitespace", () => {
		expect(scanShellSegments("ls && git status").segments).toEqual(["ls ", " git status"]);
		expect(scanShellSegments("cat | wc -l").segments).toEqual(["cat ", " wc -l"]);
		expect(scanShellSegments("a;b").segments).toEqual(["a", "b"]);
	});

	it("keeps operators inside quotes and escaped operators", () => {
		expect(scanShellSegments("grep 'a|b'").segments).toEqual(["grep 'a|b'"]);
		expect(scanShellSegments('printf "%s;%s" a b').segments).toEqual(['printf "%s;%s" a b']);
		expect(scanShellSegments("echo a \\| b").segments).toEqual(["echo a \\| b"]);
	});

	it("strict refuses what the planner cannot prove", () => {
		expect(scanShellSegments("ls > out.txt", { strict: true }).error).toBe("redirection");
		expect(scanShellSegments("cat < in.txt", { strict: true }).error).toBe("redirection");
		expect(scanShellSegments("ls $(rm -rf /)", { strict: true }).error).toBe("expansion");
		expect(scanShellSegments("ls `rm -rf /`", { strict: true }).error).toBe("command substitution");
		expect(scanShellSegments("sleep 10 &", { strict: true }).error).toBe("background");
		expect(scanShellSegments("ls 'unbalanced", { strict: true }).error).toBe("unbalanced quotes");
	});

	it("non-strict leaves redirections and substitutions in the stage", () => {
		const scan = scanShellSegments("echo hi | sudo tee x 2>/dev/null");
		expect(scan.error).toBeNull();
		expect(scan.segments).toEqual(["echo hi ", " sudo tee x 2>/dev/null"]);
		expect(scanShellSegments("echo $(rm -rf x)").error).toBeNull();
		expect(scanShellSegments("ls 'unbalanced").error).toBe("unbalanced quotes");
	});
});
