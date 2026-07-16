import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isMatch } from "picomatch";
import { GUEST_EXTERNAL_ROOT, GUEST_WORKSPACE } from "./types.js";

export type MountTarget = {
	canonicalPath: string;
	isFileRequest: boolean;
};

const CREDENTIAL_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker"]);
const KEY_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const SYSTEM_MOUNT_ROOTS = ["/dev", "/proc", "/sys", "/run"];

export function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

export function isInsidePath(root: string, value: string): boolean {
	const relative = path.relative(root, value);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function pathsOverlap(left: string, right: string): boolean {
	return isInsidePath(left, right) || isInsidePath(right, left);
}

export function expandUserPath(value: string, homeDir: string): string {
	const trimmed = stripAtPrefix(value.trim());
	if (trimmed === "~") return homeDir;
	if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith("~/")) return path.join(homeDir, trimmed.slice(2));
	return trimmed;
}

export function resolveUserMountPath(value: string, homeDir: string): string {
	const expanded = expandUserPath(value, homeDir);
	if (!path.isAbsolute(expanded)) throw new Error("External mount paths must be absolute or start with ~/.");
	return path.resolve(expanded);
}

export async function resolveMountTarget(value: string, homeDir: string): Promise<MountTarget> {
	const resolved = resolveUserMountPath(value, homeDir);
	let canonical: string;
	try {
		canonical = await realpath(resolved);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`External path does not exist: ${resolved}. Mount an existing parent directory first.`);
		}
		throw error;
	}
	const stats = await lstat(canonical);
	if (stats.isDirectory()) return { canonicalPath: canonical, isFileRequest: false };
	if (stats.isFile()) return { canonicalPath: path.dirname(canonical), isFileRequest: true };
	throw new Error(`External path must be a regular file or directory: ${canonical}`);
}

export function assertMountAllowed(canonicalPath: string, workspace: string, homeDir: string): void {
	const normalized = path.resolve(canonicalPath);
	const prohibitedRoots = [path.parse(normalized).root, path.resolve(homeDir), ...SYSTEM_MOUNT_ROOTS.map((root) => path.resolve(root))];
	for (const prohibited of prohibitedRoots) {
		if (normalized === prohibited || (SYSTEM_MOUNT_ROOTS.includes(prohibited) && isInsidePath(prohibited, normalized))) {
			throw new Error(`Sandbox policy prohibits mounting ${normalized}`);
		}
	}
	if (pathsOverlap(normalized, path.resolve(workspace))) {
		throw new Error(`${normalized} overlaps the workspace and cannot be added as an external mount`);
	}
	if (isProtectedHostLocation(normalized, homeDir)) throw new Error(`Sandbox policy prohibits mounting credential path ${normalized}`);
}

export function isProtectedHostLocation(value: string, homeDir: string): boolean {
	const relative = path.relative(homeDir, value);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
	const segments = relative.split(path.sep).filter(Boolean);
	if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return true;
	return segments.length >= 2 && segments[0] === ".config" && segments[1]?.toLowerCase() === "1password";
}

export function isProtectedRelativePath(value: string, additionalPatterns: readonly string[] = []): boolean {
	const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
	const segments = normalized.split("/").filter(Boolean);
	const basename = segments.at(-1)?.toLowerCase() ?? "";
	if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment.toLowerCase()))) return true;
	if (segments.some((segment, index) => segment.toLowerCase() === ".config" && segments[index + 1]?.toLowerCase() === "1password")) {
		return true;
	}
	if (basename === ".env" || (basename.startsWith(".env.") && !ENV_TEMPLATES.has(basename))) return true;
	if (basename === ".envrc") return true;
	if (KEY_EXTENSIONS.has(path.posix.extname(basename))) return true;
	if (basename === "credentials" || basename === "credentials.json" || basename === "secrets.json") return true;
	return additionalPatterns.some((pattern) => isMatch(normalized, pattern, { dot: true }));
}

export function guestMountPath(canonicalPath: string, existingGuestPaths: Iterable<string> = []): string {
	const basename = path.basename(canonicalPath).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "mount";
	const used = new Set(existingGuestPaths);
	for (let length = 8; length <= 64; length += 4) {
		const digest = createHash("sha256").update(canonicalPath).digest("hex").slice(0, length);
		const candidate = path.posix.join(GUEST_EXTERNAL_ROOT, `${basename}-${digest}`);
		if (!used.has(candidate)) return candidate;
	}
	throw new Error(`Could not allocate a unique guest mount path for ${canonicalPath}`);
}

export function workspaceHostPathToGuest(workspace: string, hostPath: string): string {
	if (!isInsidePath(workspace, hostPath)) throw new Error(`${hostPath} is outside workspace ${workspace}`);
	const relative = path.relative(workspace, hostPath).split(path.sep).join(path.posix.sep);
	return relative ? path.posix.join(GUEST_WORKSPACE, relative) : GUEST_WORKSPACE;
}

export function mountedHostPathToGuest(mountHostPath: string, mountGuestPath: string, hostPath: string): string {
	if (!isInsidePath(mountHostPath, hostPath)) throw new Error(`${hostPath} is outside mount ${mountHostPath}`);
	const relative = path.relative(mountHostPath, hostPath).split(path.sep).join(path.posix.sep);
	return relative ? path.posix.join(mountGuestPath, relative) : mountGuestPath;
}
