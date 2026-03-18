/**
 * Unit tests for lib/github-client.js
 *
 * Tests the GitHub API client's request handling, auth injection,
 * error mapping, and rate limiting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGitHubClient } from "../lib/github-client.js";

// ---------------------------------------------------------------------------
// Mock SDK
// ---------------------------------------------------------------------------

function makeSdk(token = "ghp_testtoken123") {
  return {
    secrets: {
      get: (key) => (key === "github_token" ? token : null),
      set: vi.fn(),
      delete: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockFetch(status, body, headers = {}) {
  const mockHeaders = new Map(Object.entries({ "content-type": "application/json", ...headers }));
  mockHeaders.get = (key) => mockHeaders._map?.get?.(key.toLowerCase()) ?? null;

  // Build a real Headers-compatible object
  const headerObj = {
    get: (key) => headers[key] ?? null,
    has: (key) => key in headers,
  };

  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: headerObj,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGitHubClient", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  it("isAuthenticated() returns true when token is present", () => {
    const sdk = makeSdk("ghp_valid");
    const client = createGitHubClient(sdk);
    expect(client.isAuthenticated()).toBe(true);
  });

  it("isAuthenticated() returns false when no token", () => {
    const sdk = makeSdk(null);
    const client = createGitHubClient(sdk);
    expect(client.isAuthenticated()).toBe(false);
  });

  // -------------------------------------------------------------------------
  it("get() sends Authorization header with Bearer token", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ login: "octocat" }),
    });

    const sdk = makeSdk("ghp_mytoken");
    const client = createGitHubClient(sdk);
    const data = await client.get("/user");

    expect(data.login).toBe("octocat");
    const callArgs = global.fetch.mock.calls[0];
    expect(callArgs[0]).toContain("https://api.github.com/user");
    expect(callArgs[1].headers.Authorization).toBe("Bearer ghp_mytoken");
  });

  // -------------------------------------------------------------------------
  it("get() omits Authorization header when no token", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify([]),
    });

    const sdk = makeSdk(null);
    const client = createGitHubClient(sdk);
    await client.get("/repos/octocat/hello");

    const callArgs = global.fetch.mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  it("maps 401 to helpful auth error message", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: "Bad credentials" }),
    });

    const sdk = makeSdk("ghp_expired");
    const client = createGitHubClient(sdk);

    await expect(client.get("/user")).rejects.toThrow(
      /Not authenticated/
    );
  });

  // -------------------------------------------------------------------------
  it("maps 404 to not found error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: "Not Found" }),
    });

    const sdk = makeSdk();
    const client = createGitHubClient(sdk);

    await expect(client.get("/repos/does-not/exist")).rejects.toThrow(
      /Not found/
    );
  });

  // -------------------------------------------------------------------------
  it("maps 429 to rate limit error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: "rate limit exceeded" }),
    });

    const sdk = makeSdk();
    const client = createGitHubClient(sdk);

    await expect(client.get("/user")).rejects.toThrow(/rate limit/i);
  });

  // -------------------------------------------------------------------------
  it("returns null data for 204 No Content", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      text: async () => "",
    });

    const sdk = makeSdk();
    const client = createGitHubClient(sdk);
    // delete() uses the 204 path
    const result = await client.delete("/repos/owner/repo/git/refs/heads/test");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  it("getPaginated() parses Link header", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (key) =>
          key === "Link"
            ? '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"'
            : null,
      },
      text: async () => JSON.stringify([{ name: "repo1" }]),
    });

    const sdk = makeSdk();
    const client = createGitHubClient(sdk);
    const { data, pagination } = await client.getPaginated("/user/repos");

    expect(data).toHaveLength(1);
    expect(pagination.next).toBe(2);
    expect(pagination.last).toBe(5);
  });

  // -------------------------------------------------------------------------
  it("post() sends JSON body", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => JSON.stringify({ id: 1, name: "new-repo" }),
    });

    const sdk = makeSdk();
    const client = createGitHubClient(sdk);
    const data = await client.post("/user/repos", { name: "new-repo" });

    expect(data.name).toBe("new-repo");
    const opts = global.fetch.mock.calls[0][1];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "new-repo" });
  });
});
