#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# External Pi extensions to install.
# Maps to entries in nix/pi-external-extensions.nix.
# Add new entries here when adding to the registry.
EXTERNAL_PI_PACKAGES=(
  "pi-mcp-adapter"
)

# Install a post-merge hook that reinstalls Pi extension dependencies after
# the stow branch is updated.
mkdir -p .git/hooks
cat > .git/hooks/post-merge <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Reinstall local extension npm deps
if [ -f .pi/agent/package-lock.json ]; then
  echo "[dot-agents] Installing Pi extension dependencies..."
  (cd .pi/agent && npm ci)
fi

# Reinstall external Pi extensions (if pi CLI is available)
if command -v pi &> /dev/null; then
  # External packages list — keep in sync with nix/pi-external-extensions.nix
  EXTERNAL_PI_PACKAGES=("pi-mcp-adapter")
  for pkg in "${EXTERNAL_PI_PACKAGES[@]}"; do
    echo "[dot-agents] Installing Pi extension: $pkg"
    pi install "npm:$pkg"
  done
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
  echo "[dot-agents] Run 'pi install ${EXTERNAL_PI_PACKAGES[*]}' after installing Pi."
fi

echo "[dot-agents] Setup complete."
