# GitHub Dev Assistant — Complete Agent Guide

A practical reference for all 60 tools. Use the example commands as natural-language prompts to the agent, replacing `xlabtg/teleton-plugins` with your own repository.

---

## Quick Setup Check

Before using any tool, verify authorization:

```
Check my authorization status on GitHub
```

Expected response: `Logged in as @your-username`

---

## Tool Reference by Category

### Authorization (1 tool)

| Tool | Example command |
|------|----------------|
| `github_check_auth` | `Check my authorization status on GitHub` |

---

### Repositories (10 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_list_repos` | `owner, type, sort` | `List repositories for org xlabtg, sorted by stars` |
| `github_create_repo` | `name*`, `description, private` | `Create a private repository called my-project with an MIT license` |
| `github_fork_repo` | `owner*`, `repo*` | `Fork octocat/hello-world into my account` |
| `github_search_repos` | `query*` | `Search for repositories about machine learning, language:python, stars:>1000` |
| `github_list_branches` | `owner*`, `repo*` | `List branches in xlabtg/teleton-plugins` |
| `github_push_files` | `owner*`, `repo*`, `branch*`, `message*`, `files[]` | `Push to xlabtg/teleton-plugins: branch main, message "Update docs", files: [{path:"README.md", content:"# Hello"}]` |
| `github_get_repo_tree` | `owner*`, `repo*`, `ref, recursive` | `Get the full file tree of xlabtg/teleton-plugins` |
| `github_list_tags` | `owner*`, `repo*` | `List tags in xlabtg/teleton-plugins` |
| `github_list_releases` | `owner*`, `repo*` | `List releases for xlabtg/teleton-plugins` |
| `github_get_latest_release` | `owner*`, `repo*` | `Get the latest release of xlabtg/teleton-plugins` |

> `*` = required parameter

---

### Files & Branches (8 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_get_file` | `owner*`, `repo*`, `path*`, `ref` | `Get the content of README.md from xlabtg/teleton-plugins` |
| `github_update_file` | `owner*`, `repo*`, `path*`, `content*`, `message*`, `branch, sha` | `Update README.md in xlabtg/teleton-plugins with content "# Updated" and commit message "Update docs"` |
| `github_create_branch` | `owner*`, `repo*`, `branch*`, `from_ref` | `Create branch feat/login from main in xlabtg/teleton-plugins` |
| `github_delete_file` | `owner*`, `repo*`, `path*`, `sha*`, `message*`, `branch` | `Delete file temp.txt with commit message "Cleanup"` |
| `github_list_directory` | `owner*`, `repo*`, `path*`, `ref` | `List contents of src/ in xlabtg/teleton-plugins` |
| `github_list_files` | `owner*`, `repo*`, `path, ref` | `List files in xlabtg/teleton-plugins` |
| `github_search_code` | `owner*`, `repo*`, `query*` | `Search for "TODO" in xlabtg/teleton-plugins` |
| `github_download_file` | `owner*`, `repo*`, `path*`, `ref` | `Download file dist/app.zip from xlabtg/teleton-plugins` |

> **Note:** `github_list_files` and `github_list_directory` are equivalent — both list files and subdirectories in a repository path. Use whichever feels more natural. `github_list_files` accepts an optional `path` (defaults to the repo root), while `github_list_directory` requires `path`.

---

### Pull Requests (9 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_create_pr` | `owner*`, `repo*`, `title*`, `head*`, `body, base, draft` | `Create a PR in xlabtg/teleton-plugins from feat/login to main with title "Add login"` |
| `github_list_prs` | `owner*`, `repo*`, `state, head, base` | `List open PRs in xlabtg/teleton-plugins` |
| `github_get_pull_request` | `owner*`, `repo*`, `pull_number*` | `Get details of PR #46 in xlabtg/teleton-plugins` |
| `github_merge_pr` | `owner*`, `repo*`, `pr_number*`, `merge_method, confirmed` | `Merge PR #46 in xlabtg/teleton-plugins using squash` |
| `github_list_comments` | `owner*`, `repo*`, `issue_number*` | `List comments on PR #46 in xlabtg/teleton-plugins` |
| `github_list_pull_request_reviews` | `owner*`, `repo*`, `pr_number*` | `List reviews on PR #46 in xlabtg/teleton-plugins` |
| `github_search_issues` | `query*` | `Search for open PRs mentioning "auth" in xlabtg/teleton-plugins` |
| `github_update_pr` | `owner*`, `repo*`, `pr_number*`, `title, body, state, base` | `Update the title of PR #46 to "Fixed: Authentication flow"` |
| `github_add_pr_review` | `owner*`, `repo*`, `pr_number*`, `event*`, `body` | `Approve PR #46 with comment "LGTM"` |

