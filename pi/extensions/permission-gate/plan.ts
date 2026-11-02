/**
 * Permission Gate — read-only command planner, ported from fx's
 * `src/core/shell_command/command_effect.zig`.
 *
 * Routine read-only shell work must never pay for a model call, so this parses
 * argv per pipeline segment and proves it touches nothing. Refusal costs one
 * review call; a wrong `read_only` costs correctness, so every branch fails
 * closed. Where it departs from fx (`echo`, `cd`, `git -C`, `/dev/null`
 * redirects, bounded file operands) the reason is measured traffic: 9.2k calls
 * replayed from the old permission log.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { checkPathFloor, stripGitEnvPrefix } from "./floor.js";

export type PlanRefusal =
	| "empty_command"
	| "too_long"
	| "unsupported_shell"
	| "too_many_stages"
	| "background"
	| "env_assignment"
	| "command_owned_input"
	| "dynamic_word"
	| "unsupported_argument"
	| "filesystem_write"
	| "network_access"
	| "process_or_system"
	| "unknown_command";

export interface PlannedStage {
	/** Absolute executable path. */
	readonly executable: string;
	/** Canonical argv including argv[0]. */
	readonly argv: readonly string[];
}

export type Plan =
	| { readonly kind: "read_only"; readonly stages: readonly PlannedStage[] }
	| { readonly kind: "review"; readonly reason: PlanRefusal };

export const MAX_COMMAND_BYTES = 4096;
export const MAX_STAGES = 8;

export interface PlanOptions {
	/** Directory the command runs in; used to bound path operands. */
	readonly cwd?: string;
	/** Repository root, when known; widens the allowed path prefix to its parent. */
	readonly repoRoot?: string | null;
}

/**
 * Remove redirections that cannot change what a read-only command does:
 * stderr to /dev/null, stdout to /dev/null, and `2>&1`. Everything else is
 * left in place so the parser refuses it.
 */
function stripSafeRedirects(segment: string): string {
	return segment
		.replace(/(^|[\s;&|])(\d?&?>>?\s*\/dev\/null|\d?>&\s*\d)\b/g, "$1")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

const FILESYSTEM_MUTATION = new Set([
	"touch",
	"rm",
	"rmdir",
	"mkdir",
	"mv",
	"cp",
	"install",
	"chmod",
	"chown",
	"ln",
	"tee",
	"truncate",
	"dd",
	"shred",
]);

const NETWORK = new Set(["curl", "wget", "ssh", "scp", "nc", "ncat", "ftp", "rsync"]);

const PROCESS_OR_SYSTEM = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"fish",
	"env",
	"xargs",
	"sudo",
	"doas",
	"su",
	"kill",
	"pkill",
	"killall",
	"nohup",
	"eval",
	"exec",
	"source",
	"systemctl",
	"launchctl",
	"crontab",
	"open",
]);

/** Operators that end a stage. Redirections are refused outright. */
const SEQUENCE_OPERATORS = new Set([";", "&&", "||", "|", "&"]);

interface Token {
	readonly value: string;
	readonly quoted: boolean;
}

class ShellShapeError extends Error {}

/**
 * Split a command into pipeline/sequence segments, honoring quotes.
 * Throws on anything the planner cannot reason about: unbalanced quotes,
 * redirections, command substitution, or a trailing operator.
 */
export function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;

	while (i < command.length) {
		const ch = command[i]!;
		if (inSingle) {
			current += ch;
			if (ch === "'") inSingle = false;
			i += 1;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				const next = command[i + 1];
				if (next === undefined) throw new ShellShapeError("trailing backslash");
				current += ch + next;
				i += 2;
				continue;
			}
			if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
				throw new ShellShapeError("command substitution");
			}
			current += ch;
			if (ch === '"') inDouble = false;
			i += 1;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			current += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			current += ch;
			i += 1;
			continue;
		}
		if (ch === "`") throw new ShellShapeError("command substitution");
		if (ch === "$" && (command[i + 1] === "(" || command[i + 1] === "{")) {
			throw new ShellShapeError("expansion");
		}
		if (ch === "<" || ch === ">") throw new ShellShapeError("redirection");
		// A newline is a command separator in `sh -c`; treating it as whitespace
		// let `echo hi` on one line and `sudo rm -rf /` on the next plan as one
		// read-only command.
		if (ch === "\n" || ch === "\r") {
			segments.push(current);
			current = "";
			i += 1;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&") {
			segments.push(current);
			current = "";
			// Consume the two-character operators; a lone `&` is a background
			// marker and must be refused rather than silently dropped.
			if (ch === "&" && command[i + 1] !== "&") {
				throw new ShellShapeError("background");
			}
			i += command[i + 1] === ch || (ch === "|" && command[i + 1] === "|") ? 2 : 1;
			continue;
		}
		current += ch;
		i += 1;
	}

	if (inSingle || inDouble) throw new ShellShapeError("unbalanced quotes");
	segments.push(current);
	return segments;
}

