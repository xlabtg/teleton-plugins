/**
 * composio-direct — Direct Integration with 1000+ Composio Tools
 *
 * Provides 7 tools for direct Composio API access:
 *   composio_search_tools   — search tools by query or toolkit
 *   composio_get_tool_schemas — fetch input/output schemas by tool slug
 *   composio_execute_tool   — execute a single tool
 *   composio_multi_execute  — batch-execute multiple tools in parallel
 *   composio_auth_link      — get OAuth authorization links
 *   composio_list_connections — list current-user connected accounts
 *   composio_get_connection — fetch one connected account by id
 *
 * Authentication:
 *   - Requires a Composio API key stored in sdk.secrets as "composio_api_key"
 *   - Set COMPOSIO_DIRECT_COMPOSIO_API_KEY, COMPOSIO_API_KEY, or use the secrets store
 *
 * SDK integration:
 *   - Uses the official @composio/core npm SDK if it is available
 *   - Uses direct HTTP calls against Composio v3 when the SDK is unavailable
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

const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3";
const DEFAULT_TOOL_VERSION = "latest";
const DEFAULT_TOOLKIT_VERSIONS = "latest";
const COMPOSIO_MANAGED_AUTH_UNAVAILABLE_PATTERN =
  /default auth config not found|does not have managed credentials|managed auth/i;
const COMPOSIO_EXECUTION_GUIDANCE = {
  tool: "composio_execute_tool",
  tool_slug_param: "tool_slug",
  parameters_param: "parameters",
  instruction:
    "Do not call returned tool_slug values directly. To run a Composio result, call composio_execute_tool with { tool_slug, parameters }.",
};

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
  try {
    const instance = new Cls({ apiKey, allowTracking: false });
    composioSdkCache.set(apiKey, instance);
    return instance;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline manifest — read by the Teleton runtime for SDK version gating,
// defaultConfig merging, and secrets registration.
// ---------------------------------------------------------------------------

export const manifest = {
  name: "composio-direct",
  version: "1.7.0",
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
  if (isAuthRequiredPayload(response.data)) return true;
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
 * Detect if a Composio response payload contains an auth_required flag,
 * even when the HTTP status is 200 and successful may be true.
 * @param {unknown} data
 * @returns {boolean}
 */
function isAuthRequiredPayload(data) {
  if (!isRecord(data)) return false;
  if (data.auth_required === true || data.authRequired === true) return true;
  const inner = data.data ?? data.response ?? data.result;
  if (isRecord(inner)) {
    return inner.auth_required === true || inner.authRequired === true;
  }
  return false;
}

/**
 * Extract connect_url from a Composio response payload that signals auth_required.
 * @param {unknown} data
 * @returns {string | null}
 */
