# Pi Sandbox Workspace Broker Implementation Plan

## Status

Implemented on `feat/pi-workspace-sandbox-broker`; validation complete and pending stacked review.

## Goal

Implement [pi-sandbox-workspace-broker-design.md](./pi-sandbox-workspace-broker-design.md) as a stacked pull request on top of the Gondolin sandbox POC.

The result replaces the production in-process Gondolin lifecycle with one ephemeral broker and one sandbox per active canonical workspace. Only Gondolin is implemented initially, but all execution passes through a mandatory backend-neutral contract.

## Delivery strategy

- Branch from `feat/pi-gondolin-sandbox`.
- Open a stacked PR targeting that branch.
- Keep the existing PR reviewable as the single-process POC.
- Do not call sandbox v1 complete or enable it by default until the broker PR is accepted.
- After the base PR merges, rebase or retarget the broker PR to `development`.

## Guiding constraints

- Prefer the smallest workspace-scoped broker over a general daemon framework.
- Reuse Pi's built-in tool factories and renderers where possible.
- Reuse shared pure policy code between sandbox and host mode.
- Keep UI and project trust inside Pi.
- Keep authoritative shared mount state inside the broker.
- Do not retain the in-process Gondolin path as a production fallback.
- Every failure path remains fail-closed.

## Proposed source layout

Exact boundaries may change during implementation, but responsibilities should remain explicit.

```text
pi/extensions/sandbox/
├── index.ts                         # Pi client registration and host-mode routing
├── client/
│   ├── broker-client.ts             # connection, requests, streams, cancellation
│   ├── broker-launch.ts             # workspace discovery, locking, startup
│   ├── operations.ts                # Pi operations adapters over broker RPC
│   └── lease.ts                     # process-scoped reconnect identity
├── broker/
│   ├── main.ts                      # executable entry point
│   ├── server.ts                    # socket server and protocol dispatch
│   ├── workspace.ts                 # one specification/backend/mount registry
│   ├── scheduler.ts                 # mount barrier and per-file queues
│   └── approvals.ts                 # serialized mount proposals and commits
├── backends/
│   ├── backend.ts                   # mandatory backend contract
│   ├── registry.ts                  # reviewed compiled backend factories
│   ├── gondolin.ts
│   ├── dynamic-mount-provider.ts
│   └── providers.ts
├── shared/
│   ├── config.ts
│   ├── paths.ts
│   ├── protected-paths.ts
│   ├── host-guards.ts
│   ├── protocol.ts
│   └── types.ts
└── test/
    ├── broker-*.test.ts
    ├── client-*.test.ts
    ├── backend-conformance.ts
    └── gondolin-multiclient.integration.test.ts
```

The control-plane source stays in the sandbox feature tree and uses the existing `pi/package.json` dependency lock. It is built into a standalone JavaScript entry point for detached execution; it is not a separate npm package.

## Phase 1: Freeze behavior with tests

Before moving code, add or update tests that capture the current accepted policy:

- Workspace canonicalization and exact-boundary mapping.
- Protected-path behavior and template exceptions.
- Symlink escape prevention.
- External mount root selection and prohibited paths.
- Read-only/read-write transitions and overlap rules.
- Host-mode guards.
- Config precedence and trusted-project restrictions.
- Fail-closed no-UI behavior.

These tests provide a safety net while splitting shared, client, broker, and backend responsibilities.

## Phase 2: Extract shared policy and schemas

Move stateless logic into shared modules without changing behavior:

- Path normalization, `@` stripping, and `~` expansion.
- Existing and nearest-existing-ancestor canonicalization.
- Containment and overlap checks.
- Host-to-guest path translation.
- Protected-path matching.
- Host-mode path and command guards.
- Config parsing, merge, normalization, and ceilings.
- Portable request, response, error, stat, and directory-entry types.

Requirements:

- Shared modules must not import Pi UI or Gondolin runtime types.
- Host mode uses shared helpers locally.
- Broker-side policy uses the same helpers authoritatively.
- Runtime schemas reject unknown or malformed protocol fields.

## Phase 3: Expand the backend contract

Replace the lifecycle-only `SandboxBackend` boundary with a mandatory execution interface.

Illustrative shape:

