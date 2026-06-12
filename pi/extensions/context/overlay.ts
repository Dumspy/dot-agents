import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	Key,
	SelectList,
	truncateToWidth,
	wrapTextWithAnsi,
	 type SelectItem,
	 type TUI,
} from "@earendil-works/pi-tui";
import type { ContextBreakdown, Screen, CategoryBreakdown, MessageInfo } from "./types.ts";
import { formatTokens, formatPercentage } from "./estimate.ts";
import { renderBar, padRight } from "./format.ts";

const MAX_BAR_WIDTH = 36;

export class ContextOverlay {
	private screen: Screen = "main";
	private selectedTool: string | null = null;
	private breakdown: ContextBreakdown;
	private theme: Theme;
	private tui: TUI;
	private done: () => void;

	// Navigation state
	private mainIndex = 0;

	// Drill-down state
	private selectedMessage: MessageInfo | null = null;

	// Cache
	private cachedLines?: string[];
	private cachedWidth?: number;
	private toolUsageList?: SelectList;
	private toolCallsList?: SelectList;
	private toolDefsList?: SelectList;
	private messagesList?: SelectList;
	private userMessagesList?: SelectList;
	private agentMessagesList?: SelectList;
	private messagePreviewLines?: string[];

	constructor(breakdown: ContextBreakdown, theme: Theme, tui: TUI, done: () => void) {
		this.breakdown = breakdown;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.screen === "main") {
				this.done();
			} else if (this.screen === "toolCalls") {
				this.screen = "toolUsage";
			} else if (this.screen === "messagePreview") {
				this.screen = this.selectedMessage?.role === "user" ? "userMessages" : "agentMessages";
			} else if (this.screen === "userMessages" || this.screen === "agentMessages") {
				this.screen = "messages";
			} else {
				this.screen = "main";
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (this.screen === "main") {
			this.handleMainInput(data);
		} else if (this.screen === "toolUsage" && this.toolUsageList) {
			this.toolUsageList.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
		} else if (this.screen === "toolCalls" && this.toolCallsList) {
			this.toolCallsList.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
		} else if (this.screen === "messages" && this.messagesList) {
			this.messagesList.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
		} else if (this.screen === "toolDefs" && this.toolDefsList) {
			this.toolDefsList.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
		} else if (this.screen === "userMessages" && this.userMessagesList) {
			this.userMessagesList.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
		} else if (this.screen === "agentMessages" && this.agentMessagesList) {
			this.agentMessagesList.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
		} else if (this.screen === "messagePreview") {
			// Preview screen is view-only; scroll with up/down
			if (matchesKey(data, Key.up)) {
				this.messagePreviewScroll = Math.max(0, this.messagePreviewScroll - 1);
				this.invalidate();
				this.tui.requestRender();
			} else if (matchesKey(data, Key.down)) {
				if (this.messagePreviewLines) {
					this.messagePreviewScroll = Math.max(0, Math.min(this.messagePreviewLines.length - 1, this.messagePreviewScroll + 1));
				}
				this.invalidate();
				this.tui.requestRender();
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const innerWidth = Math.max(1, width - 2);
		const content = this.buildContent(innerWidth);
		const th = this.theme;

		const lines: string[] = [];
		// Top border
		lines.push(th.fg("border", `┌${"─".repeat(innerWidth)}┐`));

		// Content rows with side borders
		for (const line of content) {
			const padded = padRight(truncateToWidth(line, innerWidth), innerWidth);
			lines.push(th.fg("border", "│") + padded + th.fg("border", "│"));
		}

		// Bottom border
		lines.push(th.fg("border", `└${"─".repeat(innerWidth)}┘`));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.toolUsageList?.invalidate();
		this.toolCallsList?.invalidate();
		this.messagesList?.invalidate();
		this.toolDefsList?.invalidate();
		this.userMessagesList?.invalidate();
		this.agentMessagesList?.invalidate();
	}

	private handleMainInput(data: string): void {
		const interactive = this.getInteractiveCategories();
		if (matchesKey(data, Key.up) && this.mainIndex > 0) {
			this.mainIndex--;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down) && this.mainIndex < interactive.length - 1) {
			this.mainIndex++;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.enter)) {
			const cat = interactive[this.mainIndex];
			if (cat?.id === "tooluse") {
				this.screen = "toolUsage";
				this.invalidate();
				this.tui.requestRender();
			} else if (cat?.id === "messages") {
				this.screen = "messages";
				this.invalidate();
				this.tui.requestRender();
			} else if (cat?.id === "tools") {
				this.screen = "toolDefs";
				this.invalidate();
				this.tui.requestRender();
			}
		}
	}

