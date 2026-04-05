/**
 * composio-direct — Direct Integration with 1000+ Composio Tools
 *
 * Provides 4 tools for direct Composio API access:
 *   composio_search_tools   — search tools by query or toolkit
 *   composio_execute_tool   — execute a single tool
 *   composio_multi_execute  — batch-execute multiple tools in parallel
 *   composio_auth_link      — get OAuth authorization links
 *
 * Authentication:
 *   - Requires a Composio API key stored in sdk.secrets as "composio_api_key"
 *   - Set COMPOSIO_API_KEY env var or use the secrets store
 *
 * Security:
 *   - API keys and OAuth tokens are never logged
 *   - All requests use HTTPS
 *   - Input validation before every API call
 *
 * Error handling:
 *   - 30 second default timeout (configurable via defaultConfig.timeout_ms)
 *   - 3 retries with exponential backoff (1s, 2s, 4s) for network and 5xx errors
 *   - Auth errors return structured response with connect_url
 */

// ---------------------------------------------------------------------------
// Inline manifest — read by the Teleton runtime for SDK version gating,
// defaultConfig merging, and secrets registration.
// ---------------------------------------------------------------------------

export const manifest = {
  name: "composio-direct",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description:
    "Direct access to 1000+ Composio automation tools — search, execute, batch-run, and authorize services like GitHub, Gmail, Slack, Notion, Jira, Linear without MCP transport",
  secrets: {
    composio_api_key: {
      required: true,
      env: "COMPOSIO_API_KEY",
      description: "Composio API key (create at https://app.composio.dev/settings)",
    },
  },
  defaultConfig: {
    base_url: "https://api.composio.dev/api/v1",
    timeout_ms: 30000,
    max_parallel_executions: 10,
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for ms milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build common headers for Composio API requests.
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
function buildHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

/**
 * Perform an HTTP request with retry logic for network errors and 5xx responses.
 * Never logs the API key or response bodies containing tokens.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.method
 * @param {Record<string, string>} opts.headers
 * @param {unknown} [opts.body]
 * @param {number} opts.timeoutMs
 * @param {object} opts.log - sdk.log compatible logger
 * @returns {Promise<{ status: number; data: unknown }>}
 */
async function fetchWithRetry({ url, method, headers, body, timeoutMs, log }) {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 2000, 4000];

  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      // Retry on 5xx server errors
      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        log.debug(`composio-direct: HTTP ${response.status} on attempt ${attempt + 1}, retrying`);
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }

      return { status: response.status, data };
    } catch (err) {
      clearTimeout(timer);

      const isTimeout = err.name === "AbortError";
      const isNetwork = !isTimeout;

      if (isTimeout) {
        lastError = new Error(`Request timed out after ${timeoutMs}ms`);
      } else {
        lastError = err;
      }

      if (attempt < MAX_RETRIES - 1) {
        log.debug(`composio-direct: ${isTimeout ? "timeout" : "network error"} on attempt ${attempt + 1}, retrying`);
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
    }
  }

  throw lastError;
}

/**
 * Detect if a Composio API error response indicates auth is required.
 * @param {{ status: number; data: unknown }} response
 * @returns {boolean}
 */
function isAuthError(response) {
  if (response.status === 401 || response.status === 403) return true;
  const data = response.data;
  if (data && typeof data === "object") {
    const msg = (data.message ?? data.error ?? "").toLowerCase();
    if (msg.includes("auth") || msg.includes("connect") || msg.includes("not connected")) {
      return true;
    }
  }
  return false;
}

/**
 * Extract service name from a Composio tool slug (e.g. "github_create_issue" → "github").
 * @param {string} toolSlug
 * @returns {string}
 */
function extractServiceFromSlug(toolSlug) {
  return toolSlug.split("_")[0] ?? toolSlug;
}

/**
 * Format a Composio API error into a human-readable string.
 * @param {unknown} err
 * @returns {string}
 */
