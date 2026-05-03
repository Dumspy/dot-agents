#!/usr/bin/env bash

set -euo pipefail

# PR Review Resolver Script
# Fetches unresolved PR comments and returns structured data for LLM resolution

# Check if we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo '{"error": "Not in a git repository"}' 
  exit 1
fi

# Get current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Get repo from git remote (strip .git suffix)
REPO=$(git config --get remote.origin.url | sed -E 's|.*github\.com[:/]||; s|\.git$||' || echo "")
if [[ -z "$REPO" ]]; then
  echo '{"error": "Could not determine repository from git remote"}'
  exit 1
fi

echo "🔍 Checking for open PR on branch: $CURRENT_BRANCH..." >&2

# Find PR for current branch
PR_JSON=$(gh pr view "$CURRENT_BRANCH" --json number,title,url,state,isDraft,headRefName,baseRefName 2>/dev/null || echo "")

if [[ -z "$PR_JSON" || "$PR_JSON" == "null" ]]; then
  echo '{"error": "No open pull request found for current branch", "branch": "'"$CURRENT_BRANCH"'", "repository": "'"$REPO"'"}'
  exit 0
fi

PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number')
PR_TITLE=$(echo "$PR_JSON" | jq -r '.title')
PR_URL=$(echo "$PR_JSON" | jq -r '.url')
PR_STATE=$(echo "$PR_JSON" | jq -r '.state')
IS_DRAFT=$(echo "$PR_JSON" | jq -r '.isDraft')
BASE_REF=$(echo "$PR_JSON" | jq -r '.baseRefName')

echo "📋 Found PR #$PR_NUMBER: $PR_TITLE" >&2

# Fetch review threads (code comments) - includes resolved status
echo "📝 Fetching review comments..." >&2
REVIEW_THREADS=$(gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          comments(first: 50) {
            nodes {
              id
              author { login }
              body
              createdAt
              outdated
              diffHunk
            }
          }
        }
      }
    }
  }
}' -f owner="${REPO%/*}" -f repo="${REPO#*/}" -F pr="$PR_NUMBER" 2>/dev/null || echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}')

# Fetch general PR comments (conversation tab, not tied to code)
echo "💬 Fetching general comments..." >&2
GENERAL_COMMENTS=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate 2>/dev/null || echo "[]")

# Parse unresolved code review threads (with null safety)
CODE_COMMENTS=$(echo "$REVIEW_THREADS" | jq -c '
  [(.data.repository.pullRequest.reviewThreads.nodes // [])[] 
   | select(.isResolved == false)
   | {
       thread_id: .id,
       file: .path,
       line: .line,
       start_line: .startLine,
       is_outdated: .isOutdated,
       diff_side: .diffSide,
       diff_hunk: (.comments.nodes[0].diffHunk // null),
       comments: [(.comments.nodes // [])[] | {
         author: (.author.login // "unknown"),
         body: .body,
         created_at: .createdAt,
         outdated: .outdated
       }]
     }
  ]
' 2>/dev/null || echo '[]')

UNRESOLVED_CODE_COUNT=$(echo "$CODE_COMMENTS" | jq 'length')

# Parse general comments with null safety
GENERAL_PARSED=$(echo "$GENERAL_COMMENTS" | jq -c '
  if type == "array" then
    [.[] | {
      id: .id,
      author: (.user.login // "unknown"),
      body: .body,
      created_at: .created_at,
      html_url: .html_url,
      is_bot: ((.user.type // "") == "Bot")
    }]
  else
    []
  end
' 2>/dev/null || echo '[]')

GENERAL_COUNT=$(echo "$GENERAL_PARSED" | jq 'length')

echo "Found $UNRESOLVED_CODE_COUNT unresolved code comment thread(s)" >&2
echo "Found $GENERAL_COUNT general comment(s)" >&2

# Build final output
OUTPUT=$(jq -n \
  --arg repo "$REPO" \
  --arg branch "$CURRENT_BRANCH" \
  --argjson pr_number "$PR_NUMBER" \
  --arg pr_title "$PR_TITLE" \
  --arg pr_url "$PR_URL" \
  --arg pr_state "$PR_STATE" \
  --argjson is_draft "$IS_DRAFT" \
  --arg base_ref "$BASE_REF" \
  --argjson code_comments "$CODE_COMMENTS" \
  --argjson general_comments "$GENERAL_PARSED" \
  '{
    repository: $repo,
    branch: $branch,
    pull_request: {
      number: $pr_number,
      title: $pr_title,
      url: $pr_url,
      state: $pr_state,
      is_draft: $is_draft,
      base_ref: $base_ref
    },
    unresolved_code_comments: {
      count: ($code_comments | length),
      threads: $code_comments
    },
    general_comments: {
      count: ($general_comments | length),
      comments: $general_comments
    }
  }')

echo "$OUTPUT"
