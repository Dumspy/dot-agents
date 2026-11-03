/**
 * Permission Gate — recent blocks and the `/allow` one-shot.
 *
 * `/allow` shows the three most recent blocks; picking one arms a single
 * approval that the first matching call consumes and that dies with the
 * session.
 */

export type BlockKind = "floor" | "review";

export interface BlockedCall {
	/** Tool id, used to resolve and match the approval. */
	readonly tool: string;
	/** One-line rendering for the picker. */
	readonly description: string;
	readonly value: string;
	readonly cwd: string;
	readonly kind: BlockKind;
	readonly reason: string;
	readonly detail: string;
	readonly ts: string;
}

const RECENT_LIMIT = 3;

export class BlockBuffer {
	private readonly items: BlockedCall[] = [];

	push(call: BlockedCall): void {
		this.items.unshift(call);
		if (this.items.length > RECENT_LIMIT) this.items.length = RECENT_LIMIT;
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

	set(tool: string, value: string): void {
		this.key = `${tool}:${value}`;
	}

	/** Consume on exact match; a different call leaves the approval armed. */
	consume(tool: string, value: string): boolean {
		if (this.key === null || this.key !== `${tool}:${value}`) return false;
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
	const oneLine = call.description.replace(/\s+/g, " ").trim();
	return `[${call.kind === "floor" ? "floor" : "review"}] ${oneLine} — ${call.reason}`;
}
