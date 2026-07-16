# Pi Extensions Development

This directory contains TypeScript extensions for the [Pi Coding Agent](https://pi.dev/).

## Structure

```
pi/
├── package.json              # Workspace root (private, not published)
├── tsconfig.json             # TypeScript config
├── AGENTS.md                 # This file
└── extensions/
    ├── permission-system/         # Legacy permission extension
    └── sandbox/                   # Gondolin sandbox extension
        ├── index.ts               # Extension entry point
        ├── backends/              # Host and sandbox backends
        └── test/                  # Unit and opt-in VM tests
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

## Permission System Extension

The legacy `permission-system` extension provides configurable gates and secret masking for Pi tools. It remains the default while `programs.dot-agents.pi.sandbox.enable` is false; the Home Manager module selects the sandbox extension instead when the experimental sandbox is enabled.

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

### Mask patterns

Each mask is a regex applied to the text content of `read` results:

- `pattern` — JS RegExp pattern string
- `replace` — Replacement template using native `.replace()` semantics (e.g. `"$1"`, `"$&"`)
- `flags` — RegExp flags, defaults to `"g"`

If `replace` is omitted, the matched text is replaced with asterisks (`*`).

### Commands

- `/permissions` — show current rules and masks
- `/permissions-reload` — reload config from disk
