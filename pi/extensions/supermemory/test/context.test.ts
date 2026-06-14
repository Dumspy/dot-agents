import { describe, expect, it } from "vitest";
import { formatContextForPrompt } from "../context.ts";
import type { SearchResult } from "../client.ts";

describe("formatContextForPrompt", () => {
	it("returns an empty string when there is no data", () => {
		const result = formatContextForPrompt(
			{ static: [], dynamic: [] },
			{ results: [] },
			{ results: [] },
			5,
		);
		expect(result).toBe("");
	});

	it("returns an empty string when profile is null and there are no memories", () => {
		const result = formatContextForPrompt(null, { results: [] }, { results: [] }, 5);
		expect(result).toBe("");
	});

	it("includes the user profile", () => {
		const result = formatContextForPrompt(
			{ static: ["Prefers concise responses"], dynamic: ["Working on auth refactor"] },
			{ results: [] },
			{ results: [] },
			5,
		);
		expect(result).toContain("[SUPERMEMORY]");
		expect(result).toContain("User Profile:");
		expect(result).toContain("- Prefers concise responses");
		expect(result).toContain("Recent Context:");
		expect(result).toContain("- Working on auth refactor");
	});

	it("caps profile facts at maxProfileItems", () => {
		const staticFacts = ["a", "b", "c", "d", "e", "f"];
		const dynamicFacts = ["1", "2", "3", "4", "5", "6"];
		const result = formatContextForPrompt(
			{ static: staticFacts, dynamic: dynamicFacts },
			{ results: [] },
			{ results: [] },
			2,
		);
		expect(result).toContain("- a");
		expect(result).toContain("- b");
		expect(result).not.toContain("- c");
		expect(result).toContain("- 1");
		expect(result).toContain("- 2");
		expect(result).not.toContain("- 3");
	});

	it("includes project knowledge with similarity badges", () => {
		const results: SearchResult[] = [
			{ id: "1", content: "Uses flakes for Nix configs", similarity: 1 },
			{ id: "2", content: "Deploys via deploy-rs", similarity: 0.85 },
		];
		const result = formatContextForPrompt(
			null,
			{ results },
			{ results: [] },
			5,
		);
		expect(result).toContain("Project Knowledge:");
		expect(result).toContain("- [100%] Uses flakes for Nix configs");
		expect(result).toContain("- [85%] Deploys via deploy-rs");
	});

	it("includes relevant user memories", () => {
		const results: SearchResult[] = [
			{ id: "3", content: "Build fails if .env.local missing", similarity: 0.82 },
		];
		const result = formatContextForPrompt(
			null,
			{ results: [] },
			{ results },
			5,
		);
		expect(result).toContain("Relevant User Memories:");
		expect(result).toContain("- [82%] Build fails if .env.local missing");
	});
});
