# Pi Sandbox v1 Implementation Plan

## Goal

Implement the complete behavior in [pi-sandbox-v1-design.md](./pi-sandbox-v1-design.md) as the replacement for the existing `permission-system` extension.

This plan describes architecture and sequencing. The design document is authoritative for user-visible behavior and security policy.

## Development coexistence

During the initial implementation and validation period, preserve the legacy `permission-system` source and Nix options:

- `programs.dot-agents.pi.sandbox.enable = false` deploys the legacy permission extension.
- `programs.dot-agents.pi.sandbox.enable = true` deploys the sandbox extension instead and installs QEMU.
- The two policy extensions are not auto-loaded together because both intercept the same built-in tools.
- Explicit `pi.extensions` lists remain an advanced override and are honored as written.
- The clean removal described in the migration section happens only after the sandbox POC is accepted.

## Repository scope

The canonical implementation lives in `dot-agents`:

- `pi/extensions/` — Pi extension and tests.
- `pi/package.json` / `pi/package-lock.json` — Gondolin runtime dependency.
- `nix/home-manager.nix` — deployment, configuration, and QEMU package integration.
- `nix/pi-node-modules.nix` — fixed-output Node dependency bundle.
- `README.md` and `pi/AGENTS.md` — user and contributor documentation.
- `plans/` — design, implementation plan, and roadmap.

The separate dotfiles repository should only provide per-host overrides or update its locked `dot-agents` input as needed.

## Proposed source layout

```text
pi/extensions/sandbox/
├── index.ts                 # Pi registration and lifecycle wiring
├── types.ts                 # Shared control-plane contracts
├── config.ts                # Global/project config loading and validation
├── policy.ts                # Workspace, protected path, mount, and host rules
├── paths.ts                 # Canonicalization and host/guest mapping
├── mounts.ts                # Session mount registry
├── ui.ts                    # Approval and /mounts UI
├── tools.ts                 # Built-in tool overrides
├── host-guards.ts           # Best-effort host-mode checks
├── backends/
│   ├── gondolin.ts          # Gondolin implementation
│   └── host.ts              # Explicit --no-sandbox implementation
└── *.test.ts
```

Exact file boundaries may change to keep modules cohesive.

## Control-plane abstraction

The policy layer must not import Gondolin types. A backend contract should expose only the capabilities Pi routing needs.

Illustrative contract:

```ts
type AccessMode = "read-only" | "read-write";

type SandboxStartOptions = {
  workspaceHostPath: string;
  workspaceGuestPath: "/workspace";
  image?: string;
  startupCommands: string[];
  cpus: number;
  memoryBytes: number;
  rootfsBytes: number;
  protectedPaths: string[];
};

type ExternalMount = {
  hostPath: string;
  guestPath: string;
  mode: AccessMode;
};

interface SandboxBackend {
  readonly name: string;
  readonly mode: "sandbox" | "host";

  start(options: SandboxStartOptions): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  exec(/* backend-neutral bash inputs */): Promise</* bash result */>;
  readFile(/* ... */): Promise<Buffer>;
  writeFile(/* ... */): Promise<void>;
  access(/* ... */): Promise<void>;
  stat(/* ... */): Promise</* portable stat */>;
  listDir(/* ... */): Promise<string[]>;

  mountExternal(mount: ExternalMount): Promise<void>;
  updateExternalMount(mount: ExternalMount): Promise<void>;
  unmountExternal(guestPath: string): Promise<void>;
}
```

The concrete signature should align with Pi's exported `*Operations` interfaces to avoid unnecessary adapters. Backend capabilities should be explicit so future implementations can fail clearly when a feature is unsupported.

## Policy responsibilities

The backend performs operations; the policy decides whether they are permitted.

Policy owns:

- Canonical workspace root.
- Classification as workspace, existing external mount, unapproved external, protected, or prohibited.
- Host path to guest path mapping.
- External directory root selection for files and directories.
- Approval access mode.
- Session mount registry and overlap checks.
- Protected path rules applied to all host-backed providers.
- Host-mode path and command denials.
- Fail-closed decisions in modes without UI.

The Gondolin backend must not show permission prompts. The Pi extension orchestrator asks policy, invokes UI if needed, then updates the backend.

