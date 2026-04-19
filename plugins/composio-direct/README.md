# composio-direct

Direct integration with **1000+ Composio automation tools** — no MCP transport, no SSE/HTTP issues. Search, execute, batch-run, authorize, inspect toolkits, reuse connections, manage files/triggers/webhooks, and call remote meta-tools directly from Teleton Agent.

## Features

- **27 focused tools** covering discovery, schema lookup, execution, batch execution, OAuth authorization, connection reuse, toolkits, files, triggers, webhooks, and meta-tools
- **Retry logic** — 3 attempts with exponential backoff (1 s, 2 s, 4 s) for network and 5xx errors
- **Auth error handling** — returns structured `connect_url` when a service needs authorization
- **Schema lookup** — retrieves exact input/output schemas from the v3 `tools/{tool_slug}` API
- **Connection management** — lists and fetches existing connected accounts so the agent can reuse them
- **Toolkit discovery** — lists all Composio applications and fetches versioned toolkit metadata
- **Files API** — lists registered files and requests presigned upload URLs for file-bearing tools
- **Triggers/Webhooks** — configures trigger instances and webhook subscriptions for automation callbacks
- **Meta-tools** — wraps `manage_connections`, `remote_bash_tool`, and `remote_workbench` through the standard execution flow
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

### `composio_manage_connections`

Run Composio's `COMPOSIO_MANAGE_CONNECTIONS` meta-tool when the agent should check or initiate connections for multiple toolkits in one workflow.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `toolkit` | string | no | Single toolkit slug |
| `toolkits` | array | no | One or more toolkit slugs |
| `reinitiate_all` | boolean | no | Force reconnection for all requested toolkits |
| `session_id` | string | no | Meta-tool session ID returned by Composio search tools |

For normal reuse, prefer `composio_list_connections` first. Use this wrapper when the meta-tool workflow should initiate links for missing or stale connections.

---

### Toolkit API

`composio_list_toolkits` lists available Composio toolkits/applications with auth schemes, categories, tool counts, and trigger counts. `composio_get_toolkit` fetches one toolkit by slug.

| Tool | Required parameters | v3 endpoint |
|---|---|---|
| `composio_list_toolkits` | none | `GET /api/v3/toolkits` |
| `composio_get_toolkit` | `toolkit` | `GET /api/v3/toolkits/{slug}` |

**Example:**
```json
{
  "success": true,
  "data": {
    "toolkits": [
      {
        "slug": "github",
        "name": "GitHub",
        "auth_schemes": ["oauth2"],
        "meta": {
          "tools_count": 57,
          "triggers_count": 8
        }
      }
    ],
    "count": 1
  }
}
```

---

### Files API

Use `composio_list_files` to inspect registered files and `composio_request_file_upload` to request a presigned upload URL before passing a file to a Composio tool.

| Tool | Required parameters | v3 endpoint |
|---|---|---|
| `composio_list_files` | none | `GET /api/v3/files/list` |
| `composio_request_file_upload` | `toolkit`, `tool_slug`, `filename`, `mimetype`, `md5` | `POST /api/v3/files/upload/request` |

**Upload request example:**
```json
{
  "toolkit": "gmail",
  "tool_slug": "GMAIL_SEND_EMAIL",
  "filename": "report.pdf",
  "mimetype": "application/pdf",
  "md5": "abc123"
}
```

---

### Triggers API

Triggers let the Teleton Agent discover event schemas and manage user-scoped automation instances.

| Tool | Required parameters | v3 endpoint |
|---|---|---|
| `composio_list_trigger_types` | none | `GET /api/v3/triggers_types` |
| `composio_get_trigger_type` | `trigger_slug` | `GET /api/v3/triggers_types/{slug}` |
| `composio_list_triggers` | none | `GET /api/v3/trigger_instances/active` |
| `composio_upsert_trigger` | `trigger_slug`, `connected_account_id`, `trigger_config` | `POST /api/v3/trigger_instances/{slug}/upsert` |
| `composio_set_trigger_status` | `trigger_id`, `status` or `enabled` | `PATCH /api/v3/trigger_instances/manage/{trigger_id}` |
| `composio_delete_trigger` | `trigger_id` | `DELETE /api/v3/trigger_instances/manage/{trigger_id}` |