/** Tokenize one segment into argv words, keeping quote awareness. */
export function tokenizeArgs(segment: string): Token[] {
	const tokens: Token[] = [];
	let word = "";
	let quoted = false;
	let started = false;
	let inSingle = false;
	let inDouble = false;
	let i = 0;

	const flush = (): void => {
		if (!started) return;
		tokens.push({ value: word, quoted });
		word = "";
		quoted = false;
		started = false;
	};

	while (i < segment.length) {
		const ch = segment[i]!;
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else word += ch;
			quoted = true;
			started = true;
			i += 1;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				const next = segment[i + 1];
				if (next === undefined) throw new ShellShapeError("trailing backslash");
				// Inside double quotes only `$ ` " \` and newline lose the
				// backslash; `\n` stays a literal backslash-n.
				word += next === "$" || next === "`" || next === '"' || next === "\\" ? next : "\\" + next;
				i += 2;
				quoted = true;
				started = true;
				continue;
			}
			if (ch === '"') inDouble = false;
			else word += ch;
			quoted = true;
			started = true;
			i += 1;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			quoted = true;
			started = true;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			quoted = true;
			started = true;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			const next = segment[i + 1];
			if (next === undefined) throw new ShellShapeError("trailing backslash");
			word += next;
			quoted = true;
			started = true;
			i += 2;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n") {
			flush();
			i += 1;
			continue;
		}
		if (ch === "~" && word.length === 0 && segment[i + 1] !== "/" && i + 1 !== segment.length) {
			throw new ShellShapeError("dynamic word");
		}
		if (ch === "$" || ch === "`" || ch === "*" || ch === "?") {
			throw new ShellShapeError("dynamic word");
		}
		word += ch;
		started = true;
		i += 1;
	}
	if (inSingle || inDouble) throw new ShellShapeError("unbalanced quotes");
	flush();
	return tokens;
}

type StagePlan = { readonly executable: string; readonly argv: readonly string[] } | PlanRefusal;

interface PlanScope {
	readonly cwd: string;
	/** Longest path prefix a readable operand may resolve into. */
	readonly roots: readonly string[];
}

const ALWAYS_READABLE = ["/nix/store", "/tmp", "/private/tmp", "/var/folders", "/dev/null"];

function createScope(options: PlanOptions): PlanScope {
	const cwd = options.cwd ?? process.cwd();
	const repoRoot = options.repoRoot ?? null;
	// The home directory is normal work (`ls ~/.pi/agent`), so it is in scope;
	// credential paths inside it are refused below by the floor's path list.
	const roots = new Set<string>([cwd, homedir(), ...ALWAYS_READABLE]);
	if (repoRoot !== null) {
		roots.add(repoRoot);
		// `find ..` and `git -C ..` are normal in a monorepo checkout.
		const parent = resolvePath(repoRoot, "..");
		roots.add(parent);
	}
	return { cwd, roots: [...roots] };
}

function withinRoot(path: string, root: string): boolean {
	const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
	return path === normalizedRoot || path.startsWith(normalizedRoot + "/");
}

/**
 * Accept a literal path operand only when it resolves inside the scope and is
 * not a credential path. Returns the resolved path, or null to refuse.
 */
