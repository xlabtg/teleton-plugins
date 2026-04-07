# self-improvement-assistant

Autonomous codebase analysis and GitHub issue creation — analyze GitHub repositories for bugs, security vulnerabilities, performance issues, and improvement opportunities, then create structured GitHub issues from the findings.

| Tool | Description |
|------|-------------|
| `self_analyze_codebase` | Analyze a GitHub repo's JS/TS files for quality issues |
| `self_create_issue` | Create a GitHub issue from an analysis finding |
| `self_schedule_analysis` | Enable or disable periodic autonomous analysis |
| `self_list_analysis_history` | List past analysis runs and their results |

## Install

```bash
mkdir -p ~/.teleton/plugins
cp -r plugins/self-improvement-assistant ~/.teleton/plugins/
```

## Setup

Set your GitHub Personal Access Token (needs `repo` scope):

```bash
export SELF_IMPROVEMENT_ASSISTANT_GITHUB_TOKEN=ghp_your_token_here
```

Or use the secrets store inside Teleton:

```
/plugin set self-improvement-assistant github_token ghp_your_token_here
```

Create a token at: https://github.com/settings/tokens

## Usage examples

- "Analyze the xlabtg/teleton-plugins repo for security issues"
- "Run a code quality check on myorg/myrepo and focus on performance"
- "Show me the analysis history for xlabtg/teleton-plugins"
- "Create a GitHub issue for the eval() finding in lib/parser.js"
- "Enable daily code analysis for xlabtg/teleton-agent"
- "Stop the scheduled analysis"

## Tool schemas

### self_analyze_codebase

Fetches the repository file tree, reads JS/TS source files, and applies heuristic pattern analysis to detect common code quality issues. Results are persisted to a local SQLite database for history tracking.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `repo` | string | Yes | — | GitHub repository (owner/repo) |
| `branch` | string | No | `"main"` | Branch to analyze |
| `focus_areas` | array | No | all | Areas to check: `security`, `performance`, `readability`, `tests`, `documentation` |

**Detected patterns:**

| Category | Pattern | Severity |
|----------|---------|---------|
| Security | `eval()` usage | Critical |
| Security | `new Function()` | High |
| Security | `innerHTML =` assignment | High |
| Security | Credential logging | Critical |
| Security | Weak hash (MD5/SHA-1) | Medium |
| Performance | `async` in `forEach` | Medium |
| Performance | Missing timer cleanup | Low |
| Readability | Empty catch blocks | Medium |
| Readability | Loose equality (`==`) | Low |
| Readability | Raw `console.*` calls | Low |
| Tests | Large files without tests | Low |

### self_create_issue

Creates a well-formatted GitHub issue from a finding, including severity badge, file path, description, and fix suggestion. Automatically adds the `ai-suggested` label. Requires admin scope.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `repo` | string | Yes | — | GitHub repository (owner/repo) |
| `title` | string | Yes | — | Issue title |
| `file` | string | Yes | — | File path where the issue was found |
| `severity` | string | No | `"medium"` | `critical`, `high`, `medium`, `low` |
| `category` | string | No | `"code-quality"` | `bug`, `security`, `performance`, `readability`, `test`, `documentation` |
| `description` | string | Yes | — | Detailed description of the problem |
| `suggestion` | string | Yes | — | Concrete fix suggestion |
| `code_snippet` | string | No | — | Optional code example |
| `labels` | array | No | `["ai-suggested"]` | GitHub labels to add |
| `task_id` | number | No | — | improvement_tasks.id to update after creation |

### self_schedule_analysis

Enables or disables periodic autonomous codebase analysis. When enabled, analysis runs automatically on the configured interval and results are logged to the database.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | Yes | — | `true` to enable, `false` to disable |
| `repo` | string | Conditional | — | Repository to analyze (required when enabling) |
| `interval_hours` | number | No | `24` | Analysis interval in hours |

### self_list_analysis_history

Returns past analysis runs from the local SQLite database, ordered by most recent first.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `limit` | number | No | `20` | Maximum runs to return |
| `repo` | string | No | — | Filter by repository |

## Configuration

Override defaults in `~/.teleton/config.yaml`:

```yaml
plugins:
  self_improvement_assistant:
    analysis_interval_hours: 12   # How often to run scheduled analysis
    auto_create_issues: false     # Require manual confirmation before creating issues
    max_files_per_analysis: 50    # Cap files per run to control API usage
    exclude_paths:
      - "node_modules/"
      - "dist/"
      - ".test."
      - ".spec."
```

## Security

- GitHub tokens are stored exclusively via `sdk.secrets` — never logged
- Issue creation requires `scope: admin-only` — only available to bot admins
- `auto_create_issues` defaults to `false`, requiring explicit user confirmation
- All GitHub API calls use a 15-second timeout via `AbortSignal.timeout()`
- Analysis results are persisted locally in an isolated SQLite database
