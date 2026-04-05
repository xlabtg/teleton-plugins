/**
 * Integration tests for composio-direct plugin
 *
 * These tests mock the HTTP transport layer (fetch) to simulate real
 * Composio API behavior including timeouts, 503 errors, 429 rate limits,
 * and auth flows.
 *
 * Run with: node --test plugins/composio-direct/test/integration/composio-api.test.js
 * (Node.js >= 18 built-in test runner)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSdk({ apiKey = "test-key", config = {} } = {}) {
  return {
    secrets: { composio_api_key: apiKey },
    config: {
      base_url: "https://api.composio.dev/api/v1",
      timeout_ms: 3000,
      max_parallel_executions: 5,
      ...config,
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

function makeContext(overrides = {}) {
  return { chatId: "999", senderId: "111", isGroup: false, ...overrides };
}

/**
 * Install a fetch mock from a stateful response factory.
 * @param {() => Promise<{ status: number; data: unknown }>} factory
 * @returns {Function} restore
 */
function mockFetchFactory(factory) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const { status, data } = await factory();
    return { status, text: async () => JSON.stringify(data) };
  };
  return () => { globalThis.fetch = original; };
}

const { tools: toolsFactory } = await import("../../index.js");

// ---------------------------------------------------------------------------
// Integration: retry on 5xx
// ---------------------------------------------------------------------------

