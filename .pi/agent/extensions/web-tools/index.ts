import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool } from "./webfetch.ts";

export default function webToolsExtension(pi: ExtensionAPI) {
	pi.registerTool(createWebFetchTool());
}
