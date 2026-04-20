#!/usr/bin/env node
/* global process, console, fetch */
import assert from "node:assert/strict";

const args = new Set(process.argv.slice(2));
const env = process.env;
const apiBase = env.FINAM_API_BASE || "https://api.finam.ru";
const grpcBase = env.FINAM_GRPC_BASE || "api.finam.ru:443";
const timeoutMs = Number(env.FINAM_TIMEOUT_MS || 30_000);
const requireTradingSmoke = env.FINAM_REQUIRE_TRADING_SMOKE === "1";
const requireGrpcSmoke = env.FINAM_REQUIRE_GRPC_SMOKE === "1";
const steps = [];
let failureCount = 0;
let selectedAccountId = null;

if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

if (args.has("--dry-run")) {
  printDryRun();
  process.exit(0);
}

if (!env.FINAM_SECRET) {
  console.error("FINAM_SECRET is required for live Finam smoke tests.");
  console.error("Use --dry-run to inspect the planned checks and required environment variables.");
  process.exit(2);
}

const [{ FinamAuth }, { FinamClient }, plugin] = await Promise.all([
  import("../plugins/finam-trade/src/auth.js"),
  import("../plugins/finam-trade/src/client.js"),
  import("../plugins/finam-trade/index.js"),
]);
const { start: startPlugin, stop: stopPlugin, tools } = plugin;

try {
  const sdk = createSdk(env.FINAM_SECRET);
  const toolMap = makeToolMap(tools(sdk));

  await runStep("finam_get_accounts", async () => {
    const data = await executeTool(toolMap, "finam_get_accounts", { include_details: false });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    assert.ok(accounts.length > 0, "expected at least one Finam account");
    selectedAccountId = env.FINAM_LIVE_ACCOUNT_ID || accounts[0].account_id;
    assert.ok(selectedAccountId, "selected account id is missing");
    return {
      account_count: accounts.length,
      selected_account_id: maskIdentifier(selectedAccountId),
      readonly: data.readonly ?? null,
      md_permission_count: Array.isArray(data.md_permissions) ? data.md_permissions.length : null,
    };
  });

  await runStep("finam_get_account_info", async () => {
    const data = await executeTool(toolMap, "finam_get_account_info", { account_id: selectedAccountId });
    return {
      account_id: maskIdentifier(data.account_id ?? selectedAccountId),
      type: data.type ?? null,
      status: data.status ?? null,
      position_count: Array.isArray(data.positions) ? data.positions.length : null,
      cash_count: Array.isArray(data.cash) ? data.cash.length : null,
    };
  });

  await runStep("finam_generate_report", async () => {
    const data = await executeTool(toolMap, "finam_generate_report", {
      account_id: selectedAccountId,
      date_begin: env.FINAM_LIVE_REPORT_DATE_BEGIN || defaultDateDaysAgo(8),
      date_end: env.FINAM_LIVE_REPORT_DATE_END || defaultDateDaysAgo(1),
      report_form: env.FINAM_LIVE_REPORT_FORM || "short",
    });
    assert.ok(data.report_id, "expected Finam report_id");
    return {
      report_id: maskIdentifier(data.report_id),
      status: data.status ?? null,
    };
  });

  await runStep("jwt session creation and pre-expiry refresh", async () => {
    const auth = createInstrumentedAuth(env.FINAM_SECRET);
    const firstToken = await auth.getToken();
    assertJwt(firstToken, "initial session token");
    const firstExpiresAt = auth.tokenExpiresAt;

    auth.tokenExpiresAt = Date.now() + 1;
    const secondToken = await auth.getToken();
    assertJwt(secondToken, "refreshed session token");

    const sessionCalls = auth.calls.filter((url) => url.endsWith("/v1/sessions")).length;
    assert.ok(sessionCalls >= 2, `expected at least 2 session calls, got ${sessionCalls}`);
    return {
      session_calls: sessionCalls,
      first_expires_at: toIso(firstExpiresAt),
      refreshed_expires_at: toIso(auth.tokenExpiresAt),
    };
  });

  await runStep("401/403 recovery", async () => {
    const auth = createInstrumentedAuth(env.FINAM_SECRET);
    await auth.getToken();
    auth.token = "invalid.jwt.value";
    auth.tokenExpiresAt = Date.now() + 10 * 60_000;

    const statuses = [];
    const client = new FinamClient({
      auth,
      apiBase,
      timeoutMs,
      fetchImpl: async (url, init) => {
        const response = await fetch(url, init);
        statuses.push(response.status);
        return response;
      },
    });
    const data = await client.get("/v1/usage");
    assert.ok(statuses.some((status) => status === 401 || status === 403), "expected an initial auth failure");
    return {
      statuses,
      recovered: true,
      response_keys: Object.keys(data).slice(0, 8),
    };
  });

  await runStep("negative auth failure", async () => {
    const auth = new FinamAuth({
      sdk: createSdk(env.FINAM_LIVE_INVALID_SECRET || "teleton-invalid-finam-secret"),
      apiBase,
      timeoutMs,
    });
    try {
      await auth.getToken();
    } catch (err) {
      return { observed_error: formatError(err) };
    }
    throw new Error("invalid Finam secret unexpectedly created a session");
  });

  await maybeRunTradingSmokes(toolMap);
  await maybeRunGrpcSmoke();
} finally {
  stopPlugin();
}

