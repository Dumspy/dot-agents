import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

function sha16(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function getGitEmail(): string | null {
	try {
		const email = execSync("git config user.email", { encoding: "utf-8" }).trim();
		return email || null;
	} catch {
		return null;
	}
}

function getUserTag(): string {
	const email = getGitEmail();
	if (email) {
		return `pi_user_${sha16(email)}`;
	}
	const fallback = process.env.USER || process.env.USERNAME || "anonymous";
	return `pi_user_${sha16(fallback)}`;
}

function getProjectTag(cwd: string): string {
	return `pi_project_${sha16(cwd)}`;
}

export function getTags(cwd: string): { user: string; project: string } {
	return {
		user: getUserTag(),
		project: getProjectTag(cwd),
	};
}
