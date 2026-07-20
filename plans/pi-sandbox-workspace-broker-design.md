# Pi Sandbox Workspace Broker Design

## Status

Implemented on `feat/pi-workspace-sandbox-broker` as a stacked follow-up to the Gondolin sandbox POC in PR #34; pending review.

This document refines the v1 lifecycle in [pi-sandbox-v1-design.md](./pi-sandbox-v1-design.md). The original filesystem, protected-path, external-mount, network, and host-mode security decisions remain in force unless this document explicitly changes them.

## Purpose

Give multiple Pi processes started from the same workspace the experience of sharing one ordinary development machine, while keeping that shared execution environment inside a sandbox.

The initial implementation uses Gondolin. The design keeps backend execution behind a required interface so reviewed backends can be added later without changing Pi's user-facing sandbox workflow.

## Goals

- Run Pi's filesystem tools, agent bash, and user bash in the sandbox.
- Create at most one active sandbox for one exact canonical workspace.
- Let independent Pi processes in that workspace share guest packages, processes, files, and mounts.
- Destroy the sandbox when the final attached Pi process exits.
- Preserve the existing prompt-free workspace and public-network workflow.
- Prompt only when a previously unavailable external host directory is requested.
- Keep `--no-sandbox` entirely local and independent of shared sandbox infrastructure.
- Fail closed without host or alternate-backend fallback.
- Keep the initial broker small and workspace-scoped rather than creating a general multi-workspace daemon.

## Non-goals

The initial broker does not provide:

- A permanent per-user service.
- An idle VM after the final Pi process exits.
- A central manager for all workspaces.
- Persistent external approvals.
- Adoption of a VM after its broker crashes.
- Arbitrary backend plugins or project-provided backend code.
- Per-session process, filesystem, or mount isolation inside a shared sandbox.
- Automatic fallback between backends.
- Non-interactive pre-authorization of external directories.
- Aggregate resource scheduling across workspaces.

## Execution boundary

The sandbox owns:

- `read`
- `write`
- `edit`
- `grep`
- `find`
- `ls`
- agent `bash`
- user `!` and `!!` commands

Trusted host-side control-plane functionality remains outside:

- Pi UI and model orchestration.
- Configuration and project-trust handling.
- `webfetch` and similar reviewed host integrations.
- Workspace-local todo bookkeeping.
- Explicit `--no-sandbox` execution.

## Default environment

Without any external approval, a workspace sandbox receives:

- The exact canonical Pi startup directory, read-write at `/workspace`.
- A disposable guest root filesystem.
- Public mediated HTTP/HTTPS.
- No host environment secrets.
- No host credentials, agent sockets, container sockets, package-manager services, or private network access.
- Protected-path filtering across all host-backed mounts.

The agent may otherwise run freely: install guest packages, execute builds, modify the workspace, and use public network services supported by the backend.

## Workspace identity

The workspace key is the real path of the exact directory from which Pi starts.

Consequences:

- A symlink and its canonical target share one sandbox.
- A repository root and a nested directory are different workspaces.
- Separate Git worktrees are different workspaces.
- Git discovery never expands the mounted boundary to a parent.
- Non-Git directories behave identically.

A stable opaque workspace ID is derived from the canonical path and is used only for runtime socket and lock names.

## Architecture

```text
Pi process A ─┐
Pi process B ─┼── user-only workspace socket ── workspace broker ── SandboxBackend
Pi process C ─┘                                              └──── Gondolin VM
```

There is one ephemeral broker process per active canonical workspace.

The broker owns:

- One normalized sandbox specification.
- One backend instance.
- One shared mount registry.
- Attached Pi-process leases.
- Authoritative path translation and mount policy.
- Operation scheduling and per-file mutation queues.
- Backend health and recovery.

Pi owns:

- Tool registration, rendering, and result presentation.
- Approval dialogs and user commands.
- Project trust and config resolution.
- Model-context disclosure decisions.
- Host-mode operations and guardrails.

Pi communicates directly with the broker. No Pi process proxies tools for another Pi process.

## Broker discovery and startup

Runtime files live under:

```text
$XDG_RUNTIME_DIR/pi-sandbox/
```

A platform-appropriate user runtime directory is used if `XDG_RUNTIME_DIR` is unavailable. Runtime directories and sockets must be accessible only to the current user.

Startup flow:

1. Pi canonicalizes its startup workspace and derives the workspace ID.
2. Pi attempts to connect to the workspace socket.
3. If no broker is reachable, Pi atomically acquires the workspace startup lock.
4. The lock winner starts the broker and waits for readiness.
5. Other Pi processes wait for the socket rather than starting duplicates.
6. The broker validates the attachment before creating or returning the sandbox.
7. Stale sockets, locks, and orphaned backend processes are cleaned up before replacement startup.

The initial protocol uses one exact protocol version. An incompatible client or broker fails clearly; compatibility negotiation is deferred.

