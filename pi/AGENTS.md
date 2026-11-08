# Pi Extensions Development

This directory contains TypeScript extensions for the [Pi Coding Agent](https://pi.dev/).

## Structure

```
pi/
├── package.json              # Shared deps for all extensions (private, not published)
├── tsconfig.json             # TypeScript config for `npm run check`
├── AGENTS.md                 # This file
└── extensions/
    ├── notify.ts                  # Flat-file extension
    └── permission-system/         # Folder extension
        ├── index.ts               # Extension entry point
        ├── lib.ts                 # Pure logic (testable)
        └── lib.test.ts            # Unit tests
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

Tests use [Vitest](https://vitest.dev/). We test pure logic extracted out of `index.ts` (usually into `lib.ts`). Extension event handlers that depend on Pi's `ExtensionAPI` are not unit-tested — type checking is the safety net for those.

## Adding a New Extension

1. Create `pi/extensions/my-extension.ts`, or `pi/extensions/my-extension/index.ts` if it needs tests or more than one file
2. Import types from `@earendil-works/pi-coding-agent`
3. Extract any complex pure logic into `my-extension/lib.ts`
4. Add tests in `my-extension/lib.test.ts`
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

### Extension with npm dependencies

There are no per-extension `package.json` files. All extensions share
`pi/package.json`:

```bash
cd pi
npm install some-lib
```

Then update the `outputHash` entries in `nix/pi-node-modules.nix` (the file
explains how to get the new hash).

## Nix Integration

The Home Manager module installs extensions to `~/.pi/agent/extensions/` for end users.
It also deploys `package.json` and the locked `node_modules` (built by
`nix/pi-node-modules.nix`) to `~/.pi/agent/`, so extensions can resolve their imports.
`tsconfig.json` and the tests are only for local development and are not shipped.

## External Extensions

Third-party npm extensions are listed in `nix/pi-external-extensions.nix`.
Pi discovers them via `settings.json` → `packages` and loads them from
`~/.pi/agent/npm/node_modules/<name>/`. See README.md for the full architecture and
step-by-step guide for adding new ones.

## Permission System Extension

The built-in `permission-system` extension provides configurable gates and secret masking for Pi tools.

### Permission values

| Value | Behavior |
|-------|----------|
| `"allow"` | Execute without prompting |
| `"deny"` | Block immediately |
| `"ask"` | Show Yes/No/Explain prompt |
| `"cloak"` | Allow, but mask secrets in the result (read tool only in v1) |

### Config file

Create `~/.pi/agent/permissions.json` (or use Nix — see README):

```json
{
  "rules": {
    "read": {
      "*": "allow",
      ".env": "cloak",
      ".ssh/*": "deny"
    },
    "bash": {
      "*": "ask",
      "ls*": "allow"
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

### Herdr integration

While a permission prompt is on screen, the extension emits `herdr:blocked`
on the extension event bus so Herdr's Pi integration marks the pane as blocked
(waiting for human). Enabled by default; opt out with:

```json
{
  "herdr": { "enabled": false }
}
```

`/permissions` shows whether blocked reporting is enabled.

### Mask patterns

Each mask is a regex applied to the text content of `read` results:

- `pattern` — JS RegExp pattern string
- `replace` — Replacement template using native `.replace()` semantics (e.g. `"$1"`, `"$&"`)
- `flags` — RegExp flags, defaults to `"g"`

If `replace` is omitted, the matched text is replaced with asterisks (`*`).

### Commands

- `/permissions` — show current rules and masks
- `/permissions-reload` — reload config from disk
