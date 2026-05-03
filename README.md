# dot-agents

Universal agent configuration for Pi, OpenCode, and future AI coding agents.

## What's inside

| Directory | Purpose | Install target |
|-----------|---------|----------------|
| `skills/` | Universal skills (all agents) | `~/.agents/skills/` |
| `agents/` | Subagent definitions | `~/.config/opencode/agents/` |
| `pi/skills/` | Pi-specific skills | `~/.pi/agent/skills/` |
| `pi/extensions/` | Pi TypeScript extensions | `~/.pi/agent/extensions/` |
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

## Adding Skills

1. Create a directory under `skills/<skill-name>/`
2. Add a `SKILL.md` with proper YAML frontmatter
3. Register the skill in `nix/skills.nix`
4. Rebuild or push to trigger the `stow` branch update
