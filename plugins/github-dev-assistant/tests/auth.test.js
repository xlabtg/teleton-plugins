/**
 * Unit tests for lib/auth.js
 *
 * Tests OAuth flow: state generation, code exchange, auth check, revoke.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthManager } from "../lib/auth.js";

// ---------------------------------------------------------------------------
// Mock SDK
// ---------------------------------------------------------------------------

function makeSdk({ clientId = "test-client-id", clientSecret = "test-client-secret", storedToken = null } = {}) {
  const storage = new Map();
  const secrets = new Map();
  if (clientId) secrets.set("github_client_id", clientId);
  if (clientSecret) secrets.set("github_client_secret", clientSecret);
  if (storedToken) secrets.set("github_access_token", storedToken);

  return {
    secrets: {
      get: (key) => secrets.get(key) ?? null,
      set: (key, value) => secrets.set(key, value),
      delete: (key) => secrets.delete(key),
      _map: secrets,
    },
    storage: {
      get: (key) => storage.get(key) ?? null,
      set: (key, value) => storage.set(key, value),
      delete: (key) => storage.delete(key),
      _map: storage,
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: {},
  };
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockFetchSequence(responses) {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    const { status, body } = response;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let originalFetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

describe("createAuthManager - initiateOAuth", () => {
  it("returns auth_url and state with default scopes", () => {
    const sdk = makeSdk();
    const auth = createAuthManager(sdk);
    const result = auth.initiateOAuth();

    expect(result.auth_url).toContain("github.com/login/oauth/authorize");
    expect(result.auth_url).toContain("client_id=test-client-id");
    expect(result.auth_url).toContain("scope=repo+workflow+user");
    expect(result.state).toBeTruthy();
    expect(result.state.length).toBe(64); // 32 bytes → 64 hex chars
    expect(result.instructions).toBeTruthy();
  });

  it("throws when client_id is not configured", () => {
    const sdk = makeSdk({ clientId: null });
    const auth = createAuthManager(sdk);
    expect(() => auth.initiateOAuth()).toThrow(/client_id/i);
  });

  it("saves state in sdk.storage with expiry", () => {
    const sdk = makeSdk();
    const auth = createAuthManager(sdk);
    const { state } = auth.initiateOAuth();

    // State should be stored with a prefix
    const stored = sdk.storage.get(`github_oauth_state_${state}`);
    expect(stored).toBeTruthy();
    const entry = JSON.parse(stored);
    expect(entry.state).toBe(state);
    expect(entry.expires_at).toBeGreaterThan(Date.now());
  });

  it("accepts custom scopes", () => {
    const sdk = makeSdk();
    const auth = createAuthManager(sdk);
    const { auth_url } = auth.initiateOAuth(["read:user", "gist"]);
    expect(auth_url).toContain("scope=read%3Auser+gist");
  });
});

describe("createAuthManager - exchangeCode", () => {
  it("exchanges code for token and stores it", async () => {
    const sdk = makeSdk();
    const auth = createAuthManager(sdk);

    // Pre-populate a valid state
    const { state } = auth.initiateOAuth();

    global.fetch = mockFetchSequence([
      // GitHub token exchange
      { status: 200, body: { access_token: "ghp_newtoken", scope: "repo,user", token_type: "bearer" } },
      // GitHub /user verification
      { status: 200, body: { login: "octocat", id: 1 } },
    ]);

    const result = await auth.exchangeCode("auth-code-123", state);

    expect(result.user_login).toBe("octocat");
    expect(result.scopes).toContain("repo");
    // Token should be stored in secrets
    expect(sdk.secrets._map.get("github_access_token")).toBe("ghp_newtoken");
  });

  it("throws on invalid state (CSRF protection)", async () => {
    const sdk = makeSdk();
    const auth = createAuthManager(sdk);

    await expect(
      auth.exchangeCode("auth-code-123", "invalid-state-value")
    ).rejects.toThrow(/invalid or expired/i);
  });

  it("throws on expired state", async () => {
    const sdk = makeSdk();
    const auth = createAuthManager(sdk);

    // Manually insert an expired state entry
    const fakeState = "a".repeat(64);
    sdk.storage.set(`github_oauth_state_${fakeState}`, JSON.stringify({
      state: fakeState,
      created_at: Date.now() - 700000,
      expires_at: Date.now() - 100000, // expired 100s ago
    }));

    await expect(
      auth.exchangeCode("code", fakeState)
    ).rejects.toThrow(/invalid or expired/i);
  });

  it("throws when GitHub returns error in token response", async () => {
    const sdk = makeSdk();
    const auth = createAuthManager(sdk);
    const { state } = auth.initiateOAuth();

    global.fetch = mockFetchSequence([
      { status: 200, body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } },
    ]);

    await expect(auth.exchangeCode("bad-code", state)).rejects.toThrow(
      /incorrect or expired/
    );
  });

  it("consumes state after use (prevents replay)", async () => {
    const sdk = makeSdk();
    const auth = createAuthManager(sdk);
    const { state } = auth.initiateOAuth();

    global.fetch = mockFetchSequence([
      { status: 200, body: { access_token: "ghp_tok", scope: "repo", token_type: "bearer" } },
      { status: 200, body: { login: "octocat", id: 1 } },
    ]);

    await auth.exchangeCode("code", state);

    // Second use of the same state must fail
    global.fetch = mockFetchSequence([
      { status: 200, body: { access_token: "ghp_tok2", scope: "repo", token_type: "bearer" } },
      { status: 200, body: { login: "octocat", id: 1 } },
    ]);

    await expect(auth.exchangeCode("code2", state)).rejects.toThrow(/invalid or expired/i);
  });
});

describe("createAuthManager - checkAuth", () => {
  it("returns authenticated: false when no token", async () => {
    const sdk = makeSdk({ storedToken: null });
    const auth = createAuthManager(sdk);

    const mockClient = {
      isAuthenticated: () => false,
      get: vi.fn(),
    };

    const result = await auth.checkAuth(mockClient);
    expect(result.authenticated).toBe(false);
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  it("returns user info when authenticated", async () => {
    const sdk = makeSdk({ storedToken: "ghp_valid" });
    const auth = createAuthManager(sdk);

    const mockClient = {
      isAuthenticated: () => true,
      get: vi.fn().mockResolvedValue({
        login: "octocat",
        id: 1,
        name: "The Octocat",
        email: null,
        avatar_url: "https://avatars.githubusercontent.com/u/583231",
      }),
    };

    const result = await auth.checkAuth(mockClient);
    expect(result.authenticated).toBe(true);
    expect(result.user_login).toBe("octocat");
    expect(result.avatar_url).toContain("avatars.githubusercontent.com");
  });

  it("removes stale token on 401 and returns unauthenticated", async () => {
    const sdk = makeSdk({ storedToken: "ghp_expired" });
    const auth = createAuthManager(sdk);

    const err = new Error("Bad credentials");
    err.status = 401;

    const mockClient = {
      isAuthenticated: () => true,
      get: vi.fn().mockRejectedValue(err),
    };

    const result = await auth.checkAuth(mockClient);
    expect(result.authenticated).toBe(false);
    expect(sdk.secrets._map.has("github_access_token")).toBe(false);
  });
});

describe("createAuthManager - revokeToken", () => {
  it("removes token from sdk.secrets", async () => {
    const sdk = makeSdk({ storedToken: "ghp_torevoke" });
    const auth = createAuthManager(sdk);

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });

    const result = await auth.revokeToken();
    expect(result.revoked).toBe(true);
    expect(sdk.secrets._map.has("github_access_token")).toBe(false);
  });

  it("returns revoked: false when no token to revoke", async () => {
    const sdk = makeSdk({ storedToken: null });
    const auth = createAuthManager(sdk);

    const result = await auth.revokeToken();
    expect(result.revoked).toBe(false);
  });

  it("still removes local token even if GitHub revoke API call fails", async () => {
    const sdk = makeSdk({ storedToken: "ghp_torevoke" });
    const auth = createAuthManager(sdk);

    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await auth.revokeToken();
    expect(result.revoked).toBe(true);
    expect(sdk.secrets._map.has("github_access_token")).toBe(false);
  });
});
