# Gate replay report

Source: `~/.pi/agent/permissions.log.jsonl` — 9401 rows.

Old system: 4828 rows cost a prompt or a denial, 4573 ran free.

| old prompt/deny rows (4828) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 662 | 13.7% |
| now floor-blocked | 189 | 3.9% |
| now one reviewer call (no prompt) | 3977 | 82.4% |

Old free rows (4573): 2084 now need the reviewer, 4 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1716
- `unsupported_shell`: 426
- `too_many_stages`: 353
- `command_owned_input`: 311
- `unsupported_argument`: 258
- `webfetch`: 217
- `network_access`: 206
- `dynamic_word`: 123
- `env_assignment`: 102
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

Source: `~/.pi/agent/permissions.log.jsonl (unique tool+value)` — 6814 rows.

Old system: 4756 rows cost a prompt or a denial, 2058 ran free.

| old prompt/deny rows (4756) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 661 | 13.9% |
| now floor-blocked | 188 | 4.0% |
| now one reviewer call (no prompt) | 3907 | 82.1% |

Old free rows (2058): 1082 now need the reviewer, 4 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1687
- `unsupported_shell`: 425
- `too_many_stages`: 353
- `command_owned_input`: 308
- `unsupported_argument`: 258
- `network_access`: 206
- `webfetch`: 202
- `dynamic_word`: 123
- `env_assignment`: 102
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
