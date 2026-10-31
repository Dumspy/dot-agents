# dot-agents Skills

This directory contains universal agent skills for every supported agent: Pi, OpenCode, Claude Code, and Grok Bot.

## Directory Structure

```
skills/
├── skill-name/              # One directory per skill
│   └── SKILL.md             # Skill definition with YAML frontmatter
└── another-skill/
    └── SKILL.md
```

## Skill Format

Each skill directory must contain a `SKILL.md` file with proper YAML frontmatter per the [Agent Skills specification](https://agentskills.io/specification):

```markdown
---
name: skill-name
description: Brief description (1-1024 characters)
license: MIT                    # Optional
compatibility: opencode         # Optional
metadata:                       # Optional
  author: your-name
  category: utility
---

## What I do
- Skill functionality description

## When to use me
Use this when you need specific functionality.
```

## Naming Rules

Skill names (directory names) must:
- Be 1-64 characters
- Be lowercase alphanumeric with single hyphen separators
- Not start or end with `-`
- Not contain consecutive `--`
- Match regex: `^[a-z0-9]+(-[a-z0-9]+)*$`

## Writing for every agent

Pi, OpenCode, Claude Code, and Grok Bot all follow skills in this directory. Write the instructions so each agent can run them with its own tools.

- State the outcome, the inputs, and when to use the skill.
- Name the action in plain language ("search the web", "read the file", "run the tests"). Leave out tool names, slash commands, and config paths that only one agent has.
- A skill that only makes sense for one agent belongs in `pi/skills/`, `opencode/skills/`, or `grokbot/skills/`.
- Omit `compatibility` in this directory. A skill pinned to one agent belongs in that agent's directory.

## Adding New Skills

1. Create directory: `skills/my-new-skill/`
2. Create `skills/my-new-skill/SKILL.md` with proper format
3. Add skill to `nix/skills.nix` registry
4. Rebuild with Nix or wait for the `stow` branch to update

Skills only Grok Bot should load go in `grokbot/skills/` and stay out of `nix/skills.nix`. See `grokbot/skills/README.md`.

## Secrets

This repository is public. Personal skills that contain no secrets may be committed. Never commit tokens, API keys, passwords, private keys, session cookies, or `.env` files. Name the environment variable or local file the agent should read.

## Global Installation

Nix and Stow install this directory to `~/.agents/skills/`, which Pi and OpenCode discover. Claude Code reads `~/.claude/skills/<name>/SKILL.md` and does not read `~/.agents/skills/`, so the same install symlinks each skill to `~/.claude/skills/<name>/`. Grok Bot reads the same files from this GitHub repository. `grokbot/skills/` is Grok Bot-only and is left out of that install.
