import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	matchesKey,
	Key,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	 type SelectItem,
	 type TUI,
} from "@earendil-works/pi-tui";
import type { ContextBreakdown, Screen, CategoryBreakdown } from "./types.ts";
import { formatTokens, formatPercentage } from "./estimate.ts";
import { renderBar, padRight } from "./format.ts";

const MAX_BAR_WIDTH = 40;
const MAX_DISPLAYED_CALLS = 15;

interface CallRow {
	num: string;
	args: string;
	tokens: number;
}

export class ContextOverlay {
	private screen: Screen = "main";
	private selectedTool: string | null = null;
	private breakdown: ContextBreakdown;
	private theme: Theme;
	private tui: TUI;
	private done: () => void;

	// Navigation state
	private mainIndex = 0;
	private callsIndex = 0;

	// Cache
	private cachedLines?: string[];
	private cachedWidth?: number;
	private toolUsageList?: SelectList;
	private toolDefsList?: SelectList;

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
			} else {
				this.screen = this.screen === "toolCalls" ? "toolUsage" : "main";
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (this.screen === "main") {
			this.handleMainInput(data);
		} else if (this.screen === "toolUsage" && this.toolUsageList) {
			this.toolUsageList.handleInput(data);
			this.tui.requestRender();
		} else if (this.screen === "toolCalls") {
			this.handleCallsInput(data);
		} else if (this.screen === "toolDefs" && this.toolDefsList) {
			this.toolDefsList.handleInput(data);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		this.cachedLines = this.buildLines(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.toolUsageList?.invalidate();
		this.toolDefsList?.invalidate();
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
			} else if (cat?.id === "tools") {
				this.screen = "toolDefs";
				this.invalidate();
				this.tui.requestRender();
			}
		}
	}

	private handleCallsInput(data: string): void {
		const calls = this.getSelectedToolCalls();
		if (calls.length === 0) return;
		if (matchesKey(data, Key.up) && this.callsIndex > 0) {
			this.callsIndex--;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down) && this.callsIndex < calls.length - 1) {
			this.callsIndex++;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	private getInteractiveCategories(): CategoryBreakdown[] {
		return this.breakdown.categories.filter((c) => c.id !== "free");
	}

	private getSelectedToolCalls(): CallRow[] {
		const tool = this.breakdown.toolUsage.find((t) => t.toolName === this.selectedTool);
		if (!tool) return [];

		const result: CallRow[] = [];
		const displayed = Math.min(tool.calls.length, MAX_DISPLAYED_CALLS - 1);
		for (let i = 0; i < displayed; i++) {
			result.push({
				num: `${i + 1}`,
				args: tool.calls[i]!.args,
				tokens: tool.calls[i]!.estimatedTokens,
			});
		}
		if (tool.calls.length > MAX_DISPLAYED_CALLS - 1) {
			const remaining = tool.calls.length - (MAX_DISPLAYED_CALLS - 1);
			const remainingTokens = tool.calls.slice(MAX_DISPLAYED_CALLS - 1).reduce((sum, c) => sum + c.estimatedTokens, 0);
			result.push({
				num: "…",
				args: `${remaining} more calls`,
				tokens: remainingTokens,
			});
		}
		return result;
	}

	private buildLines(width: number): string[] {
		const container = new Container();
		const th = this.theme;

		// Top border
		container.addChild(new DynamicBorder((s: string) => th.fg("border", s)));

		if (this.screen === "main") {
			this.buildMainScreen(container, width);
		} else if (this.screen === "toolUsage") {
			this.buildToolUsageScreen(container, width);
		} else if (this.screen === "toolCalls") {
			this.buildToolCallsScreen(container, width);
		} else if (this.screen === "toolDefs") {
			this.buildToolDefsScreen(container, width);
		}

		// Bottom border
		container.addChild(new DynamicBorder((s: string) => th.fg("border", s)));

		return container.render(width);
	}

	private buildMainScreen(container: Container, width: number): void {
		const th = this.theme;
		const interactive = this.getInteractiveCategories();
		const freeCat = this.breakdown.categories.find((c) => c.id === "free");

		// Title
		container.addChild(new Text(th.fg("accent", th.bold("Context Usage")), 1, 0));

		// Summary line
		const usage = `${formatTokens(this.breakdown.actualTokens)} / ${formatTokens(this.breakdown.contextWindow)}`;
		const usagePct = this.breakdown.contextWindow > 0
			? ((this.breakdown.actualTokens / this.breakdown.contextWindow) * 100).toFixed(1) + "%"
			: "0%";
		const summary = `${this.breakdown.modelName}  ${usage} (${usagePct})`;
		container.addChild(new Text(th.fg("muted", summary), 1, 0));
		container.addChild(new Spacer(1));

		// Categories
		for (let i = 0; i < interactive.length; i++) {
			const cat = interactive[i];
			const isSelected = i === this.mainIndex;
			this.renderCategoryRow(container, cat, isSelected, width);
		}

		// Free space
		if (freeCat) {
			container.addChild(new Spacer(1));
			this.renderCategoryRow(container, freeCat, false, width);
		}

		// Footer
		container.addChild(new Spacer(1));
		const est = formatTokens(this.breakdown.estimatedTokens);
		const act = formatTokens(this.breakdown.actualTokens);
		const help = `↑↓ navigate • enter drill-down • esc close    estimated ≈ ${est} / actual ${act}`;
		container.addChild(new Text(th.fg("dim", help), 1, 0));
	}

	private renderCategoryRow(container: Container, cat: CategoryBreakdown, isSelected: boolean, width: number): void {
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
		container.addChild(new Text(truncateToWidth(line, width), 0, 0));

		// Bar
		const bar = renderBar(barWidth, cat.percentage, (s) => th.fg(cat.color, s), (s) => th.fg("dim", s));
		const barLine = `  ${bar}`;
		container.addChild(new Text(truncateToWidth(barLine, width), 0, 0));
	}

	private buildToolUsageScreen(container: Container, width: number): void {
		const th = this.theme;
		const totalTokens = this.breakdown.toolUsage.reduce((sum, t) => sum + t.totalTokens, 0);
		const totalCalls = this.breakdown.toolUsage.reduce((sum, t) => sum + t.totalCalls, 0);

		container.addChild(new Text(th.fg("accent", th.bold("Tool Usage")), 1, 0));
		container.addChild(new Text(th.fg("muted", `${formatTokens(totalTokens)} tokens across ${totalCalls} calls`), 1, 0));
		container.addChild(new Spacer(1));

		if (!this.toolUsageList) {
			const items: SelectItem[] = this.breakdown.toolUsage.map((tool) => {
				const pct = totalTokens > 0 ? ((tool.totalTokens / totalTokens) * 100).toFixed(0) + "%" : "0%";
				return {
					value: tool.toolName,
					label: tool.toolName,
					description: `${formatTokens(tool.totalTokens)}  ${pct}  ${tool.totalCalls} calls`,
				};
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
					this.callsIndex = 0;
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
			container.addChild(this.toolUsageList);
		} else {
			container.addChild(new Text(th.fg("muted", "No tool usage yet"), 1, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(th.fg("dim", "↑↓ navigate • enter show calls • esc back"), 1, 0));
	}

	private buildToolCallsScreen(container: Container, width: number): void {
		const th = this.theme;
		const tool = this.breakdown.toolUsage.find((t) => t.toolName === this.selectedTool);
		const calls = this.getSelectedToolCalls();

		const title = tool ? `${tool.toolName}  ${tool.totalCalls} calls • ${formatTokens(tool.totalTokens)} tokens` : "Tool Calls";
		container.addChild(new Text(th.fg("accent", th.bold(title)), 1, 0));
		container.addChild(new Spacer(1));

		if (calls.length === 0) {
			container.addChild(new Text(th.fg("muted", "No calls found"), 1, 0));
		} else {
			for (let i = 0; i < calls.length; i++) {
				const call = calls[i];
				const isSelected = i === this.callsIndex;
				const num = isSelected ? th.fg("accent", "▶") : th.fg("dim", call.num);
				const args = th.fg(isSelected ? "text" : "muted", truncateToWidth(`[${call.args}]`, Math.floor(width * 0.6)));
				const tokens = th.fg("warning", formatTokens(call.tokens));
				const line = `${num}  ${args}  ${tokens}`;
				container.addChild(new Text(truncateToWidth(line, width), 0, 0));
			}
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(th.fg("dim", "↑↓ navigate • esc back to tools"), 1, 0));
	}

	private buildToolDefsScreen(container: Container, width: number): void {
		const th = this.theme;
		const totalTokens = this.breakdown.toolDefinitions.reduce((sum, t) => sum + t.schemaTokens, 0);

		container.addChild(new Text(th.fg("accent", th.bold("Tool Definitions")), 1, 0));
		container.addChild(new Text(th.fg("muted", `${formatTokens(totalTokens)} tokens • schema cost per tool`), 1, 0));
		container.addChild(new Spacer(1));

		if (!this.toolDefsList) {
			const items: SelectItem[] = this.breakdown.toolDefinitions.map((tool) => {
				const pct = totalTokens > 0 ? ((tool.schemaTokens / totalTokens) * 100).toFixed(0) + "%" : "0%";
				return {
					value: tool.toolName,
					label: tool.toolName,
					description: `${formatTokens(tool.schemaTokens)}  ${pct}`,
				};
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
			container.addChild(this.toolDefsList);
		} else {
			container.addChild(new Text(th.fg("muted", "No tool definitions"), 1, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(th.fg("dim", "↑↓ navigate • esc back to overview"), 1, 0));
	}
}
