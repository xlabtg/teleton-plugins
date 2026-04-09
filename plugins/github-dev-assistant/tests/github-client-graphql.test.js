/**
 * Unit tests verifying that graphql() reuses buildHeaders() logic.
 *
 * Regression test for issue #116:
 *   graphql() was duplicating auth header logic instead of reusing buildHeaders().
 *
 * Uses Node's built-in test runner (node:test).
 * Network is mocked via global fetch override.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createGitHubClient } from "../lib/github-client.js";

// ─── Minimal mock SDK ─────────────────────────────────────────────────────────

function makeSdk(token = "test-token-abc") {
  return {
    pluginConfig: {},
    secrets: {
      get(key) {
        if (key === "github_token") return token;
        return null;
      },
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

// ─── Fetch mock ───────────────────────────────────────────────────────────────

let capturedRequest = null;
const originalFetch = globalThis.fetch;

function mockFetch(url, opts) {
  capturedRequest = { url, opts };
  const responseBody = JSON.stringify({ data: { viewer: { login: "testuser" } } });
  return Promise.resolve(
    new Response(responseBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("graphql() header construction (issue #116 regression)", () => {
  before(() => {
    globalThis.fetch = mockFetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends Authorization header with token from sdk.secrets", async () => {
    const sdk = makeSdk("my-secret-token");
    const client = createGitHubClient(sdk);

    await client.graphql("{ viewer { login } }");

    assert.ok(capturedRequest, "fetch should have been called");
    assert.equal(
      capturedRequest.opts.headers.Authorization,
      "Bearer my-secret-token",
      "Authorization header should match the token from sdk.secrets"
    );
  });

  it("sends standard GitHub API headers (Accept, X-GitHub-Api-Version, User-Agent)", async () => {
    const sdk = makeSdk("some-token");
    const client = createGitHubClient(sdk);

    await client.graphql("{ viewer { login } }");

    const headers = capturedRequest.opts.headers;
    assert.equal(headers.Accept, "application/vnd.github+json");
    assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(headers["User-Agent"], "teleton-github-dev-assistant/1.0.0");
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("omits Authorization header when no token is set", async () => {
    const sdk = makeSdk(null);
    const client = createGitHubClient(sdk);

    await client.graphql("{ viewer { login } }");

    assert.equal(
      capturedRequest.opts.headers.Authorization,
      undefined,
      "Authorization header should not be set when no token is present"
    );
  });

  it("posts to the GitHub GraphQL endpoint", async () => {
    const sdk = makeSdk("token");
    const client = createGitHubClient(sdk);

    await client.graphql("{ viewer { login } }");

    assert.equal(capturedRequest.url, "https://api.github.com/graphql");
    assert.equal(capturedRequest.opts.method, "POST");
  });

  it("serializes query and variables in request body", async () => {
    const sdk = makeSdk("token");
    const client = createGitHubClient(sdk);

    await client.graphql("{ viewer { login } }", { owner: "test" });

    const body = JSON.parse(capturedRequest.opts.body);
    assert.equal(body.query, "{ viewer { login } }");
    assert.deepEqual(body.variables, { owner: "test" });
  });
});
