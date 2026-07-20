import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MountRegistry } from "./mounts.js";
import {
	assertMountAllowed,
	isInsidePath,
	mountedHostPathToGuest,
	resolveMountTarget,
	workspaceHostPathToGuest,
} from "./paths.js";
import { GUEST_EXTERNAL_ROOT, GUEST_WORKSPACE, type AccessMode, type ExternalMount } from "./types.js";

export class ExternalAccessRequiredError extends Error {
	constructor(
		readonly hostPath: string,
		readonly mountRoot: string,
		readonly requestedMode: AccessMode,
		readonly fileRequest: boolean,
		readonly upgrade = false,
	) {
		super(`External ${requestedMode} access is required for ${hostPath}`);
		this.name = "ExternalAccessRequiredError";
	}
}

async function canonicalizePotentialPath(value: string): Promise<{ path: string; exists: boolean }> {
	try {
		return { path: await realpath(value), exists: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		let parent = path.dirname(value);
		const missing: string[] = [path.basename(value)];
		while (parent !== path.dirname(parent)) {
			try {
				const canonicalParent = await realpath(parent);
				return { path: path.join(canonicalParent, ...missing.reverse()), exists: false };
			} catch (parentError) {
				if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
				missing.push(path.basename(parent));
				parent = path.dirname(parent);
			}
		}
		throw error;
	}
}

function isGuestPath(value: string): boolean {
	const normalized = path.posix.resolve(value.replaceAll("\\", "/"));
	return (
		normalized === GUEST_WORKSPACE ||
		normalized.startsWith(`${GUEST_WORKSPACE}/`) ||
		normalized === GUEST_EXTERNAL_ROOT ||
		normalized.startsWith(`${GUEST_EXTERNAL_ROOT}/`)
	);
}

export class SandboxPolicy {
	readonly mounts = new MountRegistry();

	constructor(
		readonly workspace: string,
		readonly homeDir: string,
	) {}

	async prepareToolPath(input: string, requestedMode: AccessMode): Promise<string> {
		const raw = input.startsWith("@") ? input.slice(1).trim() : input.trim();
		if (!raw) return GUEST_WORKSPACE;
		if (path.posix.isAbsolute(raw) && isGuestPath(raw)) {
			const guestPath = path.posix.resolve(raw.replaceAll("\\", "/"));
			if (guestPath === GUEST_EXTERNAL_ROOT) return guestPath;
			if (guestPath.startsWith(`${GUEST_EXTERNAL_ROOT}/`)) {
				const mount = this.mounts.list().find((candidate) =>
					guestPath === candidate.guestPath || guestPath.startsWith(`${candidate.guestPath}/`),
				);
				if (!mount) throw new Error(`External guest path is not mounted: ${guestPath}`);
				if (requestedMode === "read-write" && mount.mode !== "read-write") {
					throw new Error(`${mount.hostPath} is mounted read-only; use /mounts to change its access mode`);
				}
			}
			return guestPath;
		}

		const hostInput = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.workspace, raw);
		const canonical = await canonicalizePotentialPath(hostInput);
		if (isInsidePath(this.workspace, canonical.path)) return workspaceHostPathToGuest(this.workspace, canonical.path);
		const existing = this.mounts.findContaining(canonical.path);
		if (existing) {
			if (requestedMode === "read-write" && existing.mode !== "read-write") {
				throw new ExternalAccessRequiredError(canonical.path, existing.hostPath, requestedMode, false, true);
			}
			return mountedHostPathToGuest(existing.hostPath, existing.guestPath, canonical.path);
		}
		if (!canonical.exists) {
			throw new Error(`External path does not exist: ${hostInput}. Mount an existing parent directory first.`);
		}
		const target = await resolveMountTarget(canonical.path, this.homeDir);
		assertMountAllowed(target.canonicalPath, this.workspace, this.homeDir);
		throw new ExternalAccessRequiredError(
			canonical.path,
			target.canonicalPath,
			requestedMode,
			target.isFileRequest,
		);
	}

	async addExplicitMount(input: string, mode: AccessMode): Promise<ExternalMount> {
		const target = await resolveMountTarget(input, this.homeDir);
		if (target.isFileRequest) throw new Error("/mount requires a directory path, not a file");
		assertMountAllowed(target.canonicalPath, this.workspace, this.homeDir);
		return this.mounts.add(target.canonicalPath, mode);
	}

	approveExternal(request: ExternalAccessRequiredError, mode: AccessMode): ExternalMount {
		assertMountAllowed(request.mountRoot, this.workspace, this.homeDir);
		return this.mounts.add(request.mountRoot, mode);
	}

	async validateMountStillExists(mount: ExternalMount): Promise<void> {
		const stats = await stat(mount.hostPath);
		if (!stats.isDirectory()) throw new Error(`External mount is no longer a directory: ${mount.hostPath}`);
	}
}
