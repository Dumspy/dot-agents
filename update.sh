#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# The stow branch is force-pushed by CI, so a plain "git pull" often fails when
# the local history has diverged. Fetch and reset to the remote state instead.
echo "[dot-agents] Updating stow branch..."
git fetch origin stow
git reset --hard origin/stow

# git reset --hard does not trigger the post-merge hook, so reinstall
# dependencies manually when the lockfile changes.
if [ -f .pi/agent/package-lock.json ]; then
  echo "[dot-agents] Installing Pi extension dependencies..."
  (cd .pi/agent && npm ci)
fi
