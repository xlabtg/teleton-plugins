# GitHub Dev Assistant

Full GitHub development workflow automation for the [Teleton](https://github.com/xlabtg/teleton-agent) AI agent. Enables autonomous creation of repositories, files, branches, pull requests, issues, and workflow triggers — all from a Telegram chat.

## Features

| Category | Tools |
|----------|-------|
| **Authorization** | `github_check_auth` |
| **Repositories** | `github_list_repos`, `github_create_repo` |
| **Files & Branches** | `github_get_file`, `github_update_file`, `github_create_branch` |
| **Pull Requests** | `github_create_pr`, `github_list_prs`, `github_merge_pr` |
| **Issues** | `github_create_issue`, `github_list_issues`, `github_comment_issue`, `github_close_issue` |
| **GitHub Actions** | `github_trigger_workflow` |

**14 tools total** covering the complete GitHub development lifecycle.

## Installation

### Via Teleton Web UI
1. Open the Teleton Web UI and navigate to **Plugins**.
2. Search for `github-dev-assistant` and click **Install**.
3. Open plugin **Settings** to configure the Personal Access Token.

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

### Step 2: Configure Plugin Secret

Set the token via environment variable or Teleton secrets store:

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
```

### File Operations
```
Get the contents of README.md from octocat/hello-world
Read src/index.js from my-org/my-repo on the develop branch
Update README.md in octocat/hello with content "# Hello World" and commit message "Update docs"
Create a new file docs/api.md in my-org/my-repo with the API documentation content
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
```

### Issue Operations
```
Create an issue in my-org/my-repo: title "Bug: login fails on Safari", label it with "bug" and "priority-high"
List open issues in my-org/my-repo assigned to me
Comment on issue #15 in my-org/my-repo: "Fixed in PR #42"
Close issue #15 in my-org/my-repo as completed
```

### GitHub Actions
```
Trigger the deploy.yml workflow on the main branch in my-org/my-repo
Run CI workflow on branch feat/new-feature in my-org/my-repo with input environment=staging
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
Check whether the plugin is authenticated and return the connected user's login.

### `github_list_repos`
List repositories. Parameters: `owner`, `type`, `sort`, `direction`, `per_page`, `page`.

### `github_create_repo`
Create a new repository. Parameters: `name` (required), `description`, `private`, `auto_init`, `license_template`, `gitignore_template`.

### `github_get_file`
Read a file or list a directory. Parameters: `owner`, `repo`, `path` (all required), `ref`.

### `github_update_file`
Create or update a file with a commit. Parameters: `owner`, `repo`, `path`, `content`, `message` (all required), `branch`, `sha` (required for updates), `committer_name`, `committer_email`.

### `github_create_branch`
Create a new branch. Parameters: `owner`, `repo`, `branch` (all required), `from_ref`.

### `github_create_pr`
Create a pull request. Parameters: `owner`, `repo`, `title`, `head` (all required), `body`, `base`, `draft`, `maintainer_can_modify`.

### `github_list_prs`
List pull requests. Parameters: `owner`, `repo` (required), `state`, `head`, `base`, `sort`, `direction`, `per_page`, `page`.

### `github_merge_pr`
Merge a pull request. Parameters: `owner`, `repo`, `pr_number` (all required), `merge_method`, `commit_title`, `commit_message`, `confirmed`.

### `github_create_issue`
Create an issue. Parameters: `owner`, `repo`, `title` (all required), `body`, `labels`, `assignees`, `milestone`.

### `github_list_issues`
List issues. Parameters: `owner`, `repo` (required), `state`, `labels`, `assignee`, `creator`, `mentioned`, `sort`, `direction`, `per_page`, `page`.

### `github_comment_issue`
Add a comment. Parameters: `owner`, `repo`, `issue_number`, `body` (all required).

### `github_close_issue`
Close an issue or PR. Parameters: `owner`, `repo`, `issue_number` (all required), `comment`, `reason`.

### `github_trigger_workflow`
Trigger a GitHub Actions workflow dispatch. Parameters: `owner`, `repo`, `workflow_id`, `ref` (all required), `inputs`.

## Developer

**Developer:** [xlabtg](https://github.com/xlabtg)

## License

MIT — see [LICENSE](../../LICENSE)