	private getInteractiveCategories(): CategoryBreakdown[] {
		return this.breakdown.categories.filter((c) => c.id !== "free");
	}

	private getSelectedTool() {
		return this.breakdown.toolUsage.find((t) => t.toolName === this.selectedTool);
	}

	private buildContent(width: number): string[] {
		const lines: string[] = [];

		if (this.screen === "main") {
			this.buildMainScreen(lines, width);
		} else if (this.screen === "toolUsage") {
			this.buildToolUsageScreen(lines, width);
		} else if (this.screen === "toolCalls") {
			this.buildToolCallsScreen(lines, width);
		} else if (this.screen === "messages") {
			this.buildMessagesScreen(lines, width);
		} else if (this.screen === "toolDefs") {
			this.buildToolDefsScreen(lines, width);
		} else if (this.screen === "userMessages") {
			this.buildUserMessagesScreen(lines, width);
		} else if (this.screen === "agentMessages") {
			this.buildAgentMessagesScreen(lines, width);
		} else if (this.screen === "messagePreview") {
			this.buildMessagePreviewScreen(lines, width);
		}

		return lines;
	}

	private buildMainScreen(lines: string[], width: number): void {
		const th = this.theme;
		const interactive = this.getInteractiveCategories();
		const freeCat = this.breakdown.categories.find((c) => c.id === "free");

		// Title
		lines.push(th.fg("accent", th.bold("Context Usage")));

		// Summary line
		const usage = `${formatTokens(this.breakdown.actualTokens)} / ${formatTokens(this.breakdown.contextWindow)}`;
		const usagePct = this.breakdown.contextWindow > 0
			? ((this.breakdown.actualTokens / this.breakdown.contextWindow) * 100).toFixed(1) + "%"
			: "0%";
		const summary = `${this.breakdown.modelName}  ${usage} (${usagePct})`;
		lines.push(th.fg("muted", summary));
		lines.push("");

		// Categories
		for (let i = 0; i < interactive.length; i++) {
			const cat = interactive[i]!;
			const isSelected = i === this.mainIndex;
			this.renderCategoryRow(lines, cat, isSelected, width);
		}

		// Free space
		if (freeCat) {
			lines.push("");
			const cat = freeCat as CategoryBreakdown;
			this.renderCategoryRow(lines, cat, false, width);
		}

		// Footer
		lines.push("");
		const est = formatTokens(this.breakdown.estimatedTokens);
		const act = formatTokens(this.breakdown.actualTokens);
		const help = `↑↓ navigate • enter drill-down • esc close    estimated ≈ ${est} / actual ${act}`;
		lines.push(th.fg("dim", help));
	}

	private renderCategoryRow(lines: string[], cat: CategoryBreakdown, isSelected: boolean, width: number): void {
		const th = this.theme;
		const barWidth = Math.min(MAX_BAR_WIDTH, Math.floor(width * 0.5));
		const labelWidth = Math.max(10, width - barWidth - 4);

		const cursor = isSelected ? th.fg("accent", "▶") : " ";
		const name = th.fg(cat.color, cat.name);
		const tokens = th.fg("muted", formatTokens(cat.tokens));
		const pct = th.fg("warning", formatPercentage(cat.percentage));

		const namePart = truncateToWidth(`${cursor} ${name}`, labelWidth);
		const rightPart = `${tokens} ${pct}`;
		const rightPadded = padRight(rightPart, barWidth + 2);

		const line = `${namePart} ${rightPadded}`;
		lines.push(truncateToWidth(line, width));

		// Bar
		const bar = renderBar(barWidth, cat.percentage, (s) => th.fg(cat.color, s), (s) => th.fg("dim", s));
		const barLine = `  ${bar}`;
		lines.push(truncateToWidth(barLine, width));
	}

