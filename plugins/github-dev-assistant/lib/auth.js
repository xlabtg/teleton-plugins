/**
 * GitHub OAuth 2.0 flow manager for the github-dev-assistant plugin.
 *
 * Implements:
 *  - OAuth authorization URL generation with CSRF state parameter
 *  - State storage with TTL via sdk.storage
 *  - Token exchange (code → access token) via GitHub OAuth API
 *  - Token persistence via sdk.secrets
 *  - Token validation by calling /user endpoint
 *  - Token revocation
 *
 * Security notes:
 *  - State is generated with 32 cryptographically random bytes (64 hex chars)
 *  - State TTL is 10 minutes (600 seconds)
 *  - Tokens are stored ONLY in sdk.secrets — never logged or put in config
 *  - Client secret is read from sdk.secrets — never hardcoded
 */

import { generateState, formatError } from "./utils.js";

const GITHUB_OAUTH_BASE = "https://github.com";
const GITHUB_API_BASE = "https://api.github.com";

// State TTL in seconds (10 minutes)
const STATE_TTL_SECONDS = 600;

// Secret key under which we store the access token in sdk.secrets
export const ACCESS_TOKEN_SECRET_KEY = "github_access_token";

// Storage key for pending OAuth state entries
const STATE_STORAGE_PREFIX = "github_oauth_state_";

/**
 * Create an auth manager bound to the given sdk.
 *
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object} Auth manager with initiate(), exchange(), check(), revoke()
 */
