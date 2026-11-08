import { visibleWidth } from "@earendil-works/pi-tui";

const BAR_CHARS = {
	full: "█",
	empty: "░",
};

export const renderBar = (
	width: number,
	percentage: number,
	colorFn: (s: string) => string,
	bgColorFn?: (s: string) => string,
): string => {
	if (width <= 0) return "";
	const filled = Math.max(0, Math.min(1, percentage / 100));
	const filledChars = Math.round(filled * width);
	const emptyChars = Math.max(0, width - filledChars);
	const filledPart = colorFn(BAR_CHARS.full.repeat(filledChars));
	const emptyPart = (bgColorFn ?? ((s: string) => s))(BAR_CHARS.empty.repeat(emptyChars));
	return filledPart + emptyPart;
};

export const padRight = (text: string, width: number): string => {
	const vis = visibleWidth(text);
	if (vis >= width) return text;
	return text + " ".repeat(width - vis);
};
