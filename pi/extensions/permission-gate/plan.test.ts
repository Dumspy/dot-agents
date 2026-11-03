import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planCommand, splitSegments, tokenizeArgs } from "./plan.js";

function readOnly(command: string): boolean {
	return planCommand(command).kind === "read_only";
}

function reason(command: string): string {
	const plan = planCommand(command);
	return plan.kind === "read_only" ? "read_only" : plan.reason;
}

describe("splitSegments", () => {
	it("splits on sequencing and pipe operators", () => {
		expect(splitSegments("ls && git status")).toEqual(["ls ", " git status"]);
		expect(splitSegments("cat | wc -l")).toEqual(["cat ", " wc -l"]);
		expect(splitSegments("a;b")).toEqual(["a", "b"]);
	});

	it("keeps operators inside quotes and escaped operators", () => {
		expect(splitSegments("grep 'a|b'")).toEqual(["grep 'a|b'"]);
		expect(splitSegments('printf "%s;%s" a b')).toEqual(['printf "%s;%s" a b']);
		expect(splitSegments("echo a \\| b")).toEqual(["echo a \\| b"]);
	});

	it("refuses redirections and command substitution", () => {
		expect(() => splitSegments("ls > out.txt")).toThrow();
		expect(() => splitSegments("cat < in.txt")).toThrow();
		expect(() => splitSegments("ls $(rm -rf /)")).toThrow();
		expect(() => splitSegments("ls `rm -rf /`")).toThrow();
	});

	it("refuses a background job", () => {
		expect(() => splitSegments("sleep 10 &")).toThrow();
	});
});

describe("tokenizeArgs", () => {
	it("splits on whitespace and honors quotes", () => {
		expect(tokenizeArgs("grep -n 'two words'").map((t) => t.value)).toEqual(["grep", "-n", "two words"]);
		// Inside double quotes `\n` is a literal backslash-n the shell hands to printf.
		expect(tokenizeArgs('printf "%s\\n" a').map((t) => t.value)).toEqual(["printf", "%s\\n", "a"]);
	});

	it("refuses unquoted expansions and globs", () => {
		expect(() => tokenizeArgs("cat $HOME/x")).toThrow();
		expect(() => tokenizeArgs("ls *.ts")).toThrow();
		expect(() => tokenizeArgs("ls ?")).toThrow();
	});

	it("keeps a home-relative path, which names exactly one location", () => {
		expect(tokenizeArgs("ls ~/work").map((t) => t.value)).toEqual(["ls", "~/work"]);
		expect(() => tokenizeArgs("cat ~user/x")).toThrow();
	});
});

describe("planner: read-only fast path", () => {
	const free = [
		"ls",
		"ls -la",
		"ls -la src",
		"ls --all --human-readable",
		"pwd",
		"cat",
		"cat README.md",
		"cat secrets.txt",
		"ls ~/work",
		"head -n 20",
		"tail -n 5",
		"wc -l",
		"grep -n needle",
		"grep -n needle file.txt",
		"grep -r todo src",
		"grep -ri todo",
		'grep "two words"',
		"rg -n TODO",
		"rg --files",
		"find . -name '*.ts'",
		"git status",
		"git status --short --branch",
		"git diff --stat",
		"git log --oneline",
		"git branch --show-current",
		"git remote -v",
		"git rev-parse --show-toplevel",
		"ls | wc -l",
		"cat | grep -n needle | head -n 3",
		"git status && git diff --stat",
	];

	for (const command of free) {
		it(`plans ${JSON.stringify(command)} read-only`, () => {
			expect(reason(command)).toBe("read_only");
		});
	}
});

describe("planner: refusals", () => {
	const refused: Array<[string, string]> = [
		["", "empty_command"],
		["cat /etc/passwd", "unsupported_argument"],
		["cat ~/.ssh/id_ed25519", "unsupported_argument"],
		["grep -rn KEY .ssh", "unsupported_argument"],
		["rm -rf build", "filesystem_write"],
		["touch out.txt", "filesystem_write"],
		["mkdir -p x", "filesystem_write"],
		["cp a b", "filesystem_write"],
		["tee out.txt", "filesystem_write"],
		["curl https://example.com", "network_access"],
		["wget https://example.com", "network_access"],
		["ssh host", "network_access"],
		["bash -c ls", "process_or_system"],
		["sudo ls", "process_or_system"],
		["env", "process_or_system"],
		["xargs rm", "process_or_system"],
		["node -v", "unknown_command"],
		["npm test", "unknown_command"],
		["git push", "command_owned_input"],
		["git commit -m x", "command_owned_input"],
		["git", "command_owned_input"],
		["ls > out.txt", "unsupported_shell"],
		["ls *.ts", "dynamic_word"],
		["FOO=1 ls", "env_assignment"],
		["/bin/ls", "unsupported_argument"],
		["ls --color=always", "unsupported_argument"],
		["ls -Z", "unsupported_argument"],
		["find . -delete", "unsupported_argument"],
		["find . -exec rm {} .", "unsupported_argument"],
		["git status -Z", "unsupported_argument"],
		["git log --pretty=format:%H", "unsupported_argument"],
		["sleep 10 &", "background"],
	];

	for (const [command, expected] of refused) {
		it(`refuses ${JSON.stringify(command)} as ${expected}`, () => {
			expect(reason(command)).toBe(expected);
		});
	}
});

