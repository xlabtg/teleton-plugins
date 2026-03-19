# Changelog

All notable changes to `github-dev-assistant` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-17

### Added
- Initial release of the `github-dev-assistant` plugin
- **Authorization (1 tool)**
  - `github_check_auth` — verify current authentication status via Personal Access Token
- **Repository management (2 tools)**
  - `github_list_repos` — list user or organization repositories with filtering
  - `github_create_repo` — create new repositories with optional license and gitignore
- **File & commit operations (3 tools)**
  - `github_get_file` — read files or list directories (base64 decode handled automatically)
  - `github_update_file` — create or update files with commits (base64 encode handled automatically)
  - `github_create_branch` — create branches from any ref
- **Pull request management (3 tools)**
  - `github_create_pr` — create pull requests with draft support
  - `github_list_prs` — list PRs with state, head, base, and sort filtering
  - `github_merge_pr` — merge PRs with `require_pr_review` confirmation policy
- **Issue management (4 tools)**
  - `github_create_issue` — create issues with labels, assignees, and milestone
  - `github_list_issues` — list issues with extensive filtering options
  - `github_comment_issue` — add comments to issues and PRs
  - `github_close_issue` — close issues/PRs with optional comment and reason
- **GitHub Actions (1 tool)**
  - `github_trigger_workflow` — dispatch workflow_dispatch events with inputs
- **Security**
  - All tokens stored exclusively via `sdk.secrets`
  - Token redaction in error messages
  - `require_pr_review` confirmation policy for destructive merge operations