	private buildToolUsageScreen(lines: string[], width: number): void {
		const th = this.theme;
		const totalTokens = this.breakdown.toolUsage.reduce((sum, t) => sum + t.totalTokens, 0);
		const totalCalls = this.breakdown.toolUsage.reduce((sum, t) => sum + t.totalCalls, 0);

		lines.push(th.fg("accent", th.bold("Tool Usage")));
		lines.push(th.fg("muted", `${formatTokens(totalTokens)} tokens across ${totalCalls} calls`));
		lines.push("");

		if (!this.toolUsageList) {
			const items: SelectItem[] = this.breakdown.toolUsage
				.map((tool) => {
					const pct = totalTokens > 0 ? ((tool.totalTokens / totalTokens) * 100).toFixed(0) + "%" : "0%";
					return {
						value: tool.toolName,
						label: tool.toolName,
						description: `${formatTokens(tool.totalTokens)}  ${pct}  ${tool.totalCalls} calls`,
					};
				})
				.sort((a, b) => {
					// Defensive: sort by totalTokens extracted from description
					const aTokens = this.breakdown.toolUsage.find((t) => t.toolName === a.value)?.totalTokens ?? 0;
					const bTokens = this.breakdown.toolUsage.find((t) => t.toolName === b.value)?.totalTokens ?? 0;
					return bTokens - aTokens;
				});

			if (items.length > 0) {
				this.toolUsageList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (t) => th.fg("accent", t),
					selectedText: (t) => th.fg("accent", t),
					description: (t) => th.fg("muted", t),
					scrollInfo: (t) => th.fg("dim", t),
					noMatch: (t) => th.fg("warning", t),
				});
				this.toolUsageList.onSelect = (item) => {
					this.selectedTool = item.value;
					this.toolCallsList = undefined;
					this.screen = "toolCalls";
					this.invalidate();
					this.tui.requestRender();
				};
				this.toolUsageList.onCancel = () => {
					this.screen = "main";
					this.invalidate();
					this.tui.requestRender();
				};
			}
		}

		if (this.toolUsageList) {
			// SelectList.render() returns string[]; append them directly
			lines.push(...this.toolUsageList.render(width));
		} else {
			lines.push(th.fg("muted", "No tool usage yet"));
		}

		lines.push("");
		lines.push(th.fg("dim", "↑↓ navigate • enter show calls • esc back"));
	}

	private buildToolCallsScreen(lines: string[], width: number): void {
		const th = this.theme;
		const tool = this.getSelectedTool();

		const title = tool ? `${tool.toolName}  ${tool.totalCalls} calls • ${formatTokens(tool.totalTokens)} tokens` : "Tool Calls";
		lines.push(th.fg("accent", th.bold(title)));
		lines.push("");

		if (!tool || tool.calls.length === 0) {
			lines.push(th.fg("muted", "No calls found"));
		} else {
			if (!this.toolCallsList) {
				const items: SelectItem[] = tool.calls.map((call, index) => ({
					value: call.toolCallId,
					label: `${index + 1}  [${call.args}]`,
					description: formatTokens(call.estimatedTokens),
				}));

				this.toolCallsList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (t) => th.fg("accent", t),
					selectedText: (t) => th.fg("accent", t),
					description: (t) => th.fg("warning", t),
					scrollInfo: (t) => th.fg("dim", t),
					noMatch: (t) => th.fg("warning", t),
				});
				this.toolCallsList.onSelect = () => {
					// No further drill-down for tool calls
				};
				this.toolCallsList.onCancel = () => {
					this.screen = "toolUsage";
					this.invalidate();
					this.tui.requestRender();
				};
			}

			if (this.toolCallsList) {
				lines.push(...this.toolCallsList.render(width));
			}
		}

		lines.push("");
		lines.push(th.fg("dim", "↑↓ navigate • esc back to tools"));
	}

	private buildMessagesScreen(lines: string[], width: number): void {
		const th = this.theme;
		const totalMessages = this.breakdown.messageBreakdown.userTokens + this.breakdown.messageBreakdown.agentTokens;

		lines.push(th.fg("accent", th.bold("Messages")));
		lines.push(th.fg("muted", `${formatTokens(totalMessages)} tokens total`));
		lines.push("");

		if (!this.messagesList) {
			const items: SelectItem[] = [
				{
					value: "user",
					label: "User",
					description: `${formatTokens(this.breakdown.messageBreakdown.userTokens)}  ${formatPercentage(totalMessages > 0 ? (this.breakdown.messageBreakdown.userTokens / totalMessages) * 100 : 0)}`,
				},
				{
					value: "agent",
					label: "Agent",
					description: `${formatTokens(this.breakdown.messageBreakdown.agentTokens)}  ${formatPercentage(totalMessages > 0 ? (this.breakdown.messageBreakdown.agentTokens / totalMessages) * 100 : 0)}`,
				},
			];

			this.messagesList = new SelectList(items, items.length, {
				selectedPrefix: (t) => th.fg("accent", t),
				selectedText: (t) => th.fg("accent", t),
				description: (t) => th.fg("muted", t),
				scrollInfo: (t) => th.fg("dim", t),
				noMatch: (t) => th.fg("warning", t),
			});
			this.messagesList.onSelect = (item) => {
				this.screen = item.value === "user" ? "userMessages" : "agentMessages";
				this.invalidate();
				this.tui.requestRender();
			};
			this.messagesList.onCancel = () => {
				this.screen = "main";
				this.invalidate();
				this.tui.requestRender();
			};
		}

		if (this.messagesList) {
			lines.push(...this.messagesList.render(width));
		}

		lines.push("");
		lines.push(th.fg("dim", "↑↓ navigate • enter drill-down • esc back to overview"));
	}

	private buildUserMessagesScreen(lines: string[], width: number): void {
		this.buildMessageListScreen(lines, width, "user", "User Messages", this.breakdown.messageBreakdown.userTokens);
	}

	private buildAgentMessagesScreen(lines: string[], width: number): void {
		this.buildMessageListScreen(lines, width, "agent", "Agent Messages", this.breakdown.messageBreakdown.agentTokens);
	}

	private buildMessageListScreen(lines: string[], width: number, role: "user" | "agent", title: string, totalTokens: number): void {
		const th = this.theme;
		const roleMessages = this.breakdown.messages.filter((m) => m.role === role);

		lines.push(th.fg("accent", th.bold(title)));
		lines.push(th.fg("muted", `${formatTokens(totalTokens)} tokens • ${roleMessages.length} messages`));
		lines.push("");

		const list = role === "user" ? this.userMessagesList : this.agentMessagesList;
		if (!list) {
			const items: SelectItem[] = roleMessages.map((msg, index) => {
				const pct = totalTokens > 0 ? ((msg.tokens / totalTokens) * 100).toFixed(1) + "%" : "0%";
				const preview = msg.preview.replace(/\s+/g, " ").trim();
				return {
					value: msg.entryId,
					label: `${index + 1}  ${truncateToWidth(preview, Math.max(10, width - 30))}`,
					description: `${formatTokens(msg.tokens)}  ${pct}`,
				};
			});

			const newList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => th.fg("accent", t),
				selectedText: (t) => th.fg("accent", t),
				description: (t) => th.fg("muted", t),
				scrollInfo: (t) => th.fg("dim", t),
				noMatch: (t) => th.fg("warning", t),
			});
			newList.onSelect = (item) => {
				const msg = this.breakdown.messages.find((m) => m.entryId === item.value);
				if (msg) {
					this.selectedMessage = msg;
					this.messagePreviewLines = undefined;
					this.messagePreviewScroll = 0;
					this.screen = "messagePreview";
					this.invalidate();
					this.tui.requestRender();
				}
			};
			newList.onCancel = () => {
				this.screen = "messages";
				this.invalidate();
				this.tui.requestRender();
			};
			if (role === "user") {
				this.userMessagesList = newList;
			} else {
				this.agentMessagesList = newList;
			}
		}

		const activeList = role === "user" ? this.userMessagesList : this.agentMessagesList;
		if (activeList) {
			lines.push(...activeList.render(width));
		} else {
			lines.push(th.fg("muted", "No messages"));
		}

		lines.push("");
		lines.push(th.fg("dim", "↑↓ navigate • enter preview • esc back"));
	}

	private messagePreviewScroll = 0;

	private buildMessagePreviewScreen(lines: string[], width: number): void {
		const th = this.theme;
		const msg = this.selectedMessage;
		if (!msg) {
			lines.push(th.fg("warning", "No message selected"));
			return;
		}

		lines.push(th.fg("accent", th.bold(`${msg.role === "user" ? "User" : "Agent"} Message`)));
		lines.push(th.fg("muted", `${formatTokens(msg.tokens)} tokens • entry ${msg.entryId}`));
		lines.push("");

		if (!this.messagePreviewLines) {
			const preview = msg.preview || "(empty message)";
			this.messagePreviewLines = wrapTextWithAnsi(preview, width);
		}

		const previewLines = this.messagePreviewLines;
		const visibleLines = previewLines.slice(this.messagePreviewScroll, this.messagePreviewScroll + 15);
		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, width));
		}

		if (previewLines.length > 15) {
			lines.push("");
			lines.push(th.fg("dim", `${this.messagePreviewScroll + 1}-${Math.min(this.messagePreviewScroll + 15, previewLines.length)} / ${previewLines.length}`));
		}

		lines.push("");
		lines.push(th.fg("dim", "↑↓ scroll • esc back to list"));
	}

	private buildToolDefsScreen(lines: string[], width: number): void {
		const th = this.theme;
		const totalTokens = this.breakdown.toolDefinitions.reduce((sum, t) => sum + t.schemaTokens, 0);

		lines.push(th.fg("accent", th.bold("Tool Definitions")));
		lines.push(th.fg("muted", `${formatTokens(totalTokens)} tokens • schema cost per tool`));
		lines.push("");

		if (!this.toolDefsList) {
			const items: SelectItem[] = this.breakdown.toolDefinitions
				.map((tool) => {
					const pct = totalTokens > 0 ? ((tool.schemaTokens / totalTokens) * 100).toFixed(0) + "%" : "0%";
					return {
						value: tool.toolName,
						label: tool.toolName,
						description: `${formatTokens(tool.schemaTokens)}  ${pct}`,
					};
				})
				.sort((a, b) => {
					// Defensive: sort by schemaTokens
					const aTokens = this.breakdown.toolDefinitions.find((t) => t.toolName === a.value)?.schemaTokens ?? 0;
					const bTokens = this.breakdown.toolDefinitions.find((t) => t.toolName === b.value)?.schemaTokens ?? 0;
					return bTokens - aTokens;
				});

			if (items.length > 0) {
				this.toolDefsList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (t) => th.fg("accent", t),
					selectedText: (t) => th.fg("accent", t),
					description: (t) => th.fg("muted", t),
					scrollInfo: (t) => th.fg("dim", t),
					noMatch: (t) => th.fg("warning", t),
				});
				this.toolDefsList.onSelect = () => {
					// No drill-down for tool defs
				};
				this.toolDefsList.onCancel = () => {
					this.screen = "main";
					this.invalidate();
					this.tui.requestRender();
				};
			}
		}

		if (this.toolDefsList) {
			lines.push(...this.toolDefsList.render(width));
		} else {
			lines.push(th.fg("muted", "No tool definitions"));
		}

		lines.push("");
		lines.push(th.fg("dim", "↑↓ navigate • esc back to overview"));
	}
}
