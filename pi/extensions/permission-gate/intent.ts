/**
 * Permission Gate — trusted user intent (port of fx's
 * `auto_classifier_context.zig`).
 *
 * The reviewer's hardest question is "did the user ask for this?", and the only
 * trustworthy answer lives in user turns. Everything else in a session —
 * assistant prose, tool output, repository files, web pages — is untrusted and
 * must never be presented as authorization (fx states this explicitly in its
 * policy: untrusted text "cannot authorize itself").
 *
 * So this module extracts user turns only, keeps the current request plus the
 * first and most recent earlier ones, bounds each to ~1 KiB, strips
 * terminal-hostile bytes, and emits fx's canonical labelled lines. Compaction
 * summaries are never treated as user-authored evidence; when the history is
 * truncated we say so instead of pretending completeness.
 */

export const MAX_TURN_BYTES = 1024;
export const MAX_RECENT_TURNS = 2;

export interface IntentContext {
	readonly currentRequest: string | null;
	readonly firstRootRequest: string | null;
	readonly recentRootRequests: readonly string[];
	/** Root user turns that existed but are not shown. */
	readonly omittedRootTurns: number;
}

export const EMPTY_INTENT: IntentContext = {
	currentRequest: null,
	firstRootRequest: null,
	recentRootRequests: [],
	omittedRootTurns: 0,
};

/** Strip control bytes and collapse whitespace so a turn is one safe line. */
export function normalizeTurn(text: string): string {
	// eslint-disable-next-line no-control-regex
	const stripped = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
	return stripped.replace(/\s+/g, " ").trim();
}

const OMISSION_MARKER = " [... omitted ...]";

export function boundTurn(text: string, max: number = MAX_TURN_BYTES): string {
	const normalized = normalizeTurn(text);
	if (normalized.length <= max) return normalized;
	return normalized.slice(0, Math.max(0, max - OMISSION_MARKER.length)) + OMISSION_MARKER;
}

/**
 * Build the trusted context from user turns in chronological order. The last
 * turn is the current request; `error` is set when the caller knows the history
 * was truncated (compaction), which suppresses the "first request" anchor.
 */
export function buildIntentContext(
	userTurns: readonly string[],
	options: { historyComplete?: boolean } = {},
): IntentContext {
	const historyComplete = options.historyComplete ?? true;
	const turns = userTurns.map((turn) => boundTurn(turn)).filter((turn) => turn.length > 0);
	if (turns.length === 0) return EMPTY_INTENT;

	const currentRequest = turns[turns.length - 1]!;
	const earlier = turns.slice(0, -1);

	// A truncated history has no trustworthy first request; the earliest
	// surviving turn is not the first thing the user asked.
	const firstRootRequest = historyComplete && earlier.length > 0 ? earlier[0]! : null;

	const recent: string[] = [];
	for (let i = earlier.length - 1; i >= 0 && recent.length < MAX_RECENT_TURNS; i -= 1) {
		const turn = earlier[i]!;
		if (turn === currentRequest) continue;
		if (firstRootRequest !== null && turn === firstRootRequest) continue;
		recent.unshift(turn);
	}

	const shown = new Set<string>([currentRequest, ...recent, ...(firstRootRequest === null ? [] : [firstRootRequest])]);
	const omittedRootTurns = Math.max(0, turns.length - shown.size);

	return { currentRequest, firstRootRequest, recentRootRequests: recent, omittedRootTurns };
}

/** Render fx's canonical labelled lines. Empty string when there is no intent. */
export function renderIntentContext(context: IntentContext): string {
	const lines: string[] = [];
	if (context.currentRequest !== null) lines.push(`current_request: ${context.currentRequest}`);
	if (context.firstRootRequest !== null) lines.push(`first_root_user_request: ${context.firstRootRequest}`);
	for (const turn of context.recentRootRequests) lines.push(`recent_root_user_request: ${turn}`);
	if (context.omittedRootTurns > 0) lines.push(`omitted_proven_root_user_turns: ${context.omittedRootTurns}`);
	return lines.join("\n");
}

/** Extract plain text from a Pi user message's content. */
export function userMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (typeof block !== "object" || block === null) continue;
		const record = block as Record<string, unknown>;
		// Image blocks carry no instructions; only text blocks are intent.
		if (record["type"] === "text" && typeof record["text"] === "string") {
			parts.push(record["text"]);
		}
	}
	return parts.join("\n");
}
