import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { tools: toolsFactory, manifest } = await import("../index.js");

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
      base_url: "https://backend.composio.dev/api/v3.1",
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
  it("exports four Teleton tools and current manifest defaults", () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);

    assert.equal(manifest.version, "1.2.0");
    assert.equal(manifest.defaultConfig.base_url, "https://backend.composio.dev/api/v3.1");
    assert.equal(toolList.length, 4);
    assert.deepEqual(
      toolList.map((tool) => tool.name).sort(),
      [
        "composio_auth_link",
        "composio_execute_tool",
        "composio_multi_execute",
        "composio_search_tools",
      ]
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
      const sdk = makeSdk({ pluginConfig: { base_url: "https://example.test/api/v3.1" } });
      const searchTool = toolsFactory(sdk).find((tool) => tool.name === "composio_search_tools");
      const result = await searchTool.execute(
        { query: "create issue", toolkit: "github", limit: 5, include_params: true },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.count, 1);
      assert.equal(result.data.tools[0].slug, "GITHUB_CREATE_ISSUE");
      assert.deepEqual(result.data.tools[0].parameters_schema, {
        owner: { type: "string", required: true },
      });

      const url = new URL(calls[0].url);
      assert.equal(url.origin + url.pathname, "https://example.test/api/v3.1/tools");
      assert.equal(url.searchParams.get("query"), "create issue");
      assert.equal(url.searchParams.get("toolkit_slug"), "github");
      assert.equal(url.searchParams.get("toolkit_versions"), "latest");
      assert.equal(url.searchParams.get("limit"), "5");
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
      assert.equal(url.pathname, "/api/v3.1/tools/execute/GITHUB_LIST_REPOS");
      assert.deepEqual(calls[0].body, {
        user_id: "user-42",
        arguments: { owner: "xlabtg" },
        version: "latest",
      });
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
});
