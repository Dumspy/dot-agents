import { describe, expect, it } from "vitest";
import { isFullyPrivate, stripPrivateContent } from "../privacy.ts";

describe("stripPrivateContent", () => {
	it("removes a single private block", () => {
		const input = "Hello <private>secret</private> world";
		expect(stripPrivateContent(input)).toBe("Hello world");
	});

	it("removes multiple private blocks", () => {
		const input = "a <private>x</private> b <private>y</private> c";
		expect(stripPrivateContent(input)).toBe("a b c");
	});

	it("is case-insensitive", () => {
		const input = "a <PRIVATE>secret</PRIVATE> b";
		expect(stripPrivateContent(input)).toBe("a b");
	});

	it("handles multiline private blocks", () => {
		const input = "start\n<private>\nline1\nline2\n</private>\nend";
		expect(stripPrivateContent(input)).toBe("start\n\nend");
	});

	it("trims surrounding whitespace", () => {
		const input = "  <private>secret</private>  ";
		expect(stripPrivateContent(input)).toBe("");
	});

	it("returns the original text when there are no private blocks", () => {
		const input = "public content";
		expect(stripPrivateContent(input)).toBe("public content");
	});
});

describe("isFullyPrivate", () => {
	it("returns true when the whole content is a private block", () => {
		expect(isFullyPrivate("<private>secret</private>")).toBe(true);
	});

	it("returns true when only whitespace remains after stripping", () => {
		expect(isFullyPrivate("  <private>x</private>  ")).toBe(true);
	});

	it("returns false when public content remains", () => {
		expect(isFullyPrivate("public <private>secret</private> content")).toBe(false);
	});

	it("returns false for content without private blocks", () => {
		expect(isFullyPrivate("public content")).toBe(false);
	});
});
