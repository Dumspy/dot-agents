import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { BROKER_START_TIMEOUT_MS } from "../protocol.js";

export interface WorkspaceRuntimePaths {
	root: string;
	workspaceId: string;
	socket: string;
	lock: string;
	errorLog: string;
	pidFile: string;
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export async function workspaceRuntimePaths(workspace: string): Promise<WorkspaceRuntimePaths> {
	const base = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `pi-sandbox-${currentUid() ?? "user"}`);
	const root = path.join(base, "pi-sandbox");
	await mkdir(root, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
	const rootStats = await stat(root);
	if (!rootStats.isDirectory()) throw new Error(`Sandbox runtime path is not a directory: ${root}`);
	const uid = currentUid();
	if (uid !== undefined && rootStats.uid !== uid) throw new Error(`Sandbox runtime directory is not owned by the current user: ${root}`);
	const workspaceId = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
	return {
		root,
		workspaceId,
		socket: path.join(root, `${workspaceId}.sock`),
		lock: path.join(root, `${workspaceId}.lock`),
		errorLog: path.join(root, `${workspaceId}.error.log`),
		pidFile: path.join(root, `${workspaceId}.pid`),
	};
}

function connectSocket(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		const onError = (error: Error) => {
			socket.destroy();
			reject(error);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.off("error", onError);
			resolve(socket);
		});
	});
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function lockOwnerAlive(lockPath: string): Promise<boolean> {
	try {
		const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
		return typeof value.pid === "number" && processAlive(value.pid);
	} catch {
		return false;
	}
}

async function brokerPid(pidFile: string): Promise<number | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(pidFile, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const pid = (parsed as { pid?: unknown }).pid;
		return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

async function cleanStaleBroker(paths: WorkspaceRuntimePaths): Promise<"running" | "absent"> {
	const pid = await brokerPid(paths.pidFile);
	if (pid === undefined) return "absent";
	if (processAlive(pid)) return "running";
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await Promise.all([rm(paths.pidFile, { force: true }), rm(paths.socket, { force: true })]);
	return "absent";
}

async function waitForSocket(paths: WorkspaceRuntimePaths, timeoutMs: number): Promise<Socket> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await connectSocket(paths.socket);
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	let detail = lastError instanceof Error ? lastError.message : String(lastError ?? "timed out");
	try {
		const log = (await readFile(paths.errorLog, "utf8")).trim();
		if (log) detail = log;
	} catch {
		// No broker startup log was produced.
	}
	await rm(paths.errorLog, { force: true }).catch(() => undefined);
	throw new Error(`Sandbox broker did not become ready: ${detail}`);
}

export async function connectOrLaunchBroker(options: {
	workspace: string;
	launcherPath: string;
	timeoutMs?: number;
}): Promise<{ socket: Socket; paths: WorkspaceRuntimePaths }> {
	const paths = await workspaceRuntimePaths(options.workspace);
	try {
		return { socket: await connectSocket(paths.socket), paths };
	} catch {
		// Start or wait for the workspace broker below.
	}
	if ((await cleanStaleBroker(paths)) === "running") {
		return { socket: await waitForSocket(paths, options.timeoutMs ?? BROKER_START_TIMEOUT_MS), paths };
	}

	let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		lockHandle = await open(paths.lock, "wx", 0o600);
		await lockHandle.writeFile(JSON.stringify({ pid: process.pid, workspace: options.workspace }));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (!(await lockOwnerAlive(paths.lock))) {
			await rm(paths.lock, { force: true });
			return connectOrLaunchBroker(options);
		}
		return { socket: await waitForSocket(paths, options.timeoutMs ?? BROKER_START_TIMEOUT_MS), paths };
	}

	try {
		await rm(paths.errorLog, { force: true });
		const errorFd = openSync(paths.errorLog, "a", 0o600);
		try {
			const child = spawn(process.execPath, [options.launcherPath], {
				detached: true,
				stdio: ["ignore", "ignore", errorFd],
				env: {
					...process.env,
					PI_SANDBOX_BROKER_SOCKET: paths.socket,
					PI_SANDBOX_BROKER_WORKSPACE: options.workspace,
					PI_SANDBOX_BROKER_LOCK: paths.lock,
					PI_SANDBOX_BROKER_PID_FILE: paths.pidFile,
					PI_SANDBOX_BROKER_ERROR_LOG: paths.errorLog,
				},
			});
			child.unref();
		} finally {
			closeSync(errorFd);
		}
		return { socket: await waitForSocket(paths, options.timeoutMs ?? BROKER_START_TIMEOUT_MS), paths };
	} catch (error) {
		await rm(paths.lock, { force: true }).catch(() => undefined);
		throw error;
	} finally {
		await lockHandle?.close();
	}
}
