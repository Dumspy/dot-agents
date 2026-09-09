#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Must stay in sync with nix/pi-external-extensions.nix (name@version).
EXTERNAL_PI_PACKAGES=(
  "pi-mcp-adapter@2.32.1"
)

# Install a post-merge hook that re-runs this script after the stow branch
# is updated, so both local deps and external extensions stay in sync.
mkdir -p .git/hooks
cat > .git/hooks/post-merge <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -f stow/setup.sh ]; then
  bash stow/setup.sh
fi
HOOK
chmod +x .git/hooks/post-merge

# Run the initial install now.
if [ -f .pi/agent/package-lock.json ]; then
  echo "[dot-agents] Installing Pi extension dependencies..."
  (cd .pi/agent && npm ci)
fi

# Install external Pi extensions if pi CLI is available
if command -v pi &> /dev/null; then
  echo "[dot-agents] Installing Pi external extensions..."
  for pkg in "${EXTERNAL_PI_PACKAGES[@]}"; do
    echo "[dot-agents]   Installing: $pkg"
    pi install "npm:$pkg"
  done
else
  echo "[dot-agents] Pi CLI not found — skipping external extensions."
  echo -n "[dot-agents] Run after installing Pi:";
  printf ' pi install "npm:%s"' "${EXTERNAL_PI_PACKAGES[@]}"; echo
fi

echo "[dot-agents] Setup complete."
