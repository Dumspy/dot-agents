/**
 * Permission Gate — environment facts (port of the `environment` half of
 * Armor's rule context and fx's review evidence).
 *
 * Facts, never rules: which repository this is, which remotes it pushes to,
 * which branch is checked out, which package registry the project uses. The
 * reviewer needs them to answer "is this destination inside the trusted
 * boundary?" — without them, every push, fetch, and registry call is
 * undecidable and has to be escalated.
 *
 * Everything here is read locally with a short timeout and cached per working
 * directory. A failure degrades to a smaller fact set; it never blocks a call.
 */

import { execFileSync } from "node:child_process";

export interface EnvironmentFacts {
	/** Absolute repository root, when cwd is inside a git worktree. */
	readonly repoRoot: string | null;
	/** Remotes as `host/owner/repo` (credentials and protocols stripped). */
	readonly remotes: readonly string[];
	/** Checked-out branch, or null for a detached HEAD. */
	readonly branch: string | null;
	/** Whether the working directory is inside a trusted (user-opened) project. */
	readonly trustedProject: boolean;
}

export const EMPTY_FACTS: EnvironmentFacts = {
	repoRoot: null,
	remotes: [],
	branch: null,
	trustedProject: false,
};

const GIT_TIMEOUT_MS = 1500;

function git(cwd: string, args: readonly string[]): string | null {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim();
	} catch {
		return null;
	}
}

/** Reduce a remote URL to `host/path` so tokens and protocols never leak. */
export function normalizeRemote(url: string): string {
	let rest = url.trim();
	const scheme = rest.match(/^[a-z+]+:\/\//i);
	if (scheme) rest = rest.slice(scheme[0].length);
	// user@host:path (scp syntax) or user@host/path
	rest = rest.replace(/^[^@/]+@/, "");
	rest = rest.replace(/^([^/:]+):(?!\/\/)/, "$1/");
	rest = rest.replace(/\/\/+$/, "");
	rest = rest.replace(/\.git$/, "");
	return rest;
}

const cache = new Map<string, EnvironmentFacts>();

/** Read environment facts for `cwd`. Cached; call `clearEnvironmentCache` on session start. */
export function readEnvironmentFacts(cwd: string, trustedProject = true): EnvironmentFacts {
	const cached = cache.get(cwd);
	if (cached) return cached;

	const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
	const remoteOut = git(cwd, ["remote", "-v"]) ?? "";
	const remotes: string[] = [];
	for (const line of remoteOut.split("\n")) {
		const parts = line.split(/\s+/);
		if (parts.length < 2 || parts[2] !== "(fetch)") continue;
		const normalized = normalizeRemote(parts[1]!);
		if (normalized.length > 0) remotes.push(normalized);
	}
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

	const facts: EnvironmentFacts = {
		repoRoot,
		remotes: [...new Set(remotes)].slice(0, 8),
		branch: branch === "HEAD" ? null : branch,
		trustedProject,
	};
	cache.set(cwd, facts);
	return facts;
}

export function clearEnvironmentCache(): void {
	cache.clear();
}

/** Render facts as Armor-style `Name: value` prose lines. */
export function describeEnvironment(facts: EnvironmentFacts, cwd: string): string[] {
	const lines = [`Working directory: ${cwd}`];
	if (facts.trustedProject) lines.push("Project trust: the user opened this project; it is trusted.");
	if (facts.repoRoot !== null) lines.push(`Trusted repository: ${facts.repoRoot}`);
	if (facts.remotes.length > 0) lines.push(`Source control: ${facts.remotes.join(", ")}`);
	if (facts.branch !== null) lines.push(`Current branch: ${facts.branch}`);
	if (facts.repoRoot === null) lines.push("Source control: not a git repository");
	return lines;
}
