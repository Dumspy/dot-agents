# dot-agents

Universal agent configuration for Pi, OpenCode, and future AI coding agents.

## What's inside

| Directory | Purpose | Install target |
|-----------|---------|----------------|
| `skills/` | Universal skills (all agents) | `~/.agents/skills/` |
| `opencode/agents/` | OpenCode subagent definitions | `~/.config/opencode/agents/` |
| `pi/skills/` | Pi-specific skills | `~/.pi/agent/skills/` |
| `pi/extensions/` | Pi TypeScript extensions | `~/.pi/agent/extensions/` |
| `pi/themes/` | Pi terminal themes | `~/.pi/agent/themes/` |
| `opencode/skills/` | OpenCode-specific skills | `~/.config/opencode/skills/` |
| `opencode/commands/` | OpenCode commands | `~/.config/opencode/commands/` |
| `opencode/extensions/` | OpenCode extensions | agent-specific |
| `nix/pi-external-extensions.nix` | External Pi extension registry | `~/.pi/agent/npm/node_modules/<name>/` + settings.json |

## Nix (Home Manager)

Add as a flake input:

```nix
# flake.nix
inputs.dot-agents = {
  url = "github:<you>/dot-agents";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Import the module and enable:

```nix
# home.nix
imports = [ inputs.dot-agents.homeModules.default ];