function extractConnectUrl(data) {
  if (!isRecord(data)) return null;
  const url = data.connect_url ?? data.connectUrl ?? data.redirect_url ?? data.redirectUrl;
  if (typeof url === "string" && url.length > 0) return url;
  const inner = data.data ?? data.response ?? data.result;
  if (isRecord(inner)) {
    return inner.connect_url ?? inner.connectUrl ?? inner.redirect_url ?? inner.redirectUrl ?? null;
  }
  return null;
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
  const toolSlug = String(slug ?? "");
  const authRequired =
    item.no_auth === true
      ? false
      : (item.requiresAuth ?? item.auth_required ?? item.authRequired ?? true);

  const tool = {
    tool_slug: toolSlug,
    display_name: item.display_name ?? item.name ?? toolSlug,
    description: item.description ?? item.human_description ?? "",
    toolkit,
    auth_required: Boolean(authRequired),
    version: item.version ?? null,
    tags: item.tags ?? [],
    execute_with: {
      tool: COMPOSIO_EXECUTION_GUIDANCE.tool,
      tool_slug: toolSlug,
      parameters_param: COMPOSIO_EXECUTION_GUIDANCE.parameters_param,
    },
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
 * Convert Composio API/SDK tool objects into schema-centric results.
 * @param {Record<string, unknown>} item
 * @param {Set<string>} include
 * @returns {Record<string, unknown>}
 */
function formatToolSchema(item, include) {
  const tool = formatTool(item, true);
  const schema = {
    tool_slug: tool.tool_slug,
    display_name: tool.display_name,
    description: tool.description,
    toolkit: tool.toolkit,
    auth_required: tool.auth_required,
    version: tool.version,
    available_versions: item.available_versions ?? null,
    tags: tool.tags,
    execute_with: tool.execute_with,
  };

  if (include.has("input_schema")) {
    schema.input_schema = tool.parameters_schema;
  }
  if (include.has("output_schema")) {
    schema.output_schema = tool.output_schema;
  }
  if (include.has("metadata")) {
    schema.metadata = {
      human_description: item.human_description ?? null,
      scopes: item.scopes ?? [],
      scope_requirements: item.scope_requirements ?? null,
      is_deprecated: item.is_deprecated ?? item.deprecated?.is_deprecated ?? false,
      deprecated: item.deprecated ?? null,
    };
  }

  return schema;
}

/**
 * Normalize a single value, comma-separated string, or array into strings.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStringArray(value) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Append query parameters as repeated keys, matching Composio's array filters.
 * @param {URLSearchParams} qs
 * @param {string} key
 * @param {string[]} values
 */
function appendArrayParams(qs, key, values) {
  for (const value of values) {
    qs.append(key, value);
  }
}

/**
 * Clamp a numeric limit to a documented API range.
 * @param {unknown} value
 * @param {number} defaultValue
 * @param {number} max
 * @returns {number}
 */
function normalizeLimit(value, defaultValue, max) {
  const num = Number(value ?? defaultValue);
  if (!Number.isFinite(num)) return defaultValue;
  return Math.max(1, Math.min(Math.trunc(num), max));
}

/**
 * Convert Composio connected account payloads into compact, non-secret output.
 * State values can contain credential material, so only key names are exposed.
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function formatConnectedAccount(item) {
  const toolkitRecord = isRecord(item.toolkit) ? item.toolkit : {};
  const authConfigRecord = isRecord(item.auth_config) ? item.auth_config : null;
  const id = item.id ?? item.nanoid ?? item.connected_account_id ?? null;
  const stateKeys = isRecord(item.state) ? Object.keys(item.state).sort() : [];
  const connectionDataKeys = isRecord(item.connection_data)
    ? Object.keys(item.connection_data).sort()
    : [];

  const connection = {
    id,
    word_id: item.word_id ?? null,
    alias: item.alias ?? null,
    user_id: item.user_id ?? null,
    status: item.status ?? null,
    toolkit: {
      slug: toolkitRecord.slug ?? item.toolkit_slug ?? null,
      name: toolkitRecord.name ?? null,
    },
    auth_config: authConfigRecord
      ? {
          id: authConfigRecord.id ?? null,
          auth_scheme: authConfigRecord.auth_scheme ?? null,
          is_composio_managed: authConfigRecord.is_composio_managed ?? null,
          is_disabled: authConfigRecord.is_disabled ?? null,
        }
      : null,
    created_at: item.created_at ?? null,
    updated_at: item.updated_at ?? null,
    state_keys: stateKeys,
    connection_data_keys: connectionDataKeys,
  };

  if (id) {
    connection.execute_with = {
      tool: COMPOSIO_EXECUTION_GUIDANCE.tool,
      connected_account_id: id,
      connected_account_id_param: "connected_account_id",
    };
  }

  return connection;
}

/**
 * Detect whether Composio could not resolve a tool slug.
 * @param {{ status: number; data: unknown }} response
 * @returns {boolean}
 */
function isUnknownToolError(response) {
  const message = getComposioMessage(response.data).toLowerCase();
  if (message.includes("unknown tool")) return true;
  if (message.includes("tool") && message.includes("not found")) return true;
  if (isRecord(response.data) && isRecord(response.data.error)) {
    const slug = String(response.data.error.slug ?? "").toLowerCase();
    if (slug.includes("tool") && (slug.includes("not_found") || slug.includes("unknown"))) {
      return true;
    }
  }
  return false;
}

/**
 * Current Composio docs use /api/v3. Retry the current route when a user still
 * has the old v3.1 base URL configured and that route reports an unknown tool.
 * @param {string} baseUrl
 * @returns {string | null}
 */
function getCurrentV3FallbackBaseUrl(baseUrl) {
  if (/\/api\/v3\.1$/i.test(baseUrl)) {
    return baseUrl.replace(/\/api\/v3\.1$/i, "/api/v3");
  }
  return null;
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
        const message =
          getComposioMessage(createResponse.data) ||
          `Could not create auth config for ${toolkit}: HTTP ${createResponse.status}`;
        if (COMPOSIO_MANAGED_AUTH_UNAVAILABLE_PATTERN.test(message)) {
          throw new Error(
            `${message}. This toolkit does not support Composio-managed auth. Create an auth config in Composio for ${toolkit} and retry composio_auth_link with auth_config_id.`
          );
        }
        throw new Error(message);
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
      "Returned tool_slug values are not Teleton tools; execute them with composio_execute_tool. " +
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
          if (params.query) query.query = params.query;
          if (params.toolkit) query.toolkits = [normalizeToolkitSlug(params.toolkit)];
          query.limit = limit;
          if (toolkitVersions) query.toolkitVersions = toolkitVersions;

          const toolList = await composioSdk.tools.getRawComposioTools(query);
          const rawItems = Array.isArray(toolList)
            ? toolList
            : Array.isArray(toolList?.items)
              ? toolList.items
              : [];
          const tools = rawItems.map((item) => formatTool(item, includeParams));

          sdk.log.info(`composio_search_tools: found ${tools.length} tools (SDK)`);
          if (tools.length > 0 || (!params.query && !params.toolkit)) {
            return {
              success: true,
              data: {
                tools,
                count: tools.length,
                query: params.query ?? null,
                toolkit: params.toolkit ?? null,
                total_available: toolList?.total ?? tools.length,
                execution: COMPOSIO_EXECUTION_GUIDANCE,
              },
            };
          }
          sdk.log.debug(`composio_search_tools: SDK returned 0 tools, falling back to HTTP`);
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
            execution: COMPOSIO_EXECUTION_GUIDANCE,
          },
        };
      } catch (err) {
        sdk.log.debug(`composio_search_tools: error — ${formatApiError(err)}`);
        return { success: false, error: `Search failed: ${formatApiError(err)}` };
      }
    },
  };

  // -------------------------------------------------------------------------
  // Tool 2: composio_get_tool_schemas
  // -------------------------------------------------------------------------

  const composioGetToolSchemas = {
    name: "composio_get_tool_schemas",
    description:
      "Fetch exact Composio input and output schemas for one or more tool_slug values. " +
      "Use this after composio_search_tools and before composio_execute_tool to validate parameters.",
    category: "data-bearing",

    parameters: {
      type: "object",
      properties: {
        tool_slug: {
          type: "string",
          description:
            "Single Composio tool identifier. Use tool_slugs for multiple tools.",
        },
        tool_slugs: {
          type: "array",
          description:
            "Composio tool identifiers returned by composio_search_tools.",
          items: { type: "string" },
          minItems: 1,
          maxItems: 50,
        },
        include: {
          type: "array",
          description:
            "Schema fields to include. Defaults to ['input_schema']; add 'output_schema' or 'metadata' when needed.",
          items: {
            type: "string",
            enum: ["input_schema", "output_schema", "metadata"],
          },
        },
        version: {
          type: "string",
          description:
            "Optional Composio tool version. Defaults to plugin config tool_version (latest).",
        },
      },
    },

    execute: async (params, _context) => {
      const apiKey = getApiKey();
      if (!apiKey) return notConfiguredError();

      const { baseUrl, timeoutMs, toolVersion, toolkitVersions } = getConfig();
      const requestedSlugs = [
        ...normalizeStringArray(params.tool_slug),
        ...normalizeStringArray(params.tool_slugs),
      ];
      const toolSlugs = [...new Set(requestedSlugs.map(normalizeToolSlug))];

      if (toolSlugs.length === 0) {
        return {
          success: false,
          error: "tool_slug or tool_slugs must include at least one Composio tool slug",
        };
      }
      if (toolSlugs.length > 50) {
        return { success: false, error: "tool_slugs supports at most 50 tools per call" };
      }

      const include = new Set(normalizeStringArray(params.include).map((value) => value.toLowerCase()));
      if (include.size === 0) include.add("input_schema");

      const schemas = [];
      const errors = [];

      await Promise.all(
        toolSlugs.map(async (toolSlug) => {
          const qs = new URLSearchParams();
          const version = params.version ?? toolVersion;
          if (version) qs.set("version", String(version));
          if (toolkitVersions) qs.set("toolkit_versions", String(toolkitVersions));

          try {
            const response = await fetchWithRetry({
              url: `${baseUrl}/tools/${encodeURIComponent(toolSlug)}?${qs.toString()}`,
              method: "GET",
              headers: buildHeaders(apiKey),
              timeoutMs,
              log: sdk.log,
            });

            if (response.status !== 200 || !isRecord(response.data)) {
              errors.push({
                tool_slug: toolSlug,
                status: response.status,
                error: getComposioMessage(response.data) || `HTTP ${response.status}`,
              });
              return;
            }

            schemas.push(formatToolSchema(response.data, include));
          } catch (err) {
            errors.push({
              tool_slug: toolSlug,
              error: formatApiError(err),
            });
          }
        })
      );

      schemas.sort((a, b) => String(a.tool_slug).localeCompare(String(b.tool_slug)));
      errors.sort((a, b) => String(a.tool_slug).localeCompare(String(b.tool_slug)));

      if (errors.length > 0) {
        return {
          success: false,
          error: `Could not fetch schema for ${errors.length} of ${toolSlugs.length} tool(s)`,
          data: {
            schemas,
            errors,
            count: schemas.length,
            requested_count: toolSlugs.length,
          },
        };
      }

      return {
        success: true,
        data: {
          schemas,
          count: schemas.length,
          requested_count: toolSlugs.length,
          include: [...include],
          execution: COMPOSIO_EXECUTION_GUIDANCE,
        },
      };
    },
  };

  // -------------------------------------------------------------------------
  // Tool 3: composio_execute_tool
  // -------------------------------------------------------------------------

  const composioExecuteTool = {
    name: "composio_execute_tool",
    description:
      "Execute a single Composio tool by its slug (e.g. 'github_create_issue'). " +
      "If the service is not authorized, returns a structured auth error with a connect_url. " +
      "Use composio_search_tools first to discover available tool_slug values, then call this tool instead of calling the returned slug directly.",
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

          const resultData = result?.data ?? result;
          if (isAuthRequiredPayload(result) || isAuthRequiredPayload(resultData)) {
            const service = extractServiceFromSlug(params.tool_slug);
            const connectUrl = extractConnectUrl(result) || extractConnectUrl(resultData) || buildConnectUrl(baseUrl, apiKey, service, context);
            sdk.log.info(`composio_execute_tool: auth required for ${service} (SDK response)`);
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

          sdk.log.info(`composio_execute_tool: ${params.tool_slug} succeeded (SDK)`);
          return {
            success: true,
            data: resultData,
          };
        } catch (err) {
          const errMsg = formatApiError(err);
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
      let url = `${baseUrl}/tools/execute/${encodeURIComponent(normalizedSlug)}`;

      sdk.log.debug(`composio_execute_tool: POST ${normalizedSlug} via HTTP (timeout=${effectiveTimeout}ms)`);

      const toolArguments = params.connected_account_id
        ? { ...params.parameters, connected_account_id: params.connected_account_id }
        : params.parameters;
      const body = {
        user_id: userId,
        arguments: toolArguments,
        version: params.version ?? toolVersion,
      };
      if (params.connected_account_id) {
        body.connected_account_id = params.connected_account_id;
      }

      try {
        let response = await fetchWithRetry({
          url,
          method: "POST",
          headers: buildHeaders(apiKey),
          body,
          timeoutMs: effectiveTimeout,
          log: sdk.log,
        });
        const fallbackBaseUrl = getCurrentV3FallbackBaseUrl(baseUrl);
        if (fallbackBaseUrl && isUnknownToolError(response)) {
          url = `${fallbackBaseUrl}/tools/execute/${encodeURIComponent(normalizedSlug)}`;
          sdk.log.debug(`composio_execute_tool: retrying ${normalizedSlug} on current v3 API`);
          response = await fetchWithRetry({
            url,
            method: "POST",
            headers: buildHeaders(apiKey),
            body,
            timeoutMs: effectiveTimeout,
            log: sdk.log,
          });
        }

        if (isAuthError(response)) {
          const service = extractServiceFromSlug(params.tool_slug);
          const connectUrl = extractConnectUrl(response.data) || buildConnectUrl(baseUrl, apiKey, service, context);
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
  // Tool 4: composio_multi_execute
  // -------------------------------------------------------------------------

  const composioMultiExecute = {
    name: "composio_multi_execute",
    description:
      "Execute multiple Composio tools in parallel. " +
      "Each execution uses a Composio tool_slug discovered by composio_search_tools; do not call returned slugs as Teleton tools. " +
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

              const resultData = result?.data ?? result;
              if (isAuthRequiredPayload(result) || isAuthRequiredPayload(resultData)) {
                const service = extractServiceFromSlug(exec.tool_slug);
                const connectUrl = extractConnectUrl(result) || extractConnectUrl(resultData) || buildConnectUrl(baseUrl, apiKey, service, context);
                results[globalIdx] = {
                  tool_slug: normalizedSlug,
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

              results[globalIdx] = {
                tool_slug: normalizedSlug,
                success: true,
                data: resultData,
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
          let url = `${baseUrl}/tools/execute/${encodeURIComponent(normalizedSlug)}`;

          const execArguments = exec.connected_account_id
            ? { ...exec.parameters, connected_account_id: exec.connected_account_id }
            : exec.parameters;
          const body = {
            user_id: getUserId(context),
            arguments: execArguments,
            version: exec.version ?? toolVersion,
          };
          if (exec.connected_account_id) {
            body.connected_account_id = exec.connected_account_id;
          }

          try {
            let response = await fetchWithRetry({
              url,
              method: "POST",
              headers: buildHeaders(apiKey),
              body,
              timeoutMs: effectiveTimeout,
              log: sdk.log,
            });
            const fallbackBaseUrl = getCurrentV3FallbackBaseUrl(baseUrl);
            if (fallbackBaseUrl && isUnknownToolError(response)) {
              url = `${fallbackBaseUrl}/tools/execute/${encodeURIComponent(normalizedSlug)}`;
              sdk.log.debug(`composio_multi_execute: retrying ${normalizedSlug} on current v3 API`);
              response = await fetchWithRetry({
                url,
                method: "POST",
                headers: buildHeaders(apiKey),
                body,
                timeoutMs: effectiveTimeout,
                log: sdk.log,
              });
            }

            if (isAuthError(response)) {
              const service = extractServiceFromSlug(exec.tool_slug);
              const connectUrl = extractConnectUrl(response.data) || buildConnectUrl(baseUrl, apiKey, service, context);
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
  // Tool 5: composio_auth_link
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

  // -------------------------------------------------------------------------
  // Tool 6: composio_list_connections
  // -------------------------------------------------------------------------

  const composioListConnections = {
    name: "composio_list_connections",
    description:
      "List Composio connected accounts for the current Teleton user, optionally filtered by toolkit, status, user, auth config, or connected account ID. " +
      "Use this before composio_auth_link to reuse existing ACTIVE connections when possible.",
    category: "data-bearing",

    parameters: {
      type: "object",
      properties: {
        toolkit: {
          type: "string",
          description:
            "Filter by a single toolkit slug (e.g. github, gmail, slack).",
        },
        toolkits: {
          type: "array",
          description: "Filter by one or more toolkit slugs.",
          items: { type: "string" },
        },
        status: {
          type: "string",
          description:
            "Filter by a single connection status (e.g. ACTIVE, INITIALIZING, FAILED).",
        },
        statuses: {
          type: "array",
          description: "Filter by one or more connection statuses.",
          items: { type: "string" },
        },
        user_id: {
          type: "string",
          description:
            "Filter by a Composio user id. Defaults to the current Teleton sender.",
        },
        user_ids: {
          type: "array",
          description:
            "Filter by multiple Composio user ids. Defaults to the current Teleton sender unless include_all_users is true.",
          items: { type: "string" },
        },
        include_all_users: {
          type: "boolean",
          description:
            "When true, do not automatically filter to the current Teleton sender.",
        },
        auth_config_id: {
          type: "string",
          description: "Filter by a single Composio auth config ID.",
        },
        auth_config_ids: {
          type: "array",
          description: "Filter by one or more Composio auth config IDs.",
          items: { type: "string" },
        },
        connected_account_id: {
          type: "string",
          description: "Filter by a single connected account ID.",
        },
        connected_account_ids: {
          type: "array",
          description: "Filter by one or more connected account IDs.",
          items: { type: "string" },
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned by a previous call.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of connected accounts to return (1-1000, default: 50).",
          minimum: 1,
          maximum: 1000,
        },
        order_by: {
          type: "string",
          enum: ["created_at", "updated_at"],
          description: "Sort field. Defaults to Composio's created_at order.",
        },
        order_direction: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction. Defaults to Composio's desc order.",
        },
      },
    },

    execute: async (params, context) => {
      const apiKey = getApiKey();
      if (!apiKey) return notConfiguredError();

      const { baseUrl, timeoutMs } = getConfig();
      const qs = new URLSearchParams();
      const toolkits = [
        ...normalizeStringArray(params.toolkit),
        ...normalizeStringArray(params.toolkits),
      ].map(normalizeToolkitSlug);
      const statuses = [
        ...normalizeStringArray(params.status),
        ...normalizeStringArray(params.statuses),
      ].map((status) => status.toUpperCase());
      const userIds = [
        ...normalizeStringArray(params.user_id),
        ...normalizeStringArray(params.user_ids),
      ];
      const authConfigIds = [
        ...normalizeStringArray(params.auth_config_id),
        ...normalizeStringArray(params.auth_config_ids),
      ];
      const connectedAccountIds = [
        ...normalizeStringArray(params.connected_account_id),
        ...normalizeStringArray(params.connected_account_ids),
      ];

      appendArrayParams(qs, "toolkit_slugs", [...new Set(toolkits)]);
      appendArrayParams(qs, "statuses", [...new Set(statuses)]);
      appendArrayParams(qs, "auth_config_ids", [...new Set(authConfigIds)]);
      appendArrayParams(qs, "connected_account_ids", [...new Set(connectedAccountIds)]);

      if (params.include_all_users !== true && userIds.length === 0) {
        userIds.push(getUserId(context));
      }
      appendArrayParams(qs, "user_ids", [...new Set(userIds)]);

      qs.set("limit", String(normalizeLimit(params.limit, 50, 1000)));
      if (params.cursor) qs.set("cursor", String(params.cursor));
      if (params.order_by) qs.set("order_by", String(params.order_by));
      if (params.order_direction) {
        qs.set("order_direction", String(params.order_direction).toLowerCase());
      }

      try {
        const response = await fetchWithRetry({
          url: `${baseUrl}/connected_accounts?${qs.toString()}`,
          method: "GET",
          headers: buildHeaders(apiKey),
          timeoutMs,
          log: sdk.log,
        });

        if (response.status !== 200) {
          return {
            success: false,
            error:
              getComposioMessage(response.data) ||
              `Could not list connected accounts: HTTP ${response.status}`,
          };
        }

        const rawData = response.data;
        const items = isRecord(rawData)
          ? (rawData.items ?? rawData.data ?? rawData.connected_accounts ?? [])
          : [];
        const connections = Array.isArray(items)
          ? items.filter(isRecord).map(formatConnectedAccount)
          : [];

        return {
          success: true,
          data: {
            connections,
            count: connections.length,
            next_cursor: isRecord(rawData) ? (rawData.next_cursor ?? null) : null,
            total_items: isRecord(rawData)
              ? (rawData.total_items ?? rawData.totalItems ?? rawData.total ?? null)
              : null,
            filters: {
              toolkit_slugs: [...new Set(toolkits)],
              statuses: [...new Set(statuses)],
              user_ids: [...new Set(userIds)],
              auth_config_ids: [...new Set(authConfigIds)],
              connected_account_ids: [...new Set(connectedAccountIds)],
            },
            execution_hint:
              "Pass connection.execute_with.connected_account_id to composio_execute_tool or composio_multi_execute to reuse a specific account.",
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `Could not list connected accounts: ${formatApiError(err)}`,
        };
      }
    },
  };

  // -------------------------------------------------------------------------
  // Tool 7: composio_get_connection
  // -------------------------------------------------------------------------

  const composioGetConnection = {
    name: "composio_get_connection",
    description:
      "Get one Composio connected account by connected_account_id. " +
      "Returns non-secret metadata and the connected_account_id to pass into composio_execute_tool.",
    category: "data-bearing",

    parameters: {
      type: "object",
      properties: {
        connected_account_id: {
          type: "string",
          description: "Composio connected account ID, for example ca_1a2b3c4d5e6f.",
        },
      },
      required: ["connected_account_id"],
    },

    execute: async (params, _context) => {
      const apiKey = getApiKey();
      if (!apiKey) return notConfiguredError();

      if (!params.connected_account_id || typeof params.connected_account_id !== "string") {
        return {
          success: false,
          error: "connected_account_id is required and must be a string",
        };
      }

      const { baseUrl, timeoutMs } = getConfig();
      const connectedAccountId = params.connected_account_id.trim();

      try {
        const response = await fetchWithRetry({
          url: `${baseUrl}/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
          method: "GET",
          headers: buildHeaders(apiKey),
          timeoutMs,
          log: sdk.log,
        });

        if (response.status !== 200 || !isRecord(response.data)) {
          return {
            success: false,
            error:
              getComposioMessage(response.data) ||
              `Could not get connected account ${connectedAccountId}: HTTP ${response.status}`,
          };
        }

        return {
          success: true,
          data: {
            connection: formatConnectedAccount(response.data),
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `Could not get connected account ${connectedAccountId}: ${formatApiError(err)}`,
        };
      }
    },
  };

  return [
    composioSearchTools,
    composioGetToolSchemas,
    composioExecuteTool,
    composioMultiExecute,
    composioAuthLink,
    composioListConnections,
    composioGetConnection,
  ];
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
