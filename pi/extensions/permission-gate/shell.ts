/**
 * Permission Gate — one shell scanner for the floor and the planner.
 *
 * Both halves need to know where a command's stages begin and end, but they
 * disagree about what to do with the parts they cannot reason about:
 *
 * - the planner (strict) refuses redirections, command substitution, and
 *   background jobs, because it must prove the whole command read-only;
 * - the floor (non-strict) only needs stage boundaries, so it keeps those
 *   characters in the current segment and lets the shapes look at them.
 *
 * Keeping the scan in one place means the two halves cannot drift on quoting,
 * escaped operators, or `&&`/`||` handling. An unbalanced quote is the only
 * case where both fall back to the whole command.
 */

export type ShellScanError =
	| "unbalanced quotes"
	| "trailing backslash"
	| "command substitution"
	| "expansion"
	| "redirection"
	| "background";

export interface ShellScan {
	/** Raw segments in order, with surrounding whitespace preserved. */
	readonly segments: readonly string[];
	/** Set when the scan could not finish; `segments` is then `[command]`. */
	readonly error: ShellScanError | null;
}

export interface ShellScanOptions {
	/** Refuse what the planner cannot prove; the floor leaves it in place. */
	readonly strict?: boolean;
}

const fail = (command: string, error: ShellScanError): ShellScan => ({ segments: [command], error });

/**
 * Split a command on top-level sequencing and pipeline operators, honoring
 * quotes and backslash escapes. A single pipe is a stage boundary: the floor
 * must see `sudo` in `echo hi | sudo tee`, and the planner must canonicalize
 * every stage of `cat | grep`.
 */
export function scanShellSegments(command: string, options: ShellScanOptions = {}): ShellScan {
	const strict = options.strict ?? false;
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
				if (next === undefined) {
					if (strict) return fail(command, "trailing backslash");
					current += ch;
					i += 1;
					continue;
				}
				current += ch + next;
				i += 2;
				continue;
			}
			if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
				if (strict) return fail(command, "command substitution");
				current += ch;
				i += 1;
				continue;
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
		if (ch === "`") {
			if (strict) return fail(command, "command substitution");
			current += ch;
			i += 1;
			continue;
		}
		if (ch === "$" && (command[i + 1] === "(" || command[i + 1] === "{")) {
			if (strict) return fail(command, "expansion");
			current += ch;
			i += 1;
			continue;
		}
		if (ch === "<" || ch === ">") {
			if (strict) return fail(command, "redirection");
			current += ch;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			const next = command[i + 1];
			if (next === undefined) {
				if (strict) return fail(command, "trailing backslash");
				current += ch;
				i += 1;
				continue;
			}
			// Keep the escaped character in the segment so an escaped operator
			// is never read as a stage boundary.
			current += ch + next;
			i += 2;
			continue;
		}
		if (ch === "\n" || ch === "\r") {
			segments.push(current);
			current = "";
			i += 1;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&") {
			if (ch === "&" && command[i + 1] !== "&") {
				if (strict) return fail(command, "background");
				segments.push(current);
				current = "";
				i += 1;
				continue;
			}
			segments.push(current);
			current = "";
			// Consume the two-character operators; a lone `|` is a stage
			// boundary and a lone `&` was handled above.
			i += command[i + 1] === ch ? 2 : 1;
			continue;
		}
		current += ch;
		i += 1;
	}

	if (inSingle || inDouble) return fail(command, "unbalanced quotes");
	segments.push(current);
	return { segments, error: null };
}