## Dynamic Gondolin mounts

The desired behavior is to expose approved directories without restarting the VM.

First implementation investigation:

1. Validate whether Gondolin's current mount router can be mutated safely after `VM.create()`.
2. If no public runtime mount API exists, mount a custom mutable provider namespace at `/external` during VM creation.
3. Add and remove `RealFSProvider`/`ReadonlyProvider` routes beneath that namespace from the host control plane.
4. Confirm guest directory lookup and open-handle semantics after add, access-mode change, and removal.
5. Wait for Pi to be idle before mount changes.
6. Do not claim runtime revocation until an integration test verifies that future operations lose access.

If Gondolin cannot safely support runtime mutation, record the upstream/API gap. v1's specified behavior remains the target; do not silently emulate it with unsafe path filtering.

## Protected provider stack

Every host-backed mount should use a shared provider factory:

```text
protected policy wrapper
  -> read-only wrapper when requested
    -> RealFSProvider(canonical host directory)
```

Requirements:

- Apply protected paths inside workspace and external mounts.
- Preserve RealFSProvider's symlink escape protections.
- Reject reads and writes to protected paths.
- Allow explicit template exceptions.
- Keep `.git` visible.
- Ensure alternate `/data/...` Gondolin VFS paths cannot bypass policy.

## Pi integration

### Flags

Register:

- `--sandbox=<backend>` with `gondolin` as default.
- `--no-sandbox` as an explicit host-mode shortcut.

If Pi's extension flag API cannot express the exact CLI shape, preserve the semantics with the closest unambiguous supported form and document it. Conflicting flags must fail closed.

### Lifecycle

- Load and validate config.
- Canonicalize startup cwd.
- Register tool overrides before use.
- Start the selected backend eagerly on `session_start` so dependency errors are visible.
- Stop it on `session_shutdown` for all reasons.
- Recreate one VM for each replacement session runtime.

### Tool overrides

Use Pi's `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`, `createGrepTool`, `createFindTool`, and `createLsTool` with backend operations.

Do not reimplement rendering or result shapes. Preserve Pi's truncation and cancellation semantics.

Filesystem tool execution flow:

1. Normalize the supplied path.
2. Ask policy to classify it.
3. If external and unapproved, perform the approval flow when UI exists.
4. Update the mount registry/backend when approved.
5. Translate to a guest path.
6. Execute using backend operations.

Bash flow:

- Never parse arbitrary shell for authorization.
- Execute with `/workspace` as the base cwd.
- Provide clear errors for unavailable host paths where detectable.
- Use the explicit agent mount-request tool for external bash workflows.

### User bash

Handle Pi's `user_bash` event:

- Gondolin mode returns sandbox bash operations.
- Host mode returns local operations without applying agent command-pattern denials.

### System prompt

State:

- Current guest cwd is `/workspace`.
- Host workspace origin may be shown for user clarity.
- Built-in tools and bash execute in the selected sandbox backend.
- External host paths require approval.
- Bash should call the external-directory request tool and then use its returned `/external/...` path.
- Ordinary web retrieval should prefer `webfetch` over `curl`.

### Commands and UI

Implement:

- `/sandbox` — status, backend, workspace, resources, and active mounts.
- `/mount` — non-interactive parser and mount operation.
- `/mounts` — compact mount management UI.

Footer state should distinguish:

- Starting Gondolin.
- Running Gondolin.
- Recovering Gondolin.
- Gondolin error.
- Host mode off-warning.

## VM recovery state machine

Suggested states:

```text
stopped -> starting -> running
running -> failed -> recovering -> running
starting/recovering -> failed
running/recovering/failed -> stopping -> stopped
```

Rules:

- Serialize starts and recovery attempts.
- A tool that observes a VM failure fails without replay.
- Mark the backend for recovery before the next operation.
- Restore current mount registry after recreation.
- Notify once per failure transition.
- Never delegate to host operations from a Gondolin failure path.

## Configuration schema

Global `~/.pi/agent/sandbox.json` and trusted project `.pi/sandbox.json` should use a versioned schema.

Illustrative v1 shape:

```json
{
  "version": 1,
  "backend": "gondolin",
  "gondolin": {
    "image": "alpine-base:latest",
    "startupCommands": [],
    "cpus": 2,
    "memory": "4G",
    "rootfsSize": "8G"
  },
  "protectedPaths": []
}
```