## Attachment and configuration

Pi resolves configuration before attachment:

1. `--no-sandbox` bypasses the broker entirely.
2. `--sandbox=<backend>` has highest sandbox-backend precedence.
3. Trusted project config may select a backend compiled into the codebase.
4. Global config supplies the default backend.

Pi sends a complete normalized sandbox specification. The broker validates resource ceilings and security invariants again.

The first attachment establishes an immutable specification for that active workspace broker. Later attachments must provide the same specification. A mismatch is rejected with a diagnostic; the broker never ignores the requested configuration, restarts an in-use sandbox, creates a second sandbox for that workspace, or falls back to another backend.

## Pi-process leases

One lease represents one Pi operating-system process, not one conversation runtime.

- The lease is held by a persistent socket connection.
- A random process-local lease token survives extension reloads in process-global memory.
- `/new`, `/resume`, `/fork`, and `/reload` reconnect with the same token.
- The broker keeps a disconnected lease for a short reconnect grace period, initially five seconds.
- Normal Pi quit explicitly releases the lease without waiting for the grace period.
- A crashed process loses its lease when the connection and grace period expire.
- The final released or expired lease causes the broker to close its backend, remove runtime files, and exit.

The grace period bridges Pi lifecycle replacement only; it is not an idle-VM feature.

## Shared execution model

Attached Pi processes share the guest execution plane:

- Guest root filesystem and installed packages.
- Workspace and approved external mounts.
- Process namespace.
- Network policy.
- Guest initialization state.

Ordinary filesystem and shell operations may run concurrently. This intentionally resembles multiple unsandboxed agents sharing one host workspace.

Cancellation remains operation-specific. Cancelling one command must terminate only that command's process tree, not unrelated commands from other sessions.

## Backend contract

All reviewed backends are compiled into the repository and registered by name. Only Gondolin is implemented initially. Project configuration may select a registered backend but cannot load backend code.

The required backend contract covers:

- Start, stop, health, status, and recovery.
- Shell execution with streaming output, cancellation, and execution timeout.
- Filesystem operations needed by the routed Pi tools.
- Atomic edit behavior.
- Backend-efficient grep and find.
- Runtime external mount add, mode change, and removal.
- Protected-path enforcement beneath tools and shell.
- Read-only enforcement and handle revocation.
- Public network mediation and private-range protection.
- Deterministic cleanup and no host fallback.

The interface is mandatory rather than capability-negotiated. Every future backend must pass the same reusable conformance suite.

`host` is not a broker backend. `--no-sandbox` remains a separate local Pi path.

## Broker operation protocol

The protocol is deliberately limited to sandbox needs. A persistent user-only Unix socket carries framed requests, responses, stream events, and cancellation messages with request IDs.

Required operations:

- `attach` and `detach`
- `status`
- `exec`
- `readFile`
- `writeFile`
- `edit`
- `stat`
- `listDir`
- `access`
- `grep`
- `find`
- mount request, update, and removal

Buffers use an explicit wire representation. Runtime schemas validate all messages. Guest errors are returned as portable structured errors rather than leaking backend-specific object shapes.

Pi continues using Pi's built-in tool factories and renderers where their operations interfaces fit. Thin adapters translate broker results into those interfaces.

## Path translation and policy ownership

Shared pure utilities provide:

- Canonicalization and nearest-existing-ancestor handling.
- Workspace containment.
- Protected-path matching.
- Stable guest mount naming.
- Config normalization and validation.
- Host-mode guardrails.

The broker is authoritative for sandbox-mode path classification, mount state, and access decisions. Host mode reuses the same pure path and protection utilities locally but never contacts a broker.

Translation remains:

```text
<canonical workspace>/path -> /workspace/path
<approved external root>/path -> /external/<stable-name>/path
```

Built-in filesystem tools may receive host paths and are translated automatically. Bash is not parsed for host paths; the agent must request an external directory and use the returned guest path.

## External directory approval

External mount behavior remains:

- Existing directories expose that directory.
- Existing file requests propose the immediate parent and disclose the broader exposure.
- Nonexistent external paths are rejected until an existing parent is mounted.
- Prohibited roots, credentials, sockets, special files, and overlaps remain denied.
- Approvals are read-only, read-write, or deny.
- Protected paths remain hidden in approved directories.

Approval flow:

1. Pi sends an operation or explicit request containing the original path.
2. The broker canonicalizes and classifies it.
3. If approval is required, the broker returns the canonical mount proposal.
4. The requesting Pi displays the approval UI.
5. Pi returns the user's decision.
6. The broker revalidates and commits the mount.
7. The original operation resumes without requiring the model to issue it again.

Approval and mount-policy requests are serialized. Agent requests are monotonic:

- A read-write mount satisfies later read-only requests without downgrade.
- A read-only mount requires a new approval before upgrade to read-write.
- Agent requests never downgrade or remove a mount.
- Denials are not cached.

