import { randomUUID } from "node:crypto";

export const COMPANION_DIALOG_REQUEST_EVENT = "companion:dialog:request";
export const COMPANION_DIALOG_RESOLVED_EVENT = "companion:dialog:resolved";

export type CompanionDialogValue = string | boolean;

export interface CompanionDialogOption {
	label: string;
	value: CompanionDialogValue;
}

export interface CompanionDialogRequest {
	id: string;
	kind: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: CompanionDialogOption[];
	prefill?: string;
	placeholder?: string;
	/** Returns true only for the first valid response. */
	respond(value: unknown): boolean;
}

export interface CompanionDialogResolved {
	id: string;
}

interface DialogEventBus {
	emit(channel: string, data: unknown): void;
}

interface DialogUi {
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

/**
 * Publishes permission prompts for cooperating extensions while retaining Pi's
 * terminal dialog as the authoritative fallback. The first valid terminal or
 * remote response wins and the other surface is dismissed.
 */
export class CompanionDialogBroker {
	constructor(private readonly events: DialogEventBus) {}

	select(ui: DialogUi, title: string, options: string[]): Promise<string | undefined> {
		const allowed = new Set(options);
		return this.race(
			{
				kind: "select",
				title,
				options: options.map((option) => ({ label: option, value: option })),
			},
			(value): value is string => typeof value === "string" && allowed.has(value),
			(signal) => ui.select(title, options, { signal }),
		);
	}

	input(ui: DialogUi, title: string, placeholder?: string): Promise<string | undefined> {
		return this.race(
			{
				kind: "input",
				title,
				...(placeholder === undefined ? {} : { placeholder }),
			},
			(value): value is string => typeof value === "string",
			(signal) => ui.input(title, placeholder, { signal }),
		);
	}

	private race<T extends CompanionDialogValue>(
		request: Omit<CompanionDialogRequest, "id" | "respond">,
		isValidRemoteValue: (value: unknown) => value is T,
		showTerminal: (signal: AbortSignal) => Promise<T | undefined>,
	): Promise<T | undefined> {
		const id = randomUUID();
		const terminalController = new AbortController();
		let settled = false;

		return new Promise<T | undefined>((resolve) => {
			const settle = (value: T | undefined): boolean => {
				if (settled) return false;
				settled = true;
				resolve(value);
				return true;
			};

			const event: CompanionDialogRequest = {
				id,
				...request,
				respond: (value: unknown) => {
					if (!isValidRemoteValue(value) || !settle(value)) return false;
					terminalController.abort();
					return true;
				},
			};

			this.events.emit(COMPANION_DIALOG_REQUEST_EVENT, event);
			void showTerminal(terminalController.signal).then(
				(value) => settle(value),
				() => settle(undefined),
			);
		}).finally(() => {
			terminalController.abort();
			this.events.emit(COMPANION_DIALOG_RESOLVED_EVENT, { id } satisfies CompanionDialogResolved);
		});
	}
}
