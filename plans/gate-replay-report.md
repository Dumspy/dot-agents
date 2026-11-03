# Gate replay report

Source: `~/.pi/agent/permissions.log.jsonl` — 9428 rows.

Old system: 4848 rows cost a prompt or a denial, 4580 ran free.

| old prompt/deny rows (4848) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 664 | 13.7% |
| now floor-blocked | 190 | 3.9% |
| now one reviewer call (no prompt) | 3994 | 82.4% |

Old free rows (4580): 2091 now need the reviewer, 4 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1725
- `unsupported_shell`: 426
- `too_many_stages`: 356
- `command_owned_input`: 313
- `unsupported_argument`: 261
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

Source: `~/.pi/agent/permissions.log.jsonl (unique tool+value)` — 6838 rows.

Old system: 4776 rows cost a prompt or a denial, 2062 ran free.

| old prompt/deny rows (4776) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 663 | 13.9% |
| now floor-blocked | 189 | 4.0% |
| now one reviewer call (no prompt) | 3924 | 82.2% |

Old free rows (2062): 1086 now need the reviewer, 4 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1696
- `unsupported_shell`: 425
- `too_many_stages`: 356
- `command_owned_input`: 310
- `unsupported_argument`: 261
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