`composio_list_triggers` defaults to the current Teleton sender ID. Trigger `state` values are not returned; the response exposes only `state_keys`.

---

### Webhooks API

Webhooks configure Composio event delivery for triggers and other platform events.

| Tool | Required parameters | v3 endpoint |
|---|---|---|
| `composio_list_webhook_events` | none | `GET /api/v3/webhook_subscriptions/event_types` |
| `composio_list_webhooks` | none | `GET /api/v3/webhook_subscriptions` |
| `composio_get_webhook` | `webhook_id` | `GET /api/v3/webhook_subscriptions/{id}` |
| `composio_create_webhook` | `webhook_url`, `enabled_events` | `POST /api/v3/webhook_subscriptions` |
| `composio_update_webhook` | `webhook_id` plus field to update | `PATCH /api/v3/webhook_subscriptions/{id}` |
| `composio_rotate_webhook_secret` | `webhook_id` | `POST /api/v3/webhook_subscriptions/{id}/rotate_secret` |
| `composio_delete_webhook` | `webhook_id` | `DELETE /api/v3/webhook_subscriptions/{id}` |

Webhook signing secrets are redacted by default. Set `include_secret: true` only when the caller needs the newly generated or rotated secret value.

---

### Remote meta-tools

`composio_remote_bash` and `composio_remote_workbench` are wrappers around documented Composio meta-tools and route through the same `POST /api/v3/tools/execute/{tool_slug}` path as normal tool execution.

| Tool | Required parameters | Executed Composio slug |
|---|---|---|
| `composio_manage_connections` | `toolkit` or `toolkits` | `COMPOSIO_MANAGE_CONNECTIONS` |
| `composio_remote_bash` | `command` | `COMPOSIO_REMOTE_BASH_TOOL` |
| `composio_remote_workbench` | `code_to_execute` | `COMPOSIO_REMOTE_WORKBENCH` |

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
[ ] composio_list_toolkits search="github" returns toolkit metadata
[ ] composio_list_files toolkit="gmail" returns file records
[ ] composio_request_file_upload returns a presigned upload URL
[ ] composio_list_trigger_types toolkit="slack" returns trigger schemas
[ ] composio_upsert_trigger creates or updates a trigger instance
[ ] composio_create_webhook registers a Teleton webhook callback
[ ] composio_manage_connections toolkits=["github"] runs the manage connections meta-tool
[ ] composio_remote_bash command="pwd" executes through the remote bash meta-tool
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
- Trigger instance `state` values are not returned to the agent; only key names are exposed
- Webhook signing secrets are redacted unless `include_secret: true` is explicitly passed
- All Composio API calls use HTTPS
- Side-effecting tools are scoped to `dm-only` to prevent accidental side-effects in group chats

## API v3 audit notes

- Existing compliant routes kept: `GET /api/v3/tools`, `POST /api/v3/tools/execute/{tool_slug}`, `GET/POST /api/v3/auth_configs`, and `POST /api/v3/connected_accounts/link`.
- Added missing schema access through `GET /api/v3/tools/{tool_slug}` so the agent can validate parameters before execution.
- Added missing connected account reads through `GET /api/v3/connected_accounts` and `GET /api/v3/connected_accounts/{nanoid}` so active connections can be reused instead of starting unnecessary auth flows.
- Added toolkit coverage through `GET /api/v3/toolkits` and `GET /api/v3/toolkits/{slug}` so the agent can discover all available applications from the Composio catalog.
- Added Files API coverage through `GET /api/v3/files/list` and `POST /api/v3/files/upload/request` for file-bearing tool workflows.
- Added Triggers API coverage through trigger type discovery, active trigger listing, trigger upsert, enable/disable, and delete endpoints.
- Added Webhooks API coverage through event type discovery and webhook subscription CRUD/secret rotation endpoints.
- Meta-tool alignment: `composio_search_tools`, `composio_get_tool_schemas`, `composio_multi_execute`, connection/auth tools, `composio_manage_connections`, `composio_remote_bash`, and `composio_remote_workbench` cover the practical `search_tools`, `get_tool_schemas`, `multi_execute_tool`, `manage_connections`, `remote_bash_tool`, and `remote_workbench` flows for Teleton.
