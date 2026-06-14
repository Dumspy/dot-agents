---
name: issue-to-pr
description: |
  Resolve a GitHub issue in the dot-agents repository and open a pull request.
  Use this skill whenever the user asks to fix, resolve, or implement a GitHub issue,
  e.g. "fix issue #12", "resolve #12 and #13", "work on issue #N", or
  "create a PR for issue #N". This is the canonical workflow for turning an issue
  into a merged fix in this repo.
---

# issue-to-pr

Resolve one or more GitHub issues in the `Dumspy/dot-agents` repository and open
a pull request that closes them.

This workflow is tuned for this repo. It assumes:

- `gh` CLI is installed and authenticated.
- The current directory is a git checkout of `Dumspy/dot-agents`.
- The repo uses Nix, conventional commits, and a `development` base branch.

## Workflow

### 1. Read the issue(s)

Use `gh issue view <N> --repo Dumspy/dot-agents --json title,body,labels,comments` for each issue.
If the issue has no description or comments, treat the title as the primary
source of intent.

### 2. Decide if there is enough context

If after reading the issue you cannot infer:

- what needs to change, and
- where in the repo the change belongs,

stop and ask the user a targeted clarifying question. Do not guess.

### 3. Explore the repo

Search the codebase for relevant files. Useful places in this repo:

- `.github/workflows/` for CI-related issues.
- `nix/` for Nix/build-related issues.
- `pi/` for Pi extension issues.
- `stow/` and `nix/stow-tree.nix` for stow-branch issues.
- `skills/` and `.agents/skills/` for skill-related issues.

Read the files you need to understand before making changes.

### 4. Implement the fix

Make the smallest change that resolves the issue. Prefer:

- editing existing files over adding new ones,
- repo conventions already in use,
- keeping the PR focused on the issue.

### 5. Validate the fix

Run validation commands based on the files you changed. Use `git status` to see
what changed, then run the matching checks:

| Changed path | Validation command |
|--------------|--------------------|
| `nix/**`, `flake.nix` | `nix flake check .` |
| `pi/**` | `cd pi && npm run check && npm test` |
| `stow/**` | `nix build .#stow-tree` |
| `nix/stow-tree.nix` | `nix build .#stow-tree` |
| `.github/workflows/**` | `nix flake check .` |
| `skills/**` or `.agents/skills/**` | `nix flake check .` |

If validation fails, analyze the failure and attempt to fix it. Re-run the
relevant validation after each fix. If you cannot resolve the failure after
2–3 attempts, stop and report the failure to the user with the logs.

### 6. Create a branch

Generate a branch name from the issue summary:

- Lowercase, kebab-case.
- Format: `fix/<issue>-<short-slug>` or `feat/<issue>-<short-slug>`.
- For multiple issues: `fix/<primary>-<secondary>-<short-slug>`.

Examples:

- Issue #12 "gitignore for node_modules on stow branch" → `fix/12-stow-node-modules`
- Issues #12 and #13 about stow helpers → `fix/12-13-stow-helpers`

Create and switch to the branch before committing.

### 7. Commit

Use conventional commits:

```
type(scope): description

- bullet points of changes
```

Infer `type` from the issue (`fix`, `feat`, `chore`, `docs`, etc.), defaulting
to `fix`. Infer `scope` from the main area changed (`stow`, `nix`, `pi`,
`skills`, `github`, etc.).

### 8. Open a pull request

Push the branch to origin, then create a PR against `development` with:

- **Title:** `Closes #N, closes #M: <summary>` (or `Closes #N: <summary>` for a single issue).
- **Body:** A short summary of what changed and why, plus the closed issues.

Use the `gh pr create` command with the `--base development` flag.

## When to stop and ask the user

Stop and ask for help if:

- The issue is unactionable after reading it and exploring the repo.
- Validation fails and you cannot fix it after 2–3 attempts.
- `git push` is rejected and you cannot resolve it without force-pushing.
- The fix would require modifying CI secrets, protected branches, or external resources.

## Example invocation

> "fix issue #12 and #13"

Expected behavior:

1. Read issues #12 and #13.
2. Explore `nix/stow-tree.nix`, `stow/` (if it exists), and related files.
3. Implement the fix.
4. Validate with `nix build .#stow-tree` and `nix flake check .`.
5. Create branch `fix/12-13-stow-helpers`.
6. Commit and push.
7. Open PR titled `Closes #12, closes #13: ...` against `development`.