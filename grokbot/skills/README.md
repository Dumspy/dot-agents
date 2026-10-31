# Grok Bot skills

Skills in this directory are for Grok Bot only. Grok Bot reads `grokbot/skills/` and the shared `skills/` directory from this GitHub repository.

Nix and Stow install Pi and OpenCode. They take universal skills from the registry in `nix/skills.nix` and agent files from `pi/` and `opencode/`. Leave this directory out of that registry. Nothing here is copied into `~/.agents/skills/` or the `stow` branch.

## When to put a skill here

| Put it in | When |
|-----------|------|
| `grokbot/skills/<name>/` | Only Grok Bot should load it. Personal and home skills live here (laundry booking, Home Assistant, and similar). |
| `skills/<name>/` | Pi, OpenCode, and Grok Bot should all follow it. Register it in `nix/skills.nix`. |
| `pi/skills/<name>/` | Only Pi should load it. |
| `opencode/skills/<name>/` | Only OpenCode should load it. |

## Format

Each skill is a directory with one `SKILL.md`. The same format is used in `skills/`. Frontmatter follows the [Agent Skills specification](https://agentskills.io/specification):

```markdown
---
name: skill-name
description: When to use this skill (1-1024 characters).
---

Instructions the agent follows.
```

The directory name and `name` match: 1-64 characters, lowercase alphanumeric, single hyphens, matching `^[a-z0-9]+(-[a-z0-9]+)*$`.

This `README.md` is documentation. A skill is a subdirectory that contains `SKILL.md`.

Shared skills need to stay agent-neutral: describe the action ("search the web", "read the file") and leave out tool names that only one agent has. A skill in this directory may mention Grok Bot's own tools, because the other agents do not load it.

## Secrets

This repository is public. A skill may describe a personal workflow. It must keep tokens, API keys, passwords, private keys, session cookies, and `.env` contents out of git. Name the environment variable or local file the agent should read.
