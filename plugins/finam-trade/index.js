import { FinamAuth } from "./src/auth.js";
import { FinamClient } from "./src/client.js";
import { FinamGrpcJwtRenewal } from "./src/grpc.js";
import { accountTools } from "./src/tools/accounts.js";
import { instrumentTools } from "./src/tools/instruments.js";
import { marketTools } from "./src/tools/market.js";
import { orderTools } from "./src/tools/orders.js";
import { reportTools } from "./src/tools/reports.js";


export const manifest = {
  id: "finam-trade",
  name: "finam-trade",
  version: "1.0.0",
  description: "Finam Trade API integration for trading, market data, account analytics, reports, and portfolio operations.",
  author: "Teleton Community",
  sdkVersion: ">=1.0.0",
  secrets: {
    FINAM_SECRET: {
      required: true,
      description: "Permanent Finam API secret used to request temporary JWT sessions.",
    },
  },
  defaultConfig: {
    api_base: "https://api.finam.ru",
    grpc_base: "api.finam.ru:443",
    enable_grpc_jwt_renewal: false,
    rate_limit_rps: 3,
    rate_limit_per_minute: 200,
    timeout_ms: 30000,
    cache_ttl_seconds: 3600,
  },
};

let activeRuntime = null;

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finam_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

export const tools = (sdk) => {
  const deps = getRuntime(sdk);

  return [
    ...accountTools(deps),
    ...orderTools(deps),
    ...marketTools(deps),
    ...instrumentTools(deps),
    ...reportTools(deps),
  ];
};

export async function start(ctx) {
  const log = ctx?.log ?? ctx?.sdk?.log;
  const deps = activeRuntime ?? getRuntime(ctx?.sdk);
  if (isEnabled(deps.config.enable_grpc_jwt_renewal)) {
    try {
      await deps.auth.startJwtRenewal();
      log?.info?.("finam-trade gRPC JWT renewal stream enabled");
    } catch (err) {
      log?.warn?.(`finam-trade gRPC JWT renewal unavailable: ${err?.message ?? String(err)}`);
    }
  }
  log?.info?.("finam-trade plugin ready");
}

export function stop() {
  activeRuntime?.auth?.stopJwtRenewal?.();
  activeRuntime = null;
}

function getRuntime(sdk) {
  if (activeRuntime && activeRuntime.sdk === sdk) return activeRuntime;
  activeRuntime?.auth?.stopJwtRenewal?.();

  const config = { ...manifest.defaultConfig, ...(sdk?.pluginConfig ?? {}) };
  const apiBase = config.api_base ?? manifest.defaultConfig.api_base;
  const rateLimitPerMinute = resolveRateLimit(config);
  const timeoutMs = Number(config.timeout_ms ?? 30000);
  const grpcRenewal = isEnabled(config.enable_grpc_jwt_renewal)
    ? new FinamGrpcJwtRenewal({ sdk, grpcBase: config.grpc_base })
    : null;
  const auth = new FinamAuth({ sdk, apiBase, timeoutMs, grpcRenewal });
  const client = new FinamClient({
    sdk,
    auth,
    apiBase,
    rateLimitPerMinute,
    timeoutMs,
  });
  const cacheTtlMs = Number(config.cache_ttl_seconds ?? 3600) * 1000;
  activeRuntime = { sdk, config, auth, client, cacheTtlMs };
  return activeRuntime;
}

function resolveRateLimit(config) {
  const perMinute = Number(config.rate_limit_per_minute);
  if (Number.isFinite(perMinute) && perMinute > 0) return Math.min(200, perMinute);

  const rps = Number(config.rate_limit_rps);
  if (Number.isFinite(rps) && rps > 0) return Math.min(200, Math.floor(rps * 60));

  return 200;
}

function isEnabled(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}
