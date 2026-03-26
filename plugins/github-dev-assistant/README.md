# GitHub Dev Assistant

Complete GitHub development workflow automation for the [Teleton](https://github.com/xlabtg/teleton-agent) AI agent. Enables autonomous management of repositories, files, branches, pull requests, issues, commits, GitHub Actions workflows, labels, user profiles, gists, notifications, security alerts, and discussions — all from a Telegram chat.

## Features

| Category | Tools |
|----------|-------|
| **Authorization** | `github_check_auth` |
| **Repositories** | `github_list_repos`, `github_create_repo`, `github_fork_repo`, `github_search_repos`, `github_list_branches`, `github_push_files`, `github_get_repo_tree`, `github_list_tags`, `github_list_releases`, `github_get_latest_release` |
| **Files & Branches** | `github_get_file`, `github_update_file`, `github_create_branch`, `github_delete_file`, `github_list_directory`, `github_list_files`, `github_search_code`, `github_download_file` |
| **Pull Requests** | `github_create_pr`, `github_list_prs`, `github_get_pull_request`, `github_merge_pr`, `github_list_comments`, `github_list_pull_request_reviews`, `github_search_issues`, `github_update_pr`, `github_add_pr_review` |
| **Issues** | `github_create_issue`, `github_list_issues`, `github_comment_issue`, `github_close_issue`, `github_update_issue`, `github_reopen_issue`, `github_assign_issue` |
| **Commits** | `github_list_commits`, `github_get_commit` |
| **GitHub Actions** | `github_trigger_workflow`, `github_list_workflows`, `github_list_workflow_runs`, `github_cancel_workflow_run`, `github_get_job_logs` |
| **Labels** | `github_list_labels`, `github_create_label`, `github_delete_label` |
| **Repo Info** | `github_list_languages`, `github_list_collaborators`, `github_list_teams` |
| **User & Social** | `github_get_me`, `github_search_users`, `github_list_notifications`, `github_star_repo`, `github_unstar_repo`, `github_list_gists`, `github_get_gist`, `github_create_gist` |
| **Security** | `github_list_code_scanning_alerts`, `github_list_dependabot_alerts` |
| **Discussions** | `github_list_discussions`, `github_get_discussion` |

**60 tools total** covering the complete GitHub development lifecycle.

## Installation

### Via Teleton Web UI
1. Open the Teleton Web UI and navigate to **Plugins**.
2. Search for `github-dev-assistant` and click **Install**.
3. Navigate to **Keys** in the plugin settings to configure the Personal Access Token (see [Setup & Authorization](#setup--authorization) below).

### Manual Installation

```bash
mkdir -p ~/.teleton/plugins
cp -r plugins/github-dev-assistant ~/.teleton/plugins/
```

## Setup & Authorization

### Step 1: Create a Personal Access Token

1. Go to **GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Click **Generate new token (classic)**
3. Select scopes: `repo`, `workflow`, `user`
4. Click **Generate token** and copy the token

### Step 2: Configure the Token

#### Via Teleton Web UI (recommended)

1. Open the Teleton Web UI.
2. Navigate to **Plugins → GitHub Dev Assistant → Settings**.
3. Click the **Keys** tab.
4. Paste your Personal Access Token into the **`github_token`** field and save.

To update the token later, return to the same **Keys** tab, clear the existing value, paste the new token, and save.

#### Via Environment Variable

```bash
export GITHUB_DEV_ASSISTANT_GITHUB_TOKEN=ghp_your_token_here
```

| Secret | Environment Variable | Description |
|--------|---------------------|-------------|
| `github_token` | `GITHUB_DEV_ASSISTANT_GITHUB_TOKEN` | GitHub Personal Access Token |

### Step 3: Verify Authorization

In the agent chat:
```
Check my GitHub auth status
```

## Usage Examples

### Check Authorization
```
Check my GitHub auth status
```

### Repository Operations
```
List my GitHub repos
List repos for the organization my-org, sorted by stars
Create a private GitHub repo called my-new-project with a MIT license
Fork octocat/hello-world into my account
Search GitHub for repos about machine learning in Python with over 1000 stars
List branches in my-org/my-repo
Push multiple files to my-org/my-repo on the main branch
Get the full file tree of my-org/my-repo
List all tags in my-org/my-repo
List releases for my-org/my-repo
Get the latest release of my-org/my-repo
```

### File Operations
```
Get the contents of README.md from octocat/hello-world
Read src/index.js from my-org/my-repo on the develop branch
Update README.md in octocat/hello with content "# Hello World" and commit message "Update docs"
Create a new file docs/api.md in my-org/my-repo with the API documentation content
Delete the file old-config.json from my-org/my-repo
List the contents of the src/ directory in my-org/my-repo
Search for "TODO" in my-org/my-repo
Download the binary release asset from my-org/my-repo
```

### Branch Operations
```
Create branch feat/login-ui from main in my-org/my-repo
Create a hotfix branch from the v2.1.0 tag in my-org/production-app
```

### Pull Request Operations
```
Create a PR in my-org/my-repo from branch feat/login-ui to main with title "Add login UI"
List open PRs in my-org/my-repo
List all PRs (open and closed) in octocat/hello
Merge PR #42 in my-org/my-repo using squash strategy
List comments on PR #42 in my-org/my-repo
List reviews on PR #42 in my-org/my-repo
Search for open PRs mentioning "authentication" in my-org/my-repo
Update PR #42 title to "Fix authentication flow"
Approve PR #42 in my-org/my-repo with comment "Looks good!"
Request changes on PR #42 in my-org/my-repo
```

### Issue Operations
```
Create an issue in my-org/my-repo: title "Bug: login fails on Safari", label it with "bug" and "priority-high"
List open issues in my-org/my-repo assigned to me
Comment on issue #15 in my-org/my-repo: "Fixed in PR #42"
Close issue #15 in my-org/my-repo as completed
Update the title and labels of issue #15 in my-org/my-repo
Reopen issue #15 in my-org/my-repo
Assign issue #15 in my-org/my-repo to user alice
```

### Commit Operations
```
List commits in my-org/my-repo on the main branch
Get details of commit abc1234 in my-org/my-repo including changed files
```

### GitHub Actions
```
Trigger the deploy.yml workflow on the main branch in my-org/my-repo
Run CI workflow on branch feat/new-feature in my-org/my-repo with input environment=staging
List all workflows in my-org/my-repo
List recent workflow runs for deploy.yml in my-org/my-repo
Cancel workflow run #12345 in my-org/my-repo
Get logs for job #67890 in my-org/my-repo
```

### Label Operations
```
List all labels in my-org/my-repo
Create a label "priority-high" with color #FF0000 in my-org/my-repo
Delete the label "wontfix" from my-org/my-repo
```

### Repo Info
```
List programming languages used in my-org/my-repo
List collaborators on my-org/my-repo
List teams in my-org organization
```

### User & Social
```
Get my GitHub profile info
Search GitHub for users named "alice"
List my unread GitHub notifications
Star the repo octocat/hello-world
Unstar the repo octocat/hello-world
List public gists for user alice
Get the contents of gist abc123
Create a gist with file notes.md containing "# Notes"
```

### Security
```
List code scanning alerts for my-org/my-repo
List Dependabot vulnerability alerts for my-org/my-repo
```

### Discussions
```
List discussions in my-org/my-repo
Get discussion #5 from my-org/my-repo
```

## Configuration

```yaml
# ~/.teleton/config.yaml
plugins:
  github_dev_assistant:
    default_owner: null          # Default GitHub username/org for operations
    default_branch: "main"       # Default branch for commits and PRs
    require_pr_review: false     # Require confirmation before merging PRs
    commit_author_name: "Teleton AI Agent"   # Author name in commits
    commit_author_email: "agent@teleton.local" # Author email in commits
```

## Security Best Practices

- **Never share your Personal Access Token.** It is stored encrypted via `sdk.secrets` and never appears in logs.
- **Enable `require_pr_review`** if you want human confirmation before any PR merges.
- **Use minimum required scopes.** `repo`, `workflow`, and `user` cover all plugin features; remove `workflow` if you don't need GitHub Actions.
- **Review commit author settings** — commits will be attributed to the configured name/email, not your personal GitHub account.

## Tool Reference

### `github_check_auth`
Check whether the plugin is authenticated and return the connected user's login. No parameters.

### `github_list_repos`
List repositories for a user or organization. Parameters: `owner`, `type`, `sort`, `direction`, `per_page`, `page`.

### `github_create_repo`
Create a new repository. Parameters: `name` (required), `description`, `private`, `auto_init`, `license_template`, `gitignore_template`.

### `github_fork_repo`
Fork a repository into the authenticated user's account or an organization. Parameters: `owner`, `repo` (both required), `organization`.

### `github_search_repos`
Search GitHub repositories using search qualifiers. Parameters: `query` (required), `sort`, `order`, `per_page`, `page`.

### `github_list_branches`
List branches in a repository. Parameters: `owner`, `repo` (both required), `protected`, `per_page`, `page`.

### `github_push_files`
Commit multiple files to a repository in a single operation. Parameters: `owner`, `repo`, `branch`, `message` (all required), `files` (array of `{path, content}`).

### `github_get_repo_tree`
Get the full file tree of a repository. Parameters: `owner`, `repo` (both required), `ref`, `recursive`.

### `github_list_tags`
List tags in a repository. Parameters: `owner`, `repo` (both required), `per_page`, `page`.

### `github_list_releases`
List releases for a repository. Parameters: `owner`, `repo` (both required), `per_page`, `page`.

### `github_get_latest_release`
Get the latest stable release of a repository. Parameters: `owner`, `repo` (both required).

### `github_get_file`
Read a file or list a directory. Parameters: `owner`, `repo`, `path` (all required), `ref`.

### `github_update_file`
Create or update a file with a commit. Parameters: `owner`, `repo`, `path`, `content`, `message` (all required), `branch`, `sha` (required for updates), `committer_name`, `committer_email`.

### `github_create_branch`
Create a new branch. Parameters: `owner`, `repo`, `branch` (all required), `from_ref`.

### `github_delete_file`
Delete a file from a repository. Parameters: `owner`, `repo`, `path`, `sha`, `message` (all required), `branch`, `committer_name`, `committer_email`.

### `github_list_directory`
List contents of a directory. Parameters: `owner`, `repo`, `path` (all required), `ref`.

### `github_list_files`
List files and subdirectories in a repository path. Equivalent to `github_list_directory` — use whichever feels more natural. Parameters: `owner`, `repo` (both required), `path` (defaults to repo root), `ref`.

### `github_search_code`
Search for code patterns within a repository. Parameters: `owner`, `repo`, `query` (all required), `per_page`, `page`.

### `github_download_file`
Download a file and return its content. Parameters: `owner`, `repo`, `path` (all required), `ref`.

### `github_create_pr`
Create a pull request. Parameters: `owner`, `repo`, `title`, `head` (all required), `body`, `base`, `draft`, `maintainer_can_modify`.

### `github_list_prs`
List pull requests. Parameters: `owner`, `repo` (both required), `state`, `head`, `base`, `sort`, `direction`, `per_page`, `page`.

### `github_get_pull_request`
Get detailed information about a specific pull request, including title, body, state, draft/merged status, head/base branches, author, assignees, labels, review decision, requested reviewers, and change stats (commits, additions, deletions, changed files). Parameters: `owner`, `repo`, `pull_number` (all required).

### `github_merge_pr`
Merge a pull request. Parameters: `owner`, `repo`, `pr_number` (all required), `merge_method`, `commit_title`, `commit_message`, `confirmed`.

### `github_list_comments`
List comments on an issue or pull request. Parameters: `owner`, `repo`, `issue_number` (all required), `per_page`, `page`.

### `github_list_pull_request_reviews`
List reviews on a pull request. Parameters: `owner`, `repo`, `pr_number` (all required), `per_page`, `page`.

### `github_search_issues`
Search for issues and pull requests across GitHub. Parameters: `query` (required), `sort`, `order`, `per_page`, `page`.

### `github_update_pr`
Update a pull request title, body, state, or base branch. Parameters: `owner`, `repo`, `pr_number` (all required), `title`, `body`, `state`, `base`.

### `github_add_pr_review`
Submit a review on a pull request (approve, request changes, or comment). Parameters: `owner`, `repo`, `pr_number`, `event` (all required), `body`, `comments`.

### `github_create_issue`
Create an issue. Parameters: `owner`, `repo`, `title` (all required), `body`, `labels`, `assignees`, `milestone`.

### `github_list_issues`
List issues. Parameters: `owner`, `repo` (both required), `state`, `labels`, `assignee`, `creator`, `mentioned`, `sort`, `direction`, `per_page`, `page`.

### `github_comment_issue`
Add a comment to an issue or pull request. Parameters: `owner`, `repo`, `issue_number`, `body` (all required).

### `github_close_issue`
Close an issue or pull request. Parameters: `owner`, `repo`, `issue_number` (all required), `comment`, `reason`.

### `github_update_issue`
Update the title, body, labels, or state of an existing issue. Parameters: `owner`, `repo`, `issue_number` (all required), `title`, `body`, `labels`, `state`, `assignees`.

### `github_reopen_issue`
Reopen a closed issue. Parameters: `owner`, `repo`, `issue_number` (all required).

### `github_assign_issue`
Assign an issue to one or more users. Parameters: `owner`, `repo`, `issue_number`, `assignees` (all required).

### `github_list_commits`
List commits in a repository. Parameters: `owner`, `repo` (both required), `sha`, `path`, `author`, `per_page`, `page`.

### `github_get_commit`
Get detailed information about a specific commit including changed files. Parameters: `owner`, `repo`, `ref` (all required).

### `github_trigger_workflow`
Manually trigger a GitHub Actions workflow dispatch. Parameters: `owner`, `repo`, `workflow_id`, `ref` (all required), `inputs`.

### `github_list_workflows`
List GitHub Actions workflows in a repository. Parameters: `owner`, `repo` (both required), `per_page`, `page`.

### `github_list_workflow_runs`
List runs of GitHub Actions workflows. Parameters: `owner`, `repo` (both required), `workflow_id`, `status`, `branch`, `per_page`, `page`.

### `github_cancel_workflow_run`
Cancel a running GitHub Actions workflow run. Parameters: `owner`, `repo`, `run_id` (all required).

### `github_get_job_logs`
Get logs and details for a specific GitHub Actions workflow job. Parameters: `owner`, `repo`, `job_id` (all required).

### `github_list_labels`
List labels in a repository. Parameters: `owner`, `repo` (both required), `per_page`, `page`.

### `github_create_label`
Create a new label in a repository. Parameters: `owner`, `repo`, `name`, `color` (all required), `description`.

### `github_delete_label`
Delete a label from a repository. Parameters: `owner`, `repo`, `name` (all required).

### `github_list_languages`
List programming languages used in a repository. Parameters: `owner`, `repo` (both required).

### `github_list_collaborators`
List collaborators on a repository. Parameters: `owner`, `repo` (both required), `affiliation`, `per_page`, `page`.

### `github_list_teams`
List teams in a GitHub organization. Parameters: `org` (required), `per_page`, `page`.

### `github_get_me`
Get the authenticated GitHub user's profile information. No parameters.

### `github_search_users`
Search for GitHub users and organizations. Parameters: `query` (required), `sort`, `order`, `per_page`, `page`.

### `github_list_notifications`
List GitHub notifications for the authenticated user. Parameters: `all`, `participating`, `per_page`, `page`.

### `github_star_repo`
Star a GitHub repository. Parameters: `owner`, `repo` (both required).

### `github_unstar_repo`
Unstar a GitHub repository. Parameters: `owner`, `repo` (both required).

### `github_list_gists`
List gists for a GitHub user. Parameters: `username`, `per_page`, `page`.

### `github_get_gist`
Get the content of a specific GitHub gist. Parameters: `gist_id` (required).

### `github_create_gist`
Create a new GitHub gist with one or more files. Parameters: `files` (required, object of `{filename: {content}}`), `description`, `public`.

### `github_list_code_scanning_alerts`
List code scanning (SAST) security alerts for a repository. Parameters: `owner`, `repo` (both required), `state`, `severity`, `per_page`, `page`.

### `github_list_dependabot_alerts`
List Dependabot vulnerability alerts for a repository. Parameters: `owner`, `repo` (both required), `state`, `severity`, `per_page`, `page`.

### `github_list_discussions`
List discussions in a GitHub repository. Parameters: `owner`, `repo` (both required), `per_page`, `page`.

### `github_get_discussion`
Get a specific GitHub discussion with its body and comments. Parameters: `owner`, `repo`, `discussion_number` (all required).

## Agent Guide

For a complete agent-oriented reference — including natural-language example commands, workflow templates, and troubleshooting tips for all 60 tools — see **[GUIDE.md](./GUIDE.md)**.

## Developer

**Developer:** [xlabtg](https://github.com/xlabtg)

## License

MIT — see [LICENSE](../../LICENSE)
