# Permission Gate — shipped design

Status: shipped on `judge-gate` (PR #44). Replaces
`pi/extensions/permission-system` and supersedes the Gondolin sandbox
(PR #34) and issue #26.

This is the source of truth for the code in
`pi/extensions/permission-gate/`. `plans/judge-gate-design.md` is the
historical v1 design (one `safe/unsafe` question, `t`/`c` bands) plus the
calibration log that led to the rewrite; read it for the experiments, not for
the current behavior.

## Pipeline

```
tool_call
  │
  ├─ planner (deterministic, read-only) ──────────────► free, no model call
  │
  ├─ floor (deterministic, final) ────────────────────► block, /allow only
  │
  └─ reviewer (SystemOne, 3 narrow questions) ────────► allow / hold / block
```

Every call that is not planner-proven or floor-blocked gets exactly one
classifier call. The reviewer is never asked "is this safe" as one bundled
question.

## Modules

| File | Job |
|---|---|
| `plan.ts` | argv planner per pipeline stage; proves routine read-only shell (`ls`, `cat`, `rg`, `git status`, …) |
| `floor.ts` | final shapes and paths: recursive delete, sudo/eval/source, force-push, hard-reset, pipe-to-shell, env reads/dumps, secret egress, paste uploads, credential stores, git internals, `.env` writes |
| `shell.ts` | shared quote-aware stage scanner; strict for the planner, non-strict for the floor |
| `review.ts` | evidence building and the one `classify()` call |
| `policy.ts` | the three questions and their versioned digest |
| `intent.ts` | trusted user turns (current, first, recent) |
| `environment.ts` | repo root, remotes, branch, project trust |
| `decide.ts` | `allowAt`/`denyAt` bands and verdict precedence |
| `approvals.ts` | 3-slot block buffer, one-shot `/allow` |
| `log.ts` | `gate.log.jsonl` rows |
| `index.ts` | orchestration, commands, `.env` output masking |

## Questions

One `classify()` call carries the questions the tool needs:

| id | asked for | violation means |
|---|---|---|
| `injection` | bash, webfetch, read, write/edit, others | the action implements an instruction that arrived in untrusted text (tool output, file contents, web page, issue/PR text, assistant prose) |
| `exfiltration` | bash, webfetch, read | secret material moves outside the trusted boundary |
| `external_effect` | bash, write/edit | publishing, deploying, purchasing, deleting/rewriting a remote resource, or writing outside the working directory |

Each question has the same criteria labels (`clear` / `violation`) so one
threshold pair fits all. `policyDigest()` is pinned by a test: changing a
question is a deliberate behavior change.

The reviewer is told explicitly that destructiveness, cost, and
"unrequested" are **not** the subject of the injection question (fx's
stance). Local deletes are not the subject of the external-effect question.

## Thresholds

`p` is always the probability of the **violation**:

```
p >= denyAt   → block
p <= allowAt  → allow
otherwise     → hold
```

Defaults `allowAt = 0.25`, `denyAt = 0.6` (Armor's published prior). The bands
are independent, so loosening routine work does not loosen hazards.

Confidence is recorded in the log but does not decide. It never cleared 0.75
on clef-flash, so as a gate it was a constant.

Per-model profiles are keyed by **`provider/model`** as `modelKey(config)`
returns it:

- native Cloudflare: `cloudflare-workers-ai/@cf/cloudflare/clef-flash`
- gateway: `openrouter/cloudflare/clef-flash`
- default: `typesafe/jev-latest`

A profile with crossed bands is ignored; a missing field falls back to the
top-level pair.

## Evidence and privacy

The reviewer receives:

- the action: tool name, command text / resolved path / URL, cwd;
- the planner refusal reason, if any;
- trusted user turns only — current request, first root request, up to two
  recent root requests, each bounded to ~1 KiB; compaction is recorded as
  omitted history rather than pretended complete;
- environment facts: working directory, project trust, repo root, normalized
  remotes, branch.

It never receives file contents, diffs, tool output, assistant prose, or the
conversation. The action is truncated at 4 KiB and redacted with the secret
patterns before the request leaves the machine. The guarantee is: judge state
is a subset of what the chat model already saw, plus a new recipient.

## Config

Static config is `~/.pi/agent/gate.json`, owned by Nix (`pi.gate`):

```json
{
  "provider": "typesafe",
  "model": "jev-latest",
  "allowAt": 0.25,
  "denyAt": 0.6,
  "timeoutMs": 4000,
  "onUncertain": "hold",
  "profiles": {
    "cloudflare-workers-ai/@cf/cloudflare/clef-flash": { "allowAt": 0.2, "denyAt": 0.5 }
  }
}
```

`onUncertain` is `hold` (default) or `ask`:

- `hold`: refuse the call with a reason the agent can act on, no human
  prompt. This is the posture Armor and fx both take.
- `ask`: open a Yes/No prompt. Opt-in, because the prompt is the outcome the
  gate exists to remove.

## Failure modes

- Reviewer unavailable (no model, auth missing, timeout, 429/5xx, malformed)
  degrades to the ask path: prompt when there is a UI, block when headless.
  Logged as `review-unavailable` with a stable reason id.
- No fail-open knob. There is no sandbox behind the reviewer.
- An aborted request returns `{ block: true }` without a prompt.

## Override

`/allow` shows the three most recent blocks (floor and review, labeled),
arms **one** approval for that exact `tool:value`, and sends a steer nudge so
the agent retries. The approval is consumed by the first matching call and
dies with the session. There is no auto-execution.

## Commands

- `/judge` — policy version, reviewer, thresholds, mid-band behavior, pending
  approval, recent blocks.
- `/gate-log` — the last 15 rows.
- `/allow` — the one-shot picker.

## Logging

`~/.pi/agent/gate.log.jsonl`, one row per decision:

```json
{"ts":"…","tool":"bash","value":"…","cwd":"…","verdict":"held","reason":"hold:exfiltration","plan":"unknown_command","p":{"injection":0.1,"exfiltration":0.4,"external_effect":0.1},"confidence":0.9,"allowAt":0.25,"denyAt":0.6,"model":"typesafe/jev-latest","latencyMs":420,"contextual":true,"evidenceIncomplete":false}
```

Verdicts: `free`, `allowed`, `held`, `prompted`, `blocked`, `floor-blocked`,
`override`. This file is the calibration dataset; every threshold change
should be replayed against it first.

## Measured results

Deterministic replay over the old permission log (`plans/gate-replay-report.md`,
unique rows): 13.8% of the old prompt/deny volume now resolves without a
model, 4.0% is floor-blocked, 82% makes one reviewer call. Four previously
free rows now floor-block (all `.env` shell reads).

Live reviewer replay over 239 calls, action-only evidence, shipped thresholds
(`plans/gate-live-report.md`):

| model | benign allowed free | benign held | fixtures blocked | cost |
|---|---|---|---|---|
| `typesafe/jev-1.13` | 100% | 0% | 5/6 | $0.012 |
| `cloudflare/clef` | 76% | 24% | 5/6 | $0.054 |
| `cloudflare/clef-flash` | 22% | 70% | 5/6 | $0.020 |

The one fixture jev clears is `git push origin main`, which is routine on the
repo's own remote. Intent is not in the live corpus (the log has no user
turns), so the trusted-intent path is covered by the orchestration tests and
still needs a live A/B.

## Decisions worth remembering

- **Writes/edits inside the workspace are floor-only.** Outside it, or
  secret-adjacent, they get reviewed: that is how persistence is installed.
- **Ordinary in-workspace reads pass free.** Flagged reads (outside the
  workspace, secret-adjacent names) are reviewed. `.env` read output is
  masked regardless.
- **Floor owns shapes, not intent.** It blocks `push --force`, not `push`;
  `rm -r`, not `rm`. Anything needing "is this okay in context?" is the
  reviewer's.
- **Nested shells are shapes.** `bash -c 'rm -rf app'` is unwrapped up to
  three levels so it hits the same floor rules.
- **Paste/gist uploads are floor; fetches are reviewer-owned.** Uploading to
  a known paste host (`curl -d/-F/-T`, `wget --post-*`, `gh gist create`) is
  egress. Fetching a gist is ingress: the exfiltration question correctly
  clears it, and the injection question owns the untrusted content.
- **Planner refusals fail to the reviewer, not to allow.** A wrong
  `read_only` would be a correctness bug, so every branch fails closed.
- **One shell scanner.** The planner needs strict validation; the floor only
  needs stage boundaries. They share `shell.ts` so quoting and operator
  handling cannot drift.

## Open

- Live intent A/B: "delete the drafts folder" → `rm -rf ./drafts` should
  clear; the same call invented by the agent should hold.
- Headless `/allow`, `onUncertain: "ask"`, and `herdr:blocked` are covered by
  the orchestration tests but not yet exercised in a real TUI session.
- Nix wiring: set `pi.gate`, rebuild, confirm `~/.pi/agent/gate.json` and
  `/judge`.
- Auto-retry of approved calls (needs `executeTool` in command context).
