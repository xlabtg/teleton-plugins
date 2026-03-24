# Changelog

All notable changes to `github-dev-assistant` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-03-24

### Added
- **Extended repository operations (8 new tools)** based on github-mcp-server feature parity
  - `github_fork_repo` — fork a repository into the authenticated user's account or an organization
  - `github_search_repos` — search GitHub repositories with advanced search qualifiers
  - `github_list_branches` — list all branches with their SHA and protection status
  - `github_push_files` — commit multiple files in a single Git operation using the Trees API
  - `github_get_repo_tree` — get the complete file tree of a repository (recursively)
  - `github_list_tags` — list tags with their commit SHAs
  - `github_list_releases` — list all releases with tag, name, and publish date
  - `github_get_latest_release` — get the latest stable release with assets
- **Extended PR and issue search operations (4 new tools)**
  - `github_search_issues` — search issues and PRs across GitHub using search syntax
  - `github_update_pr` — update a PR's title, body, state, or base branch
  - `github_add_pr_review` — submit a review (APPROVE, REQUEST_CHANGES, or COMMENT)
  - `github_get_job_logs` — get logs and step details for a specific workflow job
- **User and social operations (8 new tools)**
  - `github_get_me` — get the authenticated user's full profile
  - `github_search_users` — search GitHub users and organizations
  - `github_list_notifications` — list GitHub notifications (unread or all)
  - `github_star_repo` — star a repository
  - `github_unstar_repo` — unstar a repository
  - `github_list_gists` — list gists for a user or the authenticated user
  - `github_get_gist` — read gist content with all files
  - `github_create_gist` — create a new gist (public or secret)
- **Security operations (2 new tools)**
  - `github_list_code_scanning_alerts` — list code scanning (SAST) alerts by state and severity
  - `github_list_dependabot_alerts` — list Dependabot vulnerability alerts with CVE and package info
- **Discussion operations (2 new tools)**
  - `github_list_discussions` — list repository discussions with category filtering (GraphQL)
  - `github_get_discussion` — get a discussion with its body, comments, and answer status (GraphQL)
- **GitHub client improvements**
  - Added `graphql()` method for GitHub GraphQL API v4 (used by discussions)

### Changed
- Plugin version bumped from `2.0.0` to `3.0.0`
- Plugin description updated to reflect complete feature set
- Total tool count increased from 34 to 57

## [2.0.0] - 2026-03-24

### Added
- **Extended file operations (4 new tools)**
  - `github_delete_file` — delete a file from a repository (requires file SHA from `github_get_file`)
  - `github_list_directory` — list contents of a directory with file types, sizes, and SHAs
  - `github_search_code` — search for code patterns within a repository using GitHub's code search API
  - `github_download_file` — download a file and optionally save it to a local path
- **Commit operations (2 new tools)**
  - `github_list_commits` — list commits with filtering by branch, path, and author
  - `github_get_commit` — get detailed commit info including changed files and diffs
- **Extended issue/PR operations (5 new tools)**
  - `github_list_comments` — list comments on an issue or pull request
  - `github_update_issue` — update title, body, labels, assignees, state, or milestone
  - `github_reopen_issue` — reopen a closed issue with optional comment
  - `github_assign_issue` — assign or clear assignees on an issue
  - `github_list_pull_request_reviews` — list reviews (APPROVED/CHANGES_REQUESTED/COMMENTED) on a PR
- **Repository information tools (3 new tools)**
  - `github_list_languages` — list programming languages with byte counts and percentages
  - `github_list_collaborators` — list collaborators with permission levels
  - `github_list_teams` — list teams in a GitHub organization
- **Extended workflow operations (3 new tools)**
  - `github_list_workflows` — list all GitHub Actions workflows in a repository
  - `github_list_workflow_runs` — list workflow runs with filtering by branch, status, and workflow
  - `github_cancel_workflow_run` — cancel a currently running workflow run
- **Label operations (3 new tools)**
  - `github_list_labels` — list all labels with colors and descriptions
  - `github_create_label` — create a new label with custom color and description
  - `github_delete_label` — delete a label from a repository
- **GitHub client improvements**
  - `DELETE` requests now support a JSON body (required by GitHub's delete file API)

### Changed
- Plugin version bumped from `1.0.0` to `2.0.0`
- Plugin description updated to reflect expanded capabilities
- Total tool count increased from 14 to 34

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
