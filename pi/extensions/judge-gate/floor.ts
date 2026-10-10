/**
 * Judge Gate — deterministic hard floor.
 *
 * Tiny, non-configurable, in code. A floor hit blocks finally: no prompt, no
 * session override, no judge call. Override only via `/allow` (one-shot,
 * user-initiated). Anything requiring "is this okay in context?" belongs to
 * the semantic judge, never here — otherwise the floor regrows into the old
 * permission system.
 *
 * Three categories:
 * - bash-shape: command shapes that are never the agent's job
 *   (recursive delete, sudo, force-push, pipe-to-shell, …).
 * - protected-path: credential stores, git internals, *.env writes.
 * - exfil-shape: secret-looking material combined with network egress, so the
 *   secret never even reaches the judge API.
 */

export type FloorCategory = "bash-shape" | "protected-path" | "exfil-shape";

export interface FloorHit {
	readonly category: FloorCategory;
	/** Short stable id, e.g. "recursive-delete". Used in log rows. */
	readonly reason: string;
	/** Human-facing explanation (no hard-stop suffix; caller adds tone). */
	readonly detail: string;
}

/**
 * Prefix injected by the git-interceptor extension. Strip it so floor rules
 * match the actual command (same handling as the old permission system).
 */
const GIT_ENV_PREFIX = "export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";

function stripGitEnvPrefix(command: string): string {
	return command.startsWith(GIT_ENV_PREFIX) ? command.slice(GIT_ENV_PREFIX.length) : command;
}

/** Split a command on sequencing operators (; && ||). Single pipes stay intact. */
function sequenceSegments(command: string): string[] {
	return command.split(/;|&&|\|\|/).map((seg) => seg.trim()).filter((seg) => seg.length > 0);
}

interface BashShape {
	readonly reason: string;
	readonly detail: string;
	readonly match: (command: string) => boolean;
}

const BASH_SHAPES: readonly BashShape[] = [
	{
		reason: "recursive-delete",
		detail: "Recursive force deletion is never executed autonomously. Delete it yourself.",
		match: (c) => /^\s*rm\s+(-[^\s|;&]*[rf][^\s|;&]*\s+)+/.test(c),
	},
	{
		reason: "sudo",
		detail: "Privilege escalation is never executed autonomously. Run it yourself.",
		match: (c) => /^\s*sudo\b/.test(c),
	},
	{
		reason: "eval",
		detail: "Shell eval is never executed autonomously. Run it yourself.",
		match: (c) => /^\s*eval\b/.test(c),
	},
	{
		reason: "source",
		detail: "Sourcing shell files is never executed autonomously. Run it yourself.",
		match: (c) => /^\s*source\b/.test(c) || /^\s*\.\s+\S/.test(c),
	},
	{
		reason: "force-push",
		detail: "Force-pushing rewrites shared history and is never done autonomously. Push it yourself.",
		match: (c) => /^\s*git\s+push\b/.test(c) && /(^|\s)(--force|--force-with-lease|-f)(?=\s|$)/.test(c),
	},
	{
		reason: "hard-reset",
		detail: "Hard resets destroy work and are never done autonomously. Run it yourself.",
		match: (c) => /\bgit\s+reset\s+--hard\b/.test(c),
	},
	{
		reason: "remote-code-execution",
		detail: "Downloading code and piping it to a shell is never done autonomously. Inspect it and run it yourself.",
		match: (c) => /\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|dash)\b/.test(c),
	},
	{
		// Dumping the environment (or named secrets) into output ships secrets
		// to the chat provider via tool results. No network needed.
		reason: "secret-dump",
		detail: "Dumping secrets or the environment into output is never done autonomously. Inspect them yourself.",
		match: (c) =>
			/\b(env|printenv|set)\b[^|;&]*\|\s*(grep|rg|cat|less|more|head|tail|awk|sed|tee|sort|uniq|cut|tr|wc)\b/.test(c) ||
			/^\s*(env|printenv)\s*$/.test(c) ||
			/^\s*set\s*$/.test(c) ||
			/\becho\b[^|;&]*\$[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\b/i.test(c),
	},
];

function checkBashShape(command: string): FloorHit | null {
	const clean = stripGitEnvPrefix(command.trim());
	if (!clean) return null;
	// Whole-command shapes first (they span pipes).
	for (const shape of BASH_SHAPES) {
		if (shape.reason === "remote-code-execution" && shape.match(clean)) {
			return { category: "bash-shape", reason: shape.reason, detail: shape.detail };
		}
	}
	// Every other shape applies per sequence segment: `echo hi; sudo rm -rf /`
	// must not slip past a start-anchored match.
	for (const segment of sequenceSegments(clean)) {
		for (const shape of BASH_SHAPES) {
			if (shape.reason === "remote-code-execution") continue;
			if (shape.match(segment)) {
				return { category: "bash-shape", reason: shape.reason, detail: shape.detail };
			}
		}
	}
	return null;
}