function formatApiError(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// ---------------------------------------------------------------------------
// SDK export — Teleton runtime calls tools(sdk) and uses the returned array
// ---------------------------------------------------------------------------

export const tools = (sdk) => {
  /**
   * Get plugin configuration with defaults.
   */
  function getConfig() {
    const cfg = sdk.config ?? {};
    return {
      baseUrl: (cfg.base_url ?? "https://api.composio.dev/api/v1").replace(/\/$/, ""),
      timeoutMs: Number(cfg.timeout_ms ?? 30000),
      maxParallelExecutions: Number(cfg.max_parallel_executions ?? 10),
    };
  }

  /**
   * Retrieve the API key or return null if not configured.
   * @returns {string | null}
   */
  function getApiKey() {
    return sdk.secrets?.get("composio_api_key") ?? null;
  }

  /**
   * Build a standard "not configured" error response.
   * @returns {{ success: false; error: string }}
   */
  function notConfiguredError() {
    return {
      success: false,
      error:
        "Composio API key is not configured. Please set the composio_api_key secret with your key from https://app.composio.dev/settings",
    };
  }

  // -------------------------------------------------------------------------
  // Tool 1: composio_search_tools
  // -------------------------------------------------------------------------

  const composioSearchTools = {
    name: "composio_search_tools",
    description:
      "Search for available Composio tools by query, toolkit name, or description. " +
      "Use this before executing a tool to discover its exact slug and parameters. " +
      "Supports filtering by toolkit (e.g. github, gmail, slack, notion, linear, jira).",
    category: "data-bearing",

    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text search by tool name or description (e.g. 'create issue')",
        },
        toolkit: {
          type: "string",
          description:
            "Filter by toolkit name (e.g. 'github', 'gmail', 'slack', 'notion', 'linear', 'jira')",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return (1–100, default: 50)",
          minimum: 1,
          maximum: 100,
        },
        include_params: {
          type: "boolean",
          description:
            "When true, include full parameter schemas for each tool. Default: false.",
        },
      },
    },

    execute: async (params, _context) => {
      const apiKey = getApiKey();
      if (!apiKey) return notConfiguredError();

      const { baseUrl, timeoutMs } = getConfig();
      const limit = params.limit ?? 50;
      const includeParams = params.include_params ?? false;

      // Build query string
      const qs = new URLSearchParams();
      if (params.query) qs.set("search", params.query);
      if (params.toolkit) qs.set("appName", params.toolkit);
      qs.set("limit", String(limit));
      if (includeParams) qs.set("showSchema", "true");

      const url = `${baseUrl}/actions?${qs.toString()}`;
      sdk.log.debug(`composio_search_tools: GET ${url.replace(apiKey, "[REDACTED]")}`);

      try {
        const response = await fetchWithRetry({
          url,
          method: "GET",
          headers: buildHeaders(apiKey),
          timeoutMs,
          log: sdk.log,
        });

        if (response.status !== 200) {
          sdk.log.debug(`composio_search_tools: HTTP ${response.status}`);
          return {
            success: false,
            error: `Composio API returned HTTP ${response.status}. Please check your API key and try again.`,
          };
        }

        const rawData = response.data;
        const items = rawData?.items ?? rawData?.actions ?? rawData?.data ?? [];

        const tools = Array.isArray(items)
          ? items.map((item) => {
              const tool = {
                name: item.name ?? item.slug ?? item.id,
                slug: item.name ?? item.slug ?? item.id,
                description: item.description ?? "",
                toolkit: item.appKey ?? item.app ?? item.toolkit ?? "",
                auth_required: item.requiresAuth ?? item.auth_required ?? false,
                tags: item.tags ?? [],
              };
              if (includeParams) {
                tool.parameters_schema = item.parameters ?? item.schema ?? null;
              }
              return tool;
            })
          : [];

        sdk.log.info(`composio_search_tools: found ${tools.length} tools`);

        return {
          success: true,
          data: {
            tools,
            count: tools.length,
            query: params.query ?? null,
            toolkit: params.toolkit ?? null,
            total_available: rawData?.totalItems ?? rawData?.total ?? null,
          },
        };
      } catch (err) {
        sdk.log.debug(`composio_search_tools: error — ${formatApiError(err)}`);
        return { success: false, error: `Search failed: ${formatApiError(err)}` };
      }
    },
  };

  // -------------------------------------------------------------------------
  // Tool 2: composio_execute_tool
  // -------------------------------------------------------------------------

  const composioExecuteTool = {
    name: "composio_execute_tool",
    description:
      "Execute a single Composio tool by its slug (e.g. 'github_create_issue'). " +
      "If the service is not authorized, returns a structured auth error with a connect_url. " +
      "Use composio_search_tools first to discover available tool slugs.",
    category: "action",
    scope: "dm-only",

    parameters: {
      type: "object",
      properties: {
        tool_slug: {
          type: "string",
          description:
            "Composio tool identifier (e.g. 'github_create_issue', 'gmail_send_email')",
        },
        parameters: {
          type: "object",
          description: "Tool-specific parameters as a JSON object",
        },
        connected_account_id: {
          type: "string",
          description:
            "Optional: specific connected account ID when the user has multiple connections for the same service",
        },
        timeout_override_ms: {
          type: "integer",
          description:
            "Override the default timeout in milliseconds for this specific execution",
          minimum: 1000,
          maximum: 300000,
        },
      },
      required: ["tool_slug", "parameters"],
    },

    execute: async (params, context) => {
      const apiKey = getApiKey();
      if (!apiKey) return notConfiguredError();

      const { baseUrl, timeoutMs } = getConfig();

      if (!params.tool_slug || typeof params.tool_slug !== "string") {
        return { success: false, error: "tool_slug is required and must be a string" };
      }
      if (!params.parameters || typeof params.parameters !== "object") {
        return { success: false, error: "parameters is required and must be an object" };
      }

      const effectiveTimeout = params.timeout_override_ms ?? timeoutMs;
      const url = `${baseUrl}/actions/${encodeURIComponent(params.tool_slug)}/execute`;

      sdk.log.debug(`composio_execute_tool: POST ${params.tool_slug} (timeout=${effectiveTimeout}ms)`);

      const body = {
        input: params.parameters,
      };
      if (params.connected_account_id) {
        body.connectedAccountId = params.connected_account_id;
      }
      if (context?.chatId) {
        body.entityId = String(context.chatId);
      }

      try {
        const response = await fetchWithRetry({
          url,
          method: "POST",
          headers: buildHeaders(apiKey),
          body,
          timeoutMs: effectiveTimeout,
          log: sdk.log,
        });

        if (isAuthError(response)) {
          const service = extractServiceFromSlug(params.tool_slug);
          const connectUrl = buildConnectUrl(baseUrl, apiKey, service, context);
          sdk.log.info(`composio_execute_tool: auth required for ${service}`);
          return {
            success: false,
            error: "auth_required",
            auth: {
              service,
              connect_url: connectUrl,
              message: `Authorization required for ${service.toUpperCase()}. Click the link to connect.`,
            },
          };
        }

        if (response.status !== 200) {
          const errMsg =
            response.data?.message ??
            response.data?.error ??
            `HTTP ${response.status}`;
          sdk.log.debug(`composio_execute_tool: error response ${response.status}`);
          return { success: false, error: `Tool execution failed: ${errMsg}` };
        }

        sdk.log.info(`composio_execute_tool: ${params.tool_slug} succeeded`);
        return {
          success: true,
          data: response.data?.response ?? response.data?.data ?? response.data,
        };
      } catch (err) {
        sdk.log.debug(`composio_execute_tool: exception — ${formatApiError(err)}`);
        return { success: false, error: `Execution failed: ${formatApiError(err)}` };
      }
    },
  };

  // -------------------------------------------------------------------------
  // Tool 3: composio_multi_execute
  // -------------------------------------------------------------------------

  const composioMultiExecute = {
    name: "composio_multi_execute",
    description:
      "Execute multiple Composio tools in parallel. " +
      "Returns results in the same order as the input executions array. " +
      "Use fail_fast=true to stop on the first error. " +
      "Results include individual success/error status for each tool.",
    category: "action",
    scope: "dm-only",

    parameters: {
      type: "object",
      properties: {
        executions: {
          type: "array",
          description: "Array of tool executions to perform",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              tool_slug: {
                type: "string",
                description: "Composio tool identifier",
              },
              parameters: {
                type: "object",
                description: "Tool-specific parameters",
              },
              timeout_override_ms: {
                type: "integer",
                description: "Per-tool timeout override in milliseconds",
                minimum: 1000,
                maximum: 300000,
              },
            },
            required: ["tool_slug", "parameters"],
          },
        },
        fail_fast: {
          type: "boolean",
          description:
            "When true, stop executing remaining tools after the first failure. Default: false.",
        },
        max_parallel: {
          type: "integer",
          description: "Maximum number of tools to execute concurrently (1–50, default: 10)",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["executions"],
    },

    execute: async (params, context) => {
      const apiKey = getApiKey();
      if (!apiKey) return notConfiguredError();

      const { baseUrl, timeoutMs, maxParallelExecutions } = getConfig();
      const failFast = params.fail_fast ?? false;
      const maxParallel = Math.min(
        params.max_parallel ?? maxParallelExecutions,
        50
      );

      if (!Array.isArray(params.executions) || params.executions.length === 0) {
        return { success: false, error: "executions must be a non-empty array" };
      }

      for (let i = 0; i < params.executions.length; i++) {
        const exec = params.executions[i];
        if (!exec.tool_slug || typeof exec.tool_slug !== "string") {
          return {
            success: false,
            error: `executions[${i}].tool_slug is required and must be a string`,
          };
        }
        if (!exec.parameters || typeof exec.parameters !== "object") {
          return {
            success: false,
            error: `executions[${i}].parameters is required and must be an object`,
          };
        }
      }

      sdk.log.info(
        `composio_multi_execute: ${params.executions.length} tools, maxParallel=${maxParallel}, failFast=${failFast}`
      );

      const results = new Array(params.executions.length).fill(null);
      let stopped = false;

      // Execute in batches of maxParallel
      for (let batchStart = 0; batchStart < params.executions.length; batchStart += maxParallel) {
        if (stopped) break;

        const batchEnd = Math.min(batchStart + maxParallel, params.executions.length);
        const batch = params.executions.slice(batchStart, batchEnd);

        const batchPromises = batch.map(async (exec, batchIdx) => {
          const globalIdx = batchStart + batchIdx;
          if (stopped) {
            results[globalIdx] = { tool_slug: exec.tool_slug, skipped: true };
            return;
          }

          const effectiveTimeout = exec.timeout_override_ms ?? timeoutMs;
          const url = `${baseUrl}/actions/${encodeURIComponent(exec.tool_slug)}/execute`;

          const body = {
            input: exec.parameters,
          };
          if (context?.chatId) {
            body.entityId = String(context.chatId);
          }

          try {
            const response = await fetchWithRetry({
              url,
              method: "POST",
              headers: buildHeaders(apiKey),
              body,
              timeoutMs: effectiveTimeout,
              log: sdk.log,
            });

            if (isAuthError(response)) {
              const service = extractServiceFromSlug(exec.tool_slug);
              const connectUrl = buildConnectUrl(baseUrl, apiKey, service, context);
              const result = {
                tool_slug: exec.tool_slug,
                success: false,
                error: "auth_required",
                auth: {
                  service,
                  connect_url: connectUrl,
                  message: `Authorization required for ${service.toUpperCase()}.`,
                },
              };
              results[globalIdx] = result;
              if (failFast) stopped = true;
              return;
            }

            if (response.status !== 200) {
              const errMsg =
                response.data?.message ??
                response.data?.error ??
                `HTTP ${response.status}`;
              results[globalIdx] = {
                tool_slug: exec.tool_slug,
                success: false,
                error: errMsg,
              };
              if (failFast) stopped = true;
              return;
            }

            results[globalIdx] = {
              tool_slug: exec.tool_slug,
              success: true,
              data: response.data?.response ?? response.data?.data ?? response.data,
            };
          } catch (err) {
            results[globalIdx] = {
              tool_slug: exec.tool_slug,
              success: false,
              error: formatApiError(err),
            };
            if (failFast) stopped = true;
          }
        });

        await Promise.all(batchPromises);
      }

      const succeeded = results.filter((r) => r?.success === true).length;
      const failed = results.filter((r) => r?.success === false && !r?.skipped).length;
      const skipped = results.filter((r) => r === null || r?.skipped === true).length;

      sdk.log.info(
        `composio_multi_execute: done — ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`
      );

      return {
        success: true,
        data: {
          results,
          summary: { succeeded, failed, skipped, total: params.executions.length },
        },
      };
    },
  };

  // -------------------------------------------------------------------------
  // Tool 4: composio_auth_link
  // -------------------------------------------------------------------------

  const composioAuthLink = {
    name: "composio_auth_link",
    description:
      "Get an OAuth authorization link for a Composio-supported service. " +
      "Use this when a tool execution returns auth_required, or when the user asks to connect a service. " +
      "Supported services: github, gmail, slack, notion, linear, jira, and many more.",
    category: "data-bearing",

    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            "Service to authorize (e.g. 'github', 'gmail', 'slack', 'notion', 'linear', 'jira')",
        },
        redirect_after_auth: {
          type: "string",
          description:
            "Optional message to show the user after they complete authorization",
        },
      },
      required: ["service"],
    },

    execute: async (params, context) => {
      const apiKey = getApiKey();
      if (!apiKey) return notConfiguredError();

      const { baseUrl, timeoutMs } = getConfig();

      if (!params.service || typeof params.service !== "string") {
        return { success: false, error: "service is required and must be a string" };
      }

      const service = params.service.toLowerCase().trim();
      sdk.log.debug(`composio_auth_link: generating link for ${service}`);

      const connectUrl = buildConnectUrl(baseUrl, apiKey, service, context);

      // Attempt to get a fresh connection initiation URL from the API
      let finalUrl = connectUrl;
      try {
        const qs = new URLSearchParams();
        if (context?.chatId) qs.set("entityId", String(context.chatId));
        qs.set("redirectUri", "https://app.composio.dev/");

        const url = `${baseUrl}/auth/${encodeURIComponent(service)}/initiate?${qs.toString()}`;
        const response = await fetchWithRetry({
          url,
          method: "GET",
          headers: buildHeaders(apiKey),
          timeoutMs,
          log: sdk.log,
        });

        if (response.status === 200 && response.data?.redirectUrl) {
          finalUrl = response.data.redirectUrl;
        } else if (response.status === 200 && response.data?.url) {
          finalUrl = response.data.url;
        }
      } catch {
        // Fall back to the static connect URL
        sdk.log.debug(`composio_auth_link: failed to get dynamic URL, using static fallback`);
      }

      const serviceUpper = service.toUpperCase();
      const afterMsg =
        params.redirect_after_auth ??
        "After authorizing, write 'done' and repeat your request.";

      sdk.log.info(`composio_auth_link: returning link for ${service}`);

      return {
        success: true,
        data: {
          message: `🔗 Click to connect **${serviceUpper}**:`,
          url: finalUrl,
          service,
          hint: afterMsg,
        },
      };
    },
  };

  return [composioSearchTools, composioExecuteTool, composioMultiExecute, composioAuthLink];
};

// ---------------------------------------------------------------------------
// Internal utility — build a Composio connect URL for a service.
// Not exported; used only within this module.
// ---------------------------------------------------------------------------

/**
 * Build a Composio OAuth connect URL.
 * @param {string} baseUrl
 * @param {string} _apiKey - kept for signature consistency, not included in URL
 * @param {string} service
 * @param {{ chatId?: string | number } | undefined} context
 * @returns {string}
 */
function buildConnectUrl(baseUrl, _apiKey, service, context) {
  const appBase = baseUrl.replace(/\/api\/v\d+.*$/, "").replace("api.", "app.");
  const qs = new URLSearchParams({ app: service });
  if (context?.chatId) qs.set("user_id", String(context.chatId));
  return `${appBase}/connect?${qs.toString()}`;
}
