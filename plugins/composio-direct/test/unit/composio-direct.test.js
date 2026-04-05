/**
 * Unit tests for composio-direct plugin
 *
 * Run with: node --test plugins/composio-direct/test/unit/composio-direct.test.js
 * (Node.js >= 18 built-in test runner)
 */

import { describe, it, before, after, mock } from "node:test";
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
      base_url: "https://api.composio.dev/api/v1",
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
    assert.ok(manifest.defaultConfig?.base_url, "defaultConfig.base_url set");
  });
});

describe("tools factory", () => {
  it("returns an array of 4 tools when called with sdk", () => {
    const sdk = makeSdk();
    const toolList = toolsFactory(sdk);
    assert.equal(toolList.length, 4);
    const names = toolList.map((t) => t.name);
    assert.deepEqual(names.sort(), [
      "composio_auth_link",
      "composio_execute_tool",
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
      assert.equal(result.data.tools[0].name, "github_create_issue");
      assert.equal(result.data.tools[0].toolkit, "github");
      assert.equal(result.data.query, "github issue");
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
    // Mock the initiate endpoint to fail so we test the fallback URL
    const restore = mockFetch([{ status: 404, data: {} }]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const authTool = toolList.find((t) => t.name === "composio_auth_link");
      const result = await authTool.execute({ service: "github" }, makeContext());

      assert.equal(result.success, true);
      assert.ok(result.data.url?.includes("github"), `URL should reference github, got: ${result.data.url}`);
      assert.equal(result.data.service, "github");
      assert.ok(result.data.message?.includes("GITHUB"));
      assert.ok(result.data.hint);
    } finally {
      restore();
    }
  });

  it("uses dynamic URL when API returns redirectUrl", async () => {
    const restore = mockFetch([
      {
        status: 200,
        data: { redirectUrl: "https://accounts.google.com/oauth2/auth?client_id=composio" },
      },
    ]);

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const authTool = toolList.find((t) => t.name === "composio_auth_link");
      const result = await authTool.execute({ service: "gmail" }, makeContext());

      assert.equal(result.success, true);
      assert.ok(result.data.url?.includes("google.com"), `Expected Google OAuth URL, got: ${result.data.url}`);
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
    const restore = mockFetch([{ status: 404, data: {} }]);

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
