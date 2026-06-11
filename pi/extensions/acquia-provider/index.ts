import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ACQUIA_API_KEY_ENV,
	ACQUIA_BASE_URL_ENV,
	ACQUIA_PROVIDER_LABEL,
	ACQUIA_PROVIDER_NAME,
	DEFAULT_ACQUIA_BASE_URL,
	fetchAcquiaProviderModels,
	normalizeBaseUrl,
} from "./lib.ts";

export default async function acquiaProvider(pi: ExtensionAPI) {
	const baseUrl = normalizeBaseUrl(process.env[ACQUIA_BASE_URL_ENV] || DEFAULT_ACQUIA_BASE_URL);
	const apiKey = process.env[ACQUIA_API_KEY_ENV];

	if (!apiKey) {
		console.warn(
			`[${ACQUIA_PROVIDER_NAME}-provider] skipping provider registration because ${ACQUIA_API_KEY_ENV} is not set`,
		);
		return;
	}

	try {
		const models = await fetchAcquiaProviderModels(baseUrl, apiKey);
		if (models.length === 0) {
			console.warn(
				`[${ACQUIA_PROVIDER_NAME}-provider] skipping provider registration because discovery returned no usable models`,
			);
			return;
		}

		pi.registerProvider(ACQUIA_PROVIDER_NAME, {
			name: ACQUIA_PROVIDER_LABEL,
			baseUrl,
			apiKey: ACQUIA_API_KEY_ENV,
			api: "openai-completions",
			models,
		});

		console.log(
			`[${ACQUIA_PROVIDER_NAME}-provider] registered ${models.length} models from ${baseUrl}`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${ACQUIA_PROVIDER_NAME}-provider] failed to discover models from ${baseUrl}: ${message}`);
	}
}