```ts
interface SandboxBackend {
  readonly name: string;

  start(options: SandboxStartOptions): Promise<void>;
  stop(): Promise<void>;
  status(): SandboxBackendStatus;
  healthCheck(): Promise<BackendHealth>;
  recover(): Promise<void>;

  exec(request: ExecRequest, sink: ExecEventSink): Promise<ExecResult>;
  readFile(request: ReadFileRequest): Promise<Buffer>;
  writeFile(request: WriteFileRequest): Promise<void>;
  edit(request: EditRequest): Promise<EditResult>;
  stat(request: StatRequest): Promise<PortableStats>;
  listDir(request: ListDirRequest): Promise<PortableDirEntry[]>;
  access(request: AccessRequest): Promise<void>;
  grep(request: GrepRequest): Promise<GrepResult>;
  find(request: FindRequest): Promise<FindResult>;

  mountExternal(mount: ExternalMount): Promise<void>;
  updateExternalMount(mount: ExternalMount): Promise<void>;
  unmountExternal(guestPath: string): Promise<void>;
}
```

Implementation rules:

- The backend receives guest paths only after broker policy translation.
- Gondolin types remain inside its backend implementation.
- Exec cancellation terminates only the requested process tree.
- Filesystem results use portable types.
- Protected provider construction remains shared by workspace and external mounts.
- Backend recovery restores the broker's current mount registry.

Add a backend registry with only `gondolin` initially. Unknown names fail clearly. Do not register host mode.

## Phase 4: Add the broker protocol

Implement a small framed protocol over a persistent user-only Unix socket.

Initial message categories:

- Request
- Response
- Stream event
- Cancellation
- Broker event

Every message contains:

- Protocol version.
- Request or event ID.
- Message type.
- Validated payload.

Required behaviors:

- Correlate concurrent requests by ID.
- Stream stdout/stderr chunks without buffering complete command output.
- Cancel queued or running operations by request ID.
- Return structured portable errors.
- Bound frame and buffer sizes.
- Reject incompatible protocol versions before attachment.
- Never expose backend stack traces or host-only data to the guest/model by default.

Use a direct local socket only. Do not add TCP, HTTP, plugin, or remote-control support.

## Phase 5: Implement broker discovery and launch

Add workspace runtime discovery under `$XDG_RUNTIME_DIR/pi-sandbox/` with a secure fallback when the variable is unavailable.

For each workspace ID, manage:

- Socket path.
- Startup lock.
- Broker PID metadata.
- Minimal backend process metadata needed for stale cleanup.

Launch algorithm:

1. Canonicalize the exact startup directory.
2. Derive the opaque workspace ID.
3. Connect if a healthy broker socket exists.
4. Otherwise acquire the startup lock atomically.
5. Recheck after acquiring the lock.
6. Validate and remove stale runtime artifacts.
7. Terminate a confirmed orphan backend process without touching unrelated processes.
8. Start the broker detached.
9. Wait for an explicit ready handshake with a bounded startup timeout.
10. Release the startup lock.

Security requirements:

- Runtime directory, metadata, and socket are user-only.
- Reject runtime paths owned by another user.
- Never follow untrusted symlinks while cleaning runtime files.
- Verify PID identity before orphan cleanup; do not kill from an unvalidated stale integer alone.

## Phase 6: Implement normalized attachment

Pi resolves global, trusted project, and CLI settings into a normalized specification.

The attachment request includes:

- Canonical workspace.
- Workspace ID.
- Backend name and backend config.
- Protected paths.
- Resource settings.
- Protocol/build version.
- Pi process lease token.
- Pi PID and minimal display metadata.

The broker:

- Revalidates all ceilings and security invariants.
- Creates the backend on the first attachment.
- Stores the normalized specification and fingerprint.
- Requires exact semantic equality for later attachments.
- Returns a field-level mismatch diagnostic.
- Never restarts an in-use backend to satisfy another attachment.

Backend startup is eager so dependency and initialization errors are visible before tools run.

## Phase 7: Implement Pi-process leases

Create one random lease token per Pi OS process and keep it in process-global memory across extension replacement.

Lifecycle handling:

- `session_start`: connect or reconnect the process lease.
- `/new`, `/resume`, `/fork`, `/reload`: disconnect/reconnect with the same token.
- `session_shutdown` with quit: explicitly release the lease.
- Unexpected socket loss: broker marks the lease reconnectable for five seconds.
- Reconnect with the token: reactivate without changing attachment count.
- Grace expiry: remove the lease.
- No remaining active or reconnectable leases: stop backend and broker.