Merge rules:

- Global config supplies defaults.
- Trusted project config may change image, startup commands, and bounded resources, and append protected paths.
- Project protected paths are additive.
- Project config cannot add mounts, secrets, host environment, network exceptions, or host mode.
- CLI backend/mode choice wins.

Use Pi's project trust state before honoring project config.

## Nix and packaging

1. Add a pinned Gondolin version to `pi/package.json` and refresh the lockfile.
2. Update fixed-output hashes in `nix/pi-node-modules.nix` for supported platforms as they are built.
3. Add QEMU to Home Manager packages whenever Pi sandbox support is enabled.
4. Add `programs.dot-agents.pi.sandbox` options and generate `sandbox.json`.
5. Remove `pi.permissions` and `pi.masks` options after migration.
6. Remove `permissions.json` generation.
7. Ensure the generated stow tree contains the new extension and no retired permission extension.

QEMU selection should use KVM on Linux/WSL when available and native macOS acceleration where supported. Software emulation may warn but is allowed. Missing/broken QEMU fails closed.

## Migration

This is a clean replacement, not a compatibility layer.

Remove:

- `pi/extensions/permission-system/`.
- Permission-specific tests and documentation.
- `permissions.json` Nix generation.
- `pi.permissions` and `pi.masks` Home Manager options.
- Permission logging and masking behavior.

Update `git-interceptor.ts` so it no longer imports constants from the removed permission extension.

Retain Pi's built-in project trust unchanged.

## Test strategy

### Mandatory unit tests

- Canonical path normalization and `~` expansion.
- Workspace containment and symlink-resolved external paths.
- Existing file versus directory mount-root selection.
- Nonexistent path rejection.
- Prohibited mount roots and special files.
- Stable guest mount naming and collision handling.
- Existing mount reuse.
- Overlap rejection.
- Read-only/read-write transitions.
- Protected path matching and template exceptions.
- Host-mode path denials.
- Catastrophic command and `sudo` checks.
- User bash bypass versus agent bash policy.
- Config validation, ceilings, and additive merge behavior.
- No-UI external access denial.
- Backend routing through a fake `SandboxBackend`.
- Recovery state transitions and no replay.

### Opt-in Gondolin integration tests

- Workspace read/write roundtrip.
- Guest cannot access arbitrary host paths.
- Built-in tools and bash see consistent files.
- User bash executes in the VM.
- Protected files are inaccessible through tools and shell.
- Read-only external mount rejects writes through tools and shell.
- Read-write external mount writes through to host.
- Runtime mount add, mode change, and removal.
- Symlink escapes fail closed.
- Public HTTP works while localhost/private ranges remain blocked.
- VM termination causes failure without replay and mounts restore after recovery.

### Manual smoke environments

- WSL2 x86_64 with `/dev/kvm`.
- macOS ARM64 when available.

Integration tests should be opt-in initially so normal Nix checks do not download and boot Gondolin guest assets.

## Suggested implementation order

1. Add design docs and roadmap.
2. Add backend-neutral types, path policy, mount registry, config, and unit tests.
3. Implement fake and host backends; validate Pi tool adapters.
4. Add Gondolin dependency and implement basic VM lifecycle.
5. Route all built-in tools and user bash for workspace-local operations.
6. Add protected VFS provider composition.
7. Implement external mount registry, agent request tool, and approval flow.
8. Implement `/mount` and `/mounts`.
9. Add recovery state machine.
10. Add footer/status and system-prompt guidance.
11. Add Home Manager config and QEMU deployment.
12. Add opt-in Gondolin integration tests and run WSL smoke test.
13. Remove the old permission system and update all docs.
14. Run `npm run check`, `npm test`, Nix checks, formatting, and the repository rebuild flow where appropriate.

## Definition of done

- All success criteria in the design document are demonstrated.
- Old permission prompts and config are gone.
- Normal sandbox operation produces no prompts except external directories and Pi project trust.
- No Gondolin error path executes a tool on the host.
- The backend boundary is free of Gondolin types outside its implementation.
- The WSL smoke test passes.
- Deferred features are captured in the roadmap rather than partially implemented without security tests.
