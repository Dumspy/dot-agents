import { rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrokerWorkspace } from "./workspace.js";
import { WorkspaceBrokerServer } from "./server.js";

export async function runBroker(): Promise<void> {
	const socketPath = process.env.PI_SANDBOX_BROKER_SOCKET;
	const workspaceInput = process.env.PI_SANDBOX_BROKER_WORKSPACE;
	const lockPath = process.env.PI_SANDBOX_BROKER_LOCK;
	const pidFile = process.env.PI_SANDBOX_BROKER_PID_FILE;
	const errorLog = process.env.PI_SANDBOX_BROKER_ERROR_LOG;
	if (!socketPath || !workspaceInput) throw new Error("Sandbox broker launch environment is incomplete");
	const workspacePath = realpathSync(workspaceInput);
	let server: WorkspaceBrokerServer | undefined;
	const workspace = new BrokerWorkspace(workspacePath, (event, data) => server?.broadcast(event, data));
	server = new WorkspaceBrokerServer(socketPath, workspace);
	let ready = false;

	const shutdown = () => void server?.close();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	process.once("SIGHUP", shutdown);

	try {
		if (pidFile) await writeFile(pidFile, JSON.stringify({ pid: process.pid, workspace: workspacePath }), { mode: 0o600 });
		await server.listen();
		ready = true;
		if (lockPath) await rm(lockPath, { force: true }).catch(() => undefined);
		await once(server, "closed");
	} finally {
		if (lockPath) await rm(lockPath, { force: true }).catch(() => undefined);
		if (pidFile) await rm(pidFile, { force: true }).catch(() => undefined);
		if (ready && errorLog) await rm(errorLog, { force: true }).catch(() => undefined);
		await server.close();
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
	await runBroker().catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
}