function resolveOperand(word: string, scope: PlanScope): string | null {
	if (word.length === 0 || word.includes("\u0000")) return null;
	const expanded = word === "~" ? homedir() : word.startsWith("~/") ? resolvePath(homedir(), word.slice(2)) : word;
	const absolute = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(scope.cwd, expanded);
	if (!scope.roots.some((root) => withinRoot(absolute, root))) return null;
	// Write-mode floor rules: a bash read has no output mask, so an `.env` path
	// reaches the chat provider verbatim where the read tool would redact it.
	if (checkPathFloor(absolute, true) !== null) return null;
	return absolute;
}

function pathOperands(words: readonly Token[], start: number, scope: PlanScope): string[] | null {
	const resolved: string[] = [];
	for (const word of words.slice(start)) {
		const path = resolveOperand(word.value, scope);
		if (path === null) return null;
		resolved.push(path);
	}
	return resolved;
}

const CANONICAL = {
	pwd: "/bin/pwd",
	ls: "/bin/ls",
	cat: "/bin/cat",
	head: "/usr/bin/head",
	tail: "/usr/bin/tail",
	wc: "/usr/bin/wc",
	grep: "/usr/bin/grep",
	rg: "rg",
	file: "/usr/bin/file",
	readlink: "/usr/bin/readlink",
	find: "/usr/bin/find",
	printf: "/usr/bin/printf",
	git: "git",
} as const;

const MAX_LINE_COUNT = 100_000;
const MAX_LS_OPERANDS = 16;

function setFlags(word: string, allowed: ReadonlySet<string>): string[] | null {
	if (!word.startsWith("-") || word === "-" || word === "--") return null;
	const out: string[] = [];
	if (word.startsWith("--")) {
		const [name, value] = word.split("=", 2);
		const full = value === undefined ? name! : `${name}=${value}`;
		return allowed.has(full) ? [full] : null;
	}
	for (const flag of word.slice(1)) {
		const canonical = `-${flag}`;
		if (!allowed.has(canonical)) return null;
		out.push(canonical);
	}
	return out;
}

/**
 * One description per binary instead of one function per binary. Everything a
 * read-only planner needs is data: which flags are allowed, which consume a
 * value, what the operands mean, and whether the tool needs `--` before them.
 * Adding a command is one line here.
 */
interface BinarySpec {
	readonly executable: string;
	/** Prepended before user flags, e.g. `ls -q`. */
	readonly forced?: readonly string[];
	readonly flags?: ReadonlySet<string>;
	readonly longFlags?: ReadonlySet<string>;
	/** Long flags that carry a value, matched by prefix (`--include=`). */
	readonly longPrefixes?: readonly string[];
	readonly valueFlags?: readonly string[];
	/** Flag that takes a bare count, so `head -20` becomes `head -n 20`. */
	readonly countFlag?: string;
	/** none = no operands; raw = literal words; paths = path-checked; pattern = first word is a pattern. */
	readonly operands: "none" | "raw" | "paths" | "pattern";
	/** Pattern comes from a flag, so every operand is a path. */
	readonly patternFlag?: string;
	readonly minOperands?: number;
	readonly maxOperands?: number;
	readonly separator?: boolean;
}

const LS_FLAGS = new Set(["-1", "-a", "-A", "-d", "-F", "-h", "-l", "-n", "-p", "-q", "-r", "-R", "-S", "-t", "-u", "-x"]);
const LS_LONG_FLAGS = new Set(["--all", "--almost-all", "--directory", "--human-readable", "--long", "--reverse", "--recursive"]);
const GREP_FLAGS = new Set(["-E", "-F", "-i", "-n", "-v", "-w", "-x", "-c", "-l", "-h", "-H", "-o", "-q", "-s", "-r", "-R"]);
const GREP_LONG_FLAGS = new Set(["--color", "--no-color", "--line-number", "--count", "--files-with-matches", "--only-matching", "--invert-match"]);
const RG_FLAGS = new Set(["-n", "-i", "-l", "-c", "-w", "-x", "-v", "-F", "-s", "-u", "-g", "-t", "-e", "-A", "-B", "-C", "-m", "-j", "-h", "-H"]);
const RG_LONG_FLAGS = new Set(["--files", "--files-with-matches", "--line-number", "--ignore-case", "--count", "--hidden", "--no-heading"]);

