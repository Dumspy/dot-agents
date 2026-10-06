#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Must stay in sync with nix/pi-external-extensions.nix (name@version).
# Currently empty — no external extensions enabled. Preserved example below.
EXTERNAL_PI_PACKAGES=(
  # "pi-mcp-adapter@2.32.1"
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

# settings.json `packages` is managed authoritatively from EXTERNAL_PI_PACKAGES:
# removing an entry here removes it from settings.json on the next setup run.
# Other settings.json keys are preserved. Packages installed manually via
# `pi install` are dropped — add them to EXTERNAL_PI_PACKAGES instead.
if command -v jq &> /dev/null; then
  if ((${#EXTERNAL_PI_PACKAGES[@]})); then
    WANT_JSON=$(printf '%s\n' "${EXTERNAL_PI_PACKAGES[@]}" | jq -R 'select(length > 0)' | jq -s 'map("npm:" + .) | unique')
  else
    WANT_JSON='[]'
  fi
  SETTINGS_FILE="$HOME/.pi/agent/settings.json"
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  if [ -f "$SETTINGS_FILE" ]; then
    jq --argjson want "$WANT_JSON" '.packages = $want' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" \
      && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
  else
    jq -n --argjson want "$WANT_JSON" '{packages: $want}' > "$SETTINGS_FILE"
  fi
else
  echo "[dot-agents] jq not found — skipping settings.json packages sync."
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
