import { BROKER_QUEUE_TIMEOUT_MS } from "../protocol.js";

type Waiter = {
	mode: "shared" | "exclusive";
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	timer?: NodeJS.Timeout;
};

/** Fair workspace queue: readers may run together, while queued writers block later readers. */
export class WorkspaceScheduler {
	readonly #waiters: Waiter[] = [];
	#activeReaders = 0;
	#writerActive = false;

	constructor(readonly queueTimeoutMs = BROKER_QUEUE_TIMEOUT_MS) {}

	async runShared<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const release = await this.#acquire("shared", signal);
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const release = await this.#acquire("exclusive", signal);
		try {
			return await operation();
		} finally {
			release();
		}
	}

	/** Remove a queued waiter and detach its timer and abort listener. */
	#removeWaiter(waiter: Waiter): boolean {
		const index = this.#waiters.indexOf(waiter);
		if (index < 0) return false;
		this.#waiters.splice(index, 1);
		if (waiter.timer) clearTimeout(waiter.timer);
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		return true;
	}

	#acquire(mode: Waiter["mode"], signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("aborted"));
		return new Promise((resolve, reject) => {
			const waiter: Waiter = { mode, resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					if (!this.#removeWaiter(waiter)) return;
					reject(new Error("aborted"));
					this.#drain();
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			if (this.queueTimeoutMs > 0) {
				waiter.timer = setTimeout(() => {
					if (!this.#removeWaiter(waiter)) return;
					reject(new Error(`Sandbox operation queue timed out after ${this.queueTimeoutMs}ms`));
					this.#drain();
				}, this.queueTimeoutMs);
				waiter.timer.unref();
			}
			this.#waiters.push(waiter);
			this.#drain();
		});
	}

	#grant(waiter: Waiter, release: () => void): void {
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		if (waiter.timer) clearTimeout(waiter.timer);
		waiter.resolve(release);
	}

	#drain(): void {
		if (this.#writerActive || this.#waiters.length === 0) return;
		const first = this.#waiters[0]!;
		if (first.mode === "exclusive") {
			if (this.#activeReaders > 0) return;
			this.#waiters.shift();
			this.#writerActive = true;
			this.#grant(first, () => {
				this.#writerActive = false;
				this.#drain();
			});
			return;
		}
		while (this.#waiters[0]?.mode === "shared" && !this.#writerActive) {
			const reader = this.#waiters.shift()!;
			this.#activeReaders++;
			this.#grant(reader, () => {
				this.#activeReaders--;
				this.#drain();
			});
		}
	}
}
