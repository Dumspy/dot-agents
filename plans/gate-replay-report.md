# Gate replay report

Source: `~/.pi/agent/permissions.log.jsonl` — 9326 rows.

Old system: 4760 rows cost a prompt or a denial, 4566 ran free.

| old prompt/deny rows (4760) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 652 | 13.7% |
| now floor-blocked | 163 | 3.4% |
| now one reviewer call (no prompt) | 3945 | 82.9% |

Old free rows (4566): 2080 now need the reviewer, 3 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1698
- `unsupported_shell`: 425
- `command_owned_input`: 315
- `unsupported_argument`: 312
- `too_many_stages`: 248
- `webfetch`: 217
- `network_access`: 216
- `dynamic_word`: 152
- `env_assignment`: 97
- `process_or_system`: 66
- `background`: 65
- `filesystem_write`: 59
- `read`: 57
- `too_long`: 18

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

Source: `~/.pi/agent/permissions.log.jsonl (unique tool+value)` — 6740 rows.

Old system: 4688 rows cost a prompt or a denial, 2052 ran free.

| old prompt/deny rows (4688) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 651 | 13.9% |
| now floor-blocked | 162 | 3.5% |
| now one reviewer call (no prompt) | 3875 | 82.7% |

Old free rows (2052): 1079 now need the reviewer, 3 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1669
- `unsupported_shell`: 424
- `unsupported_argument`: 312
- `command_owned_input`: 312
- `too_many_stages`: 248
- `network_access`: 216
- `webfetch`: 202
- `dynamic_word`: 152
- `env_assignment`: 97
- `process_or_system`: 66
- `background`: 65
- `filesystem_write`: 59
- `read`: 35
- `too_long`: 18

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