> **`event` values for `github_add_pr_review`:** `"APPROVE"`, `"REQUEST_CHANGES"`, `"COMMENT"`

> **`merge_method` values:** `"merge"` (default), `"squash"`, `"rebase"`

---

### Issues (7 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_create_issue` | `owner*`, `repo*`, `title*`, `body, labels[], assignees[]` | `Create an issue in xlabtg/teleton-plugins: title "Bug: login fails", labels ["bug", "high"]` |
| `github_list_issues` | `owner*`, `repo*`, `state, labels, assignee` | `List open issues in xlabtg/teleton-plugins assigned to me` |
| `github_comment_issue` | `owner*`, `repo*`, `issue_number*`, `body*` | `Comment on issue #15: "Fixed in PR #42"` |
| `github_close_issue` | `owner*`, `repo*`, `issue_number*`, `comment, reason` | `Close issue #15 as completed` |
| `github_update_issue` | `owner*`, `repo*`, `issue_number*`, `title, body, labels, state` | `Update issue #15: add label "solved"` |
| `github_reopen_issue` | `owner*`, `repo*`, `issue_number*` | `Reopen issue #15 in xlabtg/teleton-plugins` |
| `github_assign_issue` | `owner*`, `repo*`, `issue_number*`, `assignees[]*` | `Assign issue #15 to user alice` |

---

### Commits (2 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_list_commits` | `owner*`, `repo*`, `sha, path, author` | `List commits in xlabtg/teleton-plugins on main` |
| `github_get_commit` | `owner*`, `repo*`, `ref*` | `Get details of commit abc1234 in xlabtg/teleton-plugins` |

---

### GitHub Actions (5 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_trigger_workflow` | `owner*`, `repo*`, `workflow_id*`, `ref*`, `inputs` | `Trigger the deploy.yml workflow on main in xlabtg/teleton-plugins` |
| `github_list_workflows` | `owner*`, `repo*` | `List all workflows in xlabtg/teleton-plugins` |
| `github_list_workflow_runs` | `owner*`, `repo*`, `workflow_id, status, branch` | `List recent runs of deploy.yml in xlabtg/teleton-plugins` |
| `github_cancel_workflow_run` | `owner*`, `repo*`, `run_id*` | `Cancel workflow run #12345 in xlabtg/teleton-plugins` |
| `github_get_job_logs` | `owner*`, `repo*`, `job_id*` | `Get logs for job #67890 in xlabtg/teleton-plugins` |

---

### Labels (3 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_list_labels` | `owner*`, `repo*` | `List all labels in xlabtg/teleton-plugins` |
| `github_create_label` | `owner*`, `repo*`, `name*`, `color*`, `description` | `Create label "priority-high" with color #FF0000 in xlabtg/teleton-plugins` |
| `github_delete_label` | `owner*`, `repo*`, `name*` | `Delete label "wontfix" from xlabtg/teleton-plugins` |

---

### Repository Info (3 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_list_languages` | `owner*`, `repo*` | `List programming languages in xlabtg/teleton-plugins` |
| `github_list_collaborators` | `owner*`, `repo*` | `List collaborators on xlabtg/teleton-plugins` |
| `github_list_teams` | `org*` | `List teams in organization xlabtg` |

---

### User & Social (8 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_get_me` | _(none)_ | `Get my GitHub profile info` |
| `github_search_users` | `query*` | `Search GitHub for users named "alice"` |
| `github_list_notifications` | `all, participating` | `List my unread GitHub notifications` |
| `github_star_repo` | `owner*`, `repo*` | `Star repo xlabtg/teleton-plugins` |
| `github_unstar_repo` | `owner*`, `repo*` | `Unstar repo xlabtg/teleton-plugins` |
| `github_list_gists` | `username` | `List public gists for user alice` |
| `github_get_gist` | `gist_id*` | `Get the contents of gist abc123` |
| `github_create_gist` | `files*`, `description, public` | `Create a gist with file notes.md containing "# Notes"` |

---

### Security (2 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_list_code_scanning_alerts` | `owner*`, `repo*`, `state, severity` | `List code scanning alerts for xlabtg/teleton-plugins` |
| `github_list_dependabot_alerts` | `owner*`, `repo*`, `state, severity` | `List Dependabot vulnerability alerts for xlabtg/teleton-plugins` |