const report = {
  generated_at: new Date().toISOString(),
  api_base: apiBase,
  grpc_base: grpcBase,
  selected_account_id: selectedAccountId ? maskIdentifier(selectedAccountId) : null,
  steps,
};

console.log(JSON.stringify(report, null, 2));
if (failureCount > 0) process.exitCode = 1;

async function maybeRunTradingSmokes(toolMap) {
  if (env.FINAM_LIVE_ENABLE_TRADING !== "1") {
    skipStep(
      "finam_place_order",
      "set FINAM_LIVE_ENABLE_TRADING=1 and FINAM_LIVE_PLACE_ORDER_JSON to run the live order smoke",
      { required: requireTradingSmoke }
    );
    skipStep(
      "finam_place_sltp",
      "set FINAM_LIVE_ENABLE_TRADING=1 and FINAM_LIVE_SLTP_JSON to run the live SL/TP smoke",
      { required: requireTradingSmoke }
    );
    return;
  }

  await runStep("finam_place_order", async () => {
    const params = readJsonEnv("FINAM_LIVE_PLACE_ORDER_JSON");
    requireFields(params, ["account_id", "symbol", "quantity", "side", "type"], "FINAM_LIVE_PLACE_ORDER_JSON");
    const data = await executeTool(toolMap, "finam_place_order", params);
    const orderId = data.order_id ?? data.raw?.order_id ?? null;
    const cleanup = await cancelReturnedOrders(toolMap, params.account_id, [orderId]);
    return {
      account_id: maskIdentifier(params.account_id),
      symbol: params.symbol,
      order_id: orderId ? maskIdentifier(orderId) : null,
      cleanup,
    };
  });

  await runStep("finam_place_sltp", async () => {
    const params = readJsonEnv("FINAM_LIVE_SLTP_JSON");
    requireFields(params, ["account_id", "symbol", "side"], "FINAM_LIVE_SLTP_JSON");
    if (!params.quantity_sl && !params.quantity_tp) {
      throw new Error("FINAM_LIVE_SLTP_JSON must include quantity_sl and/or quantity_tp");
    }
    const data = await executeTool(toolMap, "finam_place_sltp", params);
    const ids = [data.sl_order_id, data.tp_order_id].filter(Boolean);
    const cleanup = await cancelReturnedOrders(toolMap, params.account_id, ids);
    return {
      account_id: maskIdentifier(params.account_id),
      symbol: params.symbol,
      sl_order_id: data.sl_order_id ? maskIdentifier(data.sl_order_id) : null,
      tp_order_id: data.tp_order_id ? maskIdentifier(data.tp_order_id) : null,
      cleanup,
    };
  });
}

async function maybeRunGrpcSmoke() {
  if (env.FINAM_LIVE_ENABLE_GRPC !== "1") {
    skipStep(
      "optional gRPC JWT renewal with REST flow",
      "set FINAM_LIVE_ENABLE_GRPC=1 to verify gRPC renewal startup alongside REST requests",
      { required: requireGrpcSmoke }
    );
    return;
  }

  await runStep("optional gRPC JWT renewal with REST flow", async () => {
    const sdk = createSdk(env.FINAM_SECRET, { enableGrpc: true });
    await startPlugin({ sdk });
    const data = await executeTool(makeToolMap(tools(sdk)), "finam_get_usage", {});
    return {
      rest_flow: "passed",
      response_keys: Object.keys(data).slice(0, 8),
      warning_count: sdk.logs.warn.length,
    };
  });
}

async function cancelReturnedOrders(toolMap, accountId, orderIds) {
  if (env.FINAM_LIVE_CANCEL_CREATED_ORDERS === "0") return [];
  const cleanup = [];
  for (const orderId of orderIds.filter(Boolean)) {
    const data = await executeTool(toolMap, "finam_cancel_order", { account_id: accountId, order_id: orderId });
    cleanup.push({
      order_id: maskIdentifier(orderId),
      cancelled: Boolean(data.cancelled),
    });
  }
  return cleanup;
}

async function runStep(name, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    steps.push({
      name,
      status: "passed",
      duration_ms: Date.now() - started,
      evidence: redactEvidence(evidence),
    });
    return evidence;
  } catch (err) {
    failureCount += 1;
    steps.push({
      name,
      status: "failed",
      duration_ms: Date.now() - started,
      error: formatError(err),
    });
    return null;
  }
}

function skipStep(name, reason, { required = false } = {}) {
  if (required) failureCount += 1;
  steps.push({
    name,
    status: required ? "failed" : "skipped",
    reason,
  });
}

