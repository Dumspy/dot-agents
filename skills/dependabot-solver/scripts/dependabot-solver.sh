#!/usr/bin/env bash

set -euo pipefail

# Dependabot Solver Script
# Fetches open Dependabot alerts and returns package info for consolidated PR resolution

# Get current branch
BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Check if we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "❌ Error: Not in a git repository" >&2
  exit 1
fi

# Get repo from git
REPO=$(git config --get remote.origin.url | sed 's|.*github.com[:/]\(.*\)\.git$|\1|' || echo "")
if [[ -z "$REPO" ]]; then
  echo "❌ Error: Could not determine repository URL" >&2
  exit 1
fi

OWNER="${REPO%/*}"
REPO_NAME="${REPO##*/}"

# Detect package manager
detect_package_manager() {
  if [[ -f "package-lock.json" ]]; then
    echo "npm"
  elif [[ -f "yarn.lock" ]]; then
    echo "yarn"
  elif [[ -f "pnpm-lock.yaml" ]]; then
    echo "pnpm"
  elif [[ -f "Gemfile.lock" ]]; then
    echo "bundler"
  elif [[ -f "Cargo.lock" ]]; then
    echo "cargo"
  elif [[ -f "requirements.txt" ]] || [[ -f "setup.py" ]] || [[ -f "pyproject.toml" ]]; then
    echo "pip"
  elif [[ -f "go.mod" ]]; then
    echo "go"
  else
    echo "unknown"
  fi
}

PKG_MANAGER=$(detect_package_manager)

echo "🔍 Fetching Dependabot alerts for $REPO..." >&2

# Fetch via GraphQL - more reliable and feature-rich
ALERTS_JSON=$(gh api graphql -f query='query($owner:String!, $name:String!) {
  repository(owner: $owner, name: $name) {
    vulnerabilityAlerts(first: 100, states: OPEN) {
      nodes {
        number
        securityVulnerability {
          package { name ecosystem }
          severity
          advisory { summary description }
          vulnerableVersionRange
          firstPatchedVersion { identifier }
        }
      }
    }
  }
}' \
  -f owner="$OWNER" \
  -f name="$REPO_NAME" 2>/dev/null || echo '{"data":{"repository":{"vulnerabilityAlerts":{"nodes":[]}}}}')

# Parse alerts from GraphQL response
ALERTS=$(echo "$ALERTS_JSON" | jq -c '.data.repository.vulnerabilityAlerts.nodes[] | {
  number: .number,
  package_name: .securityVulnerability.package.name,
  ecosystem: .securityVulnerability.package.ecosystem,
  severity: .securityVulnerability.severity,
  vulnerable_version_range: .securityVulnerability.vulnerableVersionRange,
  patched_version: .securityVulnerability.firstPatchedVersion.identifier
}' 2>/dev/null || echo "")

ALERT_COUNT=$(echo "$ALERTS" | jq -s 'length')
echo "Found $ALERT_COUNT Dependabot alert(s)" >&2

# Build JSON array of alerts
ALERTS_ARRAY=$(echo "$ALERTS" | jq -s '.')

# Output structured JSON
OUTPUT=$(jq -n \
  --arg repo "$REPO" \
  --arg base_branch "$BASE_BRANCH" \
  --arg pkg_manager "$PKG_MANAGER" \
  --argjson alerts "$ALERTS_ARRAY" \
  '{
    repository: $repo,
    base_branch: $base_branch,
    package_manager: $pkg_manager,
    alert_count: ($alerts | length),
    alerts: $alerts
  }')

echo "$OUTPUT"
