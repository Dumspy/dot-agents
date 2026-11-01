import { describe, expect, it } from "vitest";
import { EMPTY_FACTS, describeEnvironment, normalizeRemote, readEnvironmentFacts } from "./environment.js";

describe("normalizeRemote", () => {
	it("strips protocols and credentials", () => {
		expect(normalizeRemote("https://github.com/acme/app.git")).toBe("github.com/acme/app");
		expect(normalizeRemote("git@github.com:acme/app.git")).toBe("github.com/acme/app");
		expect(normalizeRemote("ssh://git@gitlab.com/acme/app")).toBe("gitlab.com/acme/app");
	});

	it("keeps a token out of the fact", () => {
		expect(normalizeRemote("https://user:ghp_secret@github.com/acme/app.git")).toBe("github.com/acme/app");
	});
});

describe("describeEnvironment", () => {
	it("always states the working directory", () => {
		expect(describeEnvironment(EMPTY_FACTS, "/work", true)).toContain("Working directory: /work");
	});

	it("says when the folder is not a repository", () => {
		const lines = describeEnvironment(EMPTY_FACTS, "/tmp", false);
		expect(lines).toContain("Source control: not a git repository");
	});

	it("reports the trusted boundary, remotes, and branch", () => {
		const lines = describeEnvironment(
			{ repoRoot: "/work/app", remotes: ["github.com/acme/app"], branch: "main" },
			"/work/app/src",
			true,
		);
		expect(lines).toContain("Trusted repository: /work/app");
		expect(lines).toContain("Source control: github.com/acme/app");
		expect(lines).toContain("Current branch: main");
		expect(lines.join("\n")).toContain("trusted");
	});

	it("says so when the project is not trusted", () => {
		expect(describeEnvironment(EMPTY_FACTS, "/tmp", false).join("\n")).toContain("NOT trusted");
	});
});

describe("readEnvironmentFacts", () => {
	it("degrades to a smaller fact set outside a repository", () => {
		const facts = readEnvironmentFacts("/tmp");
		expect(facts.repoRoot).toBeNull();
		expect(facts.remotes).toEqual([]);
	});

	it("reads this repository's facts", () => {
		const facts = readEnvironmentFacts(process.cwd());
		expect(facts.repoRoot).not.toBeNull();
		expect(facts.branch).not.toBe("");
	});
});