async function executeTool(toolMap, name, params) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`Tool ${name} is not exported`);
  const result = await tool.execute(params);
  if (!result?.success) throw new Error(`${name} failed: ${result?.error || "unknown error"}`);
  return result.data;
}

function makeToolMap(toolList) {
  return new Map(toolList.map((tool) => [tool.name, tool]));
}

function createSdk(secret, { enableGrpc = false } = {}) {
  const logs = { info: [], warn: [], error: [], debug: [] };
  return {
    logs,
    pluginConfig: {
      api_base: apiBase,
      grpc_base: grpcBase,
      enable_grpc_jwt_renewal: enableGrpc,
      rate_limit_per_minute: Number(env.FINAM_RATE_LIMIT_PER_MINUTE || 200),
      timeout_ms: timeoutMs,
    },
    secrets: {
      require: async (name) => {
        if (name !== "FINAM_SECRET") throw new Error(`Unexpected secret requested: ${name}`);
        return secret;
      },
    },
    db: null,
    log: {
      info: (message) => logs.info.push(formatError(message)),
      warn: (message) => logs.warn.push(formatError(message)),
      error: (message) => logs.error.push(formatError(message)),
      debug: (message) => logs.debug.push(formatError(message)),
    },
  };
}

function createInstrumentedAuth(secret) {
  const calls = [];
  const auth = new FinamAuth({
    sdk: createSdk(secret),
    apiBase,
    timeoutMs,
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      return fetch(url, init);
    },
  });
  auth.calls = calls;
  return auth;
}

function assertJwt(token, label) {
  assert.equal(typeof token, "string", `${label} must be a string`);
  assert.equal(token.split(".").length, 3, `${label} must look like a JWT`);
}

function readJsonEnv(name) {
  const text = env[name];
  if (!text) throw new Error(`${name} is required`);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${name} must be valid JSON: ${formatError(err)}`);
  }
}

function requireFields(object, fields, sourceName) {
  const missing = fields.filter((field) => object[field] == null || object[field] === "");
  if (missing.length > 0) throw new Error(`${sourceName} is missing required fields: ${missing.join(", ")}`);
}

function redactEvidence(value) {
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item));
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/secret|token|authorization/i.test(key)) {
      result[key] = "[REDACTED]";
    } else if (/account_id|order_id|report_id/i.test(key) && typeof nested === "string") {
      result[key] = maskIdentifier(nested);
    } else {
      result[key] = redactEvidence(nested);
    }
  }
  return result;
}

function maskIdentifier(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return `${text.slice(0, 2)}...${text.slice(-2)}`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function formatError(err) {
  const message = err?.message || String(err);
  return String(message).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]").slice(0, 500);
}

function toIso(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function defaultDateDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function printDryRun() {
  const plan = {
    required_env: ["FINAM_SECRET"],
    optional_env: [
      "FINAM_API_BASE",
      "FINAM_GRPC_BASE",
      "FINAM_LIVE_ACCOUNT_ID",
      "FINAM_LIVE_REPORT_DATE_BEGIN",
      "FINAM_LIVE_REPORT_DATE_END",
      "FINAM_LIVE_ENABLE_TRADING",
      "FINAM_LIVE_PLACE_ORDER_JSON",
      "FINAM_LIVE_SLTP_JSON",
      "FINAM_LIVE_ENABLE_GRPC",
    ],
    default_steps: [
      "finam_get_accounts",
      "finam_get_account_info",
      "finam_generate_report",
      "JWT session creation and pre-expiry refresh",
      "401/403 recovery",
      "negative auth failure",
    ],
    gated_steps: [
      "finam_place_order requires FINAM_LIVE_ENABLE_TRADING=1 and FINAM_LIVE_PLACE_ORDER_JSON",
      "finam_place_sltp requires FINAM_LIVE_ENABLE_TRADING=1 and FINAM_LIVE_SLTP_JSON",
      "optional gRPC JWT renewal requires FINAM_LIVE_ENABLE_GRPC=1",
    ],
  };
  console.log(JSON.stringify(plan, null, 2));
}

function printHelp() {
  console.log(`Finam live smoke test runner

Usage:
  node experiments/finam-live-smoke.mjs --dry-run
  FINAM_SECRET=... node experiments/finam-live-smoke.mjs

Trading checks are disabled unless FINAM_LIVE_ENABLE_TRADING=1 is set.
When enabled, order and SL/TP payloads must be supplied as explicit JSON:
  FINAM_LIVE_PLACE_ORDER_JSON='{"account_id":"...","symbol":"SBER@MISX","quantity":"1","side":"buy","type":"limit","limit_price":"1"}'
  FINAM_LIVE_SLTP_JSON='{"account_id":"...","symbol":"SBER@MISX","side":"sell","quantity_sl":"1","sl_price":"1"}'

Returned order ids are cancelled by default. Set FINAM_LIVE_CANCEL_CREATED_ORDERS=0 to disable cleanup.
Use only a non-production account or the safest broker-provided test environment.`);
}
