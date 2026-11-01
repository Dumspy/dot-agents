# Gate replay report

Source: `~/.pi/agent/permissions.log.jsonl` — 9249 rows.

Old system: 4687 rows cost a prompt or a denial, 4562 ran free.

| old prompt/deny rows (4687) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 712 | 15.2% |
| now floor-blocked | 110 | 2.3% |
| now one reviewer call (no prompt) | 3865 | 82.5% |

Old free rows (4562): 2077 now need the reviewer, 3 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1683
- `unsupported_shell`: 411
- `command_owned_input`: 312
- `too_many_stages`: 246
- `unsupported_argument`: 242
- `network_access`: 225
- `webfetch`: 217
- `dynamic_word`: 150
- `env_assignment`: 100
- `background`: 85
- `process_or_system`: 66
- `read`: 57
- `filesystem_write`: 56
- `too_long`: 15

## Sample of remaining reviewer volume

- `git` (unsupported_argument)
- `nix` (unknown_command)
- `darwin-rebuild` (unknown_command)
- `home-manager` (unknown_command)
- `find` (unknown_command)
- `home-manager` (unknown_command)
- `ls` (unsupported_argument)
- `ls` (dynamic_word)
- `readlink` (unsupported_argument)
- `ls` (dynamic_word)
- `find` (unsupported_argument)
- `find` (unsupported_argument)
- `find` (unsupported_argument)
- `ls` (unsupported_argument)
- `stat` (unknown_command)
- `file` (dynamic_word)
- `file` (dynamic_word)
- `chmod` (filesystem_write)
- `# Remove all stale o` (unsupported_shell)
- `search` (webfetch)
# Gate replay report

Source: `~/.pi/agent/permissions.log.jsonl (unique tool+value)` — 6665 rows.

Old system: 4615 rows cost a prompt or a denial, 2050 ran free.

| old prompt/deny rows (4615) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 711 | 15.4% |
| now floor-blocked | 109 | 2.4% |
| now one reviewer call (no prompt) | 3795 | 82.2% |

Old free rows (2050): 1077 now need the reviewer, 3 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1654
- `unsupported_shell`: 410
- `command_owned_input`: 309
- `too_many_stages`: 246
- `unsupported_argument`: 242
- `network_access`: 225
- `webfetch`: 202
- `dynamic_word`: 150
- `env_assignment`: 100
- `background`: 85
- `process_or_system`: 66
- `filesystem_write`: 56
- `read`: 35
- `too_long`: 15

## Sample of remaining reviewer volume

- `git` (unsupported_argument)
- `nix` (unknown_command)
- `darwin-rebuild` (unknown_command)
- `home-manager` (unknown_command)
- `find` (unknown_command)
- `home-manager` (unknown_command)
- `ls` (unsupported_argument)
- `ls` (dynamic_word)
- `readlink` (unsupported_argument)
- `ls` (dynamic_word)
- `find` (unsupported_argument)
- `find` (unsupported_argument)
- `find` (unsupported_argument)
- `ls` (unsupported_argument)
- `stat` (unknown_command)
- `file` (dynamic_word)
- `file` (dynamic_word)
- `chmod` (filesystem_write)
- `# Remove all stale o` (unsupported_shell)
- `search` (webfetch)