const SECRET_PATTERNS: readonly RegExp[] = [
	/\b[A-Za-z0-9_]*(_KEY|_TOKEN|_SECRET)\s*=\s*\S+/,
	/\bBearer\s+\S{8,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\b(sk-|ghp_|gho_|xox[bap]-)[A-Za-z0-9_-]{8,}/,
];

const NETWORK_PATTERNS: readonly RegExp[] = [/\b(curl|wget|ssh|scp|ftp|nc)\b/, /https?:\/\//];

/** Redact obvious secret material so it never leaves the machine toward the judge API. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const re of SECRET_PATTERNS) {
		out = out.replace(new RegExp(re.source, "g"), "[redacted]");
	}
	return out;
}

function checkExfilShape(command: string): FloorHit | null {
	const clean = stripGitEnvPrefix(command);
	const hasSecret = SECRET_PATTERNS.some((re) => re.test(clean));
	if (!hasSecret) return null;
	const hasNetwork = NETWORK_PATTERNS.some((re) => re.test(clean));
	if (!hasNetwork) return null;
	return {
		category: "exfil-shape",
		reason: "secret-egress",
		detail: "This command appears to send secret material to a network endpoint. Move the secret out of the command yourself.",
	};
}

function isCredentialPath(path: string): boolean {
	const lower = path.toLowerCase();
	return (
		path.includes("/.ssh/") ||
		path.endsWith("/.ssh") ||
		path.includes("/.gnupg/") ||
		path.endsWith("/.gnupg") ||
		path.includes("/.aws/") ||
		path.endsWith("/.aws") ||
		path.includes("/.kube/") ||
		path.endsWith("/.kube") ||
		path.includes("/.docker/") ||
		path.endsWith("/.docker") ||
		// Reading secrets into agent context exfiltrates them to the chat
		// provider — block, don't judge. Same for Trust-on-read exec files.
		path.includes("/secrets/") ||
		path.endsWith("/secrets") ||
		lower.endsWith(".envrc") ||
		/\.p(e)?m$/.test(path) ||
		/\.key$/i.test(path) ||
		/\.p12$/.test(path) ||
		/\.pfx$/.test(path)
	);
}

function isGitInternalPath(path: string): boolean {
	return path.includes("/.git/") || path.endsWith("/.git");
}

function isEnvFile(path: string): boolean {
	return /(^|\/)\.env[^/]*$/.test(path);
}

/**
 * Check a file path against the floor. `resolvedPath` must already be
 * resolved against the workspace cwd by the caller. `isWrite` distinguishes
 * writes/edits (stricter: *.env blocked) from reads (allowed; output
 * redaction handles secrecy).
 */
export function checkPathFloor(resolvedPath: string, isWrite: boolean): FloorHit | null {
	if (isCredentialPath(resolvedPath)) {
		return {
			category: "protected-path",
			reason: "credential-store",
			detail: `Credential-bearing path is off limits: ${resolvedPath}.`,
		};
	}
	if (isGitInternalPath(resolvedPath)) {
		return {
			category: "protected-path",
			reason: "git-internals",
			detail: `Git internals are off limits: ${resolvedPath}. Use git commands instead.`,
		};
	}
	if (isWrite && isEnvFile(resolvedPath)) {
		return {
			category: "protected-path",
			reason: "env-write",
			detail: `Environment files are never written autonomously: ${resolvedPath}. Edit it yourself.`,
		};
	}
	return null;
}

/**
 * Reads that deserve a semantic second opinion (floor already passed):
 * outside the workspace, or secret-adjacent names. Everything else reads free.
 */
export function shouldJudgeRead(resolvedPath: string, cwd: string): boolean {
	if (isOutsideWorkspace(resolvedPath, cwd)) return true;
	const base = resolvedPath.toLowerCase();
	return (
		/(^|\/)\.env[^/]*$/.test(base) ||
		base.includes("secret") ||
		base.includes("credential") ||
		/\.p(e)?m$/.test(base) ||
		/\.key$/.test(base)
	);
}

function isOutsideWorkspace(resolvedPath: string, cwd: string): boolean {
	if (resolvedPath === cwd) return false;
	return !resolvedPath.startsWith(cwd.endsWith("/") ? cwd : cwd + "/");
}

/**
 * Run the full floor check. `value` is the tool's primary value: command text
 * for bash, resolved path for read/write/edit, URL for webfetch (floor only
 * applies URL checks to bash exfil shapes; plain fetches go to the judge).
 * Returns the first hit, or null when the call passes the floor.
 */
export function checkFloor(toolName: string, value: string): FloorHit | null {
	switch (toolName) {
		case "bash":
			return checkBashShape(value) ?? checkExfilShape(value);
		case "read":
			return checkPathFloor(value, false);
		case "write":
		case "edit":
			return checkPathFloor(value, true);
		default:
			return null;
	}
}
