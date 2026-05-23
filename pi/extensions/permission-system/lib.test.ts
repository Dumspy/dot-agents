import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	applyMask,
	deepMerge,
	formatToolDescription,
	getToolValue,
	globToRegex,
	matchGlob,
	resolveMask,
	resolvePermission,
	shouldMask,
	type PermissionsConfig,
} from "./lib.js";

describe("globToRegex", () => {
	it("matches literal strings exactly", () => {
		const re = globToRegex("hello");
		expect(re.test("hello")).toBe(true);
		expect(re.test("hellos")).toBe(false);
		expect(re.test("ahello")).toBe(false);
	});

	it("matches wildcard * against any chars except /", () => {
		const re = globToRegex("*.ts");
		expect(re.test("file.ts")).toBe(true);
		expect(re.test(".ts")).toBe(true);
		expect(re.test("a/b.ts")).toBe(false);
	});

	it("matches wildcard ? against single char except /", () => {
		const re = globToRegex("?env");
		expect(re.test(".env")).toBe(true);
		expect(re.test("xenv")).toBe(true);
		expect(re.test("env")).toBe(false);
		expect(re.test("xxenv")).toBe(false);
	});

	it("escapes regex special characters", () => {
		const re = globToRegex("file.json");
		expect(re.test("file.json")).toBe(true);
		expect(re.test("file-json")).toBe(false);
	});
});

describe("matchGlob", () => {
	it("matches .env patterns", () => {
		expect(matchGlob(".env", ".env")).toBe(true);
		expect(matchGlob(".env", ".envrc")).toBe(false);
	});

	it("matches *.env patterns", () => {
		expect(matchGlob("*.env", "foo.env")).toBe(true);
		expect(matchGlob("*.env", ".env")).toBe(true);
		expect(matchGlob("*.env", "foo.txt")).toBe(false);
	});

	it("matches .env.* patterns", () => {
		expect(matchGlob(".env.*", ".env.local")).toBe(true);
		expect(matchGlob(".env.*", ".env")).toBe(false);
	});

	it("matches directory wildcards", () => {
		expect(matchGlob(".ssh/*", ".ssh/id_rsa")).toBe(true);
		expect(matchGlob(".ssh/*", ".ssh")).toBe(false);
		expect(matchGlob(".ssh/*", ".ssh/foo/bar")).toBe(false);
	});

	it("matches exact strings", () => {
		expect(matchGlob("pwd", "pwd")).toBe(true);
		expect(matchGlob("pwd", "pwds")).toBe(false);
	});
});

describe("getToolValue", () => {
	it("extracts path from read/write/edit", () => {
		expect(getToolValue("read", { path: "foo.ts" })).toBe("foo.ts");
		expect(getToolValue("write", { path: "/abs/path" })).toBe("/abs/path");
		expect(getToolValue("edit", { path: "x" })).toBe("x");
	});

	it("extracts command from bash", () => {
		expect(getToolValue("bash", { command: "ls -la" })).toBe("ls -la");
	});

	it("extracts url from webfetch", () => {
		expect(getToolValue("webfetch", { url: "https://example.com" })).toBe("https://example.com");
	});

	it("falls back for unknown tools", () => {
		expect(getToolValue("custom", { query: "hello" })).toBe("hello");
		expect(getToolValue("custom", {})).toBe("{}");
	});
});

describe("resolvePermission", () => {
	it("returns ask when rules are undefined", () => {
		expect(resolvePermission(undefined, "anything")).toBe("ask");
	});

	it("returns string rules directly", () => {
		expect(resolvePermission("allow", "anything")).toBe("allow");
		expect(resolvePermission("deny", "anything")).toBe("deny");
		expect(resolvePermission("ask", "anything")).toBe("ask");
		expect(resolvePermission("cloak", "anything")).toBe("cloak");
	});

	it("returns exact match immediately", () => {
		const rules = { "*": "ask", ".env": "deny", foo: "allow" };
		expect(resolvePermission(rules, "foo")).toBe("allow");
		expect(resolvePermission(rules, ".env")).toBe("deny");
	});

	it("prefers longer matching pattern", () => {
		const rules = { "*": "ask", "ls*": "allow", "ls -la": "deny" };
		expect(resolvePermission(rules, "ls -la")).toBe("deny"); // exact match wins
		expect(resolvePermission(rules, "ls -lah")).toBe("allow"); // ls* matches, longer than *
		expect(resolvePermission(rules, "pwd")).toBe("ask"); // only * matches
	});

	it("falls back to ask when nothing matches", () => {
		const rules = { "ls*": "allow" };
		expect(resolvePermission(rules, "pwd")).toBe("ask");
	});

	it("handles glob patterns correctly", () => {
		const rules = { "*": "ask", "git status*": "allow", "git *": "deny" };
		expect(resolvePermission(rules, "git status")).toBe("allow"); // longer match
		expect(resolvePermission(rules, "git log")).toBe("deny"); // git * matches
	});

	it("resolves cloak permission", () => {
		const rules = { "*": "allow", ".env": "cloak" };
		expect(resolvePermission(rules, ".env")).toBe("cloak");
		expect(resolvePermission(rules, "foo.txt")).toBe("allow");
	});
});

