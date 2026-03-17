# GitHub Dev Assistant

Full GitHub development workflow automation for the [Teleton](https://github.com/xlabtg/teleton-agent) AI agent. Enables autonomous creation of repositories, files, branches, pull requests, issues, and workflow triggers — all from a Telegram chat.

## Features

| Category | Tools |
|----------|-------|
| **Authorization** | `github_auth`, `github_check_auth` |
| **Repositories** | `github_list_repos`, `github_create_repo` |
| **Files & Branches** | `github_get_file`, `github_update_file`, `github_create_branch` |
| **Pull Requests** | `github_create_pr`, `github_list_prs`, `github_merge_pr` |
| **Issues** | `github_create_issue`, `github_list_issues`, `github_comment_issue`, `github_close_issue` |
| **GitHub Actions** | `github_trigger_workflow` |

**15 tools total** covering the complete GitHub development lifecycle.

## Installation

### Via Teleton Web UI
1. Open the Teleton Web UI and navigate to **Plugins**.
2. Search for `github-dev-assistant` and click **Install**.
3. Open plugin **Settings** to configure secrets and connect your GitHub account.

### Manual Installation
1. Clone or copy this plugin folder to your Teleton plugins directory.
2. Add the plugin to `registry.json`.
3. Restart the Teleton agent.

## Setup & Authorization

### Step 1: Create a GitHub OAuth App

1. Go to **GitHub Settings → Developer settings → OAuth Apps → New OAuth App**
2. Fill in:
   - **Application name**: `Teleton Dev Assistant` (or any name)
   - **Homepage URL**: your Teleton instance URL
   - **Authorization callback URL**: `<your-teleton-url>/plugins/github-dev-assistant/web-ui/oauth-callback.html`
3. Click **Register application**
4. Note your **Client ID** and generate a **Client Secret**

### Step 2: Configure Plugin Secrets

In the Teleton Web UI plugin settings (or via environment variables):

| Secret | Environment Variable | Description |
|--------|---------------------|-------------|
| `github_client_id` | `GITHUB_OAUTH_CLIENT_ID` | OAuth App Client ID |
| `github_client_secret` | `GITHUB_OAUTH_CLIENT_SECRET` | OAuth App Client Secret |
| `github_webhook_secret` | `GITHUB_WEBHOOK_SECRET` | Webhook secret (optional) |

### Step 3: Authorize with GitHub

In the Teleton plugin settings panel:
1. Click **Connect GitHub Account**
2. A GitHub authorization popup will appear
3. Authorize the app and grant requested scopes
4. The panel will confirm: "Connected as *your-username*"

Or via the agent chat:
```
Check my GitHub auth status
```
```
Connect my GitHub account with repo and workflow scopes
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

## Configuration Options

| Config Key | Type | Default | Description |
|------------|------|---------|-------------|
| `default_owner` | string | `null` | Default GitHub username/org for operations |
| `default_branch` | string | `"main"` | Default branch for commits and PRs |
| `auto_sign_commits` | boolean | `true` | Attribute commits to the agent |
| `require_pr_review` | boolean | `false` | Require confirmation before merging PRs |
| `commit_author_name` | string | `"Teleton AI Agent"` | Author name in commits |
| `commit_author_email` | string | `"agent@teleton.local"` | Author email in commits |

## Security Best Practices

- **Never share your OAuth Client Secret.** It is stored encrypted via `sdk.secrets` and never appears in logs.
- **Enable `require_pr_review`** if you want human confirmation before any PR merges.
- **Use minimum required scopes.** The default `["repo", "workflow", "user"]` covers all plugin features; remove `workflow` if you don't need GitHub Actions.
- **Revoke access** via the plugin settings panel if you no longer need the connection.
- **Review commit author settings** — commits will be attributed to the configured name/email, not your personal GitHub account.

## Tool Reference

### `github_auth`
Initiate or complete OAuth authorization. Call without parameters to start the flow (returns auth URL), or with `code` + `state` to complete it.

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
Merge a pull request. Parameters: `owner`, `repo`, `pr_number` (all required), `merge_method`, `commit_title`, `commit_message`, `skip_review_check`.

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

## Testing

```bash
cd plugins/github-dev-assistant
npm install
npm test
```

Tests use [Vitest](https://vitest.dev/) with mocked GitHub API responses. No real API calls are made during testing.

## Contributing

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines on adding new tools and submitting pull requests.

## License

MIT — see [LICENSE](../../LICENSE)
