import { describe, expect, it } from "vitest";
import {
	boundTurn,
	buildIntentContext,
	EMPTY_INTENT,
	normalizeTurn,
	renderIntentContext,
	userMessageText,
} from "./intent.js";

describe("normalizeTurn", () => {
	it("collapses whitespace and strips control bytes", () => {
		expect(normalizeTurn("fix\n\nthe   build\tplease")).toBe("fix the build please");
		expect(normalizeTurn("a\u0007b\u001bc")).toBe("a b c");
	});
});

describe("boundTurn", () => {
	it("leaves short turns alone", () => {
		expect(boundTurn("ls the repo")).toBe("ls the repo");
	});

	it("truncates and marks the omission", () => {
		const long = "x".repeat(5000);
		const bounded = boundTurn(long, 100);
		expect(bounded.length).toBeLessThanOrEqual(100);
		expect(bounded).toContain("[... omitted ...]");
	});
});

describe("buildIntentContext", () => {
	it("returns empty for no turns", () => {
		expect(buildIntentContext([])).toEqual(EMPTY_INTENT);
	});

	it("uses the last turn as the current request", () => {
		const context = buildIntentContext(["first", "second", "third"]);
		expect(context.currentRequest).toBe("third");
		expect(context.firstRootRequest).toBe("first");
		expect(context.recentRootRequests).toEqual(["second"]);
	});

	it("keeps at most two recent turns", () => {
		const context = buildIntentContext(["a", "b", "c", "d", "e"]);
		expect(context.currentRequest).toBe("e");
		expect(context.recentRootRequests).toEqual(["c", "d"]);
		// a, c, d and e are shown; only "b" is omitted.
		expect(context.omittedRootTurns).toBe(1);
	});

	it("drops the first-request anchor when history was compacted", () => {
		const context = buildIntentContext(["survivor", "later", "now"], { historyComplete: false });
		expect(context.firstRootRequest).toBeNull();
		expect(context.currentRequest).toBe("now");
	});

	it("ignores blank turns", () => {
		expect(buildIntentContext(["  ", "\n"])).toEqual(EMPTY_INTENT);
	});
});

describe("renderIntentContext", () => {
	it("emits fx-style labelled lines", () => {
		const text = renderIntentContext(buildIntentContext(["clean up drafts", "now delete ./drafts"]));
		expect(text).toContain("first_root_user_request: clean up drafts");
		expect(text).toContain("current_request: now delete ./drafts");
	});

	it("is empty without intent", () => {
		expect(renderIntentContext(EMPTY_INTENT)).toBe("");
	});

	it("states omitted turns so the reviewer does not assume completeness", () => {
		const text = renderIntentContext(buildIntentContext(["a", "b", "c", "d", "e"]));
		expect(text).toContain("omitted_proven_root_user_turns: 1");
	});
});

describe("userMessageText", () => {
	it("reads string content", () => {
		expect(userMessageText("hello")).toBe("hello");
	});

	it("reads text blocks and ignores images", () => {
		expect(
			userMessageText([
				{ type: "text", text: "look at this" },
				{ type: "image", data: "base64", mimeType: "image/png" },
			]),
		).toBe("look at this");
	});

	it("returns empty for unknown shapes", () => {
		expect(userMessageText(null)).toBe("");
		expect(userMessageText({ type: "text" })).toBe("");
	});
});
