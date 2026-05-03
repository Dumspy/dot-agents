---
name: pr-review-resolver
description: Fetches unresolved PR review comments from the current branch's pull request. Returns structured data with file paths, line numbers, code context, and comment threads for LLM-driven resolution. Use when addressing PR feedback or iterating on review comments.
---

# PR Review Resolver

Gathers unresolved PR review feedback and structures it for LLM-driven resolution.

## Capabilities

- **Detect Open PR**: Finds the PR associated with the current branch
- **Fetch Unresolved Code Comments**: Gets review threads that haven't been resolved
- **Include Code Context**: Provides diff hunks showing the exact code being discussed
- **Separate General Comments**: Distinguishes conversation-tab comments from inline code reviews
- **Structured Output**: Returns JSON ready for LLM processing

## Usage

### Basic Workflow

1. **Run from repository root on your PR branch**
    ```bash
    ~/.config/opencode/skills/pr-review-resolver/scripts/pr-review-resolver.sh
    ```

2. **Script returns JSON with**
    - PR metadata (number, title, URL, state, draft status)
    - Unresolved code comments with file paths, line numbers, and diff context
    - General conversation comments (may include bot feedback)

3. **LLM processes output to**
    - Read and understand each comment thread
    - Make targeted code changes to address feedback

### Output Format

```json
{
  "repository": "owner/repo",
  "branch": "feature-branch",
  "pull_request": {
    "number": 42,
    "title": "Add new feature",
    "url": "https://github.com/owner/repo/pull/42",
    "state": "OPEN",
    "is_draft": false,
    "base_ref": "main"
  },
  "unresolved_code_comments": {
    "count": 2,
    "threads": [
      {
        "thread_id": "PRRT_...",
        "file": "src/utils.ts",
        "line": 45,
        "start_line": 42,
        "is_outdated": false,
        "diff_side": "RIGHT",
        "diff_hunk": "@@ -40,6 +40,10 @@ function helper() {\n   const x = 1;\n+  const y = 2;\n+  return x + y;",
        "comments": [
          {
            "author": "reviewer",
            "body": "Consider adding error handling here",
            "created_at": "2024-01-15T10:30:00Z",
            "outdated": false
          }
        ]
      }
    ]
  },
  "general_comments": {
    "count": 1,
    "comments": [
      {
        "id": 123456,
        "author": "maintainer",
        "body": "Please add tests for the new functionality",
        "created_at": "2024-01-15T09:00:00Z",
        "html_url": "https://github.com/owner/repo/pull/42#issuecomment-123456",
        "is_bot": false
      }
    ]
  }
}
```

## Prerequisites

- Run in a cloned git repository
- `gh` CLI installed and authenticated
- Current branch must have an open pull request
- Read access to the repository

## Addressing Review Feedback

### Process

1. **Gather feedback**
    ```bash
    FEEDBACK=$(~/.config/opencode/skill/pr-review-resolver/scripts/pr-review-resolver.sh)
    ```

2. **For each unresolved code comment thread**:
    - Read the `file` and `line` to locate the code
    - Review the `diff_hunk` for context
    - Read all `comments` in the thread to understand the full discussion
    - Make targeted changes to address the feedback

3. **For general comments**:
    - These often require broader changes or clarification
    - May include bot feedback (Codecov, linters, etc.)
    - Filter by `is_bot` if focusing on human feedback

4. **Validate before committing**:
    - Re-read the comment to ensure your change addresses it
    - Run tests/linting to verify no regressions
    - Check if the feedback is still valid (may be outdated)

### Skip Invalid Feedback

Not all feedback requires action:
- **Outdated comments**: Code may have changed since the comment was made
- **Already addressed**: Check if a later commit resolved the issue
- **Incorrect feedback**: Reviewers can be wrong; validate before changing
- **Style preferences**: Discuss rather than blindly implement

## Error Handling

**No PR found**: Script exits cleanly with error message and branch info

```json
{
  "error": "No open pull request found for current branch",
  "branch": "feature-branch",
  "repository": "owner/repo"
}
```

**Common issues**:
- `gh auth status` - Verify authentication
- `git remote -v` - Confirm origin points to GitHub
- `gh pr list` - Check if PR exists but is closed/merged

## Tips

- Focus on unresolved threads first (`unresolved_code_comments`)
- Use `diff_hunk` to understand the exact code context without reading the file
- Thread comments are ordered chronologically - read all to understand the discussion
- Bot comments in `general_comments` may contain actionable CI feedback
