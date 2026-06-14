export function stripPrivateContent(content: string): string {
	return content
		.replace(/<private>[\s\S]*?<\/private>/gi, "")
		.replace(/[ \t]+/g, " ")
		.trim();
}

export function isFullyPrivate(content: string): boolean {
	return stripPrivateContent(content) === "";
}
