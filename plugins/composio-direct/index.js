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
 *   - Set COMPOSIO_DIRECT_COMPOSIO_API_KEY, COMPOSIO_API_KEY, or use the secrets store
 *
 * SDK integration:
 *   - Uses the official @composio/core npm SDK if it is available
 *   - Uses direct HTTP calls against Composio v3.1 when the SDK is unavailable
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
// @composio/core SDK — lazy-loaded from plugin-local node_modules.
// We use a dynamic import so the plugin degrades gracefully if the SDK is
// not yet installed (first boot before npm ci completes).
// ---------------------------------------------------------------------------

/** @type {typeof import("@composio/core").Composio | null} */
let ComposioClass = null;
let sdkLoadAttempted = false;

/**
 * Try to load the @composio/core SDK once.
 * Returns the Composio constructor, or null if unavailable.
 * @returns {Promise<typeof import("@composio/core").Composio | null>}
 */
async function loadComposioSdk() {
  if (sdkLoadAttempted) return ComposioClass;
  sdkLoadAttempted = true;
  try {
    const mod = await import("@composio/core");
    ComposioClass = mod.Composio;
  } catch {
    // SDK not installed — will fall back to direct HTTP
    ComposioClass = null;
  }
  return ComposioClass;
}

/**
 * Cache of Composio SDK instances keyed by API key.
 * @type {Map<string, import("@composio/core").Composio>}
 */
const composioSdkCache = new Map();

const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3.1";
const DEFAULT_TOOL_VERSION = "latest";
const DEFAULT_TOOLKIT_VERSIONS = "latest";

/**
 * Get (or create) a Composio SDK instance for the given API key.
 * Returns null if the SDK is unavailable.
 *
 * @param {string} apiKey
 * @returns {Promise<import("@composio/core").Composio | null>}
 */
async function getComposioSdk(apiKey) {
  const Cls = await loadComposioSdk();
  if (!Cls) return null;
  if (composioSdkCache.has(apiKey)) return composioSdkCache.get(apiKey);
  const instance = new Cls({ apiKey, allowTracking: false });
  composioSdkCache.set(apiKey, instance);
  return instance;
}

// ---------------------------------------------------------------------------
// Inline manifest — read by the Teleton runtime for SDK version gating,
// defaultConfig merging, and secrets registration.
// ---------------------------------------------------------------------------

