/**
 * Permission Gate — read-only command planner (port of fx's
 * `src/core/shell_command/command_effect.zig`).
 *
 * The planner exists so routine read-only shell work never reaches a model:
 * it parses the command into pipeline segments, resolves each segment against
 * a per-binary policy, and returns either a `read_only` plan or a refusal
 * reason. Anything it cannot prove read-only — unknown binary, unknown flag,
 * redirect, expansion, background job, too many stages — falls through to the
 * reviewer.
 *
 * The bias is deliberate: a refusal costs one review call, a wrong `read_only`
 * costs correctness. Every parser branch therefore fails closed.
 *
 * Faithful to fx where it matters:
 * - argv is tokenized per segment, quotes honored, operators rejected
 * - binaries are canonicalized to absolute paths
 * - ls/cat/grep/wc/head/tail/pwd/printf and git status|diff|log only
 * - filesystem mutations, network tools, and interpreters are always refused
 * - stdout-affecting flags are forced (ls -q, pwd -P) so output cannot hide
 *   bytes the terminal would interpret
 *
 * Deviations, all driven by the replay of 9.2k real calls:
 * - `/dev/null` and `2>&1` redirects are stripped (they only move stderr)
 * - `echo`, `cd`, and `git -C <path>` are planned: `cd X && git status` is the
 *   single most common unplanned shape in our traffic
 * - `rg`, a small read-only `find` subset, and `git branch`/`remote` are planned
 * - file operands are accepted for `cat`/`head`/`tail`/`wc`/`grep`/`file`/
 *   `readlink`, but every path must resolve inside the repository, /nix/store,
 *   or /tmp, and must not match a credential path (the floor's list)
 *
 * Refusing a path is cheap (one review); allowing a path that reads
 * `~/.ssh/id_ed25519` is not, so path policy fails closed too.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { checkPathFloor } from "./floor.js";

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
export function stripSafeRedirects(segment: string): string {
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
		// Unquoted dynamic / glob / tilde words are refused: the planner wants
		// to know exactly which files and bytes a stage touches.
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
	if (checkPathFloor(absolute, false) !== null) return null;
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

/** Short flags accepted per binary; long flags are listed separately. */
const LS_FLAGS = new Set(["-1", "-a", "-A", "-d", "-F", "-h", "-l", "-n", "-p", "-q", "-r", "-R", "-S", "-t", "-u", "-x"]);
const LS_LONG_FLAGS = new Set(["--all", "--almost-all", "--directory", "--human-readable", "--long", "--reverse", "--recursive"]);
const WC_FLAGS = new Set(["-c", "-l", "-m", "-w", "-L"]);
const GREP_FLAGS = new Set(["-E", "-F", "-i", "-n", "-v", "-w", "-x", "-c", "-l", "-h", "-H", "-o", "-q", "-s", "-r", "-R"]);
const GREP_LONG_FLAGS = new Set(["--color", "--no-color", "--line-number", "--count", "--files-with-matches", "--only-matching", "--invert-match", "--recursive", "--with-filename", "--no-filename", "--include", "--exclude", "--exclude-dir"]);
/** Flags that consume the next word; the value is a filter pattern, not a path. */
const GREP_VALUE_FLAGS = ["-e", "-A", "-B", "-C", "-m"];
const RG_FLAGS = new Set(["-n", "-i", "-l", "-c", "-w", "-x", "-v", "-F", "-s", "-u", "-g", "-t", "-e", "-A", "-B", "-C", "-m", "-j", "-h", "-H"]);
const RG_LONG_FLAGS = new Set(["--files", "--files-with-matches", "--line-number", "--ignore-case", "--count", "--hidden", "--no-heading", "--glob", "--type"]);
const RG_VALUE_FLAGS = ["-e", "-g", "-t", "-A", "-B", "-C", "-m", "-j"];
const FIND_FLAGS = new Set(["-name", "-iname", "-type", "-maxdepth", "-mindepth", "-path", "-ipath", "-print"]);
const FIND_REFUSED = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

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

function planPwd(words: Token[]): StagePlan {
	if (words.length > 2) return "unsupported_argument";
	if (words.length === 2 && words[1]!.value !== "-P") return "unsupported_argument";
	return { executable: CANONICAL.pwd, argv: [CANONICAL.pwd, "-P"] };
}

/** echo writes to stdout only; redirections are already refused or stripped. */
function planEcho(words: Token[]): StagePlan {
	return { executable: "builtin:echo", argv: ["echo", ...words.slice(1).map((word) => word.value)] };
}

/** cd only changes which files later stages read; the path policy still applies. */
function planCd(words: Token[], scope: PlanScope): StagePlan {
	if (words.length !== 2) return "unsupported_argument";
	const path = resolveOperand(words[1]!.value, scope);
	if (path === null) return "unsupported_argument";
	return { executable: "builtin:cd", argv: ["cd", path] };
}

