import { describe, expect, it } from "vitest";
import { renderBar, padRight, padLeft } from "../format.ts";

const identity = (s: string) => s;

describe("renderBar", () => {
	it("returns empty string for zero width", () => {
		expect(renderBar(0, 50, identity)).toBe("");
		expect(renderBar(-1, 50, identity)).toBe("");
	});

	it("renders 100% fill", () => {
		const bar = renderBar(10, 100, identity, identity);
		expect(bar).toBe("██████████");
	});

	it("renders 0% fill", () => {
		const bar = renderBar(10, 0, identity, identity);
		expect(bar).toBe("░░░░░░░░░░");
	});

	it("renders 50% fill", () => {
		const bar = renderBar(10, 50, identity, identity);
		expect(bar).toBe("█████░░░░░");
	});

	it("rounds filled chars correctly", () => {
		const bar = renderBar(10, 33, identity, identity);
		expect(bar).toBe("███░░░░░░░"); // 3.3 rounds to 3
	});

	it("caps percentage at 100%", () => {
		const bar = renderBar(10, 200, identity, identity);
		expect(bar).toBe("██████████");
	});

	it("does not go below 0%", () => {
		const bar = renderBar(10, -50, identity, identity);
		expect(bar).toBe("░░░░░░░░░░");
	});

	it("uses different colors for fill and bg", () => {
		const bar = renderBar(10, 50, (s) => `FILL:${s}`, (s) => `BG:${s}`);
		expect(bar).toBe("FILL:█████BG:░░░░░");
	});
});

describe("padRight", () => {
	it("pads with spaces to reach width", () => {
		expect(padRight("hi", 5)).toBe("hi   ");
	});

	it("returns unchanged if already wide enough", () => {
		expect(padRight("hello", 5)).toBe("hello");
		expect(padRight("hello world", 5)).toBe("hello world");
	});

	it("handles ANSI codes", () => {
		const text = "\x1b[31mhi\x1b[0m";
		expect(padRight(text, 5)).toBe("\x1b[31mhi\x1b[0m   ");
	});
});

describe("padLeft", () => {
	it("pads with spaces on the left", () => {
		expect(padLeft("hi", 5)).toBe("   hi");
	});

	it("returns unchanged if already wide enough", () => {
		expect(padLeft("hello", 5)).toBe("hello");
	});
});