programs.dot-agents = {
  enable = true;
};
```

Everything is auto-discovered from the repository and installed to the appropriate directories.
You can still add extra OpenCode commands or override Pi settings:

```nix
programs.dot-agents = {
  enable = true;

  opencode.commands = {
    my-command = ./path/to/command.md;
  };

  pi = {
    extensions = null;  # auto-discover all
    # Store-backed sources are overlaid into ~/.pi/agent/extensions/.
    extraExtensions = {
      "company-extension.ts" = ./path/to/company-extension.ts;
    };
    gate = {
      provider = "typesafe";
      model = "jev-latest";
      allowAt = 0.25;
      denyAt = 0.6;
    };
  };
};
```

## Non-Nix (Stow)

For non-Nix systems, use the auto-generated `stow` branch which vendors all external skills.
See the `README.md` on the `stow` branch for setup, update, and usage instructions:

```bash
git clone --branch stow https://github.com/<you>/dot-agents.git ~/dot-agents
cd ~/dot-agents
cat README.md
```

The `stow` branch is automatically updated by a GitHub Action on every push to `development`.

## Structure

```
dot-agents/
├── skills/           # Universal skills (all agents discover these)
├── pi/               # Pi-specific artifacts
│   ├── skills/
│   ├── extensions/
│   └── themes/
├── opencode/         # OpenCode-specific artifacts
│   ├── agents/       # Subagent definitions (.md files)
│   ├── skills/
│   ├── commands/
│   └── extensions/
├── nix/              # Nix flake, packages, and Home Manager modules
└── home/             # Only exists in the `stow` branch (auto-generated)
```

## Permission Gate

Pi tool calls go through three layers instead of glob rules:

1. **Planner** — proves routine read-only shell work (`ls`, `cat`, `rg`,
   `git status`, …) and lets it run without a model call.
2. **Floor** — blocks crisp-bad shapes and paths finally: recursive delete,
   `sudo`/`eval`/`source`, force-push, hard-reset, pipe-to-shell, env dumps,
   secret egress, paste uploads, credential stores, git internals, `.env`
   writes. Override only with `/allow`.
3. **Reviewer** — one SystemOne classifier call asking three narrow questions
   (injection, exfiltration, external effect) with the trusted user request and
   git environment attached. `allowAt`/`denyAt` decide allow, hold, or block.

Writes/edits inside the workspace are floor-only; flagged reads and calls
outside it are reviewed. The full design, thresholds, privacy model, and
measured results are in [`plans/permission-gate.md`](plans/permission-gate.md).

### Nix configuration

```nix
programs.dot-agents = {
  enable = true;
  pi = {
    extensions = null;  # auto-discover all

    # Static gate config → ~/.pi/agent/gate.json
    gate = {
      provider = "typesafe";
      model = "jev-latest";
      allowAt = 0.25;
      denyAt = 0.6;
      onUncertain = "hold";  # or "ask"
    };
  };
};
```

### Non-Nix configuration

Copy `pi/extensions/permission-gate/` to `~/.pi/agent/extensions/` and create
`~/.pi/agent/gate.json`:

```json
{
  "provider": "typesafe",
  "model": "jev-latest",
  "allowAt": 0.25,
  "denyAt": 0.6,
  "onUncertain": "hold"
}
```

The reviewer needs credentials for the selected provider (`pi auth check
--provider typesafe`). Without them every reviewed call fails closed.

### Commands

- `/judge` — reviewer, thresholds, mid-band behavior, pending approval, recent blocks
- `/gate-log` — the last 15 decisions from `~/.pi/agent/gate.log.jsonl`
- `/allow` — one-shot approval for one recent block

## External Pi Extensions

In addition to local extensions in `pi/extensions/`, dot-agents supports external
Pi extensions in two flavors:

- `type = "npm"` — third-party npm packages that Pi loads via its package manager.
- `type = "file"` — a single extension file fetched from a URL (for upstreams
  that ship a plain file rather than an npm package), deployed directly to
  `~/.pi/agent/extensions/<filename>`.

The registry at `nix/pi-external-extensions.nix` is the single source of truth
for which external extensions are available.

### How it works (npm type)

Pi discovers external extensions through `settings.json` → `packages`:

```json
{
  "packages": ["my-extension"]
}
```

Pi resolves packages from `~/.pi/agent/npm/node_modules/<name>/` (global) or `.pi/npm/node_modules/<name>/`
(project). Each package declares its extension entry point in its `package.json`
under the `pi.extensions` field.

File-type entries skip the package manager entirely — the fetched file lands
in `~/.pi/agent/extensions/` next to the bundled extensions, so no
`settings.json` entry is needed.

### Architecture

```
nix/pi-external-extensions.nix    ← single source of truth (registry)
  ├── Nix (npm): packages.nix builds each npm package as a fixed-output derivation
  │               home-manager.nix deploys to ~/.pi/agent/npm/node_modules/<name>/
  │               + merges packages into ~/.pi/agent/settings.json
  ├── Nix (file): packages.nix fetches the pinned file
  │                home-manager.nix overlays it into the extensions bundle
  │                (~/.pi/agent/extensions/<filename>)
  └── Stow (npm only): stow-tree.nix includes a settings.json with packages array
                        setup.sh runs `pi install npm:<name>` if pi CLI is available
```

Both paths are reproducible:
- **Nix**: fixed-output derivations with content hashes
- **Stow**: `pi install` uses npm registry (equivalent to `npm ci` determinism)

### Nix configuration

```nix
programs.dot-agents = {
  enable = true;
  pi = {
    # Auto-discover all external extensions from registry
    externalExtensions = null;

    # Or pick specific ones (registry is currently empty — see
    # nix/pi-external-extensions.nix for the preserved example):
    externalExtensions = ["my-extension"];

    # Or disable all:
    externalExtensions = [];
  };
};
```

Available extensions: `herdr-agent-state` (file type — Herdr agent-state reporting
for Pi, fetched from [herdrdev/herdr](https://github.com/herdrdev/herdr)).
The preserved `pi-mcp-adapter` npm example in `nix/pi-external-extensions.nix`
shows the npm-type schema.

### Non-Nix (stow)

The stow branch includes a `.pi/agent/settings.json` with external packages.
`setup.sh` runs `pi install npm:<name>` for each if `pi` is available.
If Pi isn't installed yet, the settings are in place and packages will be
installed when `pi install` is run later.

### Adding a new external extension

**File-type entries (single file from a URL)** — for upstreams that ship a
plain extension file rather than an npm package:

```nix
"my-extension" = {
  type = "file";
  filename = "my-extension.ts";   # destination under ~/.pi/agent/extensions/
  url = "https://...";            # pin to an immutable commit/tag
  hash = "";                      # fill via: nix store prefetch-file <url>
  description = "What this extension does";
};
```

Then verify with `nix build .#my-extension` and skip to Step 6 below
(no lockfile, no stow entry — file type is Nix-only).

