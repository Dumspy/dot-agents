export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Serialize async operations: each starts only after the previous one settles,
 * regardless of whether it succeeded or failed.
 */
export function createSerializer(): <T>(operation: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation, operation);
		tail = result.catch(() => undefined);
		return result;
	};
}
