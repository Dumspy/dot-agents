---
name: dependabot-solver
description: Fetches Dependabot security alerts from a repository and returns structured data about packages with vulnerabilities, their severity, and minimum versions needed to resolve them. Use with an LLM to intelligently resolve dependency updates with proper version management.
---

# Dependabot Solver

Gathers Dependabot security alert data and structures it for LLM-driven resolution.

## Capabilities

- **Fetch Dependabot Alerts**: Query open Dependabot security alerts for a repository
- **Extract Vulnerability Info**: Get package names, ecosystems, severity levels, and patched versions
- **Structured Output**: Returns JSON with all alert details for LLM processing
- **Package Manager Detection**: Auto-detects npm, yarn, pnpm, pip, cargo, bundler, go
- **Consolidated Resolution**: Resolves all vulnerabilities in a single PR

## Usage

### Basic Workflow

1. **Run from repository root on your desired branch**
    ```bash
     ~/.config/opencode/skill/dependabot-solver/scripts/dependabot-solver.sh
    ```

2. **Script returns JSON with**
    - Alert details (package, severity, vulnerability info)
    - Minimum versions needed to resolve
    - Package manager type detected
    - Current branch as the base

3. **LLM processes output to**
   - Update dependencies to patched versions
   - Create appropriate PRs
   - Handle merge conflicts if needed

### Command Examples

```bash
# Get all alerts for current branch
~/.config/opencode/skill/dependabot-solver/scripts/dependabot-solver.sh

# Parse and use output
ALERTS=$(~/.config/opencode/skill/dependabot-solver/scripts/dependabot-solver.sh | jq '.alerts')
PKG_MANAGER=$(~/.config/opencode/skill/dependabot-solver/scripts/dependabot-solver.sh | jq -r '.package_manager')
BASE_BRANCH=$(~/.config/opencode/skill/dependabot-solver/scripts/dependabot-solver.sh | jq -r '.base_branch')
```

### Output Format

```json
{
  "repository": "owner/repo",
  "base_branch": "main",
  "package_manager": "npm",
  "alert_count": 3,
  "alerts": [
    {
      "number": 1,
      "package_name": "lodash",
      "ecosystem": "npm",
      "severity": "high",
      "vulnerable_version_range": "< 4.17.21",
      "patched_version": "4.17.21"
    }
  ]
}
```

## Skill Details

### Prerequisites
- Run in an already-cloned repository
- `gh` CLI installed and authenticated
- Git remote 'origin' configured
- Read access to repository for fetching alerts

### Parameters
No parameters. Uses current branch as the base.

### LLM Integration

The script returns structured JSON that an LLM can process to:
1. Parse vulnerability details and patched versions
2. Update package.json/requirements.txt/etc. with minimum versions
3. Run appropriate install/update commands
4. Create branches and PRs with proper commit messages
5. Handle ecosystem-specific update logic

### Output
Returns JSON object with:
- Repository and base branch info
- Detected package manager
- Array of alerts with vulnerability details and patched versions

## Dependency Resolution Workflow

### 1. Create a Feature Branch

```bash
git checkout -b deps/security-updates
```

Branch naming conventions:
- Use `deps/` prefix for dependency security updates
- Use kebab-case for multi-word names
- Example: `deps/security-updates`

### 2. Update Dependencies

Update package manifests based on package manager:

**npm/yarn/pnpm:**
```bash
npm install lodash@4.17.21  # or yarn/pnpm equivalent
```

**Python (pip):**
```bash
pip install requests==2.28.0  # or update requirements.txt
pip install -r requirements.txt
```

**Ruby (bundler):**
```bash
bundle update lodash  # or modify Gemfile
bundle install
```

**Go:**
```bash
go get github.com/package@v1.0.0
```

**Cargo:**
```bash
cargo update package --precise 1.0.0
```

Run tests/validation after updating:
```bash
npm test  # or your equivalent test command
```

### 3. Commit Changes

Use clear, structured commit messages:

```
chore: resolve security vulnerabilities

- Bump lodash from 4.17.20 to 4.17.21 (high severity)
- Bump requests from 2.27.0 to 2.28.0 (medium severity)

Fixes #123, #124, #125
```

Commit message conventions:
- Type: `chore:` for dependency security updates
- Subject: Clear, actionable (max 50 chars)
- Body: List each package bump with version and severity
- Footer: Reference alert numbers with `Fixes #123, #124, #125`

### 4. Create Pull Request with gh CLI

**Check for PR template:**
```bash
# Repository PR templates (in priority order):
# 1. .github/pull_request_template.md
# 2. .github/PULL_REQUEST_TEMPLATE.md
# 3. pull_request_template.md
# 4. PULL_REQUEST_TEMPLATE.md

if [[ -f ".github/pull_request_template.md" ]]; then
  TEMPLATE_FILE=".github/pull_request_template.md"
elif [[ -f ".github/PULL_REQUEST_TEMPLATE.md" ]]; then
  TEMPLATE_FILE=".github/PULL_REQUEST_TEMPLATE.md"
elif [[ -f "pull_request_template.md" ]]; then
  TEMPLATE_FILE="pull_request_template.md"
elif [[ -f "PULL_REQUEST_TEMPLATE.md" ]]; then
  TEMPLATE_FILE="PULL_REQUEST_TEMPLATE.md"
else
  TEMPLATE_FILE=""
fi
```

**Create PR using template if available:**
```bash
if [[ -n "$TEMPLATE_FILE" ]]; then
  # Use existing template, replacing placeholders
  BODY=$(cat "$TEMPLATE_FILE" | sed \
    -e "s|<package-name>|lodash|g" \
    -e "s|<version>|4.17.21|g" \
    -e "s|<alert-number>|123|g" \
    -e "s|<severity>|high|g")
  
  gh pr create \
    --base main \
    --title "chore(deps): bump lodash to 4.17.21" \
    --body "$BODY"
else
  # Fall back to default format
  gh pr create \
    --base main \
    --title "chore: resolve security vulnerabilities" \
    --body "## Security Updates

Resolves Dependabot alerts: #123, #124, #125

### Changes
- Bump lodash from 4.17.20 to 4.17.21 (high severity)
- Bump requests from 2.27.0 to 2.28.0 (medium severity)

### Verification
- [ ] Tests pass
- [ ] No breaking changes
- [ ] Audit clean: \`npm audit\`"
fi
```



**Set draft status if needed:**
```bash
gh pr create --draft \
  --base main \
  --title "..." \
  --body "..."
```

**Enable auto-merge (requires repository setup):**
```bash
gh pr create \
  --base main \
  --title "..." \
  --body "..." \
  --auto-merge \
  --auto-merge-method squash
```

### PR Best Practices

- **Label PRs:** Add labels for categorization
  ```bash
  gh pr create ... && gh pr edit --add-label dependencies,security
  ```

- **Request reviews:** Auto-assign reviewers
  ```bash
  gh pr create ... && gh pr edit --add-assignee @me
  ```

- **Link alerts in PR body:** Reference Dependabot alert numbers (e.g., `#123`)

- **Include verification checklist:** Show that tests pass, audit clean, no regressions

- **Use draft PRs:** For work-in-progress or multi-alert reviews

### Error Handling

**Common issues:**

1. **Auth failure:** Ensure `gh auth status` shows authenticated
2. **Branch conflicts:** Run `git pull origin main` before creating PR
3. **Failed tests:** Fix test failures before PR creation
4. **Audit still shows issues:** Verify installed versions with `npm list` or equivalent
