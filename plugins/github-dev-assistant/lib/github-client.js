/**
 * GitHub REST API client for the github-dev-assistant plugin.
 *
 * Wraps the GitHub REST API v3 with:
 * - Automatic Authorization header injection from sdk.secrets at request time
 * - Rate-limit tracking and soft throttling
 * - Structured error handling with no token leakage in logs
 * - Pagination support via Link header parsing
 *
 * Usage:
 *   const client = createGitHubClient(sdk);
 *   const data = await client.get("/user/repos");
 *
 * The client reads the token from sdk.secrets on every request, so stale
 * client instances automatically pick up updated tokens.
 */

import { formatError, createRateLimiter, parseLinkHeader } from "./utils.js";

const GITHUB_API_BASE = "https://api.github.com";

// GitHub recommends no more than ~60 secondary rate-limit requests per minute
// for unauthenticated, and ~5000/hour for authenticated. We throttle lightly.
const MIN_REQUEST_DELAY_MS = 100;

/**
 * Create a GitHub API client bound to the given sdk instance.
 *
 * @param {object} sdk - Teleton plugin SDK
 * @returns {object} Client with get(), post(), put(), patch(), delete() methods
 */
export function createGitHubClient(sdk) {
  const rateLimiter = createRateLimiter(MIN_REQUEST_DELAY_MS);

  /**
   * Retrieve the stored Personal Access Token from sdk.secrets.
   * Returns null if not set (unauthenticated).
   * @returns {string|null}
   */
  function getAccessToken() {
    return sdk.secrets.get("github_token") ?? null;
  }

  /**
   * Build common request headers.
   * Token is read at request time — never at client creation time.
   * @returns {object}
   */
  function buildHeaders(extraHeaders = {}) {
    const token = getAccessToken();
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "teleton-github-dev-assistant/1.0.0",
      ...extraHeaders,
    };
    if (token) {
      // Token injected at request time — never logged
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Core fetch wrapper. Applies rate limiting, injects auth, handles errors.
   *
   * @param {string} method - HTTP method
   * @param {string} path - API path (e.g. "/repos/owner/repo")
   * @param {object|null} body - JSON body for POST/PUT/PATCH
   * @param {object} queryParams - URL query parameters
   * @returns {Promise<{ data: any, headers: Headers, status: number }>}
   * @throws {Error} On non-2xx responses with structured message
   */
  async function request(method, path, body = null, queryParams = {}) {
    await rateLimiter.wait();

    const url = new URL(path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`);
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const opts = {
      method: method.toUpperCase(),
      headers: buildHeaders(),
      signal: AbortSignal.timeout(20000),
    };

    if (body !== null && ["POST", "PUT", "PATCH"].includes(opts.method)) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), opts);

    // 204 No Content — success with no body
    if (res.status === 204) {
      return { data: null, headers: res.headers, status: res.status };
    }

    const responseText = await res.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    if (!res.ok) {
      // Build a clear, non-leaking error message
      const ghMessage =
        typeof responseData === "object" && responseData?.message
          ? responseData.message
          : responseText.slice(0, 200);

      // Map common GitHub status codes to helpful messages
      const statusMessages = {
        401: "Not authenticated. Please set the github_token secret with a valid Personal Access Token.",
        403: `Access denied. ${ghMessage}`,
        404: `Not found. ${ghMessage}`,
        409: `Conflict. ${ghMessage}`,
        422: `Validation error. ${ghMessage}`,
        429: "GitHub API rate limit exceeded. Please wait before retrying.",
      };

      const message = statusMessages[res.status] ?? `GitHub API error ${res.status}: ${ghMessage}`;
      const err = new Error(message);
      err.status = res.status;
      err.githubData = responseData;
      throw err;
    }

    return { data: responseData, headers: res.headers, status: res.status };
  }

  return {
    /**
     * GET request to GitHub API.
     * @param {string} path
     * @param {object} [queryParams]
     * @returns {Promise<any>} Response data
     */
    async get(path, queryParams = {}) {
      const { data } = await request("GET", path, null, queryParams);
      return data;
    },

    /**
     * GET with pagination — returns data and pagination metadata.
     * @param {string} path
     * @param {object} [queryParams]
     * @returns {Promise<{ data: any, pagination: object }>}
     */
    async getPaginated(path, queryParams = {}) {
      const { data, headers } = await request("GET", path, null, queryParams);
      const linkHeader = headers.get("Link");
      return { data, pagination: parseLinkHeader(linkHeader) };
    },

    /**
     * POST request.
     * @param {string} path
     * @param {object} body
     * @returns {Promise<any>}
     */
    async post(path, body) {
      const { data } = await request("POST", path, body);
      return data;
    },

    /**
     * PUT request.
     * @param {string} path
     * @param {object} body
     * @returns {Promise<any>}
     */
    async put(path, body) {
      const { data } = await request("PUT", path, body);
      return data;
    },

    /**
     * PATCH request.
     * @param {string} path
     * @param {object} body
     * @returns {Promise<any>}
     */
    async patch(path, body) {
      const { data } = await request("PATCH", path, body);
      return data;
    },

    /**
     * DELETE request.
     * @param {string} path
     * @returns {Promise<any>}
     */
    async delete(path) {
      const { data } = await request("DELETE", path);
      return data;
    },

    /**
     * POST with raw response (for workflow dispatches etc.)
     * @param {string} path
     * @param {object} body
     * @returns {Promise<{ status: number, data: any }>}
     */
    async postRaw(path, body) {
      const { status, data } = await request("POST", path, body);
      return { status, data };
    },

    /** Check if authenticated (token is present in secrets) */
    isAuthenticated() {
      return !!getAccessToken();
    },
  };
}