Any attached user may explicitly downgrade or remove a shared mount through `/mounts`. The UI warns when other Pi processes are attached.

## Scheduling

The broker provides only the coordination required by sharing:

- Ordinary independent operations run concurrently.
- `edit` and `write` participate in per-file mutation queues across Pi processes.
- Mount changes use a fair exclusive queue.
- Existing operations finish before a downgrade or removal commits.
- Operations submitted after a pending mount change wait rather than fail due to broker busy state.
- Queued operation cancellation removes that operation.
- Queue waiting and backend execution use separate timeouts.
- Execution timeout starts only when backend execution begins.

A queued operation may still fail normally if a preceding mount change removed its path or made it read-only.

## Mount visibility and model context

Mount authorization is workspace-scoped, but model disclosure is conversation-scoped.

On attachment, the user sees every active shared mount with host path, guest path, and mode. `/sandbox` and `/mounts` show the same authoritative state.

The model is not proactively given mappings created by unrelated conversations. A mapping becomes relevant to a conversation when:

- Its tool call references a host path covered by that mount.
- It calls `request_external_directory` and the broker returns the existing mapping.
- The user mounts it from that conversation.

This minimizes unnecessary model context. It is not an isolation boundary: all mounts exist inside the shared guest and may be discoverable through guest bash.

## User-visible status

Every attachment prints a concise notice.

New sandbox:

```text
Created Gondolin sandbox 8f31c2ab
Workspace: /home/user/project -> /workspace
Attached Pi processes: 1
External mounts: none
```

Existing sandbox:

```text
Reusing Gondolin sandbox 8f31c2ab
Workspace: /home/user/project -> /workspace
Attached Pi processes: 3
Shared external mounts:
  /home/user/docs -> /external/docs-a1b2c3d4 (read-only)
```

The footer shows backend and health. `/sandbox` shows backend, workspace, resources, attachment count, errors, and mounts. Mount changes and recovery are broadcast as user-visible notifications to attached Pi processes without automatically injecting mappings into unrelated model contexts.

User-requested stop or restart is allowed only when the caller holds the sole active lease.

## Failure behavior

### Backend or VM failure

If the broker remains alive:

- The active operation fails and is not replayed.
- No host or alternate-backend fallback occurs.
- Before the next operation, the broker recreates the backend.
- Workspace and approved external mounts are restored.
- Guest-local packages and processes are lost.
- All attached Pi processes receive a warning.
- Repeated recovery failure leaves the workspace fail-closed.

### Broker failure

If the broker process exits unexpectedly:

- Active operations fail and are not replayed.
- A Pi process may win the normal startup lock and create a fresh broker.
- Stale runtime artifacts and orphaned backend processes are cleaned up.
- Guest-local state and external approvals are lost.
- External directories prompt again when next requested.
- No host or alternate-backend fallback occurs.

The initial design stores only the minimal process metadata required to detect stale ownership and clean up backend processes. It does not journal mount approvals.

## Host mode

`--no-sandbox`:

- Does not connect to, start, attach to, or keep alive a broker.
- Runs built-in tools and agent bash locally with best-effort guards.
- Lets user `!` commands behave as direct user commands.
- Does not see or modify shared sandbox mounts.
- May coexist with sandboxed Pi processes in the same workspace.
- Is always visibly labeled as non-isolated.

## Non-interactive modes

Print, JSON, and RPC modes attach to the same workspace broker.

- Workspace-local operations work normally.
- Existing shared external mounts may be reused.
- New external approval fails closed when no approval UI is available.
- Project config cannot pre-authorize mounts.
- No non-interactive mount flags are added initially.

## Security properties

- The broker is trusted host-side code and validates every request.
- Runtime sockets and directories are restricted to the current user.
- The same-user attacker remains outside the threat model.
- The guest never receives broker sockets, lease tokens, host environment secrets, or control-plane credentials.
- Protected-path and read-only enforcement remain below shell execution.
- Real filesystem providers retain canonical root and symlink-escape checks.
- Public networking remains mediated with private/internal range blocking.
- Sharing does not weaken the accepted risk that one agent may modify workspace files or interfere with another process inside the same guest.

## Release criteria

The broker design is ready when:

- Two independent client processes for one canonical workspace report the same sandbox identity.
- Guest-local state and workspace changes are visible through both clients.
- A second workspace receives a distinct broker and backend instance.
- Conflicting specifications for one active workspace are rejected.
- Shared mounts retain read-only/read-write and protected-path enforcement.
- One disconnect does not stop a sandbox while another lease remains.
- Final disconnect closes the backend and broker.
- Pi conversation replacement preserves the process lease.
- Backend failure restores mounts without replay or fallback.
- Broker failure creates a fresh sandbox with approvals cleared.
- `--no-sandbox` never touches broker runtime state.
- A reusable backend conformance suite passes.
- The opt-in real Gondolin multi-client suite passes.
