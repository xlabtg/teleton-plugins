# composio-direct

Direct integration with **1000+ Composio automation tools** — no MCP transport, no SSE/HTTP issues. Search, execute, batch-run, and authorize external services like GitHub, Gmail, Slack, Notion, Jira, and Linear directly from Teleton Agent.

## Features

- **7 focused tools** covering discovery, schema lookup, execution, batch execution, OAuth authorization, and connection reuse
- **Retry logic** — 3 attempts with exponential backoff (1 s, 2 s, 4 s) for network and 5xx errors
- **Auth error handling** — returns structured `connect_url` when a service needs authorization
- **Schema lookup** — retrieves exact input/output schemas from the v3 `tools/{tool_slug}` API
- **Connection management** — lists and fetches existing connected accounts so the agent can reuse them
- **Parallel batch execution** — configurable concurrency limit
- **Zero sensitive data in logs** — API keys and OAuth tokens are never logged

## Setup

1. Get your Composio API key at <https://app.composio.dev/settings>
2. Set the `composio_api_key` secret in Teleton:

```text
/plugin set composio-direct composio_api_key <your-composio-api-key>
```

For container and CI deployments, Teleton also resolves the secret from `COMPOSIO_DIRECT_COMPOSIO_API_KEY`. The plugin keeps `COMPOSIO_API_KEY` as a direct fallback for older deployments.

```yaml
# config.yaml example
plugins:
  composio_direct:
    base_url: "https://backend.composio.dev/api/v3"    # optional
    timeout_ms: 30000                                  # optional (default: 30s)
    max_parallel_executions: 10                        # optional (default: 10)
    tool_version: "latest"                             # optional
    toolkit_versions: "latest"                         # optional
    auth_config_ids: {}                                # optional service -> auth config id
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
        "tool_slug": "GITHUB_CREATE_ISSUE",
        "display_name": "Create issue",
        "description": "Create a new issue in a GitHub repository",
        "toolkit": "github",
        "auth_required": true,
        "version": "latest",
        "tags": ["issue", "github"],
        "execute_with": {
          "tool": "composio_execute_tool",
          "tool_slug": "GITHUB_CREATE_ISSUE",
          "parameters_param": "parameters"
        }
      }
    ],
    "count": 1,
    "query": "create issue",
    "total_available": 57,
    "execution": {
      "tool": "composio_execute_tool",
      "instruction": "Do not call returned tool_slug values directly. To run a Composio result, call composio_execute_tool with { tool_slug, parameters }."
    }
  }
}
```

The returned `tool_slug` values are Composio tool identifiers, not Teleton tool names. Execute them through `composio_execute_tool` or `composio_multi_execute`.

---

### `composio_get_tool_schemas`