const BINARY_SPECS: Record<string, BinarySpec> = {
	pwd: { executable: CANONICAL.pwd, forced: ["-P"], flags: new Set(["-P", "-L"]), operands: "none" },
	echo: { executable: "builtin:echo", operands: "raw" },
	true: { executable: "builtin:true", operands: "none" },
	":": { executable: "builtin:true", operands: "none" },
	cd: { executable: "builtin:cd", operands: "paths", minOperands: 1, maxOperands: 1 },
	ls: {
		executable: CANONICAL.ls,
		forced: ["-q"],
		flags: LS_FLAGS,
		longFlags: LS_LONG_FLAGS,
		operands: "paths",
		maxOperands: MAX_LS_OPERANDS,
		separator: true,
	},
	cat: { executable: CANONICAL.cat, operands: "paths" },
	head: { executable: CANONICAL.head, flags: new Set(["-q", "-v"]), valueFlags: ["-n", "-c"], countFlag: "-n", operands: "paths" },
	tail: { executable: CANONICAL.tail, flags: new Set(["-q", "-v"]), valueFlags: ["-n", "-c"], countFlag: "-n", operands: "paths" },
	wc: { executable: CANONICAL.wc, flags: new Set(["-c", "-l", "-m", "-w", "-L"]), operands: "paths" },
	file: { executable: CANONICAL.file, flags: new Set(["-b", "-i"]), operands: "paths", minOperands: 1 },
	readlink: { executable: CANONICAL.readlink, flags: new Set(["-f"]), operands: "paths", minOperands: 1, maxOperands: 1 },
	grep: {
		executable: CANONICAL.grep,
		flags: GREP_FLAGS,
		longFlags: GREP_LONG_FLAGS,
		longPrefixes: ["--include=", "--exclude=", "--exclude-dir=", "--color="],
		valueFlags: ["-e", "-A", "-B", "-C", "-m"],
		patternFlag: "-e",
		operands: "pattern",
		separator: true,
	},
	rg: {
		executable: CANONICAL.rg,
		flags: RG_FLAGS,
		longFlags: RG_LONG_FLAGS,
		longPrefixes: ["--glob=", "--type=", "--color="],
		valueFlags: ["-e", "-g", "-t", "-A", "-B", "-C", "-m", "-j"],
		patternFlag: "-e",
		operands: "pattern",
		separator: true,
	},
};

function resolveOperands(operands: readonly Token[], scope: PlanScope): string[] | null {
	const resolved: string[] = [];
	for (const operand of operands) {
		const path = resolveOperand(operand.value, scope);
		if (path === null) return null;
		resolved.push(path);
	}
	return resolved;
}

function planWithSpec(words: readonly Token[], spec: BinarySpec, scope: PlanScope): StagePlan {
	const argv: string[] = [spec.executable, ...(spec.forced ?? [])];
	const operands: Token[] = [];
	let endOfOptions = false;

	for (let index = 1; index < words.length; index += 1) {
		const word = words[index]!.value;
		// A raw-operand command has no flags: `echo ---` prints three dashes.
		if (spec.operands === "raw") {
			operands.push(words[index]!);
			continue;
		}
		if (!endOfOptions && word === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && word.startsWith("-") && word.length > 1) {
			if (spec.valueFlags?.includes(word)) {
				const value = words[index + 1]?.value;
				if (value === undefined) return "unsupported_argument";
				argv.push(word, value);
				index += 1;
				continue;
			}
			if (spec.longFlags?.has(word) || spec.longPrefixes?.some((prefix) => word.startsWith(prefix))) {
				argv.push(word);
				continue;
			}
			const count = spec.countFlag !== undefined ? word.match(/^-(\d+)$/) : null;
			if (count !== null) {
				argv.push(spec.countFlag!, count[1]!);
				continue;
			}
			const flags = setFlags(word, spec.flags ?? new Set<string>());
			if (flags === null) return "unsupported_argument";
			argv.push(...flags);
			continue;
		}
		operands.push(words[index]!);
	}

	const min = spec.minOperands ?? 0;
	if (operands.length < min) return "unsupported_argument";
	if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) return "unsupported_argument";

	if (spec.operands === "none") {
		return operands.length === 0 ? { executable: spec.executable, argv } : "unsupported_argument";
	}
	if (spec.operands === "raw") {
		return { executable: spec.executable, argv: [...argv, ...operands.map((word) => word.value)] };
	}

	const separator = spec.separator === true ? ["--"] : [];
	if (spec.operands === "pattern") {
		const patternFromFlag = spec.patternFlag !== undefined && argv.includes(spec.patternFlag);
		const [pattern, ...paths] = operands;
		if (patternFromFlag) {
			const resolved = resolveOperands(operands, scope);
			return resolved === null
				? "unsupported_argument"
				: { executable: spec.executable, argv: [...argv, ...separator, ...resolved] };
		}
		if (pattern === undefined) {
			return spec.executable === CANONICAL.rg ? { executable: spec.executable, argv } : "unsupported_argument";
		}
		const resolved = resolveOperands(paths, scope);
		return resolved === null
			? "unsupported_argument"
			: { executable: spec.executable, argv: [...argv, ...separator, pattern.value, ...resolved] };
	}

	const resolved = resolveOperands(operands, scope);
	return resolved === null
		? "unsupported_argument"
		: { executable: spec.executable, argv: [...argv, ...separator, ...resolved] };
}

