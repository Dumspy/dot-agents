import type { WebToolsSettings } from "./types.ts";

// Fixed defaults. web-tools has no user-facing configuration.
export const WEB_TOOLS_SETTINGS: WebToolsSettings = {
	fetch: {
		defaultFormat: "markdown",
		timeoutSeconds: 30,
		maxResponseBytes: 5 * 1024 * 1024,
		blockPrivateHosts: true,
		maxRedirects: 5,
	},
};
