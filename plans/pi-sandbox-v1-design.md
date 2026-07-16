# Pi Sandbox v1 Design

## Status

Proposed and agreed design for the first proof of concept. In this document, **v1 and POC have the same scope**: the POC should demonstrate the complete intended v1 workflow rather than a reduced throwaway prototype.

## Purpose

Replace Pi's prompt-heavy permission system with isolation that is safer by default and usually requires no user interaction.

Pi remains a trusted host-side control plane. Agent-generated filesystem operations and shell commands run in a disposable Gondolin micro-VM. The directory from which Pi starts is the only host directory exposed initially. The user is prompted only when the agent requests an additional host directory, apart from Pi's existing project-trust prompt.

An explicit `--no-sandbox` mode runs tools on the host with a small set of best-effort denials.

## Threat model

Treat agent-generated commands, downloaded code, and prompt-injected instructions as potentially malicious.

The sandbox should protect:

- Host files outside explicitly exposed directories.
- Host credentials, credential stores, sockets, and environment secrets.
- Host localhost, private networks, metadata endpoints, and system devices.
- The host kernel and processes, subject to Gondolin/QEMU's isolation guarantees.

Accepted risks and non-goals:

- The workspace is fully mutable and may be destroyed. Git is the recovery mechanism.
- Approved read-write external directories may be modified or destroyed.
- Public network access can be used to exfiltrate any data visible inside the guest.
- Gondolin does not protect against QEMU escapes, same-user host attackers, side channels, or complete denial of service.
- `--no-sandbox` is not a security boundary; its rules are best-effort guardrails.

## Trust boundaries

### Trusted host control plane

- Pi itself.
- Globally installed and reviewed Pi extensions.
- The sandbox policy layer and backend implementation.
- Gondolin's host-side runtime and VFS providers.
- Pi's project-trust decision.

### Untrusted execution plane

- Agent `bash` commands.
- User `!` and `!!` commands while sandbox mode is active.
- Programs, scripts, and dependencies executed by those commands.
- The guest VM and its writable root filesystem.

### Trusted custom-extension exception

Pi cannot generically reroute arbitrary extension internals. Reviewed custom extensions remain host-side unless they explicitly integrate with the sandbox control-plane interface.

For v1:

- The file-backed `todo` extension may continue managing workspace-local `.pi/todos` on the host.
- `webfetch` remains host-side and is the preferred tool for ordinary web retrieval.
- Future extensions that execute agent-provided code or access arbitrary agent-provided paths must integrate with the sandbox interface.

## Operating modes

### Default: Gondolin

- Gondolin is the only sandbox backend implemented in v1.
- The design uses a backend interface so Docker, remote VMs, or other implementations can be added later.
- If Gondolin or QEMU cannot start, execution fails closed.
- The system never silently falls back to Docker or host execution.
- The footer clearly displays `SANDBOX: GONDOLIN`, startup/recovery state, or `SANDBOX: ERROR`.

### Explicit host mode

`pi --no-sandbox` selects the host backend.

- Built-in tools and agent bash run on the host.
- There are no approval prompts, including external-directory prompts.
- A minimal hard denylist remains active.
- User-entered `!` and `!!` commands bypass host-mode command-pattern denials because the user could run them directly in another terminal.
- The footer clearly displays `SANDBOX: OFF`.

Host mode's path and shell checks are intentionally best-effort. Shell indirection can bypass path checks, so host mode must never be represented as secure isolation.

## Workspace model

- The exact directory from which Pi starts is the workspace boundary.
- It is canonicalized once at startup and mounted read-write at `/workspace`.
- Pi does not automatically expand the boundary to a Git root or parent directory.
- The boundary remains fixed for the session; guest `cd` does not change it.
- `RealFSProvider` symlink escape protections remain enabled.
- Paths that resolve outside the workspace use the external-directory flow rather than being silently followed.

## Routed operations

The sandbox backend replaces Pi's built-in:

- `read`
- `write`
- `edit`
- `bash`
- `grep`
- `find`
- `ls`

User `!` and `!!` commands use the same backend.

The system prompt identifies `/workspace` as the guest working directory and explains external mount behavior.

## External directories

### Approval behavior

