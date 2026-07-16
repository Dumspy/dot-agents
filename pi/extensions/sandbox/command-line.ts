import type { AccessMode } from "./types.js";

export function tokenizeCommandLine(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	let started = false;
	for (const character of input) {
		if (escaping) {
			current += character;
			escaping = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}
	if (escaping) throw new Error("Trailing escape in command arguments");
	if (quote) throw new Error("Unterminated quote in command arguments");
	if (started) tokens.push(current);
	return tokens;
}

export function parseMountArguments(input: string): { path: string; mode: AccessMode } {
	const tokens = tokenizeCommandLine(input);
	let mode: AccessMode = "read-only";
	let explicitMode = false;
	const paths: string[] = [];
	for (const token of tokens) {
		if (token === "--read-only" || token === "--read-write") {
			if (explicitMode) throw new Error("Specify only one of --read-only or --read-write");
			mode = token === "--read-write" ? "read-write" : "read-only";
			explicitMode = true;
		} else if (token.startsWith("--")) {
			throw new Error(`Unknown /mount option: ${token}`);
		} else {
			paths.push(token);
		}
	}
	if (paths.length !== 1) throw new Error("Usage: /mount [--read-only|--read-write] /absolute/path");
	return { path: paths[0]!, mode };
}
