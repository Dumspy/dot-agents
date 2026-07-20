# Pi Sandbox Roadmap

## Purpose

Track deliberate follow-up work beyond the v1 design in [pi-sandbox-v1-design.md](./pi-sandbox-v1-design.md). Items here are not promises for v1 and must not weaken v1's fail-closed behavior through incomplete shortcuts.

## Highest priority after v1

### Persistence beyond active workspace processes

The workspace broker design now shares one VM while at least one sandboxed Pi process remains attached to the exact canonical workspace. It preserves guest state across concurrent processes and `/new`, `/resume`, `/fork`, and `/reload`, and intentionally shares mount authorization inside that common VM.

Remaining persistence work is deliberately beyond the initial broker release:

- Reuse guest state after the final Pi process exits.
- Reconnect across Pi process or host restarts.
- Clean up abandoned idle VMs after a configurable timeout.
- Safely adopt or checkpoint a VM after control-plane failure instead of recreating it.
- Persist user-approved mount profiles without allowing project-controlled authorization.

These features require a durable manager or checkpoint design beyond the ephemeral per-workspace broker.

### Nix/devenv development environments

Explore reproducible project toolchains without exposing the host package manager.

Candidates:

- Build Gondolin images from project Nix/devenv definitions.
- Convert OCI images produced by Nix into Gondolin guest assets.
- Cache a prepared rootfs/checkpoint keyed by flake lock or devenv inputs.
- Provide a safe guest-local Nix installation with its own store.
- Avoid mounting the host `/nix/store` or Nix daemon unless a separate security design proves it safe.

Goals:

- Match project toolchains automatically.
- Keep startup latency reasonable.
- Preserve filesystem isolation and reproducibility.

### Controlled secret use

Use Gondolin's placeholder substitution so real credentials never enter the guest.

Potential first use case:

- A narrowly scoped `GH_TOKEN` usable only for approved GitHub hosts.

Required design work:

- Declarative host and request-method allowlists.
- Least-privilege and short-lived credentials.
- Clear distinction between secret non-exposure and authorization to perform remote actions.
- Protection against allowed services echoing secrets.
- Auditable user consent without returning to prompt fatigue.
- No mounting `~/.ssh`, `~/.config/gh`, cloud credential stores, or agent sockets.

## Additional backends

Implement the existing control-plane interface for other execution environments.

### Docker/container backend

- Match Gondolin path, mount, lifecycle, and failure semantics.
- Document weaker kernel isolation and daemon/socket risks.
- Never silently fall back from Gondolin to Docker.
- Avoid exposing the host Docker socket to the guest.
- Test read-only mount enforcement, protected paths, and process cleanup.

### Remote VM or SSH backend

- Authenticate the trusted control plane without exposing credentials to agent code.
- Define workspace synchronization and conflict semantics.
- Preserve external mount approval concepts where meaningful.
- Keep host path names distinct from remote paths.

### Other local VM backends

- Evaluate libkrun as it matures.
- Consider platform-native isolation where it can satisfy the same interface and security properties.

## Mount-system improvements

### Nested mounts

Support a read-only parent with a read-write child, or other overlapping policies, only after implementing and testing shadow routing that prevents alternate-path bypasses.

Requirements:

- Longest-prefix routing.
- Hide nested host paths from containing providers.
- Handle symlinks, hard links, renames, and open file descriptors.
- Make mode downgrade and revocation semantics explicit.

### File-only exposure

Expose one external file without revealing all siblings in its parent directory.

Potential implementation:

- A custom single-file VFS provider.
- A directory provider that shadows every non-approved entry.

### Non-interactive mount authorization

Add explicit CLI mount flags for print/JSON automation if needed.

Requirements:

- Authorization must be visible in the invocation.
- No project-controlled pre-authorization.
- Support read-only/read-write modes.
- Reject prohibited and overlapping roots consistently.

### Persistent user-approved mount profiles

Potentially allow user-owned global configuration to pre-approve common directories. Do not permit project config to add them.

## Network policy evolution

v1 allows mediated public HTTP/HTTPS. Future options:

- Global and project-aware domain allowlists.
- Separate package-registry policy from arbitrary web access.
- Request method/path restrictions.
- Egress visibility or optional auditing.
- Explicit internal service mappings with narrow host/port rules.
- SSH egress for selected workflows.
- Better compatibility with HTTP/2, HTTP/3, QUIC, and tools that require raw protocols as Gondolin evolves.

Any restriction model should avoid routine prompts.

## Guest lifecycle and performance

- Prepared image/checkpoint caches.
- Disk-only Gondolin checkpoints for common toolchains.
- Configurable persistent guest caches that do not expose host credentials.
- Faster startup and lazy startup options.
- Resource governance beyond basic CPU/memory/disk settings.
- Better cancellation and process-tree cleanup tests.
- Graceful host suspend/resume behavior.

## Policy improvements

- Richer protected-path rules with explicit, user-owned exceptions.
- Content-aware secret scanning before exposing files.
- Per-mount protected-path additions.
- Safer handling of repositories that legitimately require local `.env` data.
- Optional policy diagnostics explaining which VFS rule denied an operation.
- Stronger host-mode detection while continuing to label it best-effort.

## Project configuration expansion

Potential future trusted project settings:

- Controlled secret references.
- Narrow network policy additions.
- Cache declarations.
- Toolchain builders.
- Named sandbox profiles.
- Backend requirements and capabilities.

Project configuration must never silently select host mode. Any future ability to relax built-in restrictions requires a separate explicit user-trust design.

## User experience

- Better mount visualization and search.
- Status showing backend, VM identity, uptime, resources, and mount count.
- Optional commands to restart or rebuild a sandbox.
- Clear remediation when a required tool is missing from the guest image.
- Shell attachment for the user to inspect the running VM.
- Migration tooling for renamed config schema versions.

## Testing and platform coverage

- Make real-VM tests reliable enough for CI.
- Cover Linux x86_64, Linux ARM64, macOS ARM64, and macOS x86_64 where available.
- Test WSL with and without KVM.
- Add backend conformance tests reusable by Gondolin, Docker, and future implementations.
- Add adversarial path, symlink, shell, and mount-revocation test suites.
- Pin and verify Gondolin guest assets for higher supply-chain assurance.

## Explicitly rejected shortcuts

Unless a later design supersedes these decisions, do not:

- Silently fall back to host execution.
- Treat shell parsing as a secure mount authorization mechanism.
- Mount the entire home directory.
- Forward host credential or container sockets by default.
- Let project config pre-authorize external host directories.
- Share one session's mount approvals with another session implicitly.
- Describe host-mode deny rules as a security boundary.