**npm-type entries** follow the full flow:

**Step 1 — Register the extension**

Add an entry to `nix/pi-external-extensions.nix`:

```nix
"my-extension" = {
  type = "npm";
  package = "my-extension";          # npm package name
  version = "1.0.0";                 # exact version to pin
  description = "What this extension does";
  hash = "";                         # fill in step 2
  npmDepsHash = "";                  # fill in step 3
};
```

**Step 2 — Get the tarball hash**

```bash
nix-prefetch-url https://registry.npmjs.org/my-extension/-/my-extension-1.0.0.tgz
# Copy the sha256 output into the `hash` field
```

**Step 3 — Vendor the lockfile (pins transitive deps)**

Nix builds run `npm ci` against a lockfile checked into
`nix/external-locks/<package>-<version>.package-lock.json`.
Generate it from the published tarball:

```bash
TMP=$(mktemp -d) && \
  curl -sL https://registry.npmjs.org/my-extension/-/my-extension-1.0.0.tgz -o $TMP/pkg.tgz && \
  mkdir -p $TMP/pkg && tar xzf $TMP/pkg.tgz --strip-components=1 -C $TMP/pkg && \
  (cd $TMP/pkg && npm install --package-lock-only --ignore-scripts) && \
  cp $TMP/pkg/package-lock.json nix/external-locks/my-extension-1.0.0.package-lock.json
```

Commit the lockfile — Nix requires it to be tracked by Git (`git add`).

**Step 4 — Get the npm dependencies hash**

Temporarily set `npmDepsHash = ""` in the registry entry, then:

```bash
nix build .#my-extension 2>&1 | grep 'got:'
# Copy the sha256 from the error message into `npmDepsHash`
```

The hash is stable until `version` or the lockfile changes, because `npm ci`
never resolves semver ranges live. When bumping a version, repeat steps 3–4.

**Step 5 — Add to stow setup (non-Nix users)**

Add the version-pinned package to the `EXTERNAL_PI_PACKAGES` array in `stow/setup.sh`:

```bash
EXTERNAL_PI_PACKAGES=(
  "my-extension@1.0.0"    # ← add here, keep version in sync with the registry
)
```

Also add it to the array inside the post-merge hook in the same file.

**Step 6 — Verify**

Nix: after Home Manager rebuild, the extension is in `~/.pi/agent/npm/node_modules/<name>/`
and listed in `~/.pi/agent/settings.json`. Start Pi and confirm the extension
loads via the extension's own commands (e.g. `/mcp` for an MCP adapter).

Stow: run `./setup.sh` — if `pi` is installed, the extension is installed
automatically. Otherwise Pi will use it on next startup after `pi install npm:<name>`.

**Summary of files to change when adding an extension:**

1. `nix/pi-external-extensions.nix` — registry entry with hashes
2. `nix/external-locks/<package>-<version>.package-lock.json` — vendored lockfile (pins transitive deps)
3. `stow/setup.sh` — add version-pinned `name@version` to `EXTERNAL_PI_PACKAGES` array (×2: main + post-merge hook)

That's it. The rest is automatic — Nix builds and deploys the derivation,
Home Manager merges settings.json, and stow runs `pi install`.

## Adding Skills

1. Create a directory under `skills/<skill-name>/`
2. Add a `SKILL.md` with proper YAML frontmatter
3. Register the skill in `nix/skills.nix`
4. Rebuild or push to trigger the `stow` branch update
