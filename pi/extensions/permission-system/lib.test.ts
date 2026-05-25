import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	applyMask,
	buildSessionApprovalKey,
	createLogEntry,
	deepMerge,
	formatLogLine,
	formatToolDescription,
	getExternalDirectoryRoot,
	getToolValue,
	hardStop,
	isExternalPath,
	isPathBasedTool,
	matchGlob,
	resolveMask,
	resolvePermission,
	resolveToolPath,
	shouldMask,
	type PermissionsConfig,
} from "./lib.js";

describe("matchGlob", () => {
	it("matches literal strings exactly", () => {
		expect(matchGlob("hello", "hello")).toBe(true);
		expect(matchGlob("hello", "hellos")).toBe(false);
		expect(matchGlob("hello", "ahello")).toBe(false);
	});

	it("matches wildcard * against any chars except /", () => {
		expect(matchGlob("*.ts", "file.ts")).toBe(true);
		expect(matchGlob("*.ts", ".ts")).toBe(true);
		expect(matchGlob("*.ts", "a/b.ts")).toBe(false);
	});

	it("matches wildcard ? against single char", () => {
		expect(matchGlob("?env", ".env")).toBe(true);
		expect(matchGlob("?env", "xenv")).toBe(true);
		expect(matchGlob("?env", "env")).toBe(false);
		expect(matchGlob("?env", "xxenv")).toBe(false);
	});

	it("escapes regex special characters", () => {
		expect(matchGlob("file.json", "file.json")).toBe(true);
		expect(matchGlob("file.json", "file-json")).toBe(false);
	});

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

	// picomatch-specific features
	it("matches ** across directories", () => {
		expect(matchGlob("**/*.env", ".env")).toBe(true);
		expect(matchGlob("**/*.env", "foo/.env")).toBe(true);
		expect(matchGlob("**/*.env", "a/b/c/.env")).toBe(true);
		expect(matchGlob("**/*.env", "foo.txt")).toBe(false);
	});

	it("matches brace expansion", () => {
		expect(matchGlob("*.{ts,js}", "file.ts")).toBe(true);
		expect(matchGlob("*.{ts,js}", "file.js")).toBe(true);
		expect(matchGlob("*.{ts,js}", "file.py")).toBe(false);
	});

	it("matches dotfiles with dot option", () => {
		expect(matchGlob("*.env", ".env")).toBe(true);
		expect(matchGlob(".*", ".gitignore")).toBe(true);
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

	it("strips git-interceptor env prefix from bash commands", () => {
		const prefix = "export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";
		expect(getToolValue("bash", { command: `${prefix}git status` })).toBe("git status");
		expect(getToolValue("bash", { command: `${prefix}git commit -m "hello"` })).toBe('git commit -m "hello"');
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

	it("handles ** patterns", () => {
		const rules = { "**/*.env": "deny", "*": "allow" };
		expect(resolvePermission(rules, "config/.env")).toBe("deny");
		expect(resolvePermission(rules, ".env")).toBe("deny");
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
		expect(readRules["**"]).toBe("allow"); // base preserved
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

describe("DEFAULT_CONFIG — intended behavior", () => {
	const readRules = DEFAULT_CONFIG.rules.read as Record<string, string>;
	const writeRules = DEFAULT_CONFIG.rules.write as Record<string, string>;
	const editRules = DEFAULT_CONFIG.rules.edit as Record<string, string>;
	const bashRules = DEFAULT_CONFIG.rules.bash as Record<string, string>;
	const webfetchRule = DEFAULT_CONFIG.rules.webfetch;

	describe("read — allow by default, deny/cloak on sensitive paths", () => {
		it("allows non-sensitive files at root", () => {
			expect(resolvePermission(readRules, "README.md")).toBe("allow");
			expect(resolvePermission(readRules, "src/index.ts")).toBe("allow");
			expect(resolvePermission(readRules, "docs/guide.md")).toBe("allow");
		});

		it("cloaks .env files at any depth", () => {
			expect(resolvePermission(readRules, ".env")).toBe("cloak");
			expect(resolvePermission(readRules, "packages/api/.env")).toBe("cloak");
			expect(resolvePermission(readRules, "/home/user/project/.env")).toBe("cloak");
		});

		it("cloaks .env.* files at any depth", () => {
			expect(resolvePermission(readRules, ".env.local")).toBe("cloak");
			expect(resolvePermission(readRules, "packages/api/.env.production")).toBe("cloak");
		});

		it("cloaks *.env files at any depth", () => {
			expect(resolvePermission(readRules, "foo.env")).toBe("cloak");
			expect(resolvePermission(readRules, "config/foo.env")).toBe("cloak");
		});

		it("denies .git/ content at any depth", () => {
			expect(resolvePermission(readRules, ".git/config")).toBe("deny");
			expect(resolvePermission(readRules, ".git/HEAD")).toBe("deny");
			expect(resolvePermission(readRules, "packages/frontend/.git/config")).toBe("deny");
			expect(resolvePermission(readRules, "/home/user/project/.git/config")).toBe("deny");
		});

		it("denies .gitmodules at any depth", () => {
			expect(resolvePermission(readRules, ".gitmodules")).toBe("deny");
			expect(resolvePermission(readRules, "submodule/.gitmodules")).toBe("deny");
		});

		it("denies .ssh/ content at any depth", () => {
			expect(resolvePermission(readRules, ".ssh/id_rsa")).toBe("deny");
			expect(resolvePermission(readRules, "deep/.ssh/id_rsa")).toBe("deny");
		});

		it("denies .aws/ .docker/ .kube/ at any depth", () => {
			expect(resolvePermission(readRules, ".aws/credentials")).toBe("deny");
			expect(resolvePermission(readRules, "config/.aws/credentials")).toBe("deny");
			expect(resolvePermission(readRules, ".docker/config.json")).toBe("deny");
			expect(resolvePermission(readRules, "project/.docker/config.json")).toBe("deny");
			expect(resolvePermission(readRules, ".kube/config")).toBe("deny");
			expect(resolvePermission(readRules, "home/user/.kube/config")).toBe("deny");
		});

		it("denies key/pem/p12/pfx files at any depth", () => {
			expect(resolvePermission(readRules, "id_rsa.key")).toBe("deny");
			expect(resolvePermission(readRules, ".ssh/id_rsa.key")).toBe("deny");
			expect(resolvePermission(readRules, "certs/server.pem")).toBe("deny");
			expect(resolvePermission(readRules, "/etc/ssl/cert.p12")).toBe("deny");
			expect(resolvePermission(readRules, "cert.pfx")).toBe("deny");
		});

		it("denies node_modules/ at any depth", () => {
			expect(resolvePermission(readRules, "node_modules/express/index.js")).toBe("deny");
			expect(resolvePermission(readRules, "packages/frontend/node_modules/lodash/index.js")).toBe("deny");
		});

		it("allows pi docs inside node_modules", () => {
			expect(resolvePermission(readRules, "node_modules/@earendil-works/pi-coding-agent/README.md")).toBe("allow");
			expect(resolvePermission(readRules, "node_modules/@earendil-works/pi-coding-agent/docs/extensions.md")).toBe("allow");
			expect(resolvePermission(readRules, "/nix/store/abc/lib/node_modules/@earendil-works/pi-coding-agent/README.md")).toBe("allow");
			expect(resolvePermission(readRules, "node_modules/@earendil-works/pi-ai/index.js")).toBe("allow");
			expect(resolvePermission(readRules, "node_modules/@earendil-works/pi-tui/index.js")).toBe("allow");
		});

		it("denies .venv/ venv/ at any depth", () => {
			expect(resolvePermission(readRules, ".venv/bin/python")).toBe("deny");
			expect(resolvePermission(readRules, "project/.venv/bin/python")).toBe("deny");
			expect(resolvePermission(readRules, "venv/bin/python")).toBe("deny");
			expect(resolvePermission(readRules, "project/venv/bin/python")).toBe("deny");
		});

		it("denies dist/ build/ target/ at any depth", () => {
			expect(resolvePermission(readRules, "dist/bundle.js")).toBe("deny");
			expect(resolvePermission(readRules, "project/dist/bundle.js")).toBe("deny");
			expect(resolvePermission(readRules, "build/output")).toBe("deny");
			expect(resolvePermission(readRules, "project/build/output")).toBe("deny");
			expect(resolvePermission(readRules, "target/debug/app")).toBe("deny");
			expect(resolvePermission(readRules, "project/target/debug/app")).toBe("deny");
		});

		it("denies secrets/ at any depth", () => {
			expect(resolvePermission(readRules, "secrets/db.txt")).toBe("deny");
			expect(resolvePermission(readRules, "config/secrets/db.txt")).toBe("deny");
		});

		it("denies .envrc at any depth", () => {
			expect(resolvePermission(readRules, ".envrc")).toBe("deny");
			expect(resolvePermission(readRules, "project/.envrc")).toBe("deny");
		});

		it("denies .gnupg/ at any depth", () => {
			expect(resolvePermission(readRules, ".gnupg/gpg.conf")).toBe("deny");
			expect(resolvePermission(readRules, "home/.gnupg/gpg.conf")).toBe("deny");
		});

		it("denies .config/1password/ at any depth", () => {
			expect(resolvePermission(readRules, ".config/1password/account.json")).toBe("deny");
			expect(resolvePermission(readRules, "home/.config/1password/account.json")).toBe("deny");
		});
	});

	describe("write — allow by default, deny on sensitive paths", () => {
		it("allows non-sensitive files", () => {
			expect(resolvePermission(writeRules, "src/index.ts")).toBe("allow");
			expect(resolvePermission(writeRules, "README.md")).toBe("allow");
		});

		it("denies .env files at any depth", () => {
			expect(resolvePermission(writeRules, ".env")).toBe("deny");
			expect(resolvePermission(writeRules, "packages/api/.env")).toBe("deny");
		});

		it("denies .git/ content at any depth", () => {
			expect(resolvePermission(writeRules, ".git/config")).toBe("deny");
			expect(resolvePermission(writeRules, "packages/frontend/.git/config")).toBe("deny");
		});

		it("denies node_modules/ at any depth", () => {
			expect(resolvePermission(writeRules, "node_modules/express/index.js")).toBe("deny");
			expect(resolvePermission(writeRules, "packages/frontend/node_modules/lodash/index.js")).toBe("deny");
		});

		it("denies .venv/ venv/ at any depth", () => {
			expect(resolvePermission(writeRules, ".venv/bin/python")).toBe("deny");
			expect(resolvePermission(writeRules, "project/.venv/bin/python")).toBe("deny");
			expect(resolvePermission(writeRules, "venv/bin/python")).toBe("deny");
			expect(resolvePermission(writeRules, "project/venv/bin/python")).toBe("deny");
		});
	});

	describe("edit — allow by default, deny on sensitive paths", () => {
		it("allows non-sensitive files", () => {
			expect(resolvePermission(editRules, "src/index.ts")).toBe("allow");
			expect(resolvePermission(editRules, "README.md")).toBe("allow");
		});

		it("denies .env files at any depth", () => {
			expect(resolvePermission(editRules, ".env")).toBe("deny");
			expect(resolvePermission(editRules, "packages/api/.env")).toBe("deny");
		});

		it("denies .git/ content at any depth", () => {
			expect(resolvePermission(editRules, ".git/config")).toBe("deny");
			expect(resolvePermission(editRules, "packages/frontend/.git/config")).toBe("deny");
		});

		it("denies node_modules/ at any depth", () => {
			expect(resolvePermission(editRules, "node_modules/express/index.js")).toBe("deny");
			expect(resolvePermission(editRules, "packages/frontend/node_modules/lodash/index.js")).toBe("deny");
		});

		it("denies .venv/ venv/ at any depth", () => {
			expect(resolvePermission(editRules, ".venv/bin/python")).toBe("deny");
			expect(resolvePermission(editRules, "project/.venv/bin/python")).toBe("deny");
			expect(resolvePermission(editRules, "venv/bin/python")).toBe("deny");
			expect(resolvePermission(editRules, "project/venv/bin/python")).toBe("deny");
		});
	});

	describe("bash — ask by default, allow on safe commands", () => {
		it("allows ls commands", () => {
			expect(resolvePermission(bashRules, "ls -la")).toBe("allow");
			expect(resolvePermission(bashRules, "ls")).toBe("allow");
		});

		it("allows pwd", () => {
			expect(resolvePermission(bashRules, "pwd")).toBe("allow");
		});

		it("allows git status/diff/log", () => {
			expect(resolvePermission(bashRules, "git status")).toBe("allow");
			expect(resolvePermission(bashRules, "git status -s")).toBe("allow");
			expect(resolvePermission(bashRules, "git diff")).toBe("allow");
			expect(resolvePermission(bashRules, "git log --oneline")).toBe("allow");
		});

		it("allows dex commands", () => {
			expect(resolvePermission(bashRules, "dex run -a")).toBe("allow");
		});

		it("asks for other commands", () => {
			expect(resolvePermission(bashRules, "rm -rf /")).toBe("ask");
			expect(resolvePermission(bashRules, "curl example.com")).toBe("ask");
		});
	});

	describe("webfetch — ask by default", () => {
		it("asks for any URL", () => {
			expect(webfetchRule).toBe("ask");
			expect(resolvePermission(webfetchRule, "https://example.com")).toBe("ask");
			expect(resolvePermission(webfetchRule, "http://localhost")).toBe("ask");
		});
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

	it("strips git-interceptor env prefix from bash description", () => {
		const prefix = "export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";
		expect(formatToolDescription("bash", { command: `${prefix}git status` })).toBe("run `git status`");
		expect(formatToolDescription("bash", { command: `${prefix}git commit -m "hello"` })).toBe('run `git commit -m "hello"`');
		expect(formatToolDescription("bash", { command: "ls -la" })).toBe("run `ls -la`");
	});

	it("formats webfetch", () => {
		expect(formatToolDescription("webfetch", { url: "https://example.com" })).toBe("fetch `https://example.com`");
	});

	it("formats unknown tools", () => {
		expect(formatToolDescription("custom", {})).toBe("call custom");
	});
});

describe("hardStop", () => {
	it("returns the hard stop message", () => {
		const message = hardStop();
		expect(message).toContain("policy-enforced");
		expect(message).toContain("Do not retry");
		expect(message).toContain("report the block");
	});
});

describe("buildSessionApprovalKey", () => {
	it("builds a key from tool name and value", () => {
		expect(buildSessionApprovalKey("bash", "git status")).toBe("bash:git status");
		expect(buildSessionApprovalKey("read", ".env")).toBe("read:.env");
	});
});

describe("isPathBasedTool", () => {
	it("returns true for path-based tools", () => {
		expect(isPathBasedTool("read")).toBe(true);
		expect(isPathBasedTool("write")).toBe(true);
		expect(isPathBasedTool("edit")).toBe(true);
		expect(isPathBasedTool("ls")).toBe(true);
	});

	it("returns false for non-path tools", () => {
		expect(isPathBasedTool("bash")).toBe(false);
		expect(isPathBasedTool("webfetch")).toBe(false);
		expect(isPathBasedTool("custom")).toBe(false);
	});
});

describe("resolveToolPath", () => {
	it("resolves relative paths against cwd", () => {
		expect(resolveToolPath("read", { path: "../file.txt" }, "/home/project")).toBe("/home/file.txt");
		expect(resolveToolPath("write", { path: "src/index.ts" }, "/home/project")).toBe("/home/project/src/index.ts");
	});

	it("resolves absolute paths as-is", () => {
		expect(resolveToolPath("read", { path: "/etc/passwd" }, "/home/project")).toBe("/etc/passwd");
	});

	it("returns null for empty paths", () => {
		expect(resolveToolPath("read", { path: "" }, "/home/project")).toBeNull();
		expect(resolveToolPath("ls", { path: undefined }, "/home/project")).toBeNull();
	});

	it("returns null for non-path tools", () => {
		expect(resolveToolPath("bash", { command: "ls" }, "/home/project")).toBeNull();
		expect(resolveToolPath("webfetch", { url: "https://example.com" }, "/home/project")).toBeNull();
	});
});

describe("isExternalPath", () => {
	it("returns false for paths inside cwd", () => {
		expect(isExternalPath("/home/project/src/index.ts", "/home/project")).toBe(false);
		expect(isExternalPath("/home/project", "/home/project")).toBe(false);
		expect(isExternalPath("/home/project/.env", "/home/project")).toBe(false);
	});

	it("returns true for paths outside cwd", () => {
		expect(isExternalPath("/home/other/file.txt", "/home/project")).toBe(true);
		expect(isExternalPath("/tmp/file.txt", "/home/project")).toBe(true);
		expect(isExternalPath("/home/project/../other", "/home/project")).toBe(true);
	});

	it("handles relative resolved paths correctly", () => {
		// resolveToolPath already resolves, but let's test isExternalPath directly
		expect(isExternalPath("/home/file.txt", "/home/project")).toBe(true);
	});
});

describe("getExternalDirectoryRoot", () => {
	it("returns null for paths inside cwd", () => {
		expect(getExternalDirectoryRoot("/home/project/src/index.ts", "/home/project")).toBeNull();
		expect(getExternalDirectoryRoot("/home/project", "/home/project")).toBeNull();
	});

	it("returns sibling directory root", () => {
		expect(getExternalDirectoryRoot("/home/other/file.txt", "/home/project")).toBe("/home/other");
	});

	it("returns exact path when target has no deeper directory", () => {
		expect(getExternalDirectoryRoot("/home/file.txt", "/home/project")).toBe("/home/file.txt");
	});

	it("returns deeply external directory root", () => {
		expect(getExternalDirectoryRoot("/home/other/deep/file.txt", "/home/project")).toBe("/home/other");
	});

	it("returns root for completely different paths", () => {
		expect(getExternalDirectoryRoot("/tmp/file.txt", "/home/project")).toBe("/tmp");
	});

	it("handles paths resolved via .. correctly", () => {
		expect(getExternalDirectoryRoot("/home/project/../other/file.txt", "/home/project")).toBe("/home/other");
	});
});

describe("DEFAULT_CONFIG — external_directory", () => {
	const extRules = DEFAULT_CONFIG.rules.external_directory as Record<string, string>;

	it("defaults to ask for any external directory", () => {
		expect(resolvePermission(extRules, "/home/other")).toBe("ask");
		expect(resolvePermission(extRules, "/tmp")).toBe("ask");
		expect(resolvePermission(extRules, "/home/project/../other")).toBe("ask");
	});
});

describe("External directory + tool rule interaction", () => {
	it("external path triggers ask, and .env still gets cloaked after approval", () => {
		const cwd = "/home/project";
		const externalPath = "/home/other/.env";

		// Step 1: external_directory gate fires first
		const extRoot = getExternalDirectoryRoot(externalPath, cwd);
		expect(extRoot).toBe("/home/other");
		const extRules = DEFAULT_CONFIG.rules.external_directory as Record<string, string>;
		expect(resolvePermission(extRules, extRoot)).toBe("ask");

		// Step 2: after external approval, normal read rules still apply
		const readRules = DEFAULT_CONFIG.rules.read as Record<string, string>;
		expect(resolvePermission(readRules, externalPath)).toBe("cloak");
	});

	it("external .envrc file triggers ask then deny", () => {
		const cwd = "/home/project";
		const externalPath = "/home/other/.envrc";

		const extRoot = getExternalDirectoryRoot(externalPath, cwd);
		expect(extRoot).toBe("/home/other");
		const extRules = DEFAULT_CONFIG.rules.external_directory as Record<string, string>;
		expect(resolvePermission(extRules, extRoot)).toBe("ask");

		// After external approval, .envrc is denied by read rules
		const readRules = DEFAULT_CONFIG.rules.read as Record<string, string>;
		expect(resolvePermission(readRules, externalPath)).toBe("deny");
	});

	it("external ssh key triggers ask then deny", () => {
		const cwd = "/home/project";
		const externalPath = "/home/other/.ssh/id_rsa";

		const extRoot = getExternalDirectoryRoot(externalPath, cwd);
		expect(extRoot).toBe("/home/other");
		const extRules = DEFAULT_CONFIG.rules.external_directory as Record<string, string>;
		expect(resolvePermission(extRules, extRoot)).toBe("ask");

		const readRules = DEFAULT_CONFIG.rules.read as Record<string, string>;
		expect(resolvePermission(readRules, externalPath)).toBe("deny");
	});

	it("external node_modules path is denied by read rules after external approval", () => {
		// Normal rules still apply after external directory approval.
		// The fix for pi docs is the default allow rules in lib.ts, not a bypass.
		const cwd = "/home/project";
		const externalPath = "/nix/store/abc123/lib/node_modules/@pkg/README.md";

		const extRoot = getExternalDirectoryRoot(externalPath, cwd);
		expect(extRoot).toBe("/nix");
		const extRules = DEFAULT_CONFIG.rules.external_directory as Record<string, string>;
		expect(resolvePermission(extRules, extRoot)).toBe("ask");

		// Normal read rules deny node_modules
		const readRules = DEFAULT_CONFIG.rules.read as Record<string, string>;
		expect(resolvePermission(readRules, externalPath)).toBe("deny");
	});

	it("external pi docs are allowed by default read rules", () => {
		// Pi docs live in node_modules under /nix/store or similar external paths.
		// The specific allow rules override the node_modules deny.
		const readRules = DEFAULT_CONFIG.rules.read as Record<string, string>;
		expect(resolvePermission(readRules, "/nix/store/abc/lib/node_modules/@earendil-works/pi-coding-agent/README.md")).toBe("allow");
		expect(resolvePermission(readRules, "/nix/store/abc/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md")).toBe("allow");
		expect(resolvePermission(readRules, "/nix/store/abc/lib/node_modules/@earendil-works/pi-ai/index.js")).toBe("allow");
	});

	it("internal .env path skips external gate but still gets cloaked", () => {
		const cwd = "/home/project";
		const internalPath = "/home/project/packages/api/.env";

		// Inside workspace — no external gate
		expect(isExternalPath(internalPath, cwd)).toBe(false);
		expect(getExternalDirectoryRoot(internalPath, cwd)).toBeNull();

		// But read rules still apply
		const readRules = DEFAULT_CONFIG.rules.read as Record<string, string>;
		expect(resolvePermission(readRules, internalPath)).toBe("cloak");
	});
});

describe("createLogEntry", () => {
	it("creates a log entry with all fields", () => {
		const entry = createLogEntry("bash", "ls -la", "/home/project", "allowed", "rule: allow", "2026-05-25T12:00:00.000Z");
		expect(entry).toEqual({
			timestamp: "2026-05-25T12:00:00.000Z",
			toolName: "bash",
			value: "ls -la",
			cwd: "/home/project",
			action: "allowed",
			reason: "rule: allow",
		});
	});

	it("defaults timestamp to current time when omitted", () => {
		const entry = createLogEntry("read", ".env", "/home/project", "cloaked", "rule: cloak");
		expect(entry.toolName).toBe("read");
		expect(entry.value).toBe(".env");
		expect(entry.cwd).toBe("/home/project");
		expect(entry.action).toBe("cloaked");
		expect(entry.reason).toBe("rule: cloak");
		expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("supports all permission actions", () => {
		const actions = [
			"allowed",
			"cloaked",
			"blocked",
			"blocked-no-ui",
			"allowed-session-cache",
			"prompt-approved-once",
			"prompt-approved-session",
			"prompt-denied",
			"prompt-explained",
		] as const;

		for (const action of actions) {
			const entry = createLogEntry("bash", "git push", "/home/project", action, "test");
			expect(entry.action).toBe(action);
		}
	});
});

describe("formatLogLine", () => {
	it("formats entry as JSON with trailing newline", () => {
		const entry = createLogEntry("bash", "rm -rf /", "/home/project", "blocked", "rule: deny", "2026-05-25T12:00:00.000Z");
		const line = formatLogLine(entry);
		expect(line).toBe('{"timestamp":"2026-05-25T12:00:00.000Z","toolName":"bash","value":"rm -rf /","cwd":"/home/project","action":"blocked","reason":"rule: deny"}\n');
	});

	it("produces valid JSON that can be parsed back", () => {
		const entry = createLogEntry("read", "src/index.ts", "/home/project", "allowed", "rule: allow");
		const line = formatLogLine(entry);
		const parsed = JSON.parse(line);
		expect(parsed.toolName).toBe("read");
		expect(parsed.value).toBe("src/index.ts");
		expect(parsed.action).toBe("allowed");
		expect(parsed.reason).toBe("rule: allow");
	});
});
