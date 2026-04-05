# composio-direct

Direct integration with **1000+ Composio automation tools** — no MCP transport, no SSE/HTTP issues. Search, execute, batch-run, and authorize external services like GitHub, Gmail, Slack, Notion, Jira, and Linear directly from Teleton Agent.

## Features

- **4 focused tools** covering discovery, execution, batch execution, and OAuth authorization
- **Retry logic** — 3 attempts with exponential backoff (1 s, 2 s, 4 s) for network and 5xx errors
- **Auth error handling** — returns structured `connect_url` when a service needs authorization
- **Parallel batch execution** — configurable concurrency limit
- **Zero sensitive data in logs** — API keys and OAuth tokens are never logged

## Setup

1. Get your Composio API key at <https://app.composio.dev/settings>
2. Set the `composio_api_key` secret in Teleton (or set `COMPOSIO_API_KEY` env var)

```yaml
# config.yaml example
plugins:
  composio-direct:
    composio_api_key: "${COMPOSIO_API_KEY}"
    base_url: "https://api.composio.dev/api/v1"  # optional
    timeout_ms: 30000                             # optional (default: 30s)
    max_parallel_executions: 10                   # optional (default: 10)
```

## Tools

### `composio_search_tools`

Search for available Composio tools by name, description, or toolkit.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | no | Free-text search (e.g. `"create issue"`) |
| `toolkit` | string | no | Filter by toolkit (e.g. `"github"`, `"gmail"`, `"slack"`) |
| `limit` | integer | no | Max results, 1–100 (default: 50) |
| `include_params` | boolean | no | Include parameter schemas (default: false) |

**Example response:**
```json
{
  "success": true,
  "data": {
    "tools": [
      {
        "name": "github_create_issue",
        "slug": "github_create_issue",
        "description": "Create a new issue in a GitHub repository",
        "toolkit": "github",
        "auth_required": true,
        "tags": ["issue", "github"]
      }
    ],
    "count": 1,
    "query": "create issue",
    "total_available": 57
  }
}
```

---

### `composio_execute_tool`

Execute a single Composio tool by its slug.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tool_slug` | string | **yes** | Tool identifier (e.g. `"github_create_issue"`) |
| `parameters` | object | **yes** | Tool-specific parameters |
| `connected_account_id` | string | no | Use a specific connection when multiple exist |
| `timeout_override_ms` | integer | no | Override default timeout (ms) |

**Success:**
```json
{
  "success": true,
  "data": { "issue_number": 42, "url": "https://github.com/org/repo/issues/42" }
}
```

**Auth required:**
```json
{
  "success": false,
  "error": "auth_required",
  "auth": {
    "service": "github",
    "connect_url": "https://app.composio.dev/connect?app=github",
    "message": "Authorization required for GITHUB. Click the link to connect."
  }
}
```

---

### `composio_multi_execute`

Execute multiple tools in parallel.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `executions` | array | **yes** | Array of `{ tool_slug, parameters, timeout_override_ms? }` |
| `fail_fast` | boolean | no | Stop on first error (default: false) |
| `max_parallel` | integer | no | Max concurrent tools, 1–50 (default: 10) |

**Example:**
```json
{
  "success": true,
  "data": {
    "results": [
      { "tool_slug": "github_create_issue", "success": true, "data": { "id": 1 } },
      { "tool_slug": "gmail_send_email", "success": false, "error": "auth_required", "auth": { ... } }
    ],
    "summary": { "succeeded": 1, "failed": 1, "skipped": 0, "total": 2 }
  }
}
```

---

### `composio_auth_link`

Get an OAuth authorization link for a service.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `service` | string | **yes** | Service name (e.g. `"github"`, `"gmail"`, `"slack"`, `"notion"`, `"linear"`, `"jira"`) |
| `redirect_after_auth` | string | no | Message shown after the user authorizes |

**Example:**
```json
{
  "success": true,
  "data": {
    "message": "🔗 Click to connect **GITHUB**:",
    "url": "https://app.composio.dev/connect?app=github&user_id=123456",
    "service": "github",
    "hint": "After authorizing, write 'done' and repeat your request."
  }
}
```

## Manual testing checklist

```
[ ] Plugin loads without errors
[ ] composio_search_tools query="github" returns tools
[ ] composio_auth_link service="github" returns a valid link
[ ] composio_execute_tool with invalid slug returns a helpful error
[ ] Auth errors return structured response with connect_url
[ ] composio_multi_execute with 2+ tools returns results in order
[ ] Timeouts and retries work correctly (test with a slow endpoint)
```

## Running tests

```sh
# Unit tests only
node --test plugins/composio-direct/test/unit/composio-direct.test.js

# Integration tests only
node --test plugins/composio-direct/test/integration/composio-api.test.js

# All tests
node --test plugins/composio-direct/test/unit/composio-direct.test.js \
         plugins/composio-direct/test/integration/composio-api.test.js
```

## Security

- `composio_api_key` is never written to logs
- OAuth tokens returned by the API are never written to logs
- All Composio API calls use HTTPS
- `composio_execute_tool` and `composio_multi_execute` are scoped to `dm-only` to prevent accidental side-effects in group chats