The broker must not count multiple extension runtimes in one Pi process as separate long-lived leases.

## Phase 8: Move authoritative routing into the broker

Implement broker-side workspace policy around the shared mount registry.

Filesystem request flow:

1. Receive original host or guest path.
2. Normalize and canonicalize host paths.
3. Classify workspace, existing mount, unapproved external, protected, or prohibited.
4. Translate approved host paths to guest paths.
5. Execute against the selected backend.

Bash flow:

- Always starts from `/workspace` unless a valid guest cwd is supplied.
- Never parses shell text to authorize host paths.
- Receives only the allowlisted guest environment.
- Uses `request_external_directory` for external host workflows.

Pi operations adapters should preserve built-in tool input/output, rendering, truncation, update, and cancellation semantics.

## Phase 9: Implement shared approval flow

When broker policy requires external approval, return a structured proposal containing:

- Canonical requested host path.
- Actual directory root to expose.
- Whether a file request broadened exposure to its parent.
- Requested access mode.
- Proposed guest path.
- Current mount-policy generation.
- Request ID.

The Pi client displays the existing approval choices and sends the decision back.

Commit rules:

- Revalidate path existence, canonical root, prohibited locations, overlap, and policy generation.
- Serialize approval and mount-policy requests.
- A containing mount is reused at its current mode.
- Read-write satisfies read-only.
- Read-only requires explicit approval before upgrade.
- Agent requests cannot downgrade or remove.
- Denial is not cached.
- If the requester disconnects, cancel its pending approval.
- Do not block unrelated ordinary operations while waiting for user input.

A broker crash discards all approval state by design.

## Phase 10: Add broker scheduling

Implement two focused coordination mechanisms.

### Per-file mutation queues

- `edit` and `write` for the same canonical guest target serialize across clients.
- Existing symlink aliases resolve to the same queue key.
- New files use the normalized target under a canonical existing parent.
- Queue the complete edit read/validate/write window.
- Bash mutations are intentionally outside these advisory queues.

### Mount-policy barrier

- Ordinary operations acquire shared operation slots.
- Mount downgrade/removal enters a fair exclusive queue.
- Existing operations finish first.
- New operations accepted after the pending change wait behind it.
- Handle revocation occurs when the change commits.
- Queued requests remain cancellable.
- Queue timeout and backend execution timeout are distinct.

Start with conservative constants and expose global timing configuration only if real use demonstrates a need.

## Phase 11: Wire user experience

On attachment, notify the user whether the sandbox was created or reused and show:

- Backend and sandbox ID.
- Host workspace to `/workspace` mapping.
- Attached Pi-process count.
- Every shared external mount and mode.

Update:

- Footer status.
- `/sandbox` status output.
- `/mount` explicit approval.
- `/mounts` shared management.
- `request_external_directory` reuse and approval behavior.
- Recovery notifications.

Rules:

- Existing mounts from unrelated conversations are not proactively injected into model context.
- A reused mapping is returned when that conversation references or requests its host path.
- Mount events notify users but do not automatically reveal mappings to unrelated model contexts.
- User stop/restart is allowed only for the sole active lease.

## Phase 12: Preserve host and non-interactive modes

Host mode:

- Keep local tool factories and best-effort guards in Pi.
- Do not execute broker discovery code.
- Do not create runtime directories, sockets, locks, or leases.
- Keep user bash unguarded as an explicit user action.

Non-interactive sandbox mode:

- Attach normally.
- Reuse existing mounts.
- Fail closed on a new approval requirement without UI.
- Do not add project-controlled or hidden pre-authorization.

Add explicit tests that `--no-sandbox` never contacts or launches a broker.

## Phase 13: Remove the production in-process Gondolin path

After broker routing is complete:

- Remove direct production VM ownership from the Pi extension.
- Remove direct Gondolin operations construction from tool handlers.
- Keep backend classes directly instantiable for unit, conformance, and integration tests.
- Do not add an in-process fallback flag.
- Make broker startup failure a visible fail-closed sandbox error.

## Phase 14: Package and deploy the broker

Add a build target that emits a standalone JavaScript broker entry point from the same source revision and dependency lock as the extension.

Home Manager integration must:

- Deploy the broker executable only when the sandbox extension is selected.
- Place it in a stable private libexec location discoverable by the extension.
- Continue installing Gondolin runtime dependencies and QEMU.
- Preserve explicit extension-list behavior.
- Avoid introducing a permanent user service.

The stow generation path must include the executable or a reliable equivalent launcher for non-Nix users.

The client and broker embed matching protocol/build versions.

## Phase 15: Testing

### Unit tests

- Workspace ID stability and canonical path equivalence.
- Runtime path ownership and stale socket handling.
- Atomic startup lock under concurrent clients.
- First attach and matching reattach.
- Specification mismatch diagnostics.
- Process lease reconnect and grace expiry.
- Final-detach broker shutdown.
- Request framing, validation, streaming, and cancellation.
- Portable backend error conversion.
- Per-file mutation ordering across clients.
- Fair mount barrier ordering and cancellation.
- Monotonic approval mode behavior.
- Explicit downgrade/removal behavior.
- No-UI approval failure.
- Backend recovery with mount restoration.
- Broker replacement with approvals cleared.
- Host mode does not touch broker runtime state.

### Backend conformance suite

Run the same suite against every registered backend:

- Workspace read/write.
- Protected-path hiding and write denial.
- Symlink escape denial.
- External read-only enforcement.
- External read-write persistence.
- Runtime add, upgrade, downgrade, removal, and handle revocation.
- Exec streaming, timeout, and cancellation.
- Filesystem operations, atomic edit, grep, and find.
- Public HTTP/HTTPS and internal-range denial.
- Health failure and deterministic cleanup.
- No host fallback.

### Opt-in real Gondolin multi-client suite

Use independent client processes and the real broker:

1. Attach two clients to one canonical workspace.
2. Assert the same broker and VM identity.
3. Create guest-local state through one client and read it through the other.
4. Verify workspace changes through both clients.
5. Approve an external mount through one client and reuse it through the other.
6. Verify protected files remain unavailable through tools and shell.
7. Reject a conflicting sandbox specification.
8. Disconnect one client and confirm the backend remains alive.
9. Disconnect the final client and confirm broker/backend exit.
10. Kill the VM and verify failure without replay plus mount restoration.
11. Kill the broker and verify fresh startup with approvals cleared.
12. Confirm `--no-sandbox` creates no broker runtime artifacts.

Keep real-VM tests opt-in until CI has reliable QEMU/KVM support.

## Phase 16: Documentation and migration

Update:

- `README.md` sandbox architecture and startup behavior.
- `pi/AGENTS.md` source layout and broker development commands.
- The original v1 design lifecycle section to link to the broker refinement.
- The roadmap item for persistent VM per workspace: mark active-process sharing as implemented while retaining true idle/process-restart persistence as future work.
- PR validation instructions for multi-client tests.

Document clearly:

- Mount authorization is shared across attached workspace sessions.
- Mount mappings are not proactively injected into unrelated model contexts.
- Guest state lasts only while at least one Pi process is attached.
- Broker failure loses approvals.
- `--no-sandbox` is independent and not an isolation boundary.

## Suggested implementation order

1. Freeze current policy tests.
2. Extract shared modules and protocol schemas.
3. Expand Gondolin behind the mandatory backend contract.
4. Implement an in-process test broker with fake backend.
5. Add socket protocol and broker client.
6. Add workspace startup locking and leases.
7. Move path routing and mounts into broker policy.
8. Add scheduling and approval continuation.
9. Route all Pi tools and user bash through the client.
10. Add status, commands, and context behavior.
11. Remove direct production Gondolin ownership.
12. Add broker build and Nix/stow deployment.
13. Add conformance and real multi-client tests.
14. Update documentation and run full validation.

## Definition of done

- The release criteria in the broker design are demonstrated.
- One exact canonical workspace never intentionally owns more than one active broker/backend pair.
- Multiple Pi processes share guest-local state without routing through another Pi process.
- Different workspaces can select different registered backends.
- The backend boundary includes all required execution behavior and passes conformance tests.
- External authorization remains prompt-minimal, shared, and VFS-enforced.
- Host mode never interacts with broker infrastructure.
- Backend and broker failures never execute on the host or another backend.
- The production extension has no direct in-process Gondolin fallback.
- Normal type checks, unit tests, Nix checks, Home Manager builds, and the opt-in Gondolin multi-client suite pass in their supported environments.
