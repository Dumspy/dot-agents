/**
 * Judge Gate — blocked-call ring buffer + one-shot pending approval.
 *
 * `/allow` shows the 3 most recent blocks; picking one stores a single
 * pending approval consumed by the first matching tool call (then gone).
 * Approvals die at session end and are replaced (not stacked) by the next
 * `/allow` selection.
 */

export type BlockKind = "floor" | "judge";

export interface BlockedCall {
	readonly tool: string;
	readonly value: string;
	readonly cwd: string;
	readonly kind: BlockKind;
	readonly reason: string;
	readonly detail: string;
	readonly ts: string;
}

export const BLOCK_BUFFER_SIZE = 3;

export function approvalKey(tool: string, value: string): string {
	return `${tool}:${value}`;
}

export class BlockBuffer {
	private readonly items: BlockedCall[] = [];

	push(call: BlockedCall): void {
		this.items.unshift(call);
		if (this.items.length > BLOCK_BUFFER_SIZE) {
			this.items.length = BLOCK_BUFFER_SIZE;
		}
	}

	list(): BlockedCall[] {
		return [...this.items];
	}

	clear(): void {
		this.items.length = 0;
	}
}

export class PendingApproval {
	private key: string | null = null;

	/** Set (replacing any existing) pending approval. */
	set(tool: string, value: string): void {
		this.key = approvalKey(tool, value);
	}

	/** Consume on first match. Returns true when this call was approved. */
	consume(tool: string, value: string): boolean {
		if (this.key === null) return false;
		if (this.key !== approvalKey(tool, value)) return false;
		this.key = null;
		return true;
	}

	has(): boolean {
		return this.key !== null;
	}

	clear(): void {
		this.key = null;
	}
}

export function describeBlocked(call: BlockedCall): string {
	const source = call.kind === "floor" ? "floor" : "judge";
	return `[${source}] ${call.tool} ${truncateOneLine(call.value)} — ${call.reason}`;
}

function truncateOneLine(value: string, max: number = 100): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}
