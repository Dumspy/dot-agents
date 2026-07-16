import { guestMountPath, isInsidePath, pathsOverlap } from "./paths.js";
import type { AccessMode, ExternalMount } from "./types.js";

export class MountRegistry {
	readonly #mounts = new Map<string, ExternalMount>();

	list(): ExternalMount[] {
		return [...this.#mounts.values()].map((mount) => ({ ...mount })).sort((left, right) => left.hostPath.localeCompare(right.hostPath));
	}

	findByHostPath(hostPath: string): ExternalMount | undefined {
		const mount = this.#mounts.get(hostPath);
		return mount ? { ...mount } : undefined;
	}

	findByGuestPath(guestPath: string): ExternalMount | undefined {
		const mount = [...this.#mounts.values()].find((candidate) => candidate.guestPath === guestPath);
		return mount ? { ...mount } : undefined;
	}

	findContaining(hostPath: string): ExternalMount | undefined {
		const candidates = [...this.#mounts.values()].filter((mount) => isInsidePath(mount.hostPath, hostPath));
		const mount = candidates.sort((left, right) => right.hostPath.length - left.hostPath.length)[0];
		return mount ? { ...mount } : undefined;
	}

	add(hostPath: string, mode: AccessMode): ExternalMount {
		const existing = this.findByHostPath(hostPath);
		if (existing) {
			if (existing.mode !== mode) throw new Error(`${hostPath} is already mounted ${existing.mode}; change it through /mounts`);
			return existing;
		}
		const containing = this.findContaining(hostPath);
		if (containing) return containing;
		const overlap = [...this.#mounts.values()].find((mount) => pathsOverlap(mount.hostPath, hostPath));
		if (overlap) throw new Error(`${hostPath} overlaps existing mount ${overlap.hostPath}; overlapping mounts are not supported`);
		const mount: ExternalMount = {
			hostPath,
			guestPath: guestMountPath(hostPath, [...this.#mounts.values()].map((candidate) => candidate.guestPath)),
			mode,
		};
		this.#mounts.set(hostPath, mount);
		return { ...mount };
	}

	setMode(hostPath: string, mode: AccessMode): ExternalMount {
		const mount = this.#mounts.get(hostPath);
		if (!mount) throw new Error(`${hostPath} is not mounted`);
		const updated = { ...mount, mode };
		this.#mounts.set(hostPath, updated);
		return { ...updated };
	}

	remove(hostPath: string): ExternalMount {
		const mount = this.#mounts.get(hostPath);
		if (!mount) throw new Error(`${hostPath} is not mounted`);
		this.#mounts.delete(hostPath);
		return { ...mount };
	}

	clear(): void {
		this.#mounts.clear();
	}
}
