# Pi Extensions Development

This directory contains TypeScript extensions for the [Pi Coding Agent](https://pi.dev/).

## Structure

```
pi/
├── package.json              # Workspace root (private, not published)
├── tsconfig.json             # TypeScript config
├── AGENTS.md                 # This file
└── extensions/
    └── permission-gate/           # Multi-file extension
        ├── index.ts               # Orchestration + commands
        ├── plan.ts                # Read-only argv planner
        ├── floor.ts               # Deterministic hard floor
        ├── shell.ts               # Shared stage scanner
        ├── review.ts              # Classifier call + evidence
        ├── policy.ts              # The three questions
        ├── intent.ts              # Trusted user turns
        ├── environment.ts         # Git facts
        ├── decide.ts              # allowAt/denyAt bands
        ├── approvals.ts           # /allow one-shot
        └── log.ts                 # JSONL rows
```

**Flat file:** single `.ts` file directly in `extensions/`. Use this for simple extensions.  
**Folder:** create a directory with an `index.ts` entry point for anything that needs more than one file (logic, tests, types, constants, etc.). Name test files `*.test.ts` (e.g. `lib.test.ts`) so TypeScript excludes them from the `npm run check` build.

## Getting Started

Enter the development shell:

```bash
nix develop
```

This provides `node` and `npm`. The shell hook automatically runs `npm install` in the `pi/` directory.

## Type Checking

```bash
cd pi
npm run check        # One-shot type check
npm run check:watch  # Watch mode
```

## Testing

```bash
cd pi
npm test             # Run all tests once
npm run test:watch   # Watch mode
```

Tests use [Vitest](https://vitest.dev/). We test pure logic extracted into `.lib.ts` files. Extension event handlers that depend on Pi's `ExtensionAPI` are not unit-tested — type checking is the safety net for those.

## Adding a New Extension

1. Create `pi/extensions/my-extension.ts`
2. Import types from `@earendil-works/pi-coding-agent`
3. Extract any complex pure logic into `my-extension.lib.ts`
4. Add tests in `my-extension.test.ts`
5. Run `npm run check` and `npm test` to validate
6. The Nix module auto-deploys extensions on the next Home Manager rebuild

## Extension Patterns

### Simple extension (flat file)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // ...
  });
}
```

### Complex extension (with dependencies)

```
pi/extensions/advanced-ext/
├── package.json
└── index.ts
```

```bash
cd pi
npm install some-lib --workspace=extensions/advanced-ext
```

## Nix Integration

The Home Manager module installs extensions to `~/.pi/agent/extensions/` for end users.
The workspace root (`package.json`, `tsconfig.json`, `node_modules`) is **only for local
development** and is not shipped to dependants.

## External Extensions

Third-party npm extensions are listed in `nix/pi-external-extensions.nix`.
Pi discovers them via `settings.json` → `packages` and loads them from
`~/.pi/agent/npm/node_modules/<name>/`. See README.md for the full architecture and
step-by-step guide for adding new ones.

## Permission Gate Extension

The built-in `permission-gate` extension replaces glob rules with a planner, a
deterministic floor, and a SystemOne reviewer. The shipped design lives in
`plans/permission-gate.md`.

### Pipeline

| Layer | Behavior |
|-------|----------|
| Planner (`plan.ts`) | Proves routine read-only shell work (`ls`, `cat`, `rg`, `git status`) and runs it without a model call. |
| Floor (`floor.ts`) | Blocks final shapes/paths: recursive delete, sudo/eval/source, force-push, hard-reset, pipe-to-shell, env dumps, secret egress, paste uploads, credential stores, git internals, `.env` writes. Override only with `/allow`. |
| Reviewer (`review.ts`, `policy.ts`) | One `classify()` call with three narrow questions: injection, exfiltration, external effect. `allowAt`/`denyAt` decide allow, hold, or block. |

Writes/edits inside the workspace are floor-only. Flagged reads (outside the
workspace or secret-adjacent) and calls outside it are reviewed. `.env` read
output is masked.

### Config file

Create `~/.pi/agent/gate.json` (or use Nix — see README):

```json
{
  "provider": "typesafe",
  "model": "jev-latest",
  "allowAt": 0.25,
  "denyAt": 0.6,
  "onUncertain": "hold"
}
```

`onUncertain: "ask"` opens a Yes/No prompt for the middle band; the default
`hold` refuses with guidance and no prompt. Per-model profiles are keyed by
`provider/model`, e.g. `cloudflare-workers-ai/@cf/cloudflare/clef-flash`.
Without provider credentials every reviewed call fails closed.

### Herdr integration

While a permission prompt is on screen (the reviewer-unavailable fallback or
`onUncertain: "ask"`), the extension emits `herdr:blocked` on the extension
event bus so Herdr's Pi integration marks the pane as blocked (waiting for
human). The event is cleared when the prompt closes. `/judge` shows the
current state.

### Commands

- `/judge` — reviewer, thresholds, mid-band behavior, pending approval, recent blocks
- `/gate-log` — the last 15 decisions from `~/.pi/agent/gate.log.jsonl`
- `/allow` — one-shot approval for one recent block
