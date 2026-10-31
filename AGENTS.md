# Agent Configuration Source of Truth

This repository is the canonical source for all agent configuration.

Supported agents: Pi, OpenCode, and Grok Bot.

## What's here

| Directory | Purpose |
|-----------|---------|
| `skills/` | Universal skills shared by Pi, OpenCode, and Grok Bot |
| `grokbot/skills/` | Skills only Grok Bot reads |
| `opencode/agents/` | OpenCode subagent definitions |
| `pi/` | Pi-specific extensions, skills, themes, and permissions |
| `opencode/` | OpenCode-specific skills, commands, and extensions |
| `nix/` | Nix flake, packages, Home Manager modules, and external extension registry |

## Installation targets

- Universal skills: `~/.agents/skills/` (Pi and OpenCode)
- Pi extensions: `~/.pi/agent/extensions/`
- Pi skills: `~/.pi/agent/skills/`
- OpenCode agents: `~/.config/opencode/agents/`
- OpenCode commands: `~/.config/opencode/commands/`
- OpenCode skills: `~/.config/opencode/skills/`
- Grok Bot: reads `skills/` and `grokbot/skills/` from this GitHub repository

## How it gets to the machine

Nix/Home Manager installs Pi and OpenCode artifacts to the targets above. The skill registry is `nix/skills.nix`. `grokbot/skills/` stays out of that registry, so Nix leaves it on GitHub.

Non-Nix: the auto-generated `stow` branch is a GNU Stow tree for the same Pi and OpenCode targets. Stow generation copies only those targets, so `grokbot/` stays on `development`.

## Where a skill goes

| Kind | Path | How it reaches the agent |
|------|------|--------------------------|
| Shared by every agent | `skills/<name>/` | `nix/skills.nix`, then Nix or Stow to `~/.agents/skills/`. Grok Bot reads it from GitHub. |
| Pi only | `pi/skills/<name>/` | Nix or Stow to `~/.pi/agent/skills/` |
| OpenCode only | `opencode/skills/<name>/` | Nix or Stow to `~/.config/opencode/skills/` |
| Grok Bot only | `grokbot/skills/<name>/` | Grok Bot reads it from GitHub. Leave it out of `nix/skills.nix`. |

Personal and home skills (a laundry booking service, Home Assistant, and similar) belong in `grokbot/skills/` when Pi and OpenCode should not load them. Generic skills that any agent can follow belong in `skills/`.

## Writing skills that work across agents

`SKILL.md` is YAML frontmatter (`name`, `description`) plus markdown instructions, per the [Agent Skills specification](https://agentskills.io/specification).

A skill under `skills/` is shared. Write it so Pi, OpenCode, and Grok Bot can each follow it with their own tools:

- State the outcome, the inputs, and when to use the skill.
- Name the action in plain language ("search the web", "read the file", "run the tests"). Leave out tool names, slash commands, and config paths that only one agent has.
- Keep steps that only make sense for one agent in that agent's skill directory.

## Secrets

This repository is public. Personal skills that contain no secrets may be committed. Never commit tokens, API keys, passwords, private keys, session cookies, or `.env` files. Tell the skill which environment variable or local file to read, and keep the value out of git.
