# dot-agents

Universal agent configuration for Pi, OpenCode, and future AI coding agents.

## What's inside

| Directory | Purpose | Install target |
|-----------|---------|----------------|
| `skills/` | Universal skills (all agents) | `~/.agents/skills/` |
| `agents/` | Subagent definitions | `~/.config/opencode/agents/` |
| `pi/skills/` | Pi-specific skills | `~/.pi/agent/skills/` |
| `pi/extensions/` | Pi TypeScript extensions | `~/.pi/agent/extensions/` |
| `pi/permissions.json` | Pi permission config | `~/.pi/agent/permissions.json` |
| `opencode/skills/` | OpenCode-specific skills | `~/.config/opencode/skills/` |
| `opencode/commands/` | OpenCode commands | `~/.config/opencode/commands/` |
| `opencode/extensions/` | OpenCode extensions | agent-specific |

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
  enableAllSkills = true;
  agents = [ "code-simplifier" "librarian" "oracle" ];
};
```

Or enable individual skills as separate modules:

```nix
imports = [
  inputs.dot-agents.homeModules.dependabot-solver
  inputs.dot-agents.homeModules."frontend-design"
];
```

## Non-Nix (Stow)

For non-Nix systems, use the auto-generated `stow` branch which vendors all external skills:

```bash
git clone --branch stow https://github.com/<you>/dot-agents.git ~/dot-agents
cd ~/dot-agents
stow . -t ~
```

The `stow` branch is automatically updated by a GitHub Action on every push to `main`.

## Structure

```
dot-agents/
├── skills/           # Universal skills (all agents discover these)
├── agents/           # Subagent definitions (.md files)
├── pi/               # Pi-specific artifacts
│   ├── skills/
│   ├── commands/
│   └── extensions/
├── opencode/         # OpenCode-specific artifacts
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
