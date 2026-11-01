# Gate replay report

Source: `~/.pi/agent/permissions.log.jsonl` — 9345 rows.

Old system: 4779 rows cost a prompt or a denial, 4566 ran free.

| old prompt/deny rows (4779) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 659 | 13.8% |
| now floor-blocked | 189 | 4.0% |
| now one reviewer call (no prompt) | 3931 | 82.3% |

Old free rows (4566): 2079 now need the reviewer, 4 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1690
- `unsupported_shell`: 423
- `too_many_stages`: 349
- `command_owned_input`: 305
- `unsupported_argument`: 255
- `webfetch`: 217
- `network_access`: 206
- `dynamic_word`: 120
- `env_assignment`: 101
- `process_or_system`: 65
- `background`: 65
- `filesystem_write`: 59
- `read`: 57
- `too_long`: 19

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
- `echo` (filesystem_write)
- `chmod` (filesystem_write)
- `echo` (too_many_stages)
# Gate replay report

Source: `~/.pi/agent/permissions.log.jsonl (unique tool+value)` — 6759 rows.

Old system: 4707 rows cost a prompt or a denial, 2052 ran free.

| old prompt/deny rows (4707) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 658 | 14.0% |
| now floor-blocked | 188 | 4.0% |
| now one reviewer call (no prompt) | 3861 | 82.0% |

Old free rows (2052): 1078 now need the reviewer, 4 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1661
- `unsupported_shell`: 422
- `too_many_stages`: 349
- `command_owned_input`: 302
- `unsupported_argument`: 255
- `network_access`: 206
- `webfetch`: 202
- `dynamic_word`: 120
- `env_assignment`: 101
- `process_or_system`: 65
- `background`: 65
- `filesystem_write`: 59
- `read`: 35
- `too_long`: 19

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
- `echo` (filesystem_write)
- `chmod` (filesystem_write)
- `echo` (too_many_stages)