function planLs(words: Token[], scope: PlanScope): StagePlan {
	const argv: string[] = [CANONICAL.ls, "-q"];
	const operands: string[] = [];
	let parsingOptions = true;
	let explicitSeparator = false;

	for (const word of words.slice(1)) {
		if (parsingOptions && word.value === "--") {
			parsingOptions = false;
			explicitSeparator = true;
			continue;
		}
		if (parsingOptions && word.value.startsWith("-") && word.value.length > 1) {
			const long = LS_LONG_FLAGS.has(word.value);
			const short = long ? null : setFlags(word.value, LS_FLAGS);
			if (short === null && !long) return "unsupported_argument";
			if (long) argv.push(word.value);
			else argv.push(...short!);
			continue;
		}
		parsingOptions = false;
		if (!explicitSeparator && word.value.startsWith("-") && word.value.length > 1) {
			return "unsupported_argument";
		}
		const path = resolveOperand(word.value, scope);
		if (path === null) return "unsupported_argument";
		operands.push(path);
	}

	if (operands.length > MAX_LS_OPERANDS) return "unsupported_argument";
	return { executable: CANONICAL.ls, argv: [...argv, "--", ...operands] };
}

function planCat(words: Token[], scope: PlanScope): StagePlan {
	const operands = pathOperands(words, 1, scope);
	if (operands === null) return "unsupported_argument";
	return { executable: CANONICAL.cat, argv: [CANONICAL.cat, ...operands] };
}

function planHeadOrTail(words: Token[], executable: string, scope: PlanScope): StagePlan {
	let index = 1;
	let count = "10";
	if (index < words.length && words[index]!.value === "-n") {
		const value = words[index + 1]?.value;
		if (value === undefined || !/^\d+$/.test(value) || Number(value) > MAX_LINE_COUNT) {
			return "unsupported_argument";
		}
		count = value;
		index += 2;
	}
	const operands = pathOperands(words, index, scope);
	if (operands === null) return "unsupported_argument";
	return { executable, argv: [executable, "-n", count, ...operands] };
}

function planWc(words: Token[], scope: PlanScope): StagePlan {
	const argv: string[] = [CANONICAL.wc];
	let index = 1;
	while (index < words.length) {
		const flags = setFlags(words[index]!.value, WC_FLAGS);
		if (flags === null) break;
		argv.push(...flags);
		index += 1;
	}
	const operands = pathOperands(words, index, scope);
	if (operands === null) return "unsupported_argument";
	return { executable: CANONICAL.wc, argv: [...argv, ...operands] };
}

function planFile(words: Token[], scope: PlanScope): StagePlan {
	if (words.length < 2) return "unsupported_argument";
	if (words[1]!.value === "-b" || words[1]!.value === "-i") {
		const operands = pathOperands(words, 2, scope);
		if (operands === null || operands.length === 0) return "unsupported_argument";
		return { executable: CANONICAL.file, argv: [CANONICAL.file, words[1]!.value, ...operands] };
	}
	const operands = pathOperands(words, 1, scope);
	if (operands === null || operands.length === 0) return "unsupported_argument";
	return { executable: CANONICAL.file, argv: [CANONICAL.file, ...operands] };
}

function planReadlink(words: Token[], scope: PlanScope): StagePlan {
	const args = words.slice(1);
	const flags = args.length > 1 && args[0]!.value === "-f" ? ["-f"] : [];
	const start = flags.length > 0 ? 2 : 1;
	const operands = pathOperands(words, start, scope);
	if (operands === null || operands.length !== 1) return "unsupported_argument";
	return { executable: CANONICAL.readlink, argv: [CANONICAL.readlink, ...flags, ...operands] };
}

function planGrep(words: Token[], scope: PlanScope): StagePlan {
	const argv: string[] = [CANONICAL.grep];
	let index = 1;
	let endOfOptions = false;
	while (index < words.length) {
		const word = words[index]!.value;
		if (endOfOptions) break;
		if (word === "--") {
			endOfOptions = true;
			index += 1;
			break;
		}
		if (!word.startsWith("-") || word.length <= 1) break;
		if (GREP_VALUE_FLAGS.includes(word)) {
			const value = words[index + 1]?.value;
			if (value === undefined) return "unsupported_argument";
			argv.push(word, value);
			index += 2;
			continue;
		}
		const long = GREP_LONG_FLAGS.has(word);
		const flags = long ? null : setFlags(word, GREP_FLAGS);
		if (flags === null && !long) return "unsupported_argument";
		if (long) argv.push(word);
		else argv.push(...flags!);
		index += 1;
	}
	if (index >= words.length) return "unsupported_argument";
	const pattern = words[index]!.value;
	index += 1;
	const operands = pathOperands(words, index, scope);
	if (operands === null) return "unsupported_argument";
	return { executable: CANONICAL.grep, argv: [...argv, "--", pattern, ...operands] };
}