describe("retry on 5xx errors", () => {
  it("succeeds after two 503 responses followed by 200", async () => {
    let callCount = 0;
    const responses = [
      { status: 503, data: { message: "Service Unavailable" } },
      { status: 503, data: { message: "Service Unavailable" } },
      { status: 200, data: { items: [{ name: "github_list_repos", description: "List repos", appKey: "github" }] } },
    ];

    const restore = mockFetchFactory(async () => {
      const resp = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      return resp;
    });

    try {
      const sdk = makeSdk({ config: { timeout_ms: 1000 } });
      const [searchTool] = toolsFactory(sdk);
      const result = await searchTool.execute({ query: "github" }, makeContext());

      assert.equal(result.success, true, `Expected success, got: ${JSON.stringify(result)}`);
      assert.equal(callCount, 3, `Expected 3 API calls (2 retries + 1 success), got ${callCount}`);
      assert.equal(result.data.count, 1);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: 429 rate limiting
// ---------------------------------------------------------------------------

describe("rate limit handling", () => {
  it("returns error after exhausting retries on 429", async () => {
    let callCount = 0;
    const restore = mockFetchFactory(async () => {
      callCount++;
      return { status: 429, data: { message: "Too Many Requests" } };
    });

    try {
      const sdk = makeSdk({ config: { timeout_ms: 1000 } });
      const [searchTool] = toolsFactory(sdk);
      const result = await searchTool.execute({ query: "slack" }, makeContext());

      // 429 is not 5xx so no retry — should fail on first call
      assert.equal(result.success, false);
      assert.equal(callCount, 1);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: auth error flow (execute → auth → re-execute)
// ---------------------------------------------------------------------------

describe("auth error flow", () => {
  it("returns structured auth error with connect_url on 401", async () => {
    const restore = mockFetchFactory(async () => ({
      status: 401,
      data: { message: "Not authenticated. Connect your GitHub account." },
    }));

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const executeTool = toolList.find((t) => t.name === "composio_execute_tool");
      const result = await executeTool.execute(
        { tool_slug: "github_list_repos", parameters: {} },
        makeContext()
      );

      assert.equal(result.success, false);
      assert.equal(result.error, "auth_required");
      assert.equal(result.auth.service, "github");
      assert.ok(typeof result.auth.connect_url === "string");
      assert.ok(result.auth.connect_url.length > 0);
      assert.ok(result.auth.message?.length > 0);
    } finally {
      restore();
    }
  });

  it("composio_auth_link falls back gracefully when initiate endpoint is unavailable", async () => {
    let callCount = 0;
    const restore = mockFetchFactory(async () => {
      callCount++;
      // Simulate initiate endpoint being down
      throw new Error("Network failure");
    });

    try {
      const sdk = makeSdk();
      const toolList = toolsFactory(sdk);
      const authTool = toolList.find((t) => t.name === "composio_auth_link");
      const result = await authTool.execute({ service: "notion" }, makeContext());

      // Should succeed with fallback URL even when API is unreachable
      assert.equal(result.success, true);
      assert.ok(result.data.url?.includes("notion"));
      assert.equal(result.data.service, "notion");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-execute with batching
// ---------------------------------------------------------------------------

describe("multi-execute batching", () => {
  it("processes tools in batches and aggregates results", async () => {
    let callCount = 0;
    const restore = mockFetchFactory(async () => {
      callCount++;
      return { status: 200, data: { response: { call: callCount } } };
    });

    try {
      const sdk = makeSdk({ config: { max_parallel_executions: 2 } });
      const toolList = toolsFactory(sdk);
      const multiTool = toolList.find((t) => t.name === "composio_multi_execute");

      const executions = [
        { tool_slug: "github_list_repos", parameters: {} },
        { tool_slug: "github_list_issues", parameters: {} },
        { tool_slug: "github_list_prs", parameters: {} },
      ];

      const result = await multiTool.execute({ executions, max_parallel: 2 }, makeContext());

      assert.equal(result.success, true);
      assert.equal(result.data.results.length, 3);
      assert.equal(result.data.summary.succeeded, 3);
      assert.equal(result.data.summary.failed, 0);
      assert.equal(callCount, 3);
    } finally {
      restore();
    }
  });

  it("stops after first failure with fail_fast=true", async () => {
    // Return 401 (auth error) which is NOT retried, so the first tool definitely fails
    let callCount = 0;
    const restore = mockFetchFactory(async () => {
      callCount++;
      return { status: 401, data: { message: "Unauthorized" } };
    });

    try {
      const sdk = makeSdk({ config: { max_parallel_executions: 1 } });
      const toolList = toolsFactory(sdk);
      const multiTool = toolList.find((t) => t.name === "composio_multi_execute");

      const executions = [
        { tool_slug: "github_create_issue", parameters: {} },
        { tool_slug: "github_create_issue", parameters: {} },
        { tool_slug: "github_create_issue", parameters: {} },
      ];

      const result = await multiTool.execute(
        { executions, fail_fast: true, max_parallel: 1 },
        makeContext()
      );

      assert.equal(result.success, true);
      // With fail_fast and sequential (max_parallel=1), stops after first failure
      assert.equal(result.data.summary.failed, 1, "Exactly one tool should fail");
      assert.ok(result.data.summary.skipped >= 1, "Should have skipped remaining tools");
      // Total should add up
      assert.equal(
        result.data.summary.succeeded + result.data.summary.failed + result.data.summary.skipped,
        3
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: no API key configured
// ---------------------------------------------------------------------------

describe("missing API key", () => {
  it("all tools return a helpful error when composio_api_key is not set", async () => {
    const sdk = makeSdk();
    sdk.secrets = {};

    const toolList = toolsFactory(sdk);
    const context = makeContext();

    for (const tool of toolList) {
      let params = {};
      if (tool.name === "composio_execute_tool") {
        params = { tool_slug: "github_list_repos", parameters: {} };
      } else if (tool.name === "composio_multi_execute") {
        params = { executions: [{ tool_slug: "github_list_repos", parameters: {} }] };
      } else if (tool.name === "composio_auth_link") {
        params = { service: "github" };
      }

      const result = await tool.execute(params, context);
      assert.equal(result.success, false, `${tool.name} should fail without API key`);
      assert.ok(result.error.includes("API key"), `${tool.name}: expected "API key" in error message, got: ${result.error}`);
    }
  });
});
