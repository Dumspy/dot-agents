const DIVISOR = 3.5;

export const estimateTokens = (text: string | undefined): number => {
	if (!text) return 0;
	return Math.ceil(text.length / DIVISOR);
};

export const estimateTokensFromJson = (obj: unknown): number => {
	if (obj === null || obj === undefined) return 0;
	try {
		return estimateTokens(JSON.stringify(obj));
	} catch {
		return 0;
	}
};

export const formatTokens = (tokens: number): string => {
	if (tokens >= 1000_000) {
		return `${(tokens / 1000_000).toFixed(1)}M`;
	}
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}k`;
	}
	return `${tokens}`;
};

export const formatPercentage = (pct: number): string => {
	if (!Number.isFinite(pct) || pct < 0.1) {
		return "<0.1%";
	}
	return `${pct.toFixed(1)}%`;
};
