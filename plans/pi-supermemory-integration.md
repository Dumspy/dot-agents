# pi + SuperMemory Integration Plan

> Canonical design for the pi SuperMemory extension.  
> Supersedes the draft in `~/dotfiles/docs/pi-supermemory-integration.md`.

## Goal

Give the pi coding agent persistent memory by integrating with our self-hosted
SuperMemory server on `master-node`.

`SUPERMEMORY_API_URL` only works for the OpenCode TUI — it does nothing for pi.
We therefore build a pi extension that hooks the agent lifecycle and registers
a `supermemory` tool the LLM can call.

## Reference Implementations

We studied two references:

- **[opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)** —
  official OpenCode plugin. We adopt its data model, context-injection format,
  and tool modes.
- **[ramarivera/pi-supermemory](https://github.com/ramarivera/pi-supermemory)** —
  community pi extension. We borrow its pi-specific event patterns (`input`,
  `context`, `turn_end`) but keep v1 simpler.

## Design Decisions

### 1. Container tags (scopes)

We use **two auto-generated container tags**, matching the official plugin:

- **User scope:** `pi_user_<sha16(git user.email)>` (fallback to `$USER`)
- **Project scope:** `pi_project_<sha16(cwd)>`

No env overrides for the tags in v1. Cross-project preferences live in the user
container; repo-specific knowledge lives in the project container.

### 2. API client

Use the official **`supermemory` npm SDK** (`^4.0.0`).

- Add it to the shared `pi/package.json`.
- Create `pi/extensions/supermemory.ts` (single file, like the other extensions).
- All writes go through `client.memories.add(...)` with metadata.
- Base URL comes from `SUPERMEMORY_API_BASE_URL`, default `http://master-node:6767`.

### 3. Context injection

**First message only.** On the first user turn, before the LLM runs, fetch and
inject an invisible `[SUPERMEMORY]` block:

```
[SUPERMEMORY]

User Profile:
- Prefers concise responses

Project Knowledge:
- [100%] Uses flakes for Nix configs
- [100%] Deploys via deploy-rs

Relevant User Memories:
- [82%] Build fails if .env.local missing
```

Sources:

- `profile(userContainer)` — up to 5 static + 5 dynamic facts.
- `listMemories(projectContainer, limit = 10)` — recent project memories.
- `searchMemories(query, userContainer, limit = 5)` — user memories relevant
  to the first user query.

If any call fails or times out (30 s), fail open and return the original
messages.

### 4. Keyword-based memory (no broad auto-capture)

When the user says something like “remember that we use bun”, **nudge the
assistant** by injecting a hidden instruction telling it to call `supermemory`
`mode: "add"`. The assistant chooses scope (`user`/`project`) and type.

Default keyword patterns come from the official plugin:

```
remember, memorize, save this, note this, keep in mind,
don't forget, learn this, store this, record this,
make a note, take note, commit to memory,
remember that, never forget, always remember
```

Optional env override: `PI_SUPERMEMORY_KEYWORD_PATTERNS` (comma-separated
regexes).

We deliberately **do not** do broad `turn_end` auto-capture, to avoid bloated
or low-signal memories.

### 5. Tool spec

Register one tool: `supermemory`.

Modes (match the official plugin):

| Mode | Args |
|------|------|
| `add` | `content`, `scope?: "user" \| "project"`, `type?: MemoryType` |
| `search` | `query`, `scope?: "user" \| "project"`, `limit?: number` |
| `profile` | `query?: string` |
| `list` | `scope?: "user" \| "project"`, `limit?: number` |
| `forget` | `memoryId: string` |

Memory types (official plugin):

- `project-config`
- `architecture`
- `error-solution`
- `preference`
- `learned-pattern`
- `conversation`

`scope` defaults to `project`; `type` is optional.

### 6. Human commands

Register `/supermemory` with minimal subcommands:

- `/supermemory status` — show config and connection state.
- `/supermemory save-file <path> [containerTag]` — read a file and save it to
  the active container.
- `/supermemory init` — agent-driven codebase exploration (see below).

Search/save/forget are left to the tool; the commands are for things the human
wants to do directly.

### 7. Privacy redaction

Strip `<private>...</private>` blocks from any content before saving. If the
content is empty after stripping, return an error instead of saving.

### 8. Metadata on saved memories

Stamp every memory with:

- `sm_source: "pi"`
- `sm_capture_mode`: `"tool"`, `"command"`, or `"compaction"`
- `type` when provided by the tool

This matches the official plugin and makes the SuperMemory UI useful.

### 9. Compaction integration (minimal v1)

Hook `session_compact`. When pi produces a compaction summary, save it to the
**project container** with `type: "conversation"`.

We do **not** generate a custom summary in `session_before_compact` in v1. If
we notice memories being lost after compaction, we can upgrade to the richer
approach later: fetch project memories in `session_before_compact` and return a
custom summary that explicitly preserves project context.

### 10. Configuration

v1 is env-only. Secrets stay in env vars; everything else is hardcoded with
sensible defaults.

| Variable | Default | Purpose |
|---|---|---|
| `SUPERMEMORY_API_KEY` | required | API key |
| `SUPERMEMORY_API_BASE_URL` | `http://master-node:6767` | Server URL |
| `PI_SUPERMEMORY_ENABLED` | `true` | Master switch |
| `PI_SUPERMEMORY_INJECT_PROFILE` | `true` | Include profile in first-message context |
| `PI_SUPERMEMORY_KEYWORD_PATTERNS` | `""` | Extra keyword regexes |

Hardcoded defaults:

- `maxRecall = 5`
- `maxProfileItems = 5`
- `maxProjectMemories = 10`
- `similarityThreshold = 0.6`
- per-call timeout = 30 s

A future JSON config file (`~/.config/pi/supermemory.json`) is the escape hatch
if we need more tunables without env pollution.

### 11. Project-local config

Deferred. v1 has no `.pi/supermemory.json`, directory overrides, or model rules.
If we later need per-project containers or disable/enable rules, we can adopt
something like the community extension’s policy system.

## File Layout

```
pi/
├── package.json          # add "supermemory": "^4.0.0"
├── package-lock.json     # update via npm install
├── node_modules/
│   └── supermemory/      # SDK
└── extensions/
    ├── supermemory.ts    # this extension
    ├── answer.ts
    ├── notify.ts
    └── ...
```

The extension is auto-discovered by pi because it lives in `pi/extensions/`.

## `/supermemory init` — Agent-Driven Codebase Exploration

When the user runs `/supermemory init`:

1. The extension builds a file tree (via `git ls-files` or recursive scan).
2. It checks for the existence of common key files:
   `README.md`, `AGENTS.md`, `package.json`, `flake.nix`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, `Makefile`, `justfile`, `.editorconfig`, `.gitignore`.
3. It sends a user message to the agent containing:
   - the file tree,
   - a list of suggested files to read,
   - instructions to save architecture/convention memories to the project
     container using the `supermemory` tool.

The agent decides what to read, summarize, and save.

## Implementation Phases

### Phase 1 — Tool + SDK

- Add `supermemory` to `pi/package.json`.
- Create `pi/extensions/supermemory.ts`.
- Register the `supermemory` tool (`add`, `search`, `profile`, `list`, `forget`).
- Test against `master-node` with `SUPERMEMORY_API_KEY` set.

### Phase 2 — First-Message Context Injection

- Hook `input` to capture the first user query.
- Hook `context` to inject the `[SUPERMEMORY]` block on the first turn.
- Fetch profile, project memories, and relevant user memories.
- Handle failures gracefully (fail open).

### Phase 3 — Keyword Nudge + Commands

- Detect memory keywords on `input` and nudge the assistant.
- Register `/supermemory status`.
- Register `/supermemory save-file <path>`.
- Add privacy redaction.

### Phase 4 — Compaction + Codebase Init

- Hook `session_compact` and save the summary to the project container.
- Register `/supermemory init` (agent-driven exploration).
- Polish: error messages, status output, chunking if content exceeds SDK limits.

## Notes / Future Options

- **Rich compaction:** If memories feel lost after compaction, upgrade to a
  custom `session_before_compact` summary that injects project memories.
- **Per-turn recall:** If first-message injection is insufficient, add a
  lightweight search on later turns.
- **Project-local config:** If different repos need different behavior, add
  `.pi/supermemory.json` support.
- **Auto-capture:** We explicitly removed broad `turn_end` capture. Revisit only
  if keyword nudges prove too manual.
