/**
 * Bubblewrap sandbox — always-on default tier.
 *
 * Wraps the built-in `bash` tool so bash commands execute inside a
 * `@anthropic-ai/sandbox-runtime` sandbox (bubblewrap on Linux, sandbox-exec
 * on macOS) with filesystem and network restrictions enforced at the syscall
 * layer. Path tools (read/write/edit) run host-side and are gated by the
 * permission-system extension's deny list; this module only owns bash.
 *
 * Adapted from pi's examples/extensions/sandbox. This module is loaded by
 * sandbox/index.ts (the flag loader) and exposes `setupBwrap`. The flag loader
 * sets the footer status slot + degradation warnings; this module focuses on
 * the bash tool replacement and VM lifecycle.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/extensions/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 * - Schema: pi/extensions/sandbox/schema.json ($schema field)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
	type BashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	createBashTool,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

export interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "extensions", "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`[sandbox] Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`[sandbox] Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

	return result;
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

/**
 * Engage the bubblewrap sandbox. Returns true if the sandbox is active for this
 * session and the bash tool was replaced; false if it could not engage (missing
 * binary, unsupported platform, nested container, config disabled).
 *
 * Called from sandbox/index.ts session_start. Does NOT set the footer status
 * slot — the loader owns that. Registers the /sandbox command for inspection.
 */
export async function setupBwrap(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	const config = loadConfig(ctx.cwd);

	if (!config.enabled) {
		return false;
	}

	const platform = process.platform;
	if (platform !== "darwin" && platform !== "linux") {
		return false;
	}

	let initialized = false;
	try {
		const configExt = config as unknown as {
			ignoreViolations?: Record<string, string[]>;
			enableWeakerNestedSandbox?: boolean;
		};

		await SandboxManager.initialize({
			network: config.network,
			filesystem: config.filesystem,
			ignoreViolations: configExt.ignoreViolations,
			enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
		});
		initialized = true;
	} catch (err) {
		ctx.ui.notify(
			`Sandbox initialization failed: ${err instanceof Error ? err.message : err}. Bash runs unsandboxed; static permission layer still active.`,
			"warning",
		);
		return false;
	}

	const sandboxedOps = createSandboxedBashOps();

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const sandboxedBash = createBashTool(localCwd, { operations: sandboxedOps });
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		return { operations: sandboxedOps };
	});

	pi.on("session_shutdown", async () => {
		if (initialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	return true;
}