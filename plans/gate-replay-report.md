# Gate replay report

Source: `~/.pi/agent/permissions.log.jsonl` — 9268 rows.

Old system: 4705 rows cost a prompt or a denial, 4563 ran free.

| old prompt/deny rows (4705) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 712 | 15.1% |
| now floor-blocked | 159 | 3.4% |
| now one reviewer call (no prompt) | 3834 | 81.5% |

Old free rows (4563): 2078 now need the reviewer, 3 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1680
- `unsupported_shell`: 401
- `command_owned_input`: 315
- `too_many_stages`: 248
- `unsupported_argument`: 243
- `network_access`: 218
- `webfetch`: 217
- `dynamic_word`: 152
- `env_assignment`: 97
- `process_or_system`: 66
- `background`: 65
- `filesystem_write`: 59
- `read`: 57
- `too_long`: 16

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

Source: `~/.pi/agent/permissions.log.jsonl (unique tool+value)` — 6684 rows.

Old system: 4633 rows cost a prompt or a denial, 2051 ran free.

| old prompt/deny rows (4633) | count | share |
|---|---|---|
| now deterministic (planner or floor-only tool) | 711 | 15.3% |
| now floor-blocked | 158 | 3.4% |
| now one reviewer call (no prompt) | 3764 | 81.2% |

Old free rows (2051): 1078 now need the reviewer, 3 now hit the floor.

## Reviewer reasons (old prompt/deny rows)

- `unknown_command`: 1651
- `unsupported_shell`: 400
- `command_owned_input`: 312
- `too_many_stages`: 248
- `unsupported_argument`: 243
- `network_access`: 218
- `webfetch`: 202
- `dynamic_word`: 152
- `env_assignment`: 97
- `process_or_system`: 66
- `background`: 65
- `filesystem_write`: 59
- `read`: 35
- `too_long`: 16

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
