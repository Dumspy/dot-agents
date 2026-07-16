import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import {
	createVirtualDirStats,
	ERRNO,
	formatVirtualEntries,
	normalizeVfsPath,
	VirtualProviderClass,
	type VfsStatfs,
	type VirtualFileHandle,
	type VirtualProvider,
} from "@earendil-works/gondolin";

function fsError(code: keyof typeof ERRNO, syscall: string, entryPath: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: ${syscall} ${entryPath}`) as NodeJS.ErrnoException;
	error.code = code;
	error.errno = ERRNO[code];
	error.syscall = syscall;
	error.path = entryPath;
	return error;
}

function withFileTypes(options?: object): boolean {
	return Boolean((options as { withFileTypes?: boolean } | undefined)?.withFileTypes);
}

type Route = { provider: VirtualProvider; providerPath: string; mountPath: string };

class RevocableFileHandle implements VirtualFileHandle {
	constructor(
		private readonly inner: VirtualFileHandle,
		private readonly active: () => boolean,
		private readonly entryPath: string,
	) {}

	get path(): string | undefined {
		return this.inner.path;
	}
	get flags(): string | undefined {
		return this.inner.flags;
	}
	get mode(): number | undefined {
		return this.inner.mode;
	}
	get position(): number | undefined {
		return this.inner.position;
	}
	get closed(): boolean | undefined {
		return this.inner.closed;
	}

	#assertActive(): void {
		if (!this.active()) throw fsError("EACCES", "stale mount handle", this.entryPath);
	}

	read(buffer: Buffer, offset: number, length: number, position?: number | null) {
		this.#assertActive();
		return this.inner.read(buffer, offset, length, position);
	}
	readSync(buffer: Buffer, offset: number, length: number, position?: number | null): number {
		this.#assertActive();
		return this.inner.readSync(buffer, offset, length, position);
	}
	write(buffer: Buffer, offset: number, length: number, position?: number | null) {
		this.#assertActive();
		return this.inner.write(buffer, offset, length, position);
	}
	writeSync(buffer: Buffer, offset: number, length: number, position?: number | null): number {
		this.#assertActive();
		return this.inner.writeSync(buffer, offset, length, position);
	}
	readFile(options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<Buffer | string> {
		this.#assertActive();
		return this.inner.readFile(options);
	}
	readFileSync(options?: { encoding?: BufferEncoding } | BufferEncoding): Buffer | string {
		this.#assertActive();
		return this.inner.readFileSync(options);
	}
	writeFile(data: Buffer | string, options?: { encoding?: BufferEncoding }): Promise<void> {
		this.#assertActive();
		return this.inner.writeFile(data, options);
	}
	writeFileSync(data: Buffer | string, options?: { encoding?: BufferEncoding }): void {
		this.#assertActive();
		this.inner.writeFileSync(data, options);
	}
	stat(options?: object): Promise<Stats> {
		this.#assertActive();
		return this.inner.stat(options);
	}
	statSync(options?: object): Stats {
		this.#assertActive();
		return this.inner.statSync(options);
	}
	truncate(length?: number): Promise<void> {
		this.#assertActive();
		return this.inner.truncate(length);
	}
	truncateSync(length?: number): void {
		this.#assertActive();
		this.inner.truncateSync(length);
	}
	close(): Promise<void> {
		return this.inner.close();
	}
	closeSync(): void {
		this.inner.closeSync();
	}
}

/**
 * Mutable VFS namespace used for runtime-approved external mounts.
 * Existing file handles remain valid, while every subsequent path lookup uses
 * the current routing table.
 */
export class DynamicMountProvider extends VirtualProviderClass implements VirtualProvider {
	readonly #mounts = new Map<string, VirtualProvider>();

	get readonly(): boolean {
		return false;
	}

	get supportsSymlinks(): boolean {
		return [...this.#mounts.values()].every((provider) => provider.supportsSymlinks);
	}

	get supportsWatch(): boolean {
		return [...this.#mounts.values()].every((provider) => provider.supportsWatch);
	}

	listMountPaths(): string[] {
		return [...this.#mounts.keys()].sort();
	}

	setMount(mountPath: string, provider: VirtualProvider): void {
		const normalized = normalizeVfsPath(mountPath);
		if (normalized === "/" || path.posix.dirname(normalized) !== "/") {
			throw new Error(`Dynamic external mount path must be one direct child of /: ${mountPath}`);
		}
		this.#mounts.set(normalized, provider);
	}

	removeMount(mountPath: string): VirtualProvider {
		const normalized = normalizeVfsPath(mountPath);
		const provider = this.#mounts.get(normalized);
		if (!provider) throw fsError("ENOENT", "unmount", normalized);
		this.#mounts.delete(normalized);
		return provider;
	}

	#route(entryPath: string, syscall: string): Route {
		const normalized = normalizeVfsPath(entryPath);
		if (normalized === "/") throw fsError("EISDIR", syscall, normalized);
		const firstSegment = normalized.slice(1).split("/", 1)[0];
		const mountPath = `/${firstSegment}`;
		const provider = this.#mounts.get(mountPath);
		if (!provider) throw fsError("ENOENT", syscall, normalized);
		const providerPath = normalized === mountPath ? "/" : normalized.slice(mountPath.length);
		return { provider, providerPath, mountPath };
	}

	#assertNotMountRoot(route: Route, syscall: string, entryPath: string): void {
		if (route.providerPath === "/") throw fsError("EBUSY", syscall, entryPath);
	}

	#sameRoute(left: string, right: string, syscall: string): { route: Route; rightPath: string } {
		const leftRoute = this.#route(left, syscall);
		const rightRoute = this.#route(right, syscall);
		if (leftRoute.provider !== rightRoute.provider) throw fsError("EXDEV", syscall, `${left} -> ${right}`);
		this.#assertNotMountRoot(leftRoute, syscall, left);
		this.#assertNotMountRoot(rightRoute, syscall, right);
		return { route: leftRoute, rightPath: rightRoute.providerPath };
	}

	async open(entryPath: string, flags: string, mode?: number): Promise<VirtualFileHandle> {
		const route = this.#route(entryPath, "open");
		const handle = await route.provider.open(route.providerPath, flags, mode);
		return new RevocableFileHandle(
			handle,
			() => this.#mounts.get(route.mountPath) === route.provider,
			entryPath,
		);
	}

	openSync(entryPath: string, flags: string, mode?: number): VirtualFileHandle {
		const route = this.#route(entryPath, "open");
		const handle = route.provider.openSync(route.providerPath, flags, mode);
		return new RevocableFileHandle(
			handle,
			() => this.#mounts.get(route.mountPath) === route.provider,
			entryPath,
		);
	}

	stat(entryPath: string, options?: object): Promise<Stats> {
		if (normalizeVfsPath(entryPath) === "/") return Promise.resolve(createVirtualDirStats());
		const route = this.#route(entryPath, "stat");
		return route.provider.stat(route.providerPath, options);
	}

	statSync(entryPath: string, options?: object): Stats {
		if (normalizeVfsPath(entryPath) === "/") return createVirtualDirStats();
		const route = this.#route(entryPath, "stat");
		return route.provider.statSync(route.providerPath, options);
	}

	lstat(entryPath: string, options?: object): Promise<Stats> {
		if (normalizeVfsPath(entryPath) === "/") return Promise.resolve(createVirtualDirStats());
		const route = this.#route(entryPath, "lstat");
		return route.provider.lstat(route.providerPath, options);
	}

	lstatSync(entryPath: string, options?: object): Stats {
		if (normalizeVfsPath(entryPath) === "/") return createVirtualDirStats();
		const route = this.#route(entryPath, "lstat");
		return route.provider.lstatSync(route.providerPath, options);
	}

	readdir(entryPath: string, options?: object): Promise<(string | Dirent<string>)[]> {
		if (normalizeVfsPath(entryPath) === "/") {
			return Promise.resolve(formatVirtualEntries(this.listMountPaths().map((value) => value.slice(1)), withFileTypes(options)));
		}
		const route = this.#route(entryPath, "readdir");
		return route.provider.readdir(route.providerPath, options) as Promise<(string | Dirent<string>)[]>;
	}

	readdirSync(entryPath: string, options?: object): (string | Dirent<string>)[] {
		if (normalizeVfsPath(entryPath) === "/") {
			return formatVirtualEntries(this.listMountPaths().map((value) => value.slice(1)), withFileTypes(options));
		}
		const route = this.#route(entryPath, "readdir");
		return route.provider.readdirSync(route.providerPath, options) as (string | Dirent<string>)[];
	}

	mkdir(entryPath: string, options?: object): Promise<string | void> {
		if (normalizeVfsPath(entryPath) === "/") return Promise.resolve();
		const route = this.#route(entryPath, "mkdir");
		return route.provider.mkdir(route.providerPath, options);
	}

	mkdirSync(entryPath: string, options?: object): string | void {
		if (normalizeVfsPath(entryPath) === "/") return;
		const route = this.#route(entryPath, "mkdir");
		return route.provider.mkdirSync(route.providerPath, options);
	}

	rmdir(entryPath: string): Promise<void> {
		const route = this.#route(entryPath, "rmdir");
		this.#assertNotMountRoot(route, "rmdir", entryPath);
		return route.provider.rmdir(route.providerPath);
	}

	rmdirSync(entryPath: string): void {
		const route = this.#route(entryPath, "rmdir");
		this.#assertNotMountRoot(route, "rmdir", entryPath);
		route.provider.rmdirSync(route.providerPath);
	}

	unlink(entryPath: string): Promise<void> {
		const route = this.#route(entryPath, "unlink");
		this.#assertNotMountRoot(route, "unlink", entryPath);
		return route.provider.unlink(route.providerPath);
	}

	unlinkSync(entryPath: string): void {
		const route = this.#route(entryPath, "unlink");
		this.#assertNotMountRoot(route, "unlink", entryPath);
		route.provider.unlinkSync(route.providerPath);
	}

	rename(oldPath: string, newPath: string): Promise<void> {
		const { route, rightPath } = this.#sameRoute(oldPath, newPath, "rename");
		return route.provider.rename(route.providerPath, rightPath);
	}

	renameSync(oldPath: string, newPath: string): void {
		const { route, rightPath } = this.#sameRoute(oldPath, newPath, "rename");
		route.provider.renameSync(route.providerPath, rightPath);
	}

	link(existingPath: string, newPath: string): Promise<void> {
		const { route, rightPath } = this.#sameRoute(existingPath, newPath, "link");
		if (!route.provider.link) throw fsError("ENOSYS", "link", existingPath);
		return route.provider.link(route.providerPath, rightPath);
	}

	linkSync(existingPath: string, newPath: string): void {
		const { route, rightPath } = this.#sameRoute(existingPath, newPath, "link");
		if (!route.provider.linkSync) throw fsError("ENOSYS", "link", existingPath);
		route.provider.linkSync(route.providerPath, rightPath);
	}

	readlink(entryPath: string, options?: object): Promise<string> {
		const route = this.#route(entryPath, "readlink");
		if (!route.provider.readlink) throw fsError("ENOSYS", "readlink", entryPath);
		return route.provider.readlink(route.providerPath, options);
	}

	readlinkSync(entryPath: string, options?: object): string {
		const route = this.#route(entryPath, "readlink");
		if (!route.provider.readlinkSync) throw fsError("ENOSYS", "readlink", entryPath);
		return route.provider.readlinkSync(route.providerPath, options);
	}

	symlink(target: string, entryPath: string, type?: string): Promise<void> {
		const route = this.#route(entryPath, "symlink");
		this.#assertNotMountRoot(route, "symlink", entryPath);
		if (!route.provider.symlink) throw fsError("ENOSYS", "symlink", entryPath);
		return route.provider.symlink(target, route.providerPath, type);
	}

	symlinkSync(target: string, entryPath: string, type?: string): void {
		const route = this.#route(entryPath, "symlink");
		this.#assertNotMountRoot(route, "symlink", entryPath);
		if (!route.provider.symlinkSync) throw fsError("ENOSYS", "symlink", entryPath);
		route.provider.symlinkSync(target, route.providerPath, type);
	}

	realpath(entryPath: string, options?: object): Promise<string> {
		if (normalizeVfsPath(entryPath) === "/") return Promise.resolve("/");
		const route = this.#route(entryPath, "realpath");
		if (!route.provider.realpath) return Promise.resolve(normalizeVfsPath(entryPath));
		return Promise.resolve(route.provider.realpath(route.providerPath, options)).then((resolved) =>
			path.posix.join(route.mountPath, resolved),
		);
	}

	realpathSync(entryPath: string, options?: object): string {
		if (normalizeVfsPath(entryPath) === "/") return "/";
		const route = this.#route(entryPath, "realpath");
		const resolved = route.provider.realpathSync?.(route.providerPath, options) ?? route.providerPath;
		return path.posix.join(route.mountPath, resolved);
	}

	async access(entryPath: string, mode?: number): Promise<void> {
		if (normalizeVfsPath(entryPath) === "/") return;
		const route = this.#route(entryPath, "access");
		if (route.provider.access) await route.provider.access(route.providerPath, mode);
		else await route.provider.stat(route.providerPath);
	}

	accessSync(entryPath: string, mode?: number): void {
		if (normalizeVfsPath(entryPath) === "/") return;
		const route = this.#route(entryPath, "access");
		if (route.provider.accessSync) route.provider.accessSync(route.providerPath, mode);
		else route.provider.statSync(route.providerPath);
	}

	statfs(entryPath: string): Promise<VfsStatfs> {
		const route = this.#route(entryPath, "statfs");
		if (!route.provider.statfs) throw fsError("ENOSYS", "statfs", entryPath);
		return route.provider.statfs(route.providerPath);
	}

	watch(entryPath: string, options?: object): unknown {
		const route = this.#route(entryPath, "watch");
		if (!route.provider.watch) throw fsError("ENOSYS", "watch", entryPath);
		return route.provider.watch(route.providerPath, options);
	}

	watchAsync(entryPath: string, options?: object): unknown {
		const route = this.#route(entryPath, "watch");
		if (!route.provider.watchAsync) throw fsError("ENOSYS", "watch", entryPath);
		return route.provider.watchAsync(route.providerPath, options);
	}

	watchFile(entryPath: string, options?: object, listener?: (...args: unknown[]) => void): unknown {
		const route = this.#route(entryPath, "watchFile");
		if (!route.provider.watchFile) throw fsError("ENOSYS", "watchFile", entryPath);
		return route.provider.watchFile(route.providerPath, options, listener);
	}

	unwatchFile(entryPath: string, listener?: (...args: unknown[]) => void): void {
		const route = this.#route(entryPath, "unwatchFile");
		if (!route.provider.unwatchFile) throw fsError("ENOSYS", "unwatchFile", entryPath);
		route.provider.unwatchFile(route.providerPath, listener);
	}
}
