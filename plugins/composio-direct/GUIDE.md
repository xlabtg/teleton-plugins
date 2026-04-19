# Composio Direct Agent Guide

Use `composio-direct` when a user asks Teleton to work with an external app supported by Composio, such as GitHub, Gmail, Slack, Notion, Linear, Jira, Google Calendar, Google Drive, or a remote shell/workbench. The plugin talks directly to Composio v3 and exposes Composio tool slugs through Teleton tools. A returned Composio `tool_slug` is not a Teleton tool name; execute it through `composio_execute_tool` or `composio_multi_execute`.

## Required Setup

The plugin requires the Teleton secret `composio_api_key`. It can also be supplied through `COMPOSIO_DIRECT_COMPOSIO_API_KEY`, with `COMPOSIO_API_KEY` kept as a legacy fallback. If the key is missing, stop and ask the operator to configure it before attempting Composio calls.

Default runtime settings:

| Setting | Default | Use |
|---|---:|---|
| `base_url` | `https://backend.composio.dev/api/v3` | Composio API endpoint |
| `timeout_ms` | `30000` | Default request timeout |
| `max_parallel_executions` | `10` | Batch execution concurrency |
| `tool_version` | `latest` | Tool execution/schema version |
| `toolkit_versions` | `latest` | Toolkit discovery version |
| `auth_config_ids` | `{}` | Toolkit-to-auth-config overrides |

## Core Workflow

1. Search for a tool with `composio_search_tools`.
2. Read the exact parameter contract with `composio_get_tool_schemas`.
3. Check whether the current user already has an active connection with `composio_list_connections`.
4. If no usable connection exists, create an authorization link with `composio_auth_link` or run `composio_manage_connections`.
5. Execute the Composio slug with `composio_execute_tool`.
6. For several independent actions, use `composio_multi_execute` and keep the result order aligned with the requested actions.

This order matters because Composio tool inputs vary by toolkit and version. Do not guess parameter names when `composio_get_tool_schemas` can confirm them.

## Tool Discovery

Call `composio_search_tools` when the user describes an action but not a specific Composio slug.

Useful inputs:

| Input | When to use |
|---|---|
| `query` | Natural-language action, for example `create issue`, `send email`, or `search calendar` |
| `toolkit` | Restrict results to an app, for example `github`, `gmail`, or `slack` |
| `limit` | Keep result sets small; start with 5-10 for agent workflows |
| `include_params` | Use only for quick inspection; prefer `composio_get_tool_schemas` before execution |

The response includes `execute_with` guidance. Preserve the returned `tool_slug` exactly unless the plugin normalizes it for execution.

## Schema Lookup

Use `composio_get_tool_schemas` before every first execution of a slug in a task. Request `input_schema` by default and include `output_schema` when you need to reason about the returned fields.

Typical call:

```json
{
  "tool_slug": "GITHUB_CREATE_ISSUE",
  "include": ["input_schema", "output_schema", "metadata"]
}
```

If multiple candidate slugs look useful, pass `tool_slugs` and compare their schemas before choosing. Prefer the simplest slug that satisfies the user request.

## Authentication And Connections

Composio connections are user-scoped. `composio_list_connections` and `composio_list_triggers` default to the current Teleton sender ID so the agent does not reuse another user's account.

Use this sequence for app authorization:

1. Call `composio_list_connections` with `toolkit` and `status: "ACTIVE"`.
2. If an active connection exists, pass its `connected_account_id` to execution when needed.
3. If execution returns `auth_required`, call `composio_auth_link` for that service.
4. Ask the user to open the returned URL, authorize, and confirm when done.
5. Retry the original action after authorization.

Only set `include_all_users: true` for administrative inspection explicitly requested by an operator. Do not expose connection state values; the plugin intentionally returns only key names for secret-bearing fields.

For toolkits without Composio-managed auth, use an existing `auth_config_id` or configure `auth_config_ids` in plugin config. `composio_auth_link` accepts `auth_config_id`, `callback_url`, and `alias` when the caller needs a specific connection setup.

## Executing Tools

Use `composio_execute_tool` for one Composio action.

```json
{
  "tool_slug": "GITHUB_CREATE_ISSUE",
  "parameters": {
    "owner": "xlabtg",
    "repo": "teleton-plugins",
    "title": "Example",
    "body": "Created through Composio"
  },
  "connected_account_id": "ca_123"
}
```

Rules for execution:

- Treat execution as side-effecting unless the schema and user request clearly indicate a read-only operation.
- Use exact schema field names from `composio_get_tool_schemas`.
- Include `connected_account_id` when the user has multiple accounts or when a connection lookup returned a clear match.
- Use `timeout_override_ms` only for operations expected to exceed the plugin default.
- When a slug fails because a legacy `/api/v3.1` base URL reports an unknown tool, the plugin retries against current `/api/v3` automatically.

## Batch Execution

Use `composio_multi_execute` for independent actions that can run in parallel, such as fetching several read-only resources or sending the same approved update to multiple destinations.