describe("resolveMask", () => {
	it("returns null when no masks defined", () => {
		expect(resolveMask(undefined, ".env")).toBeNull();
	});

	it("returns exact match immediately", () => {
		const masks = { ".env": { pattern: "(=).+", replace: "$1" }, "*.secret": { pattern: "secret" } };
		expect(resolveMask(masks, ".env")).toEqual({ pattern: "(=).+", replace: "$1" });
	});

	it("prefers longer matching pattern", () => {
		const masks = {
			"*": { pattern: "fallback" },
			"*.env": { pattern: "env-specific" },
			".env": { pattern: "exact" },
		};
		expect(resolveMask(masks, ".env")).toEqual({ pattern: "exact" });
		expect(resolveMask(masks, "foo.env")).toEqual({ pattern: "env-specific" });
		expect(resolveMask(masks, "foo.txt")).toEqual({ pattern: "fallback" });
	});

	it("returns null when nothing matches", () => {
		const masks = { "*.env": { pattern: "test" } };
		expect(resolveMask(masks, "foo.txt")).toBeNull();
	});
});

describe("applyMask", () => {
	it("masks with replace template", () => {
		const mask = { pattern: "(=).+", replace: "$1" };
		expect(applyMask("SECRET=hello", mask)).toBe("SECRET=");
	});

	it("masks with explicit flags", () => {
		const mask = { pattern: "(=).+", replace: "$1", flags: "g" };
		expect(applyMask("A=1\nB=2", mask)).toBe("A=\nB=");
	});

	it("masks without replace template (default asterisks)", () => {
		const mask = { pattern: "secret" };
		expect(applyMask("my secret here", mask)).toBe("my ****** here");
	});

	it("returns unchanged when no match", () => {
		const mask = { pattern: "(=).+", replace: "$1" };
		expect(applyMask("no equals here", mask)).toBe("no equals here");
	});

	it("handles regex special characters in pattern", () => {
		const mask = { pattern: "\\$\\{([^}]+)\\}", replace: "$${***}" };
		expect(applyMask("var ${SECRET}", mask)).toBe("var ${***}");
	});
});

describe("shouldMask", () => {
	it("returns null for non-read tools", () => {
		const config: PermissionsConfig = {
			rules: { read: { "*": "cloak" } },
			masks: { read: { "*": { pattern: "test" } } },
		};
		expect(shouldMask("bash", config, "ls")).toBeNull();
	});

	it("returns null when permission is not cloak", () => {
		const config: PermissionsConfig = {
			rules: { read: { "*": "allow" } },
			masks: { read: { "*": { pattern: "test" } } },
		};
		expect(shouldMask("read", config, ".env")).toBeNull();
	});

	it("returns mask config when permission is cloak and mask matches", () => {
		const config: PermissionsConfig = {
			rules: { read: { "*": "allow", ".env": "cloak" } },
			masks: { read: { ".env": { pattern: "(=).+", replace: "$1" } } },
		};
		const result = shouldMask("read", config, ".env");
		expect(result).not.toBeNull();
		expect(result?.mask).toEqual({ pattern: "(=).+", replace: "$1" });
	});

	it("returns null when no matching mask", () => {
		const config: PermissionsConfig = {
			rules: { read: { ".env": "cloak" } },
			masks: {},
		};
		expect(shouldMask("read", config, ".env")).toBeNull();
	});
});

describe("deepMerge", () => {
	it("returns base when override is empty", () => {
		const merged = deepMerge(DEFAULT_CONFIG, {});
		expect(merged.rules.read).toBeDefined();
		expect(merged.rules.bash).toBeDefined();
		expect(merged.masks.read).toBeDefined();
	});

	it("overrides string rules", () => {
		const merged = deepMerge(DEFAULT_CONFIG, { rules: { webfetch: "allow" } });
		expect(merged.rules.webfetch).toBe("allow");
		expect(merged.rules.read).toBeDefined(); // base preserved
	});

	it("merges object rules shallowly", () => {
		const merged = deepMerge(DEFAULT_CONFIG, {
			rules: {
				read: { "*.secret": "deny" },
			},
		});
		const readRules = merged.rules.read as Record<string, string>;
		expect(readRules["*.secret"]).toBe("deny");
		expect(readRules["*"]).toBe("allow"); // base preserved
	});

	it("replaces object rules with string rules", () => {
		const merged = deepMerge(DEFAULT_CONFIG, { rules: { read: "deny" } });
		expect(merged.rules.read).toBe("deny");
	});

	it("merges masks shallowly", () => {
		const merged = deepMerge(DEFAULT_CONFIG, {
			masks: {
				read: { "*.secret": { pattern: "secret" } },
			},
		});
		const readMasks = merged.masks.read;
		expect(readMasks["*.secret"]).toEqual({ pattern: "secret" });
		expect(readMasks[".env"]).toBeDefined(); // base preserved
	});

	it("adds new tool masks", () => {
		const merged = deepMerge(DEFAULT_CONFIG, {
			masks: {
				bash: { "*": { pattern: "token" } },
			},
		});
		expect(merged.masks.bash).toBeDefined();
		expect(merged.masks.bash["*"]).toEqual({ pattern: "token" });
	});
});

describe("formatToolDescription", () => {
	it("formats read/write/edit", () => {
		expect(formatToolDescription("read", { path: "foo.ts" })).toBe("read `foo.ts`");
		expect(formatToolDescription("write", { path: "bar.md" })).toBe("write `bar.md`");
	});

	it("formats bash", () => {
		expect(formatToolDescription("bash", { command: "ls -la" })).toBe("run `ls -la`");
	});

	it("formats webfetch", () => {
		expect(formatToolDescription("webfetch", { url: "https://example.com" })).toBe("fetch `https://example.com`");
	});

	it("formats unknown tools", () => {
		expect(formatToolDescription("custom", {})).toBe("call custom");
	});
});
