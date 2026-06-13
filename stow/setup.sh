#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Install a post-merge hook that reinstalls Pi extension dependencies after
# the stow branch is updated.
mkdir -p .git/hooks
cat > .git/hooks/post-merge <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -f .pi/agent/package-lock.json ]; then
  echo "[dot-agents] Installing Pi extension dependencies..."
  (cd .pi/agent && npm ci)
fi
HOOK
chmod +x .git/hooks/post-merge

# Run the initial install now.
if [ -f .pi/agent/package-lock.json ]; then
  echo "[dot-agents] Installing Pi extension dependencies..."
  (cd .pi/agent && npm ci)
fi

echo "[dot-agents] Setup complete."