function planRg(words: Token[], scope: PlanScope): StagePlan {
	const argv: string[] = [CANONICAL.rg];
	let index = 1;
	const operands: string[] = [];
	let endOfOptions = false;
	while (index < words.length) {
		const word = words[index]!.value;
		if (!endOfOptions && word === "--") {
			endOfOptions = true;
			index += 1;
			continue;
		}
		if (!endOfOptions && word.startsWith("-") && word.length > 1) {
			if (RG_VALUE_FLAGS.includes(word)) {
				const value = words[index + 1]?.value;
				if (value === undefined) return "unsupported_argument";
				argv.push(word, value);
				index += 2;
				continue;
			}
			const long = RG_LONG_FLAGS.has(word.split("=", 1)[0]!);
			const flags = long ? null : setFlags(word, RG_FLAGS);
			if (flags === null && !long) return "unsupported_argument";
			if (long) argv.push(word);
			else argv.push(...flags!);
			index += 1;
			continue;
		}
		operands.push(word);
		index += 1;
	}
	// First operand is the pattern; the rest are paths and must be bounded.
	if (operands.length === 0) {
		return argv.includes("--files") ? { executable: CANONICAL.rg, argv } : "unsupported_argument";
	}
	const paths: string[] = [];
	for (const operand of operands.slice(1)) {
		const path = resolveOperand(operand, scope);
		if (path === null) return "unsupported_argument";
		paths.push(path);
	}
	return { executable: CANONICAL.rg, argv: [...argv, "--", operands[0]!, ...paths] };
}

function planFind(words: Token[], scope: PlanScope): StagePlan {
	const argv: string[] = [CANONICAL.find];
	const args = words.slice(1);
	if (args.length === 0) return "unsupported_argument";
	const root = args[0]!.value;
	if (root.startsWith("-")) return "unsupported_argument";
	const resolvedRoot = resolveOperand(root, scope);
	if (resolvedRoot === null) return "unsupported_argument";
	argv.push("--", resolvedRoot);
	let index = 1;
	while (index < args.length) {
		const word = args[index]!.value;
		if (FIND_REFUSED.has(word)) return "unsupported_argument";
		if (!FIND_FLAGS.has(word)) return "unsupported_argument";
		const value = args[index + 1]?.value;
		if (value === undefined) return "unsupported_argument";
		argv.push(word, value);
		index += 2;
	}
	return { executable: CANONICAL.find, argv };
}

function planPrintf(words: Token[]): StagePlan {
	if (words.length < 2) return "unsupported_argument";
	const format = words[1]!.value;
	if (format.length === 0 || format.startsWith("-")) return "unsupported_argument";
	if (!/^[\x20-\x7e]*$/.test(format)) return "unsupported_argument";
	let conversions = 0;
	for (let i = 0; i < format.length; i += 1) {
		const ch = format[i]!;
		if (ch === "\\") {
			if (format[i + 1] !== "n") return "unsupported_argument";
			i += 1;
			continue;
		}
		if (ch === "%") {
			const next = format[i + 1];
			if (next === "%") {
				i += 1;
				continue;
			}
			if (next !== "s") return "unsupported_argument";
			conversions += 1;
			i += 1;
		}
	}
	if (words.length - 2 !== conversions) return "unsupported_argument";
	return { executable: CANONICAL.printf, argv: [CANONICAL.printf, ...words.slice(1).map((word) => word.value)] };
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
	// `git -C <path> <sub>` is the shape Pi's own extensions use.
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

function planStage(words: Token[], scope: PlanScope): StagePlan {
	if (words.length === 0) return "unknown_command";
	const command = words[0]!.value;
	if (command.length === 0) return "unknown_command";
	if (command.includes("=")) return "env_assignment";
	if (command.includes("/")) return "unsupported_argument";

	if (FILESYSTEM_MUTATION.has(command)) return "filesystem_write";
	if (NETWORK.has(command)) return "network_access";
	if (PROCESS_OR_SYSTEM.has(command)) return "process_or_system";

	switch (command) {
		case "pwd":
			return planPwd(words);
		case "echo":
			return planEcho(words);
		case "true":
		case ":":
			return { executable: "builtin:true", argv: [command] };
		case "cd":
			return planCd(words, scope);
		case "ls":
			return planLs(words, scope);
		case "cat":
			return planCat(words, scope);
		case "head":
			return planHeadOrTail(words, CANONICAL.head, scope);
		case "tail":
			return planHeadOrTail(words, CANONICAL.tail, scope);
		case "wc":
			return planWc(words, scope);
		case "file":
			return planFile(words, scope);
		case "readlink":
			return planReadlink(words, scope);
		case "grep":
			return planGrep(words, scope);
		case "rg":
			return planRg(words, scope);
		case "find":
			return planFind(words, scope);
		case "printf":
			return planPrintf(words);
		case "git":
			return planGit(words, scope);
		default:
			return "unknown_command";
	}
}

/** Plan a shell command. `read_only` means every stage is a canonicalized
 * read-only invocation whose path operands are inside the allowed roots. */
export function planCommand(command: string, options: PlanOptions = {}): Plan {
	const trimmed = command.trim();
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
