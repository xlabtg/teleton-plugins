import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { tools: toolsFactory, manifest } = await import("../index.js");

const expectedToolNames = [
  "composio_auth_link",
  "composio_create_webhook",
  "composio_delete_trigger",
  "composio_delete_webhook",
  "composio_execute_tool",
  "composio_get_connection",
  "composio_get_tool_schemas",
  "composio_get_toolkit",
  "composio_get_trigger_type",
  "composio_get_webhook",
  "composio_list_connections",
  "composio_list_files",
  "composio_list_toolkits",
  "composio_list_trigger_types",
  "composio_list_triggers",
  "composio_list_webhook_events",
  "composio_list_webhooks",
  "composio_manage_connections",
  "composio_multi_execute",
  "composio_remote_bash",
  "composio_remote_workbench",
  "composio_request_file_upload",
  "composio_rotate_webhook_secret",
  "composio_search_tools",
  "composio_set_trigger_status",
  "composio_update_webhook",
  "composio_upsert_trigger",
];

function makeSdk({ apiKey = "test-api-key", pluginConfig = {} } = {}) {
  return {
    secrets: {
      get: (key) => (key === "composio_api_key" ? apiKey : undefined),
      has: (key) => key === "composio_api_key" && Boolean(apiKey),
      require: (key) => {
        if (key !== "composio_api_key" || !apiKey) throw new Error(`SECRET_NOT_FOUND: ${key}`);
        return apiKey;
      },
    },
    pluginConfig: {
      base_url: "https://backend.composio.dev/api/v3",
      timeout_ms: 1000,
      max_parallel_executions: 5,
      tool_version: "latest",
      toolkit_versions: "latest",
      auth_config_ids: {},
      ...pluginConfig,
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

function makeContext(overrides = {}) {
  return { chatId: "chat-1", senderId: "user-1", isGroup: false, ...overrides };
}

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: opts.method ?? "GET",
      headers: opts.headers ?? {},
      body: opts.body ? JSON.parse(String(opts.body)) : undefined,
    };
    calls.push(call);
    const response = await handler(call, calls.length);
    return {
      status: response.status,
      text: async () => JSON.stringify(response.data ?? {}),
    };
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("composio-direct Teleton integration", () => {
  it("exports schema and connection tools with current manifest defaults", () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);

    assert.equal(manifest.version, "1.8.0");
    assert.equal(manifest.defaultConfig.base_url, "https://backend.composio.dev/api/v3");
    assert.deepEqual(
      toolList.map((tool) => tool.name).sort(),
      expectedToolNames
    );
  });

  it("searches current Composio /tools API using sdk.pluginConfig", async () => {
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      data: {
        items: [
          {
            slug: "GITHUB_CREATE_ISSUE",
            name: "Create issue",
            description: "Create a GitHub issue",
            toolkit: { slug: "github", name: "GitHub" },
            no_auth: false,
            input_parameters: { owner: { type: "string", required: true } },
            tags: ["github"],
          },
        ],
        total_items: 1,
      },
    }));

    try {
      const sdk = makeSdk({ pluginConfig: { base_url: "https://example.test/api/v3" } });
      const searchTool = toolsFactory(sdk).find((tool) => tool.name === "composio_search_tools");
      const result = await searchTool.execute(
        { query: "create issue", toolkit: "github", limit: 5, include_params: true },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.count, 1);
      assert.equal(result.data.execution.tool, "composio_execute_tool");
      assert.match(result.data.execution.instruction, /Do not call returned tool_slug values directly/);
      assert.equal(result.data.tools[0].tool_slug, "GITHUB_CREATE_ISSUE");
      assert.equal(Object.hasOwn(result.data.tools[0], "name"), false);
      assert.equal(result.data.tools[0].execute_with.tool, "composio_execute_tool");
      assert.deepEqual(result.data.tools[0].parameters_schema, {
        owner: { type: "string", required: true },
      });

      const url = new URL(calls[0].url);
      assert.equal(url.origin + url.pathname, "https://example.test/api/v3/tools");
      assert.equal(url.searchParams.get("query"), "create issue");
      assert.equal(url.searchParams.has("search"), false);
      assert.equal(url.searchParams.get("toolkit_slug"), "github");
      assert.equal(url.searchParams.get("toolkit_versions"), "latest");
      assert.equal(url.searchParams.get("limit"), "5");
    } finally {
      restore();
    }
  });

  it("sends current 'query' parameter to Composio /tools endpoint", async () => {
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      data: { items: [], total_items: 0 },
    }));

    try {
      const searchTool = toolsFactory(makeSdk()).find((t) => t.name === "composio_search_tools");
      await searchTool.execute({ query: "coinmarketcap" }, makeContext());

      const url = new URL(calls[0].url);
      assert.equal(url.searchParams.get("query"), "coinmarketcap");
      assert.equal(url.searchParams.has("search"), false);
    } finally {
      restore();
    }
  });

  it("executes tools through current /tools/execute API with sender-scoped user_id", async () => {
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      data: {
        successful: true,
        data: { repositories: [] },
        log_id: "log_123",
      },
    }));

    try {
      const executeTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_execute_tool");
      const result = await executeTool.execute(
        { tool_slug: "github_list_repos", parameters: { owner: "xlabtg" } },
        makeContext({ senderId: "user-42", chatId: "chat-99" })
      );

      assert.equal(result.success, true);
      assert.deepEqual(result.data.repositories, []);
      assert.equal(result.data.log_id, "log_123");

      const url = new URL(calls[0].url);
      assert.equal(url.pathname, "/api/v3/tools/execute/GITHUB_LIST_REPOS");
      assert.deepEqual(calls[0].body, {
        user_id: "user-42",
        arguments: { owner: "xlabtg" },
        version: "latest",
      });
    } finally {
      restore();
    }
  });

  it("retries current v3 execute API when legacy v3.1 reports unknown tool", async () => {
    const { calls, restore } = mockFetch((call, idx) => {
      if (idx === 1) {
        return {
          status: 404,
          data: {
            error: {
              message: "Unknown tool",
              slug: "UNKNOWN_TOOL",
              status: 404,
            },
          },
        };
      }
      return {
        status: 200,
        data: {
          successful: true,
          data: { ok: true },
        },
      };
    });

    try {
      const executeTool = toolsFactory(
        makeSdk({ pluginConfig: { base_url: "https://backend.composio.dev/api/v3.1" } })
      ).find((tool) => tool.name === "composio_execute_tool");
      const result = await executeTool.execute(
        { tool_slug: "github_list_repos", parameters: {} },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.ok, true);
      assert.equal(calls.length, 2);
      assert.equal(new URL(calls[0].url).pathname, "/api/v3.1/tools/execute/GITHUB_LIST_REPOS");
      assert.equal(new URL(calls[1].url).pathname, "/api/v3/tools/execute/GITHUB_LIST_REPOS");
    } finally {
      restore();
    }
  });

  it("passes connected_account_id in HTTP body when provided", async () => {
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      data: {
        successful: true,
        data: { price: 42000 },
      },
    }));

    try {
      const executeTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_execute_tool");
      const result = await executeTool.execute(
        {
          tool_slug: "COINMARKETCAP_CRYPTOCURRENCY_LISTINGS_LATEST",
          parameters: {},
          connected_account_id: "ca_lc9TestLuaI",
        },
        makeContext({ senderId: "user-42" })
      );

      assert.equal(result.success, true);
      assert.equal(calls[0].body.connected_account_id, "ca_lc9TestLuaI");
      assert.equal(calls[0].body.user_id, "user-42");
      // connected_account_id must also be inside arguments so Composio API picks it up
      assert.equal(calls[0].body.arguments.connected_account_id, "ca_lc9TestLuaI");
    } finally {
      restore();
    }
  });

  it("passes connected_account_id inside arguments for multi_execute HTTP body", async () => {
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      data: { successful: true, data: { ok: true } },
    }));

    try {
      const multiTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_multi_execute");
      const result = await multiTool.execute(
        {
          executions: [
            {
              tool_slug: "COINMARKETCAP_CRYPTOCURRENCY_LISTINGS_LATEST",
              parameters: { symbol: "BTC" },
              connected_account_id: "ca_multi_inside",
            },
          ],
        },
        makeContext()
      );

      assert.equal(result.success, true);
      // connected_account_id must be inside arguments so Composio API picks it up
      assert.equal(calls[0].body.arguments.connected_account_id, "ca_multi_inside");
      assert.equal(calls[0].body.connected_account_id, "ca_multi_inside");
    } finally {
      restore();
    }
  });

  it("detects auth_required in 200 response data and returns structured auth error", async () => {
    const { restore } = mockFetch(() => ({
      status: 200,
      data: {
        successful: true,
        data: {
          auth_required: true,
          connect_url: "https://connect.composio.dev/link/ln_abc",
        },
      },
    }));

    try {
      const executeTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_execute_tool");
      const result = await executeTool.execute(
        {
          tool_slug: "COINMARKETCAP_CRYPTOCURRENCY_LISTINGS_LATEST",
          parameters: {},
          connected_account_id: "ca_lc9TestLuaI",
        },
        makeContext()
      );

      assert.equal(result.success, false);
      assert.equal(result.error, "auth_required");
      assert.equal(result.auth.service, "coinmarketcap");
      assert.equal(result.auth.connect_url, "https://connect.composio.dev/link/ln_abc");
      assert.ok(result.auth.message.includes("COINMARKETCAP"));
    } finally {
      restore();
    }
  });

  it("detects auth_required at top level of 200 response", async () => {
    const { restore } = mockFetch(() => ({
      status: 200,
      data: {
        auth_required: true,
        connect_url: "https://connect.composio.dev/link/ln_xyz",
      },
    }));

    try {
      const executeTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_execute_tool");
      const result = await executeTool.execute(
        { tool_slug: "GEMINI_GENERATE_IMAGE", parameters: {} },
        makeContext()
      );

      assert.equal(result.success, false);
      assert.equal(result.error, "auth_required");
      assert.equal(result.auth.service, "gemini");
      assert.equal(result.auth.connect_url, "https://connect.composio.dev/link/ln_xyz");
    } finally {
      restore();
    }
  });

  it("passes connected_account_id in multi_execute HTTP body", async () => {
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      data: { successful: true, data: { ok: true } },
    }));

    try {
      const multiTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_multi_execute");
      const result = await multiTool.execute(
        {
          executions: [
            {
              tool_slug: "COINMARKETCAP_CRYPTOCURRENCY_LISTINGS_LATEST",
              parameters: {},
              connected_account_id: "ca_multi_test",
            },
          ],
        },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.results[0].success, true);
      assert.equal(calls[0].body.connected_account_id, "ca_multi_test");
    } finally {
      restore();
    }
  });

  it("accepts the Teleton-derived env var when the secret store is empty", async () => {
    const previous = process.env.COMPOSIO_DIRECT_COMPOSIO_API_KEY;
    process.env.COMPOSIO_DIRECT_COMPOSIO_API_KEY = "env-api-key";
    const { calls, restore } = mockFetch((call) => {
      assert.equal(call.headers["x-api-key"], "env-api-key");
      return { status: 200, data: { items: [], total_items: 0 } };
    });

    try {
      const searchTool = toolsFactory(makeSdk({ apiKey: null })).find(
        (tool) => tool.name === "composio_search_tools"
      );
      const result = await searchTool.execute({ query: "github" }, makeContext());

      assert.equal(result.success, true);
      assert.equal(calls.length, 1);
    } finally {
      restore();
      if (previous === undefined) {
        delete process.env.COMPOSIO_DIRECT_COMPOSIO_API_KEY;
      } else {
        process.env.COMPOSIO_DIRECT_COMPOSIO_API_KEY = previous;
      }
    }
  });

  it("creates a real Composio Connect Link through auth_configs and connected_accounts APIs", async () => {
    const { calls, restore } = mockFetch((call) => {
      const url = new URL(call.url);
      if (call.method === "GET" && url.pathname.endsWith("/auth_configs")) {
        assert.equal(url.searchParams.get("toolkit_slug"), "github");
        assert.equal(url.searchParams.get("is_composio_managed"), "true");
        return { status: 200, data: { items: [] } };
      }
      if (call.method === "POST" && url.pathname.endsWith("/auth_configs")) {
        assert.deepEqual(call.body.toolkit, { slug: "github" });
        return { status: 201, data: { auth_config: { id: "ac_123" } } };
      }
      if (call.method === "POST" && url.pathname.endsWith("/connected_accounts/link")) {
        assert.deepEqual(call.body, {
          auth_config_id: "ac_123",
          user_id: "user-42",
          alias: "work",
        });
        return {
          status: 201,
          data: {
            redirect_url: "https://connect.composio.dev/link/ln_123",
            connected_account_id: "ca_123",
            expires_at: "2026-04-16T21:00:00Z",
          },
        };
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    try {
      const authTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_auth_link");
      const result = await authTool.execute(
        { service: "github", alias: "work" },
        makeContext({ senderId: "user-42" })
      );

      assert.equal(result.success, true);
      assert.equal(result.data.url, "https://connect.composio.dev/link/ln_123");
      assert.equal(result.data.auth_config_id, "ac_123");
      assert.equal(result.data.connected_account_id, "ca_123");
      assert.equal(result.data.user_id, "user-42");
      assert.equal(calls.length, 3);
    } finally {
      restore();
    }
  });

  it("fetches tool schemas through the current /tools/{tool_slug} API", async () => {
    const { calls, restore } = mockFetch((call) => {
      const url = new URL(call.url);
      assert.equal(url.pathname, "/api/v3/tools/GITHUB_CREATE_ISSUE");
      assert.equal(url.searchParams.get("version"), "latest");
      assert.equal(url.searchParams.get("toolkit_versions"), "latest");
      return {
        status: 200,
        data: {
          slug: "GITHUB_CREATE_ISSUE",
          name: "Create issue",
          description: "Create a GitHub issue",
          toolkit: { slug: "github", name: "GitHub" },
          input_parameters: { title: { type: "string", required: true } },
          output_parameters: { url: { type: "string" } },
          version: "20250905_00",
        },
      };
    });

    try {
      const schemaTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_get_tool_schemas");
      const result = await schemaTool.execute(
        {
          tool_slugs: ["github_create_issue"],
          include: ["input_schema", "output_schema"],
        },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.count, 1);
      assert.equal(result.data.schemas[0].tool_slug, "GITHUB_CREATE_ISSUE");
      assert.deepEqual(result.data.schemas[0].input_schema, {
        title: { type: "string", required: true },
      });
      assert.deepEqual(result.data.schemas[0].output_schema, {
        url: { type: "string" },
      });
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  it("lists current-user connected accounts with documented filters", async () => {
    const { calls, restore } = mockFetch((call) => {
      const url = new URL(call.url);
      assert.equal(url.pathname, "/api/v3/connected_accounts");
      assert.deepEqual(url.searchParams.getAll("toolkit_slugs"), ["github"]);
      assert.deepEqual(url.searchParams.getAll("statuses"), ["ACTIVE"]);
      assert.deepEqual(url.searchParams.getAll("user_ids"), ["user-42"]);
      assert.equal(url.searchParams.get("limit"), "25");
      return {
        status: 200,
        data: {
          items: [
            {
              id: "ca_123",
              alias: "work",
              user_id: "user-42",
              status: "ACTIVE",
              toolkit: { slug: "github", name: "GitHub" },
              auth_config: {
                id: "ac_123",
                auth_scheme: "OAUTH2",
                is_composio_managed: true,
              },
              state: { access_token: "secret-token" },
            },
          ],
          next_cursor: "cursor_2",
        },
      };
    });

    try {
      const listTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_list_connections");
      const result = await listTool.execute(
        { toolkit: "github", status: "ACTIVE", limit: 25 },
        makeContext({ senderId: "user-42" })
      );

      assert.equal(result.success, true);
      assert.equal(result.data.count, 1);
      assert.equal(result.data.next_cursor, "cursor_2");
      assert.equal(result.data.connections[0].id, "ca_123");
      assert.equal(result.data.connections[0].execute_with.connected_account_id, "ca_123");
      assert.equal(result.data.connections[0].state, undefined);
      assert.deepEqual(result.data.connections[0].state_keys, ["access_token"]);
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  it("gets a connected account without exposing state values", async () => {
    const { calls, restore } = mockFetch((call) => {
      const url = new URL(call.url);
      assert.equal(url.pathname, "/api/v3/connected_accounts/ca_123");
      return {
        status: 200,
        data: {
          id: "ca_123",
          alias: "work",
          user_id: "user-42",
          status: "ACTIVE",
          toolkit: { slug: "github", name: "GitHub" },
          state: { refresh_token: "secret-refresh-token" },
        },
      };
    });

    try {
      const getTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_get_connection");
      const result = await getTool.execute(
        { connected_account_id: "ca_123" },
        makeContext({ senderId: "user-42" })
      );

      assert.equal(result.success, true);
      assert.equal(result.data.connection.id, "ca_123");
      assert.equal(result.data.connection.state, undefined);
      assert.deepEqual(result.data.connection.state_keys, ["refresh_token"]);
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  it("lists toolkits through the current /toolkits API", async () => {
    const { calls, restore } = mockFetch((call) => {
      const url = new URL(call.url);
      assert.equal(url.pathname, "/api/v3/toolkits");
      assert.equal(url.searchParams.get("search"), "github");
      assert.equal(url.searchParams.get("category"), "developer-tools");
      assert.equal(url.searchParams.get("managed_by"), "composio");
      assert.equal(url.searchParams.get("sort_by"), "usage");
      assert.equal(url.searchParams.get("include_deprecated"), "false");
      assert.equal(url.searchParams.get("limit"), "10");
      return {
        status: 200,
        data: {
          items: [
            {
              slug: "github",
              name: "GitHub",
              auth_schemes: ["oauth2"],
              composio_managed_auth_schemes: ["oauth2"],
              no_auth: false,
              meta: {
                description: "GitHub tools",
                tools_count: 12,
                triggers_count: 5,
                version: "20250905_00",
              },
            },
          ],
          total_items: 1,
        },
      };
    });

    try {
      const listTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_list_toolkits");
      const result = await listTool.execute(
        {
          search: "github",
          category: "developer-tools",
          managed_by: "composio",
          sort_by: "usage",
          limit: 10,
        },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.count, 1);
      assert.equal(result.data.toolkits[0].slug, "github");
      assert.equal(result.data.toolkits[0].meta.tools_count, 12);
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  it("gets one toolkit through /toolkits/{slug}", async () => {
    const { calls, restore } = mockFetch((call) => {
      const url = new URL(call.url);
      assert.equal(url.pathname, "/api/v3/toolkits/github");
      assert.equal(url.searchParams.get("version"), "latest");
      return {
        status: 200,
        data: {
          slug: "github",
          name: "GitHub",
          enabled: true,
          auth_config_details: [{ mode: "oauth2" }],
          meta: { description: "GitHub tools" },
        },
      };
    });

    try {
      const getTool = toolsFactory(makeSdk()).find((tool) => tool.name === "composio_get_toolkit");
      const result = await getTool.execute({ toolkit: "github" }, makeContext());

      assert.equal(result.success, true);
      assert.equal(result.data.toolkit.slug, "github");
      assert.equal(result.data.toolkit.enabled, true);
      assert.deepEqual(result.data.toolkit.auth_config_details, [{ mode: "oauth2" }]);
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  it("lists files and requests a presigned upload URL through the files API", async () => {
    const { calls, restore } = mockFetch((call, idx) => {
      const url = new URL(call.url);
      if (idx === 1) {
        assert.equal(url.pathname, "/api/v3/files/list");
        assert.equal(url.searchParams.get("toolkit_slug"), "gmail");
        assert.equal(url.searchParams.get("tool_slug"), "GMAIL_SEND_EMAIL");
        assert.equal(url.searchParams.get("limit"), "25");
        return {
          status: 200,
          data: {
            items: [
              {
                toolkit_slug: "gmail",
                tool_slug: "GMAIL_SEND_EMAIL",
                filename: "report.pdf",
                mimetype: "application/pdf",
                md5: "abc123",
              },
            ],
            total_items: 1,
          },
        };
      }

      assert.equal(url.pathname, "/api/v3/files/upload/request");
      assert.deepEqual(call.body, {
        toolkit_slug: "gmail",
        tool_slug: "GMAIL_SEND_EMAIL",
        filename: "report.pdf",
        mimetype: "application/pdf",
        md5: "abc123",
      });
      return {
        status: 200,
        data: {
          id: "file_123",
          key: "uploads/report.pdf",
          new_presigned_url: "https://s3.example.test/upload",
          type: "new",
        },
      };
    });

    try {
      const toolList = toolsFactory(makeSdk());
      const listFiles = toolList.find((tool) => tool.name === "composio_list_files");
      const requestUpload = toolList.find((tool) => tool.name === "composio_request_file_upload");

      const listResult = await listFiles.execute(
        { toolkit: "gmail", tool_slug: "gmail_send_email", limit: 25 },
        makeContext()
      );
      const uploadResult = await requestUpload.execute(
        {
          toolkit: "gmail",
          tool_slug: "gmail_send_email",
          filename: "report.pdf",
          mimetype: "application/pdf",
          md5: "abc123",
        },
        makeContext()
      );

      assert.equal(listResult.success, true);
      assert.equal(listResult.data.files[0].filename, "report.pdf");
      assert.equal(uploadResult.success, true);
      assert.equal(uploadResult.data.file.id, "file_123");
      assert.equal(uploadResult.data.file.presigned_url, "https://s3.example.test/upload");
      assert.equal(calls.length, 2);
    } finally {
      restore();
    }
  });

  it("lists trigger types, active triggers, and upserts trigger instances through v3 endpoints", async () => {
    const { calls, restore } = mockFetch((call, idx) => {
      const url = new URL(call.url);
      if (idx === 1) {
        assert.equal(url.pathname, "/api/v3/triggers_types");
        assert.deepEqual(url.searchParams.getAll("toolkit_slugs"), ["slack"]);
        assert.equal(url.searchParams.get("toolkit_versions"), "latest");
        return {
          status: 200,
          data: {
            items: [
              {
                slug: "SLACK_RECEIVE_MESSAGE",
                name: "New message",
                type: "webhook",
                toolkit: { slug: "slack", name: "Slack" },
                config: { channel_id: { type: "string", required: true } },
                payload: { message: { type: "string" } },
              },
            ],
          },
        };
      }
      if (idx === 2) {
        assert.equal(url.pathname, "/api/v3/trigger_instances/active");
        assert.deepEqual(url.searchParams.getAll("user_ids"), ["user-42"]);
        assert.deepEqual(url.searchParams.getAll("trigger_names"), ["SLACK_RECEIVE_MESSAGE"]);
        assert.equal(url.searchParams.get("show_disabled"), "true");
        return {
          status: 200,
          data: {
            items: [
              {
                id: "trig_123",
                connected_account_id: "ca_123",
                user_id: "user-42",
                trigger_name: "SLACK_RECEIVE_MESSAGE",
                state: { cursor: "secret-ish-state" },
              },
            ],
          },
        };
      }

      assert.equal(url.pathname, "/api/v3/trigger_instances/SLACK_RECEIVE_MESSAGE/upsert");
      assert.deepEqual(call.body, {
        connected_account_id: "ca_123",
        trigger_config: { channel_id: "C123" },
        toolkit_versions: "latest",
      });
      return { status: 201, data: { trigger_id: "trig_123" } };
    });

    try {
      const toolList = toolsFactory(makeSdk());
      const listTypes = toolList.find((tool) => tool.name === "composio_list_trigger_types");
      const listTriggers = toolList.find((tool) => tool.name === "composio_list_triggers");
      const upsertTrigger = toolList.find((tool) => tool.name === "composio_upsert_trigger");

      const typesResult = await listTypes.execute({ toolkit: "slack" }, makeContext());
      const triggersResult = await listTriggers.execute(
        { trigger_name: "slack_receive_message", show_disabled: true },
        makeContext({ senderId: "user-42" })
      );
      const upsertResult = await upsertTrigger.execute(
        {
          trigger_slug: "slack_receive_message",
          connected_account_id: "ca_123",
          trigger_config: { channel_id: "C123" },
        },
        makeContext()
      );

      assert.equal(typesResult.success, true);
      assert.equal(typesResult.data.trigger_types[0].slug, "SLACK_RECEIVE_MESSAGE");
      assert.equal(triggersResult.success, true);
      assert.equal(triggersResult.data.triggers[0].state, undefined);
      assert.deepEqual(triggersResult.data.triggers[0].state_keys, ["cursor"]);
      assert.equal(upsertResult.success, true);
      assert.equal(upsertResult.data.trigger_id, "trig_123");
      assert.equal(calls.length, 3);
    } finally {
      restore();
    }
  });

  it("manages trigger status and deletion through v3 trigger manage endpoints", async () => {
    const { calls, restore } = mockFetch((call, idx) => {
      const url = new URL(call.url);
      if (idx === 1) {
        assert.equal(call.method, "PATCH");
        assert.equal(url.pathname, "/api/v3/trigger_instances/manage/trig_123");
        assert.deepEqual(call.body, { status: "disable" });
        return { status: 200, data: { success: true } };
      }

      assert.equal(call.method, "DELETE");
      assert.equal(url.pathname, "/api/v3/trigger_instances/manage/trig_123");
      return { status: 200, data: { success: true } };
    });

    try {
      const toolList = toolsFactory(makeSdk());
      const statusTool = toolList.find((tool) => tool.name === "composio_set_trigger_status");
      const deleteTool = toolList.find((tool) => tool.name === "composio_delete_trigger");

      const statusResult = await statusTool.execute(
        { trigger_id: "trig_123", status: "disable" },
        makeContext()
      );
      const deleteResult = await deleteTool.execute({ trigger_id: "trig_123" }, makeContext());

      assert.equal(statusResult.success, true);
      assert.equal(deleteResult.success, true);
      assert.equal(calls.length, 2);
    } finally {
      restore();
    }
  });

  it("manages webhook subscriptions without exposing secrets by default", async () => {
    const { calls, restore } = mockFetch((call, idx) => {
      const url = new URL(call.url);
      if (idx === 1) {
        assert.equal(url.pathname, "/api/v3/webhook_subscriptions/event_types");
        return {
          status: 200,
          data: {
            items: [
              {
                event_type: "trigger.event_received",
                description: "Trigger event received",
                supported_versions: ["V3"],
              },
            ],
          },
        };
      }
      if (idx === 2) {
        assert.equal(call.method, "POST");
        assert.equal(url.pathname, "/api/v3/webhook_subscriptions");
        assert.deepEqual(call.body, {
          webhook_url: "https://agent.example.test/composio",
          enabled_events: ["trigger.event_received"],
          version: "V3",
        });
        return {
          status: 201,
          data: {
            id: "wh_123",
            webhook_url: "https://agent.example.test/composio",
            enabled_events: ["trigger.event_received"],
            version: "V3",
            secret: "secret-value",
          },
        };
      }
      if (idx === 3) {
        assert.equal(call.method, "PATCH");
        assert.equal(url.pathname, "/api/v3/webhook_subscriptions/wh_123");
        return {
          status: 200,
          data: {
            id: "wh_123",
            webhook_url: "https://agent.example.test/composio/v2",
            enabled_events: ["trigger.event_received"],
            version: "V3",
            secret: "updated-secret",
          },
        };
      }

      assert.equal(call.method, "POST");
      assert.equal(url.pathname, "/api/v3/webhook_subscriptions/wh_123/rotate_secret");
      return {
        status: 200,
        data: {
          id: "wh_123",
          webhook_url: "https://agent.example.test/composio/v2",
          enabled_events: ["trigger.event_received"],
          version: "V3",
          secret: "rotated-secret",
        },
      };
    });

    try {
      const toolList = toolsFactory(makeSdk());
      const listEvents = toolList.find((tool) => tool.name === "composio_list_webhook_events");
      const createWebhook = toolList.find((tool) => tool.name === "composio_create_webhook");
      const updateWebhook = toolList.find((tool) => tool.name === "composio_update_webhook");
      const rotateSecret = toolList.find((tool) => tool.name === "composio_rotate_webhook_secret");

      const eventsResult = await listEvents.execute({}, makeContext());
      const createResult = await createWebhook.execute(
        {
          webhook_url: "https://agent.example.test/composio",
          enabled_events: ["trigger.event_received"],
        },
        makeContext()
      );
      const updateResult = await updateWebhook.execute(
        {
          webhook_id: "wh_123",
          webhook_url: "https://agent.example.test/composio/v2",
        },
        makeContext()
      );
      const rotateResult = await rotateSecret.execute({ webhook_id: "wh_123" }, makeContext());

      assert.equal(eventsResult.success, true);
      assert.equal(eventsResult.data.event_types[0].event_type, "trigger.event_received");
      assert.equal(createResult.success, true);
      assert.equal(createResult.data.webhook.secret, undefined);
      assert.equal(createResult.data.webhook.secret_present, true);
      assert.equal(updateResult.data.webhook.secret, undefined);
      assert.equal(rotateResult.data.webhook.secret, undefined);
      assert.equal(calls.length, 4);
    } finally {
      restore();
    }
  });

  it("wraps manage connections, remote bash, and workbench meta-tools through composio_execute_tool", async () => {
    const { calls, restore } = mockFetch((call, idx) => {
      const url = new URL(call.url);
      if (idx === 1) {
        assert.equal(url.pathname, "/api/v3/tools/execute/COMPOSIO_MANAGE_CONNECTIONS");
        assert.deepEqual(call.body.arguments, {
          toolkits: ["github", "gmail"],
          reinitiate_all: true,
          session_id: "sess_123",
        });
        return { status: 200, data: { successful: true, data: { connected: ["github"] } } };
      }
      if (idx === 2) {
        assert.equal(url.pathname, "/api/v3/tools/execute/COMPOSIO_REMOTE_BASH_TOOL");
        assert.equal(call.body.arguments.command, "pwd");
        assert.equal(call.body.arguments.session_id, "sess_123");
        return { status: 200, data: { successful: true, data: { stdout: "/workspace" } } };
      }

      assert.equal(url.pathname, "/api/v3/tools/execute/COMPOSIO_REMOTE_WORKBENCH");
      assert.equal(call.body.arguments.code_to_execute, "print(1)");
      assert.equal(call.body.arguments.current_step, "RUNNING_CODE");
      return { status: 200, data: { successful: true, data: { result: 1 } } };
    });

    try {
      const toolList = toolsFactory(makeSdk());
      const manageConnections = toolList.find((tool) => tool.name === "composio_manage_connections");
      const remoteBash = toolList.find((tool) => tool.name === "composio_remote_bash");
      const remoteWorkbench = toolList.find((tool) => tool.name === "composio_remote_workbench");

      const manageResult = await manageConnections.execute(
        {
          toolkits: ["github", "gmail"],
          reinitiate_all: true,
          session_id: "sess_123",
        },
        makeContext()
      );
      const bashResult = await remoteBash.execute(
        { command: "pwd", session_id: "sess_123" },
        makeContext()
      );
      const workbenchResult = await remoteWorkbench.execute(
        {
          code_to_execute: "print(1)",
          current_step: "RUNNING_CODE",
        },
        makeContext()
      );

      assert.equal(manageResult.success, true);
      assert.deepEqual(manageResult.data.connected, ["github"]);
      assert.equal(bashResult.success, true);
      assert.equal(bashResult.data.stdout, "/workspace");
      assert.equal(workbenchResult.success, true);
      assert.equal(workbenchResult.data.result, 1);
      assert.equal(calls.length, 3);
    } finally {
      restore();
    }
  });
});
