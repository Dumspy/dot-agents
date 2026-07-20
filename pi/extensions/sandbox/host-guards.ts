import path from "node:path";
import { canonicalizePotentialPathSync, isInsidePath, isProtectedHostLocation, isProtectedRelativePath } from "./paths.js";

export type HostPathOperation = "read" | "write";

export function assertHostPathAllowed(options: {
	value: string;
	workspace: string;
	homeDir: string;
	operation: HostPathOperation;
	additionalProtectedPaths?: readonly string[];
}): void {
	const absolute = canonicalizePotentialPathSync(path.resolve(options.workspace, options.value));
	if (isProtectedHostLocation(absolute, options.homeDir)) throw new Error(`Host-mode policy denies credential path ${absolute}`);
	const relative = isInsidePath(options.workspace, absolute) ? path.relative(options.workspace, absolute) : path.basename(absolute);
	if (isProtectedRelativePath(relative, options.additionalProtectedPaths)) throw new Error(`Host-mode policy denies protected path ${absolute}`);
	if (options.operation === "write" && isInsidePath(path.join(options.workspace, ".git"), absolute)) {
		throw new Error(`Host-mode policy denies writes to Git internals: ${absolute}`);
	}
}

const SUDO_COMMAND = /(?:^|[;&|()\n])\s*(?:(?:env|command|exec)\s+)?sudo(?:\s|$)/i;
const POWER_COMMAND = /(?:^|[;&|()\n])\s*(?:shutdown|reboot|poweroff|halt)(?:\s|$)/i;
const FORMAT_COMMAND = /(?:^|[;&|()\n])\s*(?:mkfs(?:\.[a-z0-9]+)?|mkswap|fdisk|parted)(?:\s|$)/i;
const BLOCK_DEVICE_WRITE = /(?:^|[;&|]\s*)(?:dd\b[^\n;&|]*\bof=\/dev\/(?:sd|vd|xvd|nvme|mmcblk)|[^\n;&|]*>\s*\/dev\/(?:sd|vd|xvd|nvme|mmcblk))/i;
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

function escapedForRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCatastrophicDelete(command: string, homeDir: string): boolean {
	const normalized = command.replace(/\s+/g, " ").trim();
	if (!/(^|[;&|] )rm\s+[^;&|]*(?:-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b/i.test(normalized)) return false;
	if (/\brm\s+[^;&|]*(?:--\s+)?\/(?:\s|$|\*)/i.test(normalized)) return true;
	if (/\brm\s+[^;&|]*(?:~|\$HOME)(?:\s|$|\/\*)/i.test(normalized)) return true;
	return new RegExp(`\\brm\\s+[^;&|]*(?:--\\s+)?${escapedForRegex(homeDir)}(?:\\s|$|/\\*)`, "i").test(normalized);
}

/** Return a user-facing reason when an agent bash command hits a host-mode hard stop. */
export function hostCommandDenial(command: string, homeDir: string): string | undefined {
	if (SUDO_COMMAND.test(command)) return "Host-mode policy broadly denies sudo for agent commands";
	if (POWER_COMMAND.test(command)) return "Host-mode policy denies host power commands";
	if (FORMAT_COMMAND.test(command)) return "Host-mode policy denies disk formatting and partitioning commands";
	if (BLOCK_DEVICE_WRITE.test(command)) return "Host-mode policy denies raw writes to block devices";
	if (FORK_BOMB.test(command)) return "Host-mode policy denies fork bombs";
	if (hasCatastrophicDelete(command, homeDir)) return "Host-mode policy denies catastrophic recursive deletion";
	return undefined;
}