const FIND_FLAGS = new Set(["-name", "-iname", "-type", "-maxdepth", "-mindepth", "-path", "-ipath", "-print"]);
const FIND_REFUSED = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

function planFind(words: Token[], scope: PlanScope): StagePlan {
	const args = words.slice(1);
	const root = args[0]?.value;
	if (root === undefined || root.startsWith("-")) return "unsupported_argument";
	const resolvedRoot = resolveOperand(root, scope);
	if (resolvedRoot === null) return "unsupported_argument";

	const argv: string[] = [CANONICAL.find, "--", resolvedRoot];
	for (let index = 1; index < args.length; index += 2) {
		const word = args[index]!.value;
		const value = args[index + 1]?.value;
		if (FIND_REFUSED.has(word) || !FIND_FLAGS.has(word) || value === undefined) return "unsupported_argument";
		argv.push(word, value);
	}
	return { executable: CANONICAL.find, argv };
}

function planPrintf(words: Token[]): StagePlan {
	const format = words[1]?.value;
	// Only the format's leading dash and `%n` are interesting: printf writes to
	// stdout and cannot touch a file.
	if (format === undefined || format.length === 0 || format.startsWith("-") || /%n/.test(format)) {
		return "unsupported_argument";
	}
	return { executable: CANONICAL.printf, argv: [CANONICAL.printf, ...words.slice(1).map((word) => word.value)] };
}

function planStage(words: Token[], scope: PlanScope): StagePlan {
	const command = words[0]?.value;
	if (command === undefined || command.length === 0) return "unknown_command";
	if (command.includes("=")) return "env_assignment";
	if (command.includes("/")) return "unsupported_argument";

	if (FILESYSTEM_MUTATION.has(command)) return "filesystem_write";
	if (NETWORK.has(command)) return "network_access";
	if (PROCESS_OR_SYSTEM.has(command)) return "process_or_system";

	// `export A=1 B=2` only sets variables for this shell; a bare `export`
	// prints the environment and is the floor's business.
	// `export A=1` only sets variables for this shell. A flag is not a no-op:
	// `export -p` and `declare -p` print every live value.
	if (command === "export" || command === "declare") {
		const assignments = words.slice(1);
		const onlyAssignments =
			assignments.length > 0 && assignments.every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value));
		return onlyAssignments
			? { executable: "builtin:export", argv: [command, ...assignments.map((word) => word.value)] }
			: "unsupported_argument";
	}

	if (command === "git") return planGit(words, scope);
	if (command === "find") return planFind(words, scope);
	if (command === "printf") return planPrintf(words);

	const spec = BINARY_SPECS[command];
	return spec === undefined ? "unknown_command" : planWithSpec(words, spec, scope);
}

const GIT_READ_ONLY: Record<string, readonly string[]> = {
	status: ["--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=normal", "--untracked-files=all", "--untracked-files=no", "--ignored", "-s", "-b", "-sb"],
	diff: ["--stat", "--name-only", "--name-status", "--cached", "--staged", "--no-color", "--color=never", "--unified=0", "--unified=3", "--quiet", "--exit-code", "--", "-U0", "-U3"],
	log: ["--oneline", "--graph", "--decorate", "--no-decorate", "--stat", "--name-only", "--name-status", "--format=%H", "--format=%h", "--format=%s", "--max-count=1", "--max-count=5", "--max-count=10", "--max-count=20", "--", "-n", "-5", "-10", "-20"],
	branch: ["--list", "--all", "--show-current", "--verbose", "-a", "-v", "-vv"],
	remote: ["-v"],
	rev: ["--show-toplevel", "--show-current", "--abbrev-ref", "--git-dir"],
};