External mounts are scoped to the current Pi session runtime and are not persisted.

An agent-triggered request presents:

1. Allow read-only.
2. Allow read-write.
3. Deny.

The dialog shows:

- The canonical host path.
- The directory that will actually be exposed.
- The requested operation and access level.
- The resulting guest mount path.

Approvals are not cached across sessions. Denials are also not cached: repeated requests prompt again so the user can see that the agent is looping and stop the session.

Read-only and read-write access are enforced by the VFS provider, not merely by tool-call policy.

### How access is requested

- `read`, `write`, and `edit` automatically invoke the external-directory flow for host paths outside the workspace.
- Bash is not parsed to infer host paths; shell parsing is not a safe authorization mechanism.
- An agent tool requests an external directory explicitly for bash workflows and returns its guest path.
- Bash attempts to use unavailable host paths fail with guidance to request or mount the directory.

### Path selection

- An existing requested directory exposes that exact directory.
- An existing requested file proposes its immediate parent directory and makes that broader exposure explicit in the dialog.
- A nonexistent path is rejected rather than guessing a broad ancestor. The user or agent must mount an existing parent first.
- Host paths are canonicalized with `realpath` before policy decisions.
- An existing mount is reused when it already contains the requested path.

### Guest mount names

External paths receive stable, collision-resistant guest paths under `/external`, for example:

```text
/external/another-project-a1b2c3d4
```

The mapping remains stable for the session and is always returned to the agent or user.

### Explicit user commands

`/mount` is non-interactive because typing it is the user's approval.

```text
/mount /absolute/path
/mount --read-only /absolute/path
/mount --read-write /absolute/path
```

Rules:

- Read-only is the default.
- Accept absolute host paths and `~/...`.
- Support quoted paths containing spaces.
- Reject relative paths.
- Require an existing directory.
- Either add the mount and print its guest path or return a validation error.

`/mounts` opens a compact management dialog that can:

- List host path, guest path, and access mode.
- Upgrade read-only to read-write.
- Downgrade read-write to read-only.
- Remove a mount.
- Exit without changes.

The extension waits for Pi to become idle before changing or removing a mount.

### Prohibited mounts

The following cannot be mounted, even with explicit `/mount`:

- Host `/`.
- The user's home directory itself.
- `/dev`, `/proc`, `/sys`, and `/run`.
- Known credential stores and private-key locations.
- Docker or other container-engine sockets.
- SSH/GPG agent sockets.
- Sockets and non-regular filesystem objects.
- Paths already represented by the workspace or an existing mount.

Specific normal directories below the home directory remain mountable.

### Overlapping mounts

v1 does not permit overlapping external mount roots.

- A containing mount is reused at its current access level.
- It is never silently upgraded.
- Mounting a parent of an existing mount is rejected.
- If narrower read-write access is needed beneath a broad read-only mount, the user must remove the broad mount and add non-overlapping narrower mounts.

This avoids alternate-path authorization bypasses until nested shadow routing is implemented and tested.

## Protected paths

Tool-only read rules are insufficient because guest bash can access the same mount. Sensitive paths are hidden or denied in the Gondolin VFS for both workspace and external mounts.

The initial policy covers:

- `.env` and non-template `.env.*` files.
- Conventional private-key files and `*.key`, `*.pem`, `*.p12`, and `*.pfx`.
- Project-local credential directories and files.
- Known credential-store paths.

Obvious templates such as `.env.example` and `.env.sample` remain visible. `.git` remains accessible for ordinary Git workflows. Protected paths cannot be read or written, and read-write mount approval does not override this policy.

## Host-mode guardrails

### Path denials

Deny read/write access to:

- `.env` and non-template `.env.*`.
- `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, and 1Password configuration.
- Private-key files.
- Writes to `.git` internals.

### Agent bash denials

Deny obvious forms of:

- `sudo`.
- Recursive deletion targeting `/`, the home directory, or equivalent broad globs.
- Raw writes to block devices.
- Filesystem formatting.
- Shutdown, reboot, and power-off.
- Fork bombs.

Do not broadly deny ordinary deletion, package managers, builds, Git mutations, networking tools, `eval`, or `source`.

Simple sensitive-path references may be blocked, but the implementation must document that arbitrary shell scripts and indirection cannot be analyzed securely.

## Network policy

v1 focuses on filesystem isolation.

- Allow unrestricted mediated public HTTP/HTTPS from Gondolin.
- Keep Gondolin's private/internal range and metadata protections enabled.
- Do not provide raw unrestricted NAT.
- Do not inject credentials.
- Do not mount GitHub CLI, Git, SSH, cloud, package-manager, or other auth configuration.
- Do not forward SSH/GPG agents or container sockets.
- Prefer host-side `webfetch` over guest `curl` for ordinary page retrieval.
- Package-manager traffic such as `npm install` should work without permission prompts where Gondolin's supported protocols permit it.

Authenticated `gh`, Git credential injection, and SSH access are deferred.

## Guest image and resources

The default image is a versioned baseline with common shell and development utilities. Trusted project configuration may select another image and run guest-only initialization.

Defaults:

- 2 virtual CPUs.
- 4 GiB memory.
- 8 GiB disposable root filesystem.

Validation ceilings:

- 16 virtual CPUs.
- 32 GiB memory.
- 100 GiB root filesystem.

Project configuration may adjust values within those ceilings.

Host-level facilities are not exposed. In particular, v1 does not mount `/nix/store`, the Nix daemon, Docker sockets, or host package-manager sockets. Host-level actions such as applying a NixOS rebuild require a separate explicit host-mode Pi invocation or manual user action.

## Lifecycle and recovery

- One disposable VM exists per active Pi session runtime.
- It is destroyed on quit, reload, new session, resume, or fork.
- Host-backed workspace and external changes persist.
- Guest rootfs changes and installed packages are discarded.
- Project guest initialization runs for each new VM.

If the VM crashes:

- The active tool fails and is never replayed automatically.
- The backend never falls back to host execution.
- A new VM is created before the next sandboxed operation.
- Workspace and approved external mounts are restored with the same modes.
- The user is notified that guest-local state was lost.
- Repeated recovery failure leaves tools fail-closed with `SANDBOX: ERROR`.

## Configuration

### Global

Home Manager exposes `programs.dot-agents.pi.sandbox` and generates:

```text
~/.pi/agent/sandbox.json
```

Global configuration contains backend defaults, image selection, resource limits, and built-in/additional protected paths. Per-host dotfiles may override machine-specific values.

### Project

Trusted `.pi/sandbox.json` may additively configure:

- Gondolin image selector or image path.
- Guest startup commands.
- CPU, memory, and rootfs size.
- Additional protected workspace paths.

Project configuration may not:

- Remove built-in protected paths.
- Add or pre-authorize external mounts.
- Expose host environment variables or secrets.
- Disable sandboxing or select host mode.
- Relax private/internal network protections.

CLI mode/backend flags have the highest precedence. Session mount decisions are never persisted in configuration.

## Non-interactive modes

- Sandbox mode remains enabled in print, JSON, and RPC modes.
- Workspace-local operations work normally.
- External access fails closed when no approval UI is available.
- Project config cannot pre-authorize external mounts.
- v1 does not add non-interactive mount flags.
- `--no-sandbox` remains the explicit escape hatch.

## Pi project trust

Pi's built-in project-trust prompt remains unchanged. It protects the host-side control plane because project-local Pi extensions execute on the host, outside Gondolin.

The desired prompt model is therefore:

- Project trust when required by Pi.
- External-directory approval during an interactive session.
- No routine command, read, write, edit, or network permission prompts.

## Audit logging

v1 adds no sandbox audit log.

## Success criteria

v1 is successful when:

- Starting Pi normally starts Gondolin and visibly reports sandbox mode.
- The seven built-in tools and user bash operate against `/workspace` in the guest.
- Guest commands cannot access arbitrary host paths, host sockets, or protected files.
- External directory approval and explicit mount management work as specified.
- Read-only and read-write access are enforced beneath bash, not only Pi tools.
- `--no-sandbox` is explicit, visible, prompt-free, and guarded by the minimal denylist.
- Sandbox startup and failure never silently execute tools on the host.
- Unit tests cover policy and routing, and an opt-in real-VM smoke test passes on WSL.
