# dot-agents Skills

This directory contains universal agent skills available to all supported agents (Pi, OpenCode, and future agents).

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

## Adding New Skills

1. Create directory: `skills/my-new-skill/`
2. Create `skills/my-new-skill/SKILL.md` with proper format
3. Add skill to `nix/skills.nix` registry
4. Rebuild with Nix or wait for the `stow` branch to update

## Global Installation

Universal skills in this directory are installed to `~/.agents/skills/` by default, which both Pi and OpenCode discover automatically.
