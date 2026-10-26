import { describe, expect, it } from "vitest";
import { BlockBuffer, describeBlocked, PendingApproval } from "./approvals.js";

describe("BlockBuffer", () => {
	it("keeps the 3 most recent blocks, newest first", () => {
		const buf = new BlockBuffer();
		for (let i = 1; i <= 4; i++) {
			buf.push({
				tool: "bash",
				value: `cmd${i}`,
				cwd: "/proj",
				kind: "judge",
				reason: "p-block",
				detail: `d${i}`,
				ts: new Date().toISOString(),
			});
		}
		const list = buf.list();
		expect(list).toHaveLength(3);
		expect(list[0]?.value).toBe("cmd4");
		expect(list[2]?.value).toBe("cmd2");
	});

	it("describes blocked calls compactly", () => {
		expect(
			describeBlocked({
				tool: "bash",
				value: "rm -rf build",
				cwd: "/p",
				kind: "floor",
				reason: "recursive-delete",
				detail: "d",
				ts: "t",
			}),
		).toBe("[floor] bash rm -rf build — recursive-delete");
	});
});

describe("PendingApproval", () => {
	it("consumes exactly once on exact match", () => {
		const pending = new PendingApproval();
		expect(pending.has()).toBe(false);
		pending.set("bash", "rm -rf build");
		expect(pending.has()).toBe(true);
		expect(pending.consume("bash", "rm -rf build")).toBe(true);
		expect(pending.has()).toBe(false);
		expect(pending.consume("bash", "rm -rf build")).toBe(false);
	});

	it("ignores non-matching calls and replaces on re-set", () => {
		const pending = new PendingApproval();
		pending.set("bash", "cmd-a");
		expect(pending.consume("bash", "cmd-b")).toBe(false);
		expect(pending.has()).toBe(true);
		pending.set("bash", "cmd-b");
		expect(pending.consume("bash", "cmd-a")).toBe(false);
		expect(pending.consume("bash", "cmd-b")).toBe(true);
	});
});