Fetch exact input and output schemas for Composio tool slugs returned by `composio_search_tools`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tool_slug` | string | no | Single tool identifier |
| `tool_slugs` | array | no | One or more tool identifiers |
| `include` | array | no | Fields to include: `input_schema`, `output_schema`, `metadata` (default: `input_schema`) |
| `version` | string | no | Composio tool version (default: plugin `tool_version`) |

**Example response:**
```json
{
  "success": true,
  "data": {
    "schemas": [
      {
        "tool_slug": "GITHUB_CREATE_ISSUE",
        "display_name": "Create issue",
        "toolkit": "github",
        "input_schema": {
          "title": { "type": "string", "required": true }
        },
        "output_schema": {
          "url": { "type": "string" }
        },
        "execute_with": {
          "tool": "composio_execute_tool",
          "tool_slug": "GITHUB_CREATE_ISSUE",
          "parameters_param": "parameters"
        }
      }
    ],
    "count": 1
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
| `version` | string | no | Composio tool version (default: plugin `tool_version`) |
| `timeout_override_ms` | integer | no | Override default timeout (ms) |

**Success:**
```json
{
  "success": true,
  "data": {
    "issue_number": 42,
    "url": "https://github.com/org/repo/issues/42",
    "log_id": "log_123"
  }
}
```

**Auth required:**
```json
{
  "success": false,
  "error": "auth_required",
  "auth": {
    "service": "github",
    "connect_url": null,
    "message": "Authorization required for GITHUB. Call composio_auth_link for a fresh connection link."
  }
}
```

---

### `composio_multi_execute`

Execute multiple tools in parallel.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `executions` | array | **yes** | Array of `{ tool_slug, parameters, connected_account_id?, version?, timeout_override_ms? }` |
| `fail_fast` | boolean | no | Stop on first error (default: false) |
| `max_parallel` | integer | no | Max concurrent tools, 1–50 (default: 10) |

**Example:**
```json
{
  "success": true,
  "data": {
    "results": [
      { "tool_slug": "GITHUB_CREATE_ISSUE", "success": true, "data": { "id": 1 } },
      { "tool_slug": "GMAIL_SEND_EMAIL", "success": false, "error": "auth_required", "auth": { "service": "gmail" } }
    ],
    "summary": { "succeeded": 1, "failed": 1, "skipped": 0, "total": 2 }
  }
}
```

---

### `composio_list_connections`

List existing Composio connected accounts. By default, the tool filters to the current Teleton sender ID so the agent does not accidentally reuse another user's connection. Set `include_all_users` only for administrative inspection.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `toolkit` | string | no | Filter by one toolkit slug |
| `toolkits` | array | no | Filter by multiple toolkit slugs |
| `status` | string | no | Filter by one status (for example `ACTIVE`) |
| `statuses` | array | no | Filter by multiple statuses |
| `user_id` | string | no | Filter by one Composio user ID |
| `user_ids` | array | no | Filter by multiple Composio user IDs |
| `include_all_users` | boolean | no | Disable the default current-user filter |
| `auth_config_id` | string | no | Filter by one auth config ID |
| `connected_account_id` | string | no | Filter by one connected account ID |
| `cursor` | string | no | Pagination cursor |
| `limit` | integer | no | Max results, 1-1000 (default: 50) |
| `order_by` | string | no | `created_at` or `updated_at` |
| `order_direction` | string | no | `asc` or `desc` |

Connection state values are not returned because they can contain credential material. The response includes only `state_keys` and `connection_data_keys`.

**Example response:**
```json
{
  "success": true,
  "data": {
    "connections": [
      {
        "id": "ca_123",
        "alias": "work",
        "user_id": "123456",
        "status": "ACTIVE",
        "toolkit": { "slug": "github", "name": "GitHub" },
        "execute_with": {
          "tool": "composio_execute_tool",
          "connected_account_id": "ca_123",
          "connected_account_id_param": "connected_account_id"
        }
      }
    ],
    "count": 1
  }
}
```

---

### `composio_get_connection`

Get one connected account by ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `connected_account_id` | string | **yes** | Composio connected account ID (for example `ca_123`) |

Use the returned `connection.execute_with.connected_account_id` with `composio_execute_tool` or `composio_multi_execute`.

---

### `composio_auth_link`

Get an OAuth authorization link for a service.

The tool creates a real Composio Connect Link through the v3 `auth_configs`
and `connected_accounts/link` APIs. For toolkits without Composio-managed auth,
create an auth config in Composio and pass its ID as `auth_config_id`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `service` | string | **yes** | Service name (e.g. `"github"`, `"gmail"`, `"slack"`, `"notion"`, `"linear"`, `"jira"`) |
| `redirect_after_auth` | string | no | Message shown after the user authorizes |
| `auth_config_id` | string | no | Existing Composio auth config ID to use |
| `callback_url` | string | no | URL Composio should redirect to after authentication |
| `alias` | string | no | Human-readable alias for the connected account |

**Example:**
```json
{
  "success": true,
  "data": {
    "message": "Click to connect GITHUB:",
    "url": "https://connect.composio.dev/link/ln_123",
    "service": "github",
    "user_id": "123456",
    "auth_config_id": "ac_123",
    "connected_account_id": "ca_123",
    "hint": "After authorizing, write 'done' and repeat your request."
  }
}
```

## Manual testing checklist

```
[ ] Plugin loads without errors
[ ] composio_search_tools query="github" returns tools
[ ] composio_get_tool_schemas tool_slug="GITHUB_CREATE_ISSUE" returns input_schema
[ ] composio_list_connections toolkit="github" status="ACTIVE" returns reusable connection IDs
[ ] composio_get_connection connected_account_id="ca_..." returns non-secret metadata
[ ] composio_auth_link service="github" returns a valid link
[ ] composio_execute_tool with invalid slug returns a helpful error
[ ] Auth errors return structured response with connect_url
[ ] composio_multi_execute with 2+ tools returns results in order
[ ] Timeouts and retries work correctly (test with a slow endpoint)
```

## Running tests

```sh
# CI-discovered Teleton integration test
node --test plugins/composio-direct/tests/index.test.js

# Unit tests only
node --test plugins/composio-direct/test/unit/composio-direct.test.js

# Integration tests only
node --test plugins/composio-direct/test/integration/composio-api.test.js

# All tests
node --test plugins/composio-direct/tests/index.test.js \
         plugins/composio-direct/test/unit/composio-direct.test.js \
         plugins/composio-direct/test/integration/composio-api.test.js
```

The repository-wide `npm test` command also discovers `plugins/composio-direct/tests/index.test.js`.

Legacy explicit tests:

```sh
node --test plugins/composio-direct/test/unit/composio-direct.test.js \
         plugins/composio-direct/test/integration/composio-api.test.js
```

## Security

- `composio_api_key` is never written to logs
- OAuth tokens returned by the API are never written to logs
- Connected account `state` and `connection_data` values are not returned to the agent; only key names are exposed
- All Composio API calls use HTTPS
- `composio_execute_tool` and `composio_multi_execute` are scoped to `dm-only` to prevent accidental side-effects in group chats

## API v3 audit notes

- Existing compliant routes kept: `GET /api/v3/tools`, `POST /api/v3/tools/execute/{tool_slug}`, `GET/POST /api/v3/auth_configs`, and `POST /api/v3/connected_accounts/link`.
- Added missing schema access through `GET /api/v3/tools/{tool_slug}` so the agent can validate parameters before execution.
- Added missing connected account reads through `GET /api/v3/connected_accounts` and `GET /api/v3/connected_accounts/{nanoid}` so active connections can be reused instead of starting unnecessary auth flows.
- Meta-tool alignment: `composio_search_tools`, `composio_get_tool_schemas`, `composio_multi_execute`, and the connection/auth tools now cover the practical `search_tools`, `get_tool_schemas`, `multi_execute_tool`, and `manage_connections` flows for Teleton.
