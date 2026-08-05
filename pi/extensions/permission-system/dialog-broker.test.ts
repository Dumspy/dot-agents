import { describe, expect, it } from "vitest";
import {
	COMPANION_DIALOG_REQUEST_EVENT,
	COMPANION_DIALOG_RESOLVED_EVENT,
	CompanionDialogBroker,
	type CompanionDialogRequest,
} from "./dialog-broker.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("CompanionDialogBroker", () => {
	it("returns the remote select response and dismisses the terminal fallback", async () => {
		const events: Array<{ channel: string; data: unknown }> = [];
		const terminal = deferred<string | undefined>();
		let terminalSignal: AbortSignal | undefined;
		const broker = new CompanionDialogBroker({
			emit(channel, data) {
				events.push({ channel, data });
			},
		});

		const result = broker.select(
			{
				select: async (_title, _options, opts) => {
					terminalSignal = opts?.signal;
					return terminal.promise;
				},
				input: async () => undefined,
			},
			"Allow this action?",
			["Yes", "No", "Explain"],
		);

		const request = events[0]?.data as CompanionDialogRequest;
		expect(events[0]?.channel).toBe(COMPANION_DIALOG_REQUEST_EVENT);
		expect(request.options).toEqual([
			{ label: "Yes", value: "Yes" },
			{ label: "No", value: "No" },
			{ label: "Explain", value: "Explain" },
		]);
		expect(request.respond("Yes")).toBe(true);
		expect(request.respond("No")).toBe(false);
		expect(await result).toBe("Yes");
		expect(terminalSignal?.aborted).toBe(true);
		expect(events.at(-1)).toEqual({
			channel: COMPANION_DIALOG_RESOLVED_EVENT,
			data: { id: request.id },
		});
	});

	it("rejects a remote response after the terminal has already won", async () => {
		let request: CompanionDialogRequest | undefined;
		const broker = new CompanionDialogBroker({
			emit(channel, data) {
				if (channel === COMPANION_DIALOG_REQUEST_EVENT) request = data as CompanionDialogRequest;
			},
		});

		const result = broker.select(
			{
				select: async () => "No",
				input: async () => undefined,
			},
			"Allow?",
			["Yes", "No"],
		);

		expect(await result).toBe("No");
		expect(request?.respond("Yes")).toBe(false);
	});

	it("keeps invalid remote values from deciding a selection", async () => {
		let request: CompanionDialogRequest | undefined;
		const broker = new CompanionDialogBroker({
			emit(channel, data) {
				if (channel === COMPANION_DIALOG_REQUEST_EVENT) request = data as CompanionDialogRequest;
			},
		});

		const result = broker.select(
			{
				select: async () => "No",
				input: async () => undefined,
			},
			"Allow?",
			["Yes", "No"],
		);

		expect(request?.respond("Explain")).toBe(false);
		expect(await result).toBe("No");
	});

	it("preserves empty remote input and exact placeholder metadata", async () => {
		const terminal = deferred<string | undefined>();
		let request: CompanionDialogRequest | undefined;
		const broker = new CompanionDialogBroker({
			emit(channel, data) {
				if (channel === COMPANION_DIALOG_REQUEST_EVENT) request = data as CompanionDialogRequest;
			},
		});

		const result = broker.input(
			{
				select: async () => undefined,
				input: async () => terminal.promise,
			},
			"What should I do instead?",
			"Leave empty to just block",
		);

		expect(request).toMatchObject({
			kind: "input",
			title: "What should I do instead?",
			placeholder: "Leave empty to just block",
		});
		expect(request?.respond(12)).toBe(false);
		expect(request?.respond("")).toBe(true);
		expect(await result).toBe("");
	});

	it("uses the terminal response when no remote surface responds", async () => {
		const channels: string[] = [];
		const broker = new CompanionDialogBroker({
			emit(channel) {
				channels.push(channel);
			},
		});

		const result = await broker.input(
			{
				select: async () => undefined,
				input: async () => "Use another path",
			},
			"Alternative",
		);

		expect(result).toBe("Use another path");
		expect(channels).toEqual([
			COMPANION_DIALOG_REQUEST_EVENT,
			COMPANION_DIALOG_RESOLVED_EVENT,
		]);
	});
});
