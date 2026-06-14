import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const KEY_FILES = [
	"README.md",
	"AGENTS.md",
	"package.json",
	"flake.nix",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"Makefile",
	"justfile",
	".editorconfig",
	".gitignore",
];

async function buildFileTree(cwd: string): Promise<string> {
	const entries: string[] = [];

	async function walk(dir: string, prefix: string) {
		let items: string[];
		try {
			items = await readdir(dir);
		} catch {
			return;
		}

		for (let i = 0; i < items.length; i++) {
			const name = items[i];
			if (!name) continue;
			if (name.startsWith(".git") || name === "node_modules") continue;

			const path = join(dir, name);
			const isLast = i === items.length - 1;
			entries.push(`${prefix}${isLast ? "└── " : "├── "}${name}`);

			try {
				const s = await stat(path);
				if (s.isDirectory()) {
					await walk(path, `${prefix}${isLast ? "    " : "│   "}`);
				}
			} catch {
				// ignore
			}
		}
	}

	await walk(cwd, "");
	return entries.join("\n") || "(empty directory)";
}

export async function buildInitMessage(cwd: string): Promise<string> {
	const tree = await buildFileTree(cwd);

	const foundFiles = KEY_FILES.filter((f) => existsSync(join(cwd, f)));
	const suggested = foundFiles.length > 0
		? foundFiles.map((f) => `- ${f}`).join("\n")
		: "- (no common key files detected)";

	return `Explore this codebase and save important architecture and convention memories to the project SuperMemory container using the \`supermemory\` tool (mode: "add", scope: "project").

File tree:
\`\`\`
${tree}
\`\`\`

Key files detected:
${suggested}

Please:
1. Read the key files above.
2. Identify the tech stack, build system, conventions, and architecture.
3. Save concise memories with appropriate types (e.g., "architecture", "project-config", "learned-pattern").
`;
}
