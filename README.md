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
| `pi/permissions.json` | Pi permission config | `~/.pi/agent/permissions.json` |
| `opencode/skills/` | OpenCode-specific skills | `~/.config/opencode/skills/` |
| `opencode/commands/` | OpenCode commands | `~/.config/opencode/commands/` |
| `opencode/extensions/` | OpenCode extensions | agent-specific |
| `nix/pi-external-extensions.nix` | External Pi extension registry | `~/.pi/agent/npm/<name>/` + settings.json |

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
    permissions = {
      read = { "*" = "allow"; };
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

## Pi Permissions

The `permission-system` extension adds configurable permission gates and secret masking to Pi tools.
When a tool matches an `"ask"` rule, a simple prompt appears with three options:
**Yes**, **No**, and **Explain**. When a tool matches a `"cloak"` rule, the call is allowed
but sensitive values in the result are masked (read tool only in v1).

### Nix configuration

```nix
programs.dot-agents = {
  enable = true;
  pi = {
    # Auto-discover all extensions in pi/extensions/
    extensions = null;

    # Permission rules (mirrors OpenCode's permission system)
    permissions = {
      read = {
        "*" = "allow";
        # Secrets & credentials — cloak instead of deny so the agent sees variable names but not values
        ".env" = "cloak";
        "*.env" = "cloak";
        "*.env.*" = "cloak";
        "*.envrc" = "deny";
        "secrets/*" = "deny";
        # Private keys & auth
        ".ssh/*" = "deny";
        ".gnupg/*" = "deny";
        ".config/1password/*" = "deny";
        "*.key" = "deny";
        "*.pem" = "deny";
        "*.p12" = "deny";
        "*.pfx" = "deny";
        # Cloud/container credentials
        ".aws/*" = "deny";
        ".docker/*" = "deny";
        ".kube/*" = "deny";
        # Version control internals
        ".git/*" = "deny";
        ".gitmodules" = "deny";
        # Build artifacts
        "node_modules/*" = "deny";
        ".venv/*" = "deny";
        "venv/*" = "deny";
        "dist/*" = "deny";
        "build/*" = "deny";
        "target/*" = "deny";
      };
      write = {
        "*" = "ask";
        ".env" = "deny";
        ".git/*" = "deny";
        "node_modules/*" = "deny";
        ".venv/*" = "deny";
        "venv/*" = "deny";
      };
      edit = {
        "*" = "ask";
        ".env" = "deny";
        ".git/*" = "deny";
        "node_modules/*" = "deny";
        ".venv/*" = "deny";
        "venv/*" = "deny";
      };
      bash = {
        "*" = "ask";
        "ls*" = "allow";
        "pwd" = "allow";
        "git status*" = "allow";
        "git diff*" = "allow";
        "git log*" = "allow";
        "dex *" = "allow";
      };
      webfetch = "ask";
    };

    # Mask patterns applied to read results when a rule resolves to "cloak"
    masks = {
      read = {
        ".env" = { pattern = "(=).+"; replace = "$1"; };
        "*.env" = { pattern = "(=).+"; replace = "$1"; };
        "*.env.*" = { pattern = "(=).+"; replace = "$1"; };
        "*.vars*" = { pattern = "(=).+"; replace = "$1"; };
      };
    };
  };
};
```

### Non-Nix configuration

Copy `pi/extensions/permission-system.ts` to `~/.pi/agent/extensions/` and create
`~/.pi/agent/permissions.json`:

```json
{
  "rules": {
    "read": {
      "*": "allow",
      ".env": "cloak"
    },
    "bash": {
      "*": "ask",
      "ls*": "allow",
      "pwd": "allow"
    }
  },
  "masks": {
    "read": {
      ".env": { "pattern": "(=).+", "replace": "$1" }
    }
  }
}
```

Rules and masks are merged with project-local `.pi/permissions.json` (project takes precedence).

## External Pi Extensions

In addition to local extensions in `pi/extensions/`, dot-agents supports external
Pi extensions — third-party npm packages that Pi loads via its package manager.

The registry at `nix/pi-external-extensions.nix` is the single source of truth
for which external extensions are available.

### How it works

Pi discovers external extensions through `settings.json` → `packages`:

```json
{
  "packages": ["pi-mcp-adapter"]
}
```

Pi resolves packages from `~/.pi/agent/npm/<name>/` (global) or `.pi/npm/<name>/`
(project). Each package declares its extension entry point in its `package.json`
under the `pi.extensions` field.

### Architecture

```
nix/pi-external-extensions.nix    ← single source of truth (registry)
  ├── Nix: packages.nix builds each npm package as a fixed-output derivation
  │         home-manager.nix deploys to ~/.pi/agent/npm/<name>/
  │         + merges packages into ~/.pi/agent/settings.json
  └── Stow: stow-tree.nix includes a settings.json with packages array
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

    # Or pick specific ones:
    externalExtensions = ["pi-mcp-adapter"];

    # Or disable all:
    externalExtensions = [];
  };
};
```

Available extensions: `pi-mcp-adapter`

### Non-Nix (stow)

The stow branch includes a `.pi/agent/settings.json` with external packages.
`setup.sh` runs `pi install npm:<name>` for each if `pi` is available.
If Pi isn't installed yet, the settings are in place and packages will be
installed when `pi install` is run later.

### Adding a new external extension

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

**Step 3 — Get the npm dependencies hash**

Temporarily set `npmDepsHash = ""` in the registry entry, then:

```bash
nix build .#my-extension --rebuild 2>&1 | grep 'got:'
# Copy the sha256 from the error message into `npmDepsHash`
```

This is a fixed-output derivation — it only needs to build once, then Nix
caches the result.

**Step 4 — Add to stow setup (non-Nix users)**

Add the package name to the `EXTERNAL_PI_PACKAGES` array in `stow/setup.sh`:

```bash
EXTERNAL_PI_PACKAGES=(
  "pi-mcp-adapter"
  "my-extension"    # ← add here
)
```

Also add it to the array inside the post-merge hook in the same file.

**Step 5 — Verify**

Nix: after Home Manager rebuild, the extension is in `~/.pi/agent/npm/<name>/`
and listed in `~/.pi/agent/settings.json`. Start Pi and confirm the extension
loads via `/mcp` (for pi-mcp-adapter) or the extension's own commands.

Stow: run `./setup.sh` — if `pi` is installed, the extension is installed
automatically. Otherwise Pi will use it on next startup after `pi install npm:<name>`.

**Summary of files to change when adding an extension:**

1. `nix/pi-external-extensions.nix` — registry entry with hashes
2. `stow/setup.sh` — add to `EXTERNAL_PI_PACKAGES` array (×2: main + post-merge hook)

That's it. The rest is automatic — Nix builds and deploys the derivation,
Home Manager merges settings.json, and stow runs `pi install`.

## Pi Permissions (continued)

### Permission values

| Value | Behavior |
|-------|----------|
| `"allow"` | Execute without prompting |
| `"deny"` | Block immediately |
| `"ask"` | Show Yes/No/Explain prompt |
| `"cloak"` | Allow, but mask secrets in the result (read tool only in v1) |

### Mask patterns

Each mask is a regex applied to the text content of `read` results:

- `pattern` — JS RegExp pattern string
- `replace` — Replacement template using native `.replace()` semantics (e.g. `"$1"`, `"$&"`)
- `flags` — RegExp flags, defaults to `"g"`

If `replace` is omitted, the matched text is replaced with asterisks (`*`).

### Commands

- `/permissions` — show current rules and masks
- `/permissions-reload` — reload config from disk

## Adding Skills

1. Create a directory under `skills/<skill-name>/`
2. Add a `SKILL.md` with proper YAML frontmatter
3. Register the skill in `nix/skills.nix`
4. Rebuild or push to trigger the `stow` branch update