function planGit(words: Token[], scope: PlanScope): StagePlan {
	let index = 1;
	const prefix: string[] = [CANONICAL.git];
	while (index < words.length && words[index]!.value === "-C") {
		const path = words[index + 1] === undefined ? null : resolveOperand(words[index + 1]!.value, scope);
		if (path === null) return "unsupported_argument";
		prefix.push("-C", path);
		index += 2;
	}
	const sub = words[index]?.value;
	if (sub === undefined) return "command_owned_input";
	index += 1;

	if (sub === "rev-parse") {
		const rest = words.slice(index);
		const rev = GIT_READ_ONLY["rev"] ?? [];
		const allowed = rest.every((word) => rev.includes(word.value));
		if (!allowed) return "unsupported_argument";
		return { executable: CANONICAL.git, argv: [...prefix, "rev-parse", ...rest.map((word) => word.value)] };
	}
	const allowed = GIT_READ_ONLY[sub];
	if (allowed === undefined) return "command_owned_input";

	const rest = words.slice(index).map((word) => word.value);
	const positional: string[] = [];
	let sawSeparator = false;
	for (const word of rest) {
		if (word === "--") {
			sawSeparator = true;
			continue;
		}
		if (sawSeparator) {
			positional.push(word);
			continue;
		}
		if (!allowed.includes(word)) {
			if (word.startsWith("-")) return "unsupported_argument";
			positional.push(word);
		}
	}
	const maxPositional = sub === "branch" || sub === "remote" ? 0 : 2;
	if (positional.length > maxPositional) return "unsupported_argument";
	return { executable: CANONICAL.git, argv: [...prefix, sub, ...rest] };
}

/** Plan a shell command. `read_only` means every stage is a canonicalized
 * read-only invocation whose path operands are inside the allowed roots. */
export function planCommand(command: string, options: PlanOptions = {}): Plan {
	// git-interceptor prefixes every git call with its editor-neutralizing
	// exports; the floor already ignores that prefix, so the planner must too.
	const trimmed = stripGitEnvPrefix(command).trim();
	if (trimmed.length === 0) return { kind: "review", reason: "empty_command" };
	if (trimmed.length > MAX_COMMAND_BYTES) return { kind: "review", reason: "too_long" };

	const scope = createScope(options);
	// Safe redirects are stripped before splitting: `2>/dev/null` would
	// otherwise read as a redirection and refuse the whole command.
	const normalized = stripSafeRedirects(trimmed);
	let segments: string[];
	try {
		segments = splitSegments(normalized);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message === "background") return { kind: "review", reason: "background" };
		return { kind: "review", reason: "unsupported_shell" };
	}
	if (segments.length === 0) return { kind: "review", reason: "empty_command" };
	if (segments.length > MAX_STAGES) return { kind: "review", reason: "too_many_stages" };

	const stages: PlannedStage[] = [];
	let stageScope = scope;
	for (const segment of segments) {
		const cleaned = stripSafeRedirects(segment);
		if (cleaned.length === 0) continue;
		let words: Token[];
		try {
			words = tokenizeArgs(cleaned);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			return { kind: "review", reason: message === "dynamic word" ? "dynamic_word" : "unsupported_shell" };
		}
		const stage = planStage(words, stageScope);
		if (typeof stage === "string") return { kind: "review", reason: stage };
		stages.push(stage);
		// A planned `cd` moves the path root for later stages in the pipeline.
		if (stage.executable === "builtin:cd" && stage.argv[1] !== undefined) {
			stageScope = { ...scope, cwd: stage.argv[1], roots: [...new Set([...scope.roots, stage.argv[1]])] };
		}
	}
	if (stages.length === 0) return { kind: "review", reason: "empty_command" };
	return { kind: "read_only", stages };
}