```json
{
  "executions": [
    { "tool_slug": "GITHUB_GET_REPO", "parameters": { "owner": "xlabtg", "repo": "teleton-plugins" } },
    { "tool_slug": "GITHUB_LIST_ISSUES", "parameters": { "owner": "xlabtg", "repo": "teleton-plugins" } }
  ],
  "max_parallel": 2,
  "fail_fast": false
}
```

Use `fail_fast: true` when later results are not useful after the first failure. Keep `max_parallel` modest for write operations, and never batch destructive writes unless the user explicitly asked for every action.

## Toolkit Catalog

Use `composio_list_toolkits` when you need to discover supported apps or find the correct toolkit slug. Use `composio_get_toolkit` when you need one toolkit's auth schemes, categories, tool count, or trigger count.

Good examples:

- "Which apps can you connect to?"
- "Does Composio support Linear triggers?"
- "What slug should I use for Google Calendar?"

## Files

Some Composio tools need uploaded files. Use `composio_request_file_upload` before execution, then upload the bytes to the returned presigned URL outside the plugin flow if needed. Use `composio_list_files` to inspect files already registered with Composio.

Required upload inputs are `toolkit`, `tool_slug`, `filename`, `mimetype`, and `md5`. Do not fabricate checksums; compute them from the actual file content.

## Triggers

Use trigger tools for event-driven workflows.

| Goal | Tool |
|---|---|
| Discover trigger schemas | `composio_list_trigger_types` |
| Inspect one trigger schema | `composio_get_trigger_type` |
| List active trigger instances | `composio_list_triggers` |
| Create or update a trigger | `composio_upsert_trigger` |
| Enable or disable a trigger | `composio_set_trigger_status` |
| Delete a trigger | `composio_delete_trigger` |

Before upserting a trigger, fetch its trigger type and build `trigger_config` from the returned schema. Bind triggers to the intended `connected_account_id`. Like connections, trigger listing defaults to the current Teleton sender.

## Webhooks

Use webhook tools when Composio should deliver events to a Teleton callback URL.

| Goal | Tool |
|---|---|
| List event types | `composio_list_webhook_events` |
| List subscriptions | `composio_list_webhooks` |
| Inspect one subscription | `composio_get_webhook` |
| Create subscription | `composio_create_webhook` |
| Update subscription | `composio_update_webhook` |
| Rotate signing secret | `composio_rotate_webhook_secret` |
| Delete subscription | `composio_delete_webhook` |

Webhook secrets are redacted by default. Set `include_secret: true` only when the caller needs to store a newly created or rotated secret, and avoid repeating that secret in user-visible text.

## Remote Meta-Tools

The plugin wraps Composio meta-tools through the normal execute endpoint.

| Teleton tool | Composio slug | Use |
|---|---|---|
| `composio_manage_connections` | `COMPOSIO_MANAGE_CONNECTIONS` | Check or initiate toolkit auth flows |
| `composio_remote_bash` | `COMPOSIO_REMOTE_BASH_TOOL` | Run an approved shell command in Composio remote execution |
| `composio_remote_workbench` | `COMPOSIO_REMOTE_WORKBENCH` | Run code in the remote workbench |

Remote bash and workbench calls can execute code outside Teleton. Use them only when the user requested remote execution or when a Composio workflow explicitly requires it. Summarize outputs, errors, and session IDs so the user can continue the remote session.

## Error Handling

The plugin returns structured results:

- `{ "success": true, "data": ... }` for success.
- `{ "success": false, "error": "auth_required", "auth": ... }` when the user must connect an app.
- `{ "success": false, "error": "...", "details": ... }` for validation or API failures.

For `auth_required`, do not retry blindly. Generate or surface a connection link, wait for user confirmation, then retry. For validation errors, fetch the schema again and correct the parameters. For transient network or 5xx failures, the plugin already retries three times with exponential backoff.

## Security Rules

- Never ask the user to paste OAuth tokens or Composio API keys into chat.
- Never log or repeat `composio_api_key`, OAuth tokens, connection state values, or webhook signing secrets.
- Prefer current-user connection filters. Use `include_all_users` only for explicit administrative requests.
- Treat write, delete, send, create, update, webhook, trigger, remote bash, and remote workbench operations as side-effecting.
- Confirm destructive or broad actions before execution.
- Keep file upload checksums tied to the actual file bytes.

## Testing And Diagnostics

Local tests:

```sh
node --test plugins/composio-direct/tests/index.test.js
node --test plugins/composio-direct/test/unit/composio-direct.test.js
node --test plugins/composio-direct/test/integration/composio-api.test.js
```

Repository checks:

```sh
npm run validate
npm test
```

The integration test may require a live Composio API key depending on its environment checks. When diagnosing a user report, record the tool name, parameters without secrets, `connected_account_id` if relevant, returned `error`, and whether the call was discovery, auth, execution, trigger, webhook, or remote execution.