export const manifest = {
  name: "composio-direct",
  version: "1.2.0",
  sdkVersion: ">=1.0.0",
  description:
    "Direct access to 1000+ Composio automation tools — search, execute, batch-run, and authorize services like GitHub, Gmail, Slack, Notion, Jira, Linear without MCP transport",
  secrets: {
    composio_api_key: {
      required: true,
      env: "COMPOSIO_DIRECT_COMPOSIO_API_KEY",
      description: "Composio API key (create at https://app.composio.dev/settings)",
    },
  },
  defaultConfig: {
    base_url: DEFAULT_BASE_URL,
    timeout_ms: 30000,
    max_parallel_executions: 10,
    tool_version: DEFAULT_TOOL_VERSION,
    toolkit_versions: DEFAULT_TOOLKIT_VERSIONS,
    auth_config_ids: {},
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
  const msg = getComposioMessage(response.data).toLowerCase();
  if (msg) {
    return (
      msg.includes("auth") ||
      msg.includes("connect") ||
      msg.includes("connection") ||
      msg.includes("not connected") ||
      msg.includes("no active account") ||
      msg.includes("no connected account")
    );
  }
  return false;
}

/**
 * Extract service name from a Composio tool slug (e.g. "github_create_issue" → "github").
 * @param {string} toolSlug
 * @returns {string}
 */
function extractServiceFromSlug(toolSlug) {
  return String(toolSlug).split("_")[0]?.toLowerCase() ?? String(toolSlug).toLowerCase();
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} toolSlug
 * @returns {string}
 */
function normalizeToolSlug(toolSlug) {
  return String(toolSlug).trim().toUpperCase();
}

/**
 * @param {string} toolkit
 * @returns {string}
 */
function normalizeToolkitSlug(toolkit) {
  return String(toolkit).trim().toLowerCase();
}

/**
 * Resolve a stable Composio user id from Teleton tool context.
 * Prefer senderId so connected accounts are per-user, not per-chat.
 * @param {unknown} context
 * @returns {string}
 */
function getUserId(context) {
  if (isRecord(context)) {
    const senderId = context.senderId ?? context.userId ?? context.chatId;
    if (senderId !== undefined && senderId !== null && senderId !== "") {
      return String(senderId);
    }
  }
  return "teleton";
}

/**
 * Extract a useful error message from Composio response shapes.
 * @param {unknown} data
 * @returns {string}
 */
function getComposioMessage(data) {
  if (!isRecord(data)) return typeof data === "string" ? data : "";

  if (typeof data.message === "string") return data.message;
  if (typeof data.error === "string") return data.error;

  if (isRecord(data.error)) {
    const err = data.error;
    const message = [err.message, err.suggested_fix]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join(" ");
    if (message) return message;
    if (typeof err.slug === "string") return err.slug;
  }

  return "";
}

/**
 * Convert Composio API/SDK tool objects into compact LLM-visible results.
 * @param {Record<string, unknown>} item
 * @param {boolean} includeParams
 * @returns {Record<string, unknown>}
 */
function formatTool(item, includeParams) {
  const toolkit = isRecord(item.toolkit)
    ? (item.toolkit.slug ?? item.toolkit.name ?? "")
    : (item.toolkit_slug ?? item.toolkit ?? item.appKey ?? item.app ?? "");
  const slug = item.slug ?? item.name ?? item.id;
  const authRequired =
    item.no_auth === true
      ? false
      : (item.requiresAuth ?? item.auth_required ?? item.authRequired ?? true);

  const tool = {
    name: slug,
    slug,
    display_name: item.name ?? slug,
    description: item.description ?? item.human_description ?? "",
    toolkit,
    auth_required: Boolean(authRequired),
    version: item.version ?? null,
    tags: item.tags ?? [],
  };

  if (includeParams) {
    tool.parameters_schema =
      item.input_parameters ??
      item.inputParameters ??
      item.parameters ??
      item.schema ??
      null;
    tool.output_schema =
      item.output_parameters ??
      item.outputParameters ??
      null;
  }

  return tool;
}

/**
 * Preserve Composio's data payload while carrying useful metadata.
 * @param {unknown} data
 * @returns {unknown}
 */
function formatExecutionData(data) {
  if (!isRecord(data)) return data;

  const payload = data.data ?? data.response ?? data.result ?? data;
  const meta = {};
  if (data.log_id) meta.log_id = data.log_id;
  if (data.session_info) meta.session_info = data.session_info;

  if (isRecord(payload)) {
    return Object.keys(meta).length > 0 ? { ...payload, ...meta } : payload;
  }
  return Object.keys(meta).length > 0 ? { result: payload, ...meta } : payload;
}

// ---------------------------------------------------------------------------
// SDK export — Teleton runtime calls tools(sdk) and uses the returned array
// ---------------------------------------------------------------------------

export const tools = (sdk) => {
  /**
   * Get plugin configuration with defaults.
   */
  function getConfig() {
    const legacyConfig = isRecord(sdk.config) ? sdk.config : {};
    const pluginConfig = isRecord(sdk.pluginConfig) ? sdk.pluginConfig : {};
    const cfg = { ...legacyConfig, ...pluginConfig };
    return {
      baseUrl: String(cfg.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      timeoutMs: Number(cfg.timeout_ms ?? 30000),
      maxParallelExecutions: Number(cfg.max_parallel_executions ?? 10),
      toolVersion: String(cfg.tool_version ?? DEFAULT_TOOL_VERSION),
      toolkitVersions: cfg.toolkit_versions ?? DEFAULT_TOOLKIT_VERSIONS,
      authConfigIds: isRecord(cfg.auth_config_ids) ? cfg.auth_config_ids : {},
    };
  }

  /**
   * Retrieve the API key or return null if not configured.
   * @returns {string | null}
   */
  function getApiKey() {
    const fromSecrets = sdk.secrets?.get?.("composio_api_key");
    if (typeof fromSecrets === "string" && fromSecrets.length > 0) return fromSecrets;
    return (
      process.env.COMPOSIO_DIRECT_COMPOSIO_API_KEY ??
      process.env.COMPOSIO_API_KEY ??
      null
    );
  }

  /**
   * Build a standard "not configured" error response.
   * @returns {{ success: false; error: string }}
   */
  function notConfiguredError() {
    return {
      success: false,
      error:
        "Composio API key is not configured. Please set the composio_api_key secret or COMPOSIO_DIRECT_COMPOSIO_API_KEY with your key from https://app.composio.dev/settings",
    };
  }

  /**
   * Find or create a Composio-managed auth config and return a Connect Link.
   *
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.service
   * @param {string} opts.userId
   * @param {string | undefined} [opts.authConfigId]
   * @param {string | undefined} [opts.callbackUrl]
   * @param {string | undefined} [opts.alias]
   * @returns {Promise<Record<string, unknown>>}
   */
  async function createAuthLink({ apiKey, service, userId, authConfigId, callbackUrl, alias }) {
    const { baseUrl, timeoutMs, authConfigIds } = getConfig();
    const toolkit = normalizeToolkitSlug(service);
    let resolvedAuthConfigId = authConfigId ?? authConfigIds[toolkit];

    if (!resolvedAuthConfigId) {
      const qs = new URLSearchParams({
        toolkit_slug: toolkit,
        is_composio_managed: "true",
        limit: "1",
      });
      const listResponse = await fetchWithRetry({
        url: `${baseUrl}/auth_configs?${qs.toString()}`,
        method: "GET",
        headers: buildHeaders(apiKey),
        timeoutMs,
        log: sdk.log,
      });

      if (listResponse.status === 200) {
        const items = Array.isArray(listResponse.data?.items) ? listResponse.data.items : [];
        resolvedAuthConfigId = items[0]?.id ?? items[0]?.auth_config?.id;
      }
    }

    if (!resolvedAuthConfigId) {
      const createResponse = await fetchWithRetry({
        url: `${baseUrl}/auth_configs`,
        method: "POST",
        headers: buildHeaders(apiKey),
        body: {
          toolkit: { slug: toolkit },
          auth_config: {
            type: "use_composio_managed_auth",
            credentials: {},
            restrict_to_following_tools: [],
          },
        },
        timeoutMs,
        log: sdk.log,
      });

      if (createResponse.status !== 201 && createResponse.status !== 200) {
        throw new Error(
          getComposioMessage(createResponse.data) ||
            `Could not create auth config for ${toolkit}: HTTP ${createResponse.status}`
        );
      }

      resolvedAuthConfigId = createResponse.data?.auth_config?.id ?? createResponse.data?.id;
    }

    if (!resolvedAuthConfigId) {
      throw new Error(`Composio did not return an auth config id for ${toolkit}`);
    }

    const linkBody = {
      auth_config_id: resolvedAuthConfigId,
      user_id: userId,
    };
    if (callbackUrl) linkBody.callback_url = callbackUrl;
    if (alias) linkBody.alias = alias;

    const linkResponse = await fetchWithRetry({
      url: `${baseUrl}/connected_accounts/link`,
      method: "POST",
      headers: buildHeaders(apiKey),
      body: linkBody,
      timeoutMs,
      log: sdk.log,
    });

    if (linkResponse.status !== 201 && linkResponse.status !== 200) {
      throw new Error(
        getComposioMessage(linkResponse.data) ||
          `Could not create connection link for ${toolkit}: HTTP ${linkResponse.status}`
      );
    }

    return {
      url: linkResponse.data?.redirect_url ?? linkResponse.data?.redirectUrl,
      service: toolkit,
      auth_config_id: resolvedAuthConfigId,
      connected_account_id: linkResponse.data?.connected_account_id ?? null,
      expires_at: linkResponse.data?.expires_at ?? null,
      link_token: linkResponse.data?.link_token ?? null,
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

      const { baseUrl, timeoutMs, toolkitVersions } = getConfig();
      const limit = params.limit ?? 50;
      const includeParams = params.include_params ?? false;

      // --- Try SDK path first ---
      const composioSdk = await getComposioSdk(apiKey);
      if (composioSdk) {
        sdk.log.debug(`composio_search_tools: using @composio/core SDK`);
        try {
          const query = {};
          if (params.query) query.search = params.query;
          if (params.toolkit) query.toolkits = [normalizeToolkitSlug(params.toolkit)];
          query.limit = limit;
          if (toolkitVersions) query.toolkitVersions = toolkitVersions;

          const toolList = await composioSdk.tools.getRawComposioTools(query);
          const items = Array.isArray(toolList?.items) ? toolList.items : [];
          const tools = items.map((item) => formatTool(item, includeParams));

          sdk.log.info(`composio_search_tools: found ${tools.length} tools (SDK)`);
          return {
            success: true,
            data: {
              tools,
              count: tools.length,
              query: params.query ?? null,
              toolkit: params.toolkit ?? null,
              total_available: toolList?.total ?? tools.length,
            },
          };
        } catch (err) {
          sdk.log.debug(`composio_search_tools: SDK error — ${formatApiError(err)}, falling back to HTTP`);
          // fall through to HTTP path
        }
      }

      // --- HTTP fallback path ---
      const qs = new URLSearchParams();
      if (params.query) qs.set("query", params.query);
      if (params.toolkit) qs.set("toolkit_slug", normalizeToolkitSlug(params.toolkit));
      qs.set("limit", String(limit));
      qs.set("include_deprecated", "false");
      if (toolkitVersions) qs.set("toolkit_versions", String(toolkitVersions));

      const url = `${baseUrl}/tools?${qs.toString()}`;
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
          ? items.map((item) => formatTool(item, includeParams))
          : [];

        sdk.log.info(`composio_search_tools: found ${tools.length} tools`);

        return {
          success: true,
          data: {
            tools,
            count: tools.length,
            query: params.query ?? null,
            toolkit: params.toolkit ?? null,
            total_available: rawData?.total_items ?? rawData?.totalItems ?? rawData?.total ?? null,
            next_cursor: rawData?.next_cursor ?? null,
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
        version: {
          type: "string",
          description:
            "Optional Composio tool version. Defaults to plugin config tool_version (latest).",
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

      const { baseUrl, timeoutMs, toolVersion } = getConfig();

      if (!params.tool_slug || typeof params.tool_slug !== "string") {
        return { success: false, error: "tool_slug is required and must be a string" };
      }
      if (!params.parameters || typeof params.parameters !== "object") {
        return { success: false, error: "parameters is required and must be an object" };
      }

      const normalizedSlug = normalizeToolSlug(params.tool_slug);
      const userId = getUserId(context);

      sdk.log.debug(`composio_execute_tool: ${normalizedSlug}`);

      // --- Try SDK path first ---
      const composioSdk = await getComposioSdk(apiKey);
      if (composioSdk) {
        sdk.log.debug(`composio_execute_tool: using @composio/core SDK`);
        try {
          const execBody = {
            userId,
            arguments: params.parameters,
            dangerouslySkipVersionCheck: true,
          };
          if (params.version ?? toolVersion) {
            execBody.version = params.version ?? toolVersion;
          }
          if (params.connected_account_id) {
            execBody.connectedAccountId = params.connected_account_id;
          }

          const result = await composioSdk.tools.execute(
            normalizedSlug,
            execBody
          );

          sdk.log.info(`composio_execute_tool: ${params.tool_slug} succeeded (SDK)`);
          return {
            success: true,
            data: result?.data ?? result,
          };
        } catch (err) {
          const errMsg = formatApiError(err);
          // Detect auth errors from SDK exceptions
          if (err?.status === 401 || err?.status === 403 ||
              errMsg.toLowerCase().includes("auth") ||
              errMsg.toLowerCase().includes("connect") ||
              errMsg.toLowerCase().includes("not connected")) {
            const service = extractServiceFromSlug(params.tool_slug);
            const connectUrl = buildConnectUrl(baseUrl, apiKey, service, context);
            sdk.log.info(`composio_execute_tool: auth required for ${service} (SDK)`);
            return {
              success: false,
              error: "auth_required",
              auth: {
                service,
                connect_url: connectUrl,
                message: `Authorization required for ${service.toUpperCase()}. Call composio_auth_link for a fresh connection link.`,
              },
            };
          }
          sdk.log.debug(`composio_execute_tool: SDK error — ${errMsg}, falling back to HTTP`);
          // fall through to HTTP path
        }
      }

      // --- HTTP fallback path ---
      const effectiveTimeout = params.timeout_override_ms ?? timeoutMs;
      const url = `${baseUrl}/tools/execute/${encodeURIComponent(normalizedSlug)}`;

      sdk.log.debug(`composio_execute_tool: POST ${normalizedSlug} via HTTP (timeout=${effectiveTimeout}ms)`);

      const body = {
        user_id: userId,
        arguments: params.parameters,
        version: params.version ?? toolVersion,
      };
      if (params.connected_account_id) {
        body.connected_account_id = params.connected_account_id;
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
              message: `Authorization required for ${service.toUpperCase()}. Call composio_auth_link for a fresh connection link.`,
            },
          };
        }

        if (response.status !== 200) {
          const errMsg =
            getComposioMessage(response.data) ||
            `HTTP ${response.status}`;
          sdk.log.debug(`composio_execute_tool: error response ${response.status}`);
          return { success: false, error: `Tool execution failed: ${errMsg}` };
        }

        if (response.data?.successful === false) {
          const errMsg = getComposioMessage(response.data) || "Composio tool returned unsuccessful=false";
          return { success: false, error: `Tool execution failed: ${errMsg}` };
        }

        sdk.log.info(`composio_execute_tool: ${normalizedSlug} succeeded`);
        return {
          success: true,
          data: formatExecutionData(response.data),
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
              connected_account_id: {
                type: "string",
                description: "Optional connected account ID for this execution",
              },
              version: {
                type: "string",
                description: "Optional Composio tool version for this execution",
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

      const { baseUrl, timeoutMs, maxParallelExecutions, toolVersion } = getConfig();
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

        const composioSdk = await getComposioSdk(apiKey);

        const batchPromises = batch.map(async (exec, batchIdx) => {
          const globalIdx = batchStart + batchIdx;
          if (stopped) {
            results[globalIdx] = { tool_slug: exec.tool_slug, skipped: true };
            return;
          }

          // --- Try SDK path first ---
          if (composioSdk) {
            try {
              const normalizedSlug = normalizeToolSlug(exec.tool_slug);
              const execBody = {
                userId: getUserId(context),
                arguments: exec.parameters,
                dangerouslySkipVersionCheck: true,
                version: exec.version ?? toolVersion,
              };
              if (exec.connected_account_id) {
                execBody.connectedAccountId = exec.connected_account_id;
              }

              const result = await composioSdk.tools.execute(
                normalizedSlug,
                execBody
              );

              results[globalIdx] = {
                tool_slug: normalizedSlug,
                success: true,
                data: result?.data ?? result,
              };
              return;
            } catch (err) {
              const errMsg = formatApiError(err);
              const isAuthErr = err?.status === 401 || err?.status === 403 ||
                errMsg.toLowerCase().includes("auth") ||
                errMsg.toLowerCase().includes("connect") ||
                errMsg.toLowerCase().includes("not connected");

              if (isAuthErr) {
                const service = extractServiceFromSlug(exec.tool_slug);
                const connectUrl = buildConnectUrl(baseUrl, apiKey, service, context);
                results[globalIdx] = {
                  tool_slug: normalizeToolSlug(exec.tool_slug),
                  success: false,
                  error: "auth_required",
                  auth: {
                    service,
                    connect_url: connectUrl,
                    message: `Authorization required for ${service.toUpperCase()}. Call composio_auth_link for a fresh connection link.`,
                  },
                };
                if (failFast) stopped = true;
                return;
              }
              sdk.log.debug(`composio_multi_execute: SDK error for ${exec.tool_slug} — ${errMsg}, falling back to HTTP`);
              // fall through to HTTP path
            }
          }

          // --- HTTP fallback path ---
          const normalizedSlug = normalizeToolSlug(exec.tool_slug);
          const effectiveTimeout = exec.timeout_override_ms ?? timeoutMs;
          const url = `${baseUrl}/tools/execute/${encodeURIComponent(normalizedSlug)}`;

          const body = {
            user_id: getUserId(context),
            arguments: exec.parameters,
            version: exec.version ?? toolVersion,
          };
          if (exec.connected_account_id) {
            body.connected_account_id = exec.connected_account_id;
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
                tool_slug: normalizedSlug,
                success: false,
                error: "auth_required",
                auth: {
                  service,
                  connect_url: connectUrl,
                  message: `Authorization required for ${service.toUpperCase()}. Call composio_auth_link for a fresh connection link.`,
                },
              };
              results[globalIdx] = result;
              if (failFast) stopped = true;
              return;
            }

            if (response.status !== 200) {
              const errMsg = getComposioMessage(response.data) || `HTTP ${response.status}`;
              results[globalIdx] = {
                tool_slug: normalizedSlug,
                success: false,
                error: errMsg,
              };
              if (failFast) stopped = true;
              return;
            }

            if (response.data?.successful === false) {
              results[globalIdx] = {
                tool_slug: normalizedSlug,
                success: false,
                error: getComposioMessage(response.data) || "Composio tool returned unsuccessful=false",
              };
              if (failFast) stopped = true;
              return;
            }

            results[globalIdx] = {
              tool_slug: normalizedSlug,
              success: true,
              data: formatExecutionData(response.data),
            };
          } catch (err) {
            results[globalIdx] = {
              tool_slug: normalizeToolSlug(exec.tool_slug),
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
        auth_config_id: {
          type: "string",
          description:
            "Optional Composio auth config ID. If omitted, the plugin finds or creates a Composio-managed auth config for the service.",
        },
        callback_url: {
          type: "string",
          description:
            "Optional URL Composio should redirect the user to after authentication.",
        },
        alias: {
          type: "string",
          description: "Optional human-readable alias for this connected account.",
        },
      },
      required: ["service"],
    },

    execute: async (params, context) => {
      const apiKey = getApiKey();
      if (!apiKey) return notConfiguredError();

      if (!params.service || typeof params.service !== "string") {
        return { success: false, error: "service is required and must be a string" };
      }

      const service = normalizeToolkitSlug(params.service);
      const userId = getUserId(context);
      sdk.log.debug(`composio_auth_link: generating link for ${service}`);

      let link;
      try {
        const composioSdk = await getComposioSdk(apiKey);
        if (composioSdk?.toolkits?.authorize) {
          const request = await composioSdk.toolkits.authorize(
            userId,
            service,
            params.auth_config_id
          );
          link = {
            url: request.redirectUrl ?? request.redirect_url,
            service,
            auth_config_id: request.authConfigId ?? request.auth_config_id ?? params.auth_config_id ?? null,
            connected_account_id: request.connectedAccountId ?? request.connected_account_id ?? null,
            expires_at: request.expiresAt ?? request.expires_at ?? null,
            link_token: request.linkToken ?? request.link_token ?? null,
          };
        }
      } catch (err) {
        sdk.log.debug(`composio_auth_link: SDK authorize failed — ${formatApiError(err)}, falling back to HTTP`);
      }

      if (!link?.url) {
        try {
          link = await createAuthLink({
            apiKey,
            service,
            userId,
            authConfigId: params.auth_config_id,
            callbackUrl: params.callback_url,
            alias: params.alias,
          });
        } catch (err) {
          sdk.log.debug(`composio_auth_link: HTTP authorize failed — ${formatApiError(err)}`);
          return {
            success: false,
            error: `Could not create Composio auth link for ${service}: ${formatApiError(err)}`,
            data: {
              service,
              user_id: userId,
              hint:
                "Create or verify a Composio auth config for this toolkit, then retry with auth_config_id if needed.",
            },
          };
        }
      }

      if (!link?.url) {
        return {
          success: false,
          error: `Composio did not return a connect URL for ${service}`,
          data: {
            service,
            user_id: userId,
          },
        };
      }

      const serviceUpper = service.toUpperCase();
      const afterMsg =
        params.redirect_after_auth ??
        "After authorizing, write 'done' and repeat your request.";

      sdk.log.info(`composio_auth_link: returning link for ${service}`);

      return {
        success: true,
        data: {
          message: `Click to connect ${serviceUpper}:`,
          url: link.url,
          service,
          user_id: userId,
          auth_config_id: link.auth_config_id ?? null,
          connected_account_id: link.connected_account_id ?? null,
          expires_at: link.expires_at ?? null,
          hint: afterMsg,
        },
      };
    },
  };

  return [composioSearchTools, composioExecuteTool, composioMultiExecute, composioAuthLink];
};

// ---------------------------------------------------------------------------
// Internal utility — build a Composio connect URL for a service.
// Used only as a last-resort hint when a tool execution reports auth_required.
// ---------------------------------------------------------------------------

/**
 * Build a Composio OAuth connect URL hint.
 * @param {string} baseUrl
 * @param {string} _apiKey - kept for signature consistency, not included in URL
 * @param {string} service
 * @param {unknown} context
 * @returns {string}
 */
function buildConnectUrl(baseUrl, _apiKey, service, context) {
  const appBase = baseUrl.replace(/\/api\/v\d+(?:\.\d+)?$/, "").replace("backend.", "app.");
  const qs = new URLSearchParams({ app: service });
  if (isRecord(context)) {
    const userId = getUserId(context);
    if (userId) qs.set("user_id", userId);
  }
  return `${appBase}/connect?${qs.toString()}`;
}