export function createAuthManager(sdk) {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the GitHub OAuth App client ID from secrets.
   * @returns {string|null}
   */
  function getClientId() {
    return sdk.secrets.get("github_client_id") ?? null;
  }

  /**
   * Get the GitHub OAuth App client secret from secrets.
   * @returns {string|null}
   */
  function getClientSecret() {
    return sdk.secrets.get("github_client_secret") ?? null;
  }

  /**
   * Persist a state token with TTL in sdk.storage.
   * @param {string} state
   */
  function saveState(state) {
    const entry = {
      state,
      created_at: Date.now(),
      expires_at: Date.now() + STATE_TTL_SECONDS * 1000,
    };
    sdk.storage.set(`${STATE_STORAGE_PREFIX}${state}`, JSON.stringify(entry));
  }

  /**
   * Validate a state token: must exist in storage and not be expired.
   * Deletes the state entry regardless to prevent replay.
   * @param {string} state
   * @returns {boolean}
   */
  function validateAndConsumeState(state) {
    if (!state) return false;
    const key = `${STATE_STORAGE_PREFIX}${state}`;
    const raw = sdk.storage.get(key);
    if (!raw) return false;

    // Always consume (delete) the state to prevent replay attacks
    sdk.storage.delete(key);

    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return false;
    }

    // Check expiry
    if (Date.now() > entry.expires_at) {
      return false;
    }
    return entry.state === state;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    /**
     * Generate an OAuth authorization URL and save state for CSRF protection.
     *
     * @param {string[]} [scopes] - OAuth scopes to request
     * @returns {{ auth_url: string, state: string, instructions: string }}
     */
    initiateOAuth(scopes = ["repo", "workflow", "user"]) {
      const clientId = getClientId();
      if (!clientId) {
        throw new Error(
          "GitHub OAuth App client ID not configured. " +
          "Set github_client_id in the plugin secrets (env: GITHUB_OAUTH_CLIENT_ID)."
        );
      }

      const state = generateState(32);
      saveState(state);

      const url = new URL(`${GITHUB_OAUTH_BASE}/login/oauth/authorize`);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);

      sdk.log.info("GitHub OAuth: authorization URL generated");

      return {
        auth_url: url.toString(),
        state,
        instructions:
          "Open the auth_url in your browser, authorize the app, " +
          "then paste the code returned by the callback page back into the chat.",
      };
    },

    /**
     * Exchange an OAuth authorization code for an access token.
     * Validates the CSRF state before proceeding.
     *
     * @param {string} code - Authorization code from GitHub callback
     * @param {string} state - State parameter from callback (must match saved state)
     * @returns {{ success: boolean, user_login?: string, scopes?: string[], error?: string }}
     */
    async exchangeCode(code, state) {
      if (!validateAndConsumeState(state)) {
        throw new Error(
          "Invalid or expired OAuth state. Please restart the authorization flow."
        );
      }

      const clientId = getClientId();
      const clientSecret = getClientSecret();

      if (!clientId || !clientSecret) {
        throw new Error(
          "GitHub OAuth App credentials not fully configured. " +
          "Ensure github_client_id and github_client_secret are set in secrets."
        );
      }

      // Exchange code for token
      const tokenRes = await fetch(
        `${GITHUB_OAUTH_BASE}/login/oauth/access_token`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": "teleton-github-dev-assistant/1.0.0",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!tokenRes.ok) {
        throw new Error(
          `OAuth token exchange failed: HTTP ${tokenRes.status}`
        );
      }

      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        throw new Error(
          `OAuth error: ${tokenData.error_description ?? tokenData.error}`
        );
      }

      const accessToken = tokenData.access_token;
      if (!accessToken) {
        throw new Error("No access token received from GitHub.");
      }

      // Store the token — never logged, only in sdk.secrets
      sdk.secrets.set(ACCESS_TOKEN_SECRET_KEY, accessToken);
      sdk.log.info("GitHub OAuth: access token stored successfully");

      // Verify token by fetching the authenticated user
      const userRes = await fetch(`${GITHUB_API_BASE}/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "teleton-github-dev-assistant/1.0.0",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!userRes.ok) {
        throw new Error(`Token validation failed: GitHub API returned ${userRes.status}`);
      }

      const user = await userRes.json();
      const grantedScopes = (tokenData.scope ?? "").split(",").filter(Boolean);

      sdk.log.info(`GitHub OAuth: authenticated as ${user.login}`);

      return {
        user_login: user.login,
        scopes: grantedScopes,
      };
    },

    /**
     * Check the current authentication status.
     * Calls /user endpoint to verify the stored token is still valid.
     *
     * @param {object} client - GitHub API client (from github-client.js)
     * @returns {{ authenticated: boolean, user_login?: string, scopes?: string[] }}
     */
    async checkAuth(client) {
      if (!client.isAuthenticated()) {
        return { authenticated: false };
      }

      try {
        const user = await client.get("/user");
        // Fetch token scopes — they're in the X-OAuth-Scopes header of /user
        // We can't easily get headers here, so just return what we know
        return {
          authenticated: true,
          user_login: user.login,
          user_id: user.id,
          user_name: user.name ?? null,
          user_email: user.email ?? null,
          avatar_url: user.avatar_url ?? null,
        };
      } catch (err) {
        if (err.status === 401) {
          // Token is invalid — clean it up
          sdk.secrets.delete(ACCESS_TOKEN_SECRET_KEY);
          sdk.log.info("GitHub OAuth: stale token removed");
          return { authenticated: false };
        }
        throw err;
      }
    },

    /**
     * Revoke the stored access token and remove it from sdk.secrets.
     * Calls GitHub's OAuth revoke endpoint if client credentials are available.
     *
     * @returns {{ revoked: boolean, message: string }}
     */
    async revokeToken() {
      const token = sdk.secrets.get(ACCESS_TOKEN_SECRET_KEY);
      if (!token) {
        return { revoked: false, message: "No token to revoke." };
      }

      const clientId = getClientId();
      const clientSecret = getClientSecret();

      // Attempt to revoke at GitHub's side (best-effort; local removal is authoritative)
      if (clientId && clientSecret) {
        try {
          await fetch(
            `${GITHUB_API_BASE}/applications/${clientId}/token`,
            {
              method: "DELETE",
              headers: {
                Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "teleton-github-dev-assistant/1.0.0",
              },
              body: JSON.stringify({ access_token: token }),
              signal: AbortSignal.timeout(10000),
            }
          );
          sdk.log.info("GitHub OAuth: token revoked at GitHub");
        } catch (err) {
          // Non-fatal — we still remove locally
          sdk.log.warn(`GitHub OAuth: remote revocation failed: ${formatError(err)}`);
        }
      }

      // Always remove locally
      sdk.secrets.delete(ACCESS_TOKEN_SECRET_KEY);
      sdk.log.info("GitHub OAuth: access token removed from secrets");

      return { revoked: true, message: "GitHub access token revoked and removed." };
    },
  };
}
