#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# The stow branch is force-pushed by CI, so a plain "git pull" often fails when
# the local history has diverged. Fetch and reset to the remote state instead.
echo "[dot-agents] Updating stow branch..."
git fetch origin stow
git reset --hard origin/stow
