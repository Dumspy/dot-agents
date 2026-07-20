import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	truncateLine,
	type BashOperations,
	type EditOperations,
	type FindOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { GUEST_EXTERNAL_ROOT, GUEST_WORKSPACE } from "./types.js";

const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

export function normalizeGuestPath(value: string): string {
	const trimmed = value.startsWith("@") ? value.slice(1).trim() : value.trim();
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.posix.isAbsolute(trimmed)) {
		const normalized = path.posix.resolve(trimmed.replaceAll("\\", "/"));
		if (
			normalized !== GUEST_WORKSPACE &&
			!normalized.startsWith(`${GUEST_WORKSPACE}/`) &&
			normalized !== GUEST_EXTERNAL_ROOT &&
			!normalized.startsWith(`${GUEST_EXTERNAL_ROOT}/`)
		) {
			throw new Error(`Path is not available in the sandbox: ${value}`);
		}
		return normalized;
	}
	return path.posix.resolve(GUEST_WORKSPACE, trimmed.replaceAll("\\", "/"));
}

export function createGondolinReadOps(getVm: () => VM): ReadOperations {
	return {
		readFile: async (filePath) => getVm().fs.readFile(normalizeGuestPath(filePath)),
		access: async (filePath) => {
			await getVm().fs.access(normalizeGuestPath(filePath));
		},
		detectImageMimeType: async (filePath) => {
			const extension = path.posix.extname(normalizeGuestPath(filePath)).toLowerCase();
			if (extension === ".png") return "image/png";
			if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
			if (extension === ".gif") return "image/gif";
			if (extension === ".webp") return "image/webp";
			return null;
		},
	};
}

export function createGondolinWriteOps(getVm: () => VM): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await getVm().fs.writeFile(normalizeGuestPath(filePath), content, { encoding: "utf8" });
		},
		mkdir: async (directoryPath) => {
			await getVm().fs.mkdir(normalizeGuestPath(directoryPath), { recursive: true });
		},
	};
}

export function createGondolinEditOps(getVm: () => VM): EditOperations {
	const read = createGondolinReadOps(getVm);
	const write = createGondolinWriteOps(getVm);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

async function guestExists(getVm: () => VM, filePath: string): Promise<boolean> {
	try {
		await getVm().fs.access(normalizeGuestPath(filePath));
		return true;
	} catch {
		return false;
	}
}

export function createGondolinLsOps(getVm: () => VM): LsOperations {
	return {
		exists: (filePath) => guestExists(getVm, filePath),
		stat: async (filePath) => getVm().fs.stat(normalizeGuestPath(filePath)),
		readdir: async (directoryPath) => getVm().fs.listDir(normalizeGuestPath(directoryPath)),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stats = await vm.fs.stat(root, { signal });
	if (!stats.isDirectory()) return visit(root, path.posix.basename(root));
	const walkDirectory = async (directory: string, relativeDirectory: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		for (const entry of await vm.fs.listDir(directory, { signal })) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(directory, entry);
			const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry) : entry;
			let entryStats: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStats = await vm.fs.stat(guestPath, { signal });
			} catch {
				continue;
			}
			if (entryStats.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) return false;
		}
		return true;
	};
	return walkDirectory(root, "");
}

function matchesGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = pattern.replaceAll("\\", "/");
	if (normalizedPattern.includes("/")) {
		return path.posix.matchesGlob(relativePath, normalizedPattern) || path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

export function createGondolinFindOps(getVm: () => VM): FindOperations {
	return {
		exists: (filePath) => guestExists(getVm, filePath),
		glob: async (pattern, cwd, options) => {
			const vm = getVm();
			const root = normalizeGuestPath(cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesGlob(relativePath, pattern)) results.push(guestPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

function lineMatcher(pattern: string, literal?: boolean, ignoreCase?: boolean): (line: string) => boolean {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line) => regex.test(line);
}

function appendGrepBlock(options: {
	output: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let truncated = false;
	const start = options.contextLines > 0 ? Math.max(0, options.lineIndex - options.contextLines) : options.lineIndex;
	const end = options.contextLines > 0 ? Math.min(options.lines.length - 1, options.lineIndex + options.contextLines) : options.lineIndex;
	for (let index = start; index <= end; index++) {
		const line = truncateLine((options.lines[index] ?? "").replace(/\r/g, ""));
		if (line.wasTruncated) truncated = true;
		const separator = index === options.lineIndex ? ":" : "-";
		options.output.push(`${options.relativePath}${separator}${index + 1}${separator} ${line.text}`);
	}
	return truncated;
}

export async function executeGondolinGrep(
	getVm: () => VM,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const vm = getVm();
	const root = normalizeGuestPath(params.path ?? ".");
	const rootStats = await vm.fs.stat(root, { signal });
	const rootIsDirectory = rootStats.isDirectory();
	const matches = lineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = Math.max(0, params.context ?? 0);
	const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const output: string[] = [];
	const details: GrepToolDetails = {};
	let count = 0;
	let matchLimitReached = false;
	let linesTruncated = false;
	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (count >= limit) return false;
			if (params.glob && !matchesGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				return true;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matches(lines[index] ?? "")) continue;
				count++;
				if (appendGrepBlock({ output, lines, relativePath: displayPath, lineIndex: index, contextLines })) linesTruncated = true;
				if (count >= limit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);
	if (count === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let text = truncation.content;
	if (matchLimitReached) {
		details.matchLimitReached = limit;
		notices.push(`${limit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
}

const SAFE_ENV_NAMES = new Set(["COLORTERM", "FORCE_COLOR", "LANG", "LC_ALL", "NO_COLOR", "TERM", "TZ"]);

function safeGuestEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const safe: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (SAFE_ENV_NAMES.has(name) && typeof value === "string") safe[name] = value;
	}
	return Object.keys(safe).length > 0 ? safe : undefined;
}

export function createGondolinBashOps(getVm: () => VM, getShellPath: () => string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			let timedOut = false;
			const timer = timeout && timeout > 0 ? setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeout * 1000) : undefined;
			try {
				const process = getVm().exec([getShellPath(), "-lc", command], {
					cwd: normalizeGuestPath(cwd),
					env: safeGuestEnv(env),
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of process.output()) onData(chunk.data);
				return { exitCode: (await process).exitCode };
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			}
		},
	};
}
