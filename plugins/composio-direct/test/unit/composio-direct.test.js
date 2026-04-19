/**
 * Unit tests for composio-direct plugin
 *
 * Run with: node --test plugins/composio-direct/test/unit/composio-direct.test.js
 * (Node.js >= 18 built-in test runner)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers & mocks
// ---------------------------------------------------------------------------

/**
 * Create a minimal SDK mock.
 * @param {object} overrides
 * @returns {object}
 */
function makeSdk({ apiKey = "test-api-key", config = {} } = {}) {
  const secretsStore = apiKey ? { composio_api_key: apiKey } : {};
  return {
    secrets: {
      get: (key) => secretsStore[key] ?? undefined,
      has: (key) => key in secretsStore,
      require: (key) => {
        if (!(key in secretsStore)) throw new Error(`SECRET_NOT_FOUND: ${key}`);
        return secretsStore[key];
      },
    },
    config: {
      base_url: "https://backend.composio.dev/api/v3",
      timeout_ms: 5000,
      max_parallel_executions: 10,
      ...config,
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

/**
 * Create a minimal context mock.
 * @param {object} overrides
 * @returns {object}
 */
function makeContext(overrides = {}) {
  return {
    chatId: "123456",
    senderId: "789",
    isGroup: false,
    ...overrides,
  };
}

/**
 * Install a global fetch mock that returns the given responses in order.
 * Each entry: { status, data }
 * @param {Array<{ status: number; data: unknown }>} responses
 * @returns {Function} restore function
 */
function mockFetch(responses) {
  let index = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => {
    const resp = responses[index] ?? responses[responses.length - 1];
    index++;
    return {
      status: resp.status,
      text: async () => JSON.stringify(resp.data),
    };
  };
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Install a global fetch mock backed by a request handler.
 * @param {(call: { url: string; method: string; body: unknown }) => { status: number; data: unknown }} handler
 * @returns {Function} restore function
 */
function mockFetchHandler(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(String(opts.body)) : undefined;
    const resp = handler({
      url: String(url),
      method: String(opts.method ?? "GET"),
      body,
    });
    return {
      status: resp.status,
      text: async () => JSON.stringify(resp.data),
    };
  };
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// Load the plugin
// ---------------------------------------------------------------------------

// Dynamic import so we can mock fetch before each test
const { tools: toolsFactory, manifest } = await import("../../index.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("exports a manifest with required fields", () => {
    assert.ok(manifest.name, "manifest.name is set");
    assert.ok(manifest.version, "manifest.version is set");
    assert.ok(manifest.secrets?.composio_api_key, "secret composio_api_key declared");
    assert.equal(manifest.version, "1.7.0");
    assert.equal(manifest.defaultConfig?.base_url, "https://backend.composio.dev/api/v3");
  });
});

describe("tools factory", () => {
  it("returns schema, connection, and execution tools when called with sdk", () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);
    const names = toolList.map((t) => t.name);
    assert.deepEqual(names.sort(), [
      "composio_auth_link",
      "composio_execute_tool",
      "composio_get_connection",
      "composio_get_tool_schemas",
      "composio_list_connections",
      "composio_multi_execute",
      "composio_search_tools",
    ]);
  });
});

// ---------------------------------------------------------------------------
// composio_search_tools
// ---------------------------------------------------------------------------

