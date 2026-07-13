# dot-agents (stow branch)

This branch is auto-generated from the `development` branch and is intended for
use with [GNU Stow](https://www.gnu.org/software/stow/) on non-Nix systems.

It contains the final install tree so you can symlink everything under `~` with
a single command.

## Quick start

```bash
git clone --branch stow https://github.com/Dumspy/dot-agents.git ~/dot-agents
cd ~/dot-agents
./setup.sh
stow . -t ~
```

`setup.sh` installs a `post-merge` git hook that automatically runs `npm ci` in
`.pi/agent/` whenever the branch is updated, and it performs the initial install.

## Updating

Because this branch is force-pushed by CI, use the provided helper instead of a
plain `git pull`:

```bash
./update.sh
```

This fetches the latest `stow` branch and resets your local checkout to match
the remote state exactly.

## Layout

The tree mirrors the target paths under `$HOME`:

```
.agents/skills/          -> ~/.agents/skills/
.config/opencode/        -> ~/.config/opencode/
.pi/agent/               -> ~/.pi/agent/
```

External Pi extensions (like `pi-mcp-adapter`) are installed automatically by
`setup.sh` if the `pi` CLI is available. See `nix/pi-external-extensions.nix`
for the registry of available extensions.

`node_modules/` is gitignored and installed locally by `setup.sh` / the
`post-merge` hook.
