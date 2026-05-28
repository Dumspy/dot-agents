# Agent Configuration Source of Truth

This repository is the canonical source for all agent configuration.

## What's here

| Directory | Purpose |
|-----------|---------|
| `skills/` | Universal agent skills (discovered by Pi, OpenCode, and future agents) |
| `opencode/agents/` | OpenCode subagent definitions |
| `pi/` | Pi-specific extensions, skills, and permissions |
| `opencode/` | OpenCode-specific skills, commands, and extensions |
| `nix/` | Nix flake, packages, and Home Manager modules |

## Installation targets

- Universal skills: `~/.agents/skills/`
- Pi extensions: `~/.pi/agent/extensions/`
- Pi skills: `~/.pi/agent/skills/`
- OpenCode agents: `~/.config/opencode/agents/`
- OpenCode commands: `~/.config/opencode/commands/`
- OpenCode skills: `~/.config/opencode/skills/`

## How it gets to the machine

Nix/Home Manager: this repo is a flake input that installs artifacts to the targets above.  
Non-Nix: the auto-generated `stow` branch can be used with GNU Stow.