describe("planner: canonicalization", () => {
	it("pins absolute executables so PATH cannot be shadowed", () => {
		const plan = planCommand("ls -l");
		expect(plan.kind).toBe("read_only");
		if (plan.kind !== "read_only") return;
		expect(plan.stages[0]!.executable).toBe("/bin/ls");
		expect(plan.stages[0]!.argv[0]).toBe("/bin/ls");
	});

	it("forces ls -q so filenames cannot emit terminal escapes", () => {
		expect(tokenizeArgs("ls") && reason("ls")).toBe("read_only");
		const plan = planCommand("ls");
		if (plan.kind !== "read_only") throw new Error("expected read_only");
		expect(plan.stages[0]!.argv).toContain("-q");
	});

	it("normalizes chained short flags and keeps an explicit separator", () => {
		const plan = planCommand("ls -la src");
		if (plan.kind !== "read_only") throw new Error("expected read_only");
		const resolved = resolve(process.cwd(), "src");
		expect(plan.stages[0]!.argv).toEqual(["/bin/ls", "-q", "-l", "-a", "--", resolved]);
	});

	it("pins pwd to the physical path", () => {
		const plan = planCommand("pwd");
		if (plan.kind !== "read_only") throw new Error("expected read_only");
		expect(plan.stages[0]!.argv).toEqual(["/bin/pwd", "-P"]);
	});

	it("plans every stage of a pipeline", () => {
		const plan = planCommand("cat | grep -n needle | head -n 2");
		if (plan.kind !== "read_only") throw new Error("expected read_only");
		expect(plan.stages).toHaveLength(3);
		expect(plan.stages.map((stage) => stage.executable)).toEqual([
			"/bin/cat",
			"/usr/bin/grep",
			"/usr/bin/head",
		]);
	});
});

describe("planner: a newline ends a command", () => {
	it("refuses a mutating second line after a read-only first line", () => {
		expect(reason("echo hi\nsudo rm -rf /")).not.toBe("read_only");
		expect(reason("ls -la\nrm -rf build")).not.toBe("read_only");
		expect(reason("cat README.md\ngit push --force")).not.toBe("read_only");
	});

	it("still plans two read-only lines", () => {
		expect(reason("ls -la\ncat README.md")).toBe("read_only");
	});
});

describe("planner: env files are never free", () => {
	it("refuses an env read, which bash cannot mask", () => {
		expect(reason("cat .env")).toBe("unsupported_argument");
		expect(reason("grep -r KEY .env")).toBe("unsupported_argument");
		expect(reason("head -n 5 config/.env.local")).toBe("unsupported_argument");
	});

	it("leaves templates alone", () => {
		expect(reason("cat .env.example")).toBe("read_only");
	});
});

describe("planner: git-interceptor prefix", () => {
	const prefix = "export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";

	it("plans intercepted git reads instead of sending them to review", () => {
		expect(reason(prefix + "git status --short")).toBe("read_only");
		expect(reason(prefix + "git diff --stat")).toBe("read_only");
	});

	it("does not let the prefix launder a write", () => {
		expect(reason(prefix + "git commit -m x")).toBe("command_owned_input");
	});

	it("plans plain exports but not a bare one", () => {
		expect(reason("export FOO=1 BAR=2")).toBe("read_only");
		expect(reason("export")).not.toBe("read_only");
	});
});

describe("planner: export is only a no-op when it assigns", () => {
	it("refuses print flags, which the floor also blocks", () => {
		expect(reason("export -p")).not.toBe("read_only");
		expect(reason("declare -p")).not.toBe("read_only");
		expect(reason("declare -f")).not.toBe("read_only");
	});

	it("still plans the git-interceptor's assignment form", () => {
		expect(reason("export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true")).toBe("read_only");
	});
});