describe("composio_search_tools", () => {
  it("returns tool list on successful API response", async () => {
    const restore = mockFetch([
      {
        status: 200,
        data: {
          items: [
            {
              name: "github_create_issue",
              description: "Create a new issue",
              appKey: "github",
              requiresAuth: true,
              tags: ["issue"],
            },
          ],
          totalItems: 1,
        },
      },
    ]);

    try {
      const sdk = makeSdk();
      const [searchTool] = toolsFactory(sdk);
      const result = await searchTool.execute({ query: "github issue" }, makeContext());

      assert.equal(result.success, true);
      assert.equal(result.data.count, 1);
      assert.equal(result.data.tools[0].tool_slug, "github_create_issue");
      assert.equal(Object.hasOwn(result.data.tools[0], "name"), false);
      assert.equal(result.data.tools[0].toolkit, "github");
      assert.equal(result.data.query, "github issue");
      assert.equal(result.data.execution.tool, "composio_execute_tool");
    } finally {
      restore();
    }
  });

  it("returns success with empty list when no tools found", async () => {
    const restore = mockFetch([{ status: 200, data: { items: [], totalItems: 0 } }]);

    try {
      const sdk = makeSdk();
      const [searchTool] = toolsFactory(sdk);
      const result = await searchTool.execute({ toolkit: "nonexistent" }, makeContext());

      assert.equal(result.success, true);
      assert.equal(result.data.count, 0);
      assert.deepEqual(result.data.tools, []);
    } finally {
      restore();
    }
  });

  it("returns error when API key is missing", async () => {
    const sdk = makeSdk({ apiKey: null });
    const [searchTool] = toolsFactory(sdk);
    const result = await searchTool.execute({}, makeContext());

    assert.equal(result.success, false);
    assert.ok(result.error.includes("API key"));
  });

  it("returns error on non-200 API response", async () => {
    const restore = mockFetch([{ status: 500, data: { message: "Server Error" } }]);

    try {
      const sdk = makeSdk();
      const [searchTool] = toolsFactory(sdk);
      const result = await searchTool.execute({ query: "test" }, makeContext());

      assert.equal(result.success, false);
      assert.ok(result.error.includes("HTTP 500"));
    } finally {
      restore();
    }
  });

  it("respects limit parameter", async () => {
    let capturedUrl = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        status: 200,
        text: async () => JSON.stringify({ items: [], totalItems: 0 }),
      };
    };

    try {
      const sdk = makeSdk();
      const [searchTool] = toolsFactory(sdk);
      await searchTool.execute({ limit: 5 }, makeContext());
      assert.ok(capturedUrl.includes("limit=5"), `URL should include limit=5, got: ${capturedUrl}`);
      assert.ok(capturedUrl.includes("query=") === false, `URL should not include query without a query param, got: ${capturedUrl}`);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// composio_execute_tool
// ---------------------------------------------------------------------------

describe("composio_execute_tool", () => {
  it("executes tool successfully", async () => {
    const restore = mockFetch([
      {
        status: 200,
        data: { response: { issue_id: 42, url: "https://github.com/org/repo/issues/42" } },
      },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const executeTool = toolList.find((t) => t.name === "composio_execute_tool");
      const result = await executeTool.execute(
        { tool_slug: "github_create_issue", parameters: { title: "Test issue" } },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.issue_id, 42);
    } finally {
      restore();
    }
  });

  it("returns structured auth error when 401", async () => {
    const restore = mockFetch([{ status: 401, data: { message: "Unauthorized" } }]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const executeTool = toolList.find((t) => t.name === "composio_execute_tool");
      const result = await executeTool.execute(
        { tool_slug: "github_create_issue", parameters: {} },
        makeContext()
      );

      assert.equal(result.success, false);
      assert.equal(result.error, "auth_required");
      assert.ok(result.auth?.service === "github");
      assert.ok(result.auth?.connect_url?.includes("github"));
      assert.ok(result.auth?.message);
    } finally {
      restore();
    }
  });

  it("returns validation error when tool_slug is missing", async () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);
    const executeTool = toolList.find((t) => t.name === "composio_execute_tool");
    const result = await executeTool.execute({ parameters: {} }, makeContext());

    assert.equal(result.success, false);
    assert.ok(result.error.includes("tool_slug"));
  });

  it("returns validation error when parameters is missing", async () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);
    const executeTool = toolList.find((t) => t.name === "composio_execute_tool");
    const result = await executeTool.execute({ tool_slug: "github_create_issue" }, makeContext());

    assert.equal(result.success, false);
    assert.ok(result.error.includes("parameters"));
  });

  it("returns error when API key is missing", async () => {
    const sdk = makeSdk({ apiKey: null });
    const toolList = toolsFactory(sdk);
    const executeTool = toolList.find((t) => t.name === "composio_execute_tool");
    const result = await executeTool.execute(
      { tool_slug: "github_create_issue", parameters: {} },
      makeContext()
    );

    assert.equal(result.success, false);
    assert.ok(result.error.includes("API key"));
  });

  it("returns error on non-200 API response", async () => {
    const restore = mockFetch([
      { status: 422, data: { message: "Invalid parameter: repo is required" } },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const executeTool = toolList.find((t) => t.name === "composio_execute_tool");
      const result = await executeTool.execute(
        { tool_slug: "github_create_issue", parameters: {} },
        makeContext()
      );

      assert.equal(result.success, false);
      assert.ok(result.error.includes("Invalid parameter"));
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// composio_multi_execute
// ---------------------------------------------------------------------------

describe("composio_multi_execute", () => {
  it("executes multiple tools and returns results in order", async () => {
    const restore = mockFetch([
      { status: 200, data: { response: { id: 1 } } },
      { status: 200, data: { response: { id: 2 } } },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const multiTool = toolList.find((t) => t.name === "composio_multi_execute");
      const result = await multiTool.execute(
        {
          executions: [
            { tool_slug: "github_create_issue", parameters: { title: "Issue 1" } },
            { tool_slug: "github_create_issue", parameters: { title: "Issue 2" } },
          ],
        },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.results.length, 2);
      assert.equal(result.data.summary.succeeded, 2);
      assert.equal(result.data.summary.failed, 0);
      assert.equal(result.data.results[0].success, true);
      assert.equal(result.data.results[0].data.id, 1);
      assert.equal(result.data.results[1].success, true);
      assert.equal(result.data.results[1].data.id, 2);
    } finally {
      restore();
    }
  });

  it("handles partial errors without fail_fast", async () => {
    const restore = mockFetch([
      { status: 200, data: { response: { id: 1 } } },
      { status: 500, data: { message: "Server error" } },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const multiTool = toolList.find((t) => t.name === "composio_multi_execute");
      const result = await multiTool.execute(
        {
          executions: [
            { tool_slug: "github_list_issues", parameters: {} },
            { tool_slug: "gmail_send_email", parameters: {} },
          ],
          fail_fast: false,
        },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.summary.succeeded, 1);
      assert.equal(result.data.summary.failed, 1);
    } finally {
      restore();
    }
  });

  it("returns validation error when executions is empty", async () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);
    const multiTool = toolList.find((t) => t.name === "composio_multi_execute");
    const result = await multiTool.execute({ executions: [] }, makeContext());

    assert.equal(result.success, false);
    assert.ok(result.error.includes("non-empty"));
  });

  it("returns validation error when tool_slug is missing in an execution", async () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);
    const multiTool = toolList.find((t) => t.name === "composio_multi_execute");
    const result = await multiTool.execute(
      { executions: [{ parameters: {} }] },
      makeContext()
    );

    assert.equal(result.success, false);
    assert.ok(result.error.includes("tool_slug"));
  });

  it("returns error when API key is missing", async () => {
    const sdk = makeSdk({ apiKey: null });
    const toolList = toolsFactory(sdk);
    const multiTool = toolList.find((t) => t.name === "composio_multi_execute");
    const result = await multiTool.execute(
      { executions: [{ tool_slug: "github_list_issues", parameters: {} }] },
      makeContext()
    );

    assert.equal(result.success, false);
    assert.ok(result.error.includes("API key"));
  });
});

// ---------------------------------------------------------------------------
// composio_auth_link
// ---------------------------------------------------------------------------

describe("composio_auth_link", () => {
  it("returns a valid auth link for a known service", async () => {
    const restore = mockFetch([
      { status: 200, data: { items: [] } },
      { status: 201, data: { auth_config: { id: "ac_github" } } },
      {
        status: 201,
        data: {
          redirect_url: "https://connect.composio.dev/link/ln_github",
          connected_account_id: "ca_github",
        },
      },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const authTool = toolList.find((t) => t.name === "composio_auth_link");
      const result = await authTool.execute({ service: "github" }, makeContext());

      assert.equal(result.success, true);
      assert.equal(result.data.url, "https://connect.composio.dev/link/ln_github");
      assert.equal(result.data.service, "github");
      assert.equal(result.data.auth_config_id, "ac_github");
      assert.equal(result.data.connected_account_id, "ca_github");
      assert.ok(result.data.message?.includes("GITHUB"));
      assert.ok(result.data.hint);
    } finally {
      restore();
    }
  });

  it("uses explicit auth_config_id when provided", async () => {
    const restore = mockFetch([
      {
        status: 201,
        data: { redirect_url: "https://connect.composio.dev/link/ln_gmail" },
      },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const authTool = toolList.find((t) => t.name === "composio_auth_link");
      const result = await authTool.execute(
        { service: "gmail", auth_config_id: "ac_gmail" },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.url, "https://connect.composio.dev/link/ln_gmail");
      assert.equal(result.data.auth_config_id, "ac_gmail");
    } finally {
      restore();
    }
  });

  it("sends callback_url and alias to the connected accounts link API", async () => {
    const restore = mockFetchHandler((call) => {
      const url = new URL(call.url);
      if (call.method === "POST" && url.pathname.endsWith("/connected_accounts/link")) {
        assert.deepEqual(call.body, {
          auth_config_id: "ac_gmail",
          user_id: "789",
          callback_url: "https://example.com/composio/callback",
          alias: "primary",
        });
        return {
          status: 201,
          data: { redirect_url: "https://connect.composio.dev/link/ln_gmail" },
        };
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const authTool = toolList.find((t) => t.name === "composio_auth_link");
      const result = await authTool.execute(
        {
          service: "gmail",
          auth_config_id: "ac_gmail",
          callback_url: "https://example.com/composio/callback",
          alias: "primary",
        },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.url, "https://connect.composio.dev/link/ln_gmail");
      assert.equal(result.data.auth_config_id, "ac_gmail");
    } finally {
      restore();
    }
  });

  it("returns an actionable error when Composio-managed auth is unavailable", async () => {
    const restore = mockFetch([
      { status: 200, data: { items: [] } },
      {
        status: 400,
        data: {
          message:
            'Default auth config not found for toolkit "openai". Composio does not have managed credentials for this toolkit.',
        },
      },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const authTool = toolList.find((t) => t.name === "composio_auth_link");
      const result = await authTool.execute({ service: "openai" }, makeContext());

      assert.equal(result.success, false);
      assert.ok(result.error.includes("does not support Composio-managed auth"));
      assert.ok(result.error.includes("auth_config_id"));
      assert.equal(result.data.service, "openai");
      assert.equal(result.data.user_id, "789");
    } finally {
      restore();
    }
  });

  it("returns validation error when service is missing", async () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);
    const authTool = toolList.find((t) => t.name === "composio_auth_link");
    const result = await authTool.execute({}, makeContext());

    assert.equal(result.success, false);
    assert.ok(result.error.includes("service"));
  });

  it("returns error when API key is missing", async () => {
    const sdk = makeSdk({ apiKey: null });
    const toolList = toolsFactory(sdk);
    const authTool = toolList.find((t) => t.name === "composio_auth_link");
    const result = await authTool.execute({ service: "github" }, makeContext());

    assert.equal(result.success, false);
    assert.ok(result.error.includes("API key"));
  });

  it("includes custom redirect message when provided", async () => {
    const restore = mockFetch([
      { status: 200, data: { items: [{ id: "ac_slack" }] } },
      { status: 201, data: { redirect_url: "https://connect.composio.dev/link/ln_slack" } },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const authTool = toolList.find((t) => t.name === "composio_auth_link");
      const result = await authTool.execute(
        { service: "slack", redirect_after_auth: "Connection complete! Retry your request." },
        makeContext()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.hint, "Connection complete! Retry your request.");
    } finally {
      restore();
    }
  });
});