---

### Discussions (2 tools)

| Tool | Parameters | Example |
|------|-----------|---------|
| `github_list_discussions` | `owner*`, `repo*` | `List discussions in xlabtg/teleton-plugins` |
| `github_get_discussion` | `owner*`, `repo*`, `discussion_number*` | `Get discussion #5 from xlabtg/teleton-plugins` |

---

## Common Workflow Templates

### Check a Pull Request

```
1. Get details of PR {NUMBER} in {OWNER}/{REPO}
2. List comments on PR {NUMBER} in {OWNER}/{REPO}
3. List reviews on PR {NUMBER} in {OWNER}/{REPO}
4. Summarize: status, approvals, requested changes, recent activity
```

### Create a File in the Repository

```
Push to {OWNER}/{REPO}:
- branch: main
- message: "Add report: {DESCRIPTION}"
- files: [{
    path: "reports/{FILENAME}.md",
    content: "# Report\n\n**Date:** {DATE}\n\n## Results\n- ✅ Item\n\n## Issues\n- [description]\n\n## Recommendations\n1. [item]"
  }]
```

### Create an Issue with Error Report

```
Create an issue in {OWNER}/{REPO}:
- title: "{Short title}"
- body: "## Steps to reproduce\n1. ...\n\n## Expected\n...\n\n## Actual\n...\n\n## Environment\n- Agent: Teleton\n- Plugin: github-dev-assistant"
- labels: ["bug", "github-dev-assistant", "priority-medium"]
```

### Create and Merge a Pull Request

```
1. Create branch feat/my-feature from main in {OWNER}/{REPO}
2. Push files to {OWNER}/{REPO} on branch feat/my-feature
3. Create a PR from feat/my-feature to main with title "Add: {FEATURE}"
4. Check PR status and reviews
5. Merge PR using squash (confirmed: true)
6. Close the related issue if applicable
```

### Trigger a GitHub Actions Workflow

```
1. List all workflows in {OWNER}/{REPO}
2. Trigger the {WORKFLOW_FILE}.yml on the main branch in {OWNER}/{REPO}
3. List recent workflow runs to track progress
4. Get job logs if the run fails
```

---

## Configuration

```yaml
# ~/.teleton/config.yaml
plugins:
  github_dev_assistant:
    default_owner: "xlabtg"          # optional: default org/user for operations
    default_branch: "main"           # default branch for commits and PRs
    require_pr_review: false         # true = agent asks for confirmation before merging
    commit_author_name: "Teleton AI Agent"
    commit_author_email: "agent@teleton.local"
```

---

## Security Guidelines

1. **Store the token securely** — use `sdk.secrets` or the `GITHUB_DEV_ASSISTANT_GITHUB_TOKEN` environment variable; never paste it in chat.
2. **Minimum scopes** — `repo` + `user` covers all tools; add `workflow` only if you use GitHub Actions tools.
3. **Enable `require_pr_review`** — set to `true` to require explicit confirmation before any PR is merged.
4. **Commit authorship** — commits are attributed to the configured `commit_author_name` / `commit_author_email`, not your personal GitHub account.
5. **Destructive operations** — `github_delete_file`, `github_merge_pr`, and `github_push_files` modify the repository permanently; double-check parameters before confirming.

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `401 Unauthorized` | Invalid or expired token | Re-generate PAT at github.com/settings/tokens and update the secret |
| `403 Forbidden` | Insufficient token scopes | Ensure `repo` scope is selected; add `workflow` for Actions |
| `404 Not Found` | Wrong owner/repo, private repo, or missing resource | Check `owner/repo` spelling, verify repository visibility and access |
| `422 Unprocessable Entity` | Missing required parameters | Check that `sha` is provided for file updates, `branch` exists for pushes |
| `Rate limit exceeded` | >5,000 GitHub API requests/hour | Wait for the rate limit window to reset (~1 hour) |
| `Merge failed` | Conflicts or missing approval | Resolve conflicts manually, then retry with `confirmed: true` |

---

## Quick Validation (5 test commands)

Run these after setup to confirm the plugin is working correctly:

```
1. Check my authorization status on GitHub
2. List open PRs in xlabtg/teleton-plugins
3. Get the content of README.md from xlabtg/teleton-plugins
4. List open issues in xlabtg/teleton-plugins with label "bug"
5. Get my GitHub profile info
```

All five commands returning valid responses confirms the plugin is configured and operational.
