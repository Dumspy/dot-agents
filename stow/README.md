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

`node_modules/` is gitignored and installed locally by `setup.sh` / the
`post-merge` hook.

## Sandbox system dependency (non-Nix)

Pi ships an always-on bubblewrap sandbox for `bash` commands via the
`pi/extensions/sandbox` extension (npm deps are installed by `setup.sh`).
The `bwrap` *binary* is a host package, not a node module, so non-Nix users
must install it themselves for the always-on default to engage. Without it,
pi degrades loudly to the static permission layer (curated global bash denies
+ path deny list + `external_directory` ask still apply).

| Platform | Install |
| --- | --- |
| macOS | (none) — `sandbox-exec` is built-in and used instead |
| Debian/Ubuntu | `sudo apt install bubblewrap` |
| Arch | `sudo pacman -S bubblewrap` |
| Fedora | `sudo dnf install bubblewrap` |
| Homebrew (Linux) | `brew install bubblewrap` |

Escalation to the Gondolin micro-VM (`pi --sandbox`) additionally requires
QEMU — install it manually only on machines where you intend to use that tier
(e.g. `sudo apt install qemu-system-x86`). Node.js >= 23.6 is also required for
`@earendil-works/gondolin` at runtime.
