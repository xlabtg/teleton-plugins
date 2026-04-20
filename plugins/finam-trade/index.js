import { FinamAuth } from "./src/auth.js";
import { FinamClient } from "./src/client.js";
import { accountTools } from "./src/tools/accounts.js";
import { instrumentTools } from "./src/tools/instruments.js";
import { marketTools } from "./src/tools/market.js";
import { orderTools } from "./src/tools/orders.js";
import { reportTools } from "./src/tools/reports.js";

const TOOL_METADATA = [
  { name: "finam_get_accounts", description: "List Finam trading accounts available to FINAM_SECRET" },
  { name: "finam_get_account_info", description: "Get Finam account equity, PnL, margin, cash, and positions" },
  { name: "finam_get_positions", description: "List open Finam account positions" },
  { name: "finam_get_cash", description: "Get Finam account cash balances" },
  { name: "finam_get_trades", description: "Get Finam account executed trade history" },
  { name: "finam_get_transactions", description: "Get Finam account transaction history" },
  { name: "finam_place_order", description: "Place a Finam market, limit, stop, stop-limit, or multi-leg order" },
  { name: "finam_cancel_order", description: "Cancel a Finam order" },
  { name: "finam_get_orders", description: "List Finam account orders" },
  { name: "finam_get_order_status", description: "Get detailed Finam order status" },
  { name: "finam_place_sltp", description: "Place Finam stop-loss and take-profit orders" },
  { name: "finam_get_bars", description: "Get historical candle bars for a Finam instrument" },
  { name: "finam_get_latest_trades", description: "Get latest public trades for a Finam instrument" },
  { name: "finam_get_orderbook", description: "Get current Finam order book rows" },
  { name: "finam_get_last_quote", description: "Get latest Finam instrument quote" },
  { name: "finam_get_instrument", description: "Get detailed Finam instrument information" },
  { name: "finam_get_asset_params", description: "Get account-specific Finam instrument trading parameters" },
  { name: "finam_get_instruments_list", description: "Get paginated Finam instrument list" },
  { name: "finam_get_tradeable_instruments", description: "Get currently tradeable Finam instruments" },
  { name: "finam_get_exchanges", description: "Get Finam exchanges and MIC codes" },
  { name: "finam_get_schedule", description: "Get Finam instrument trading schedule" },
  { name: "finam_get_clock", description: "Get Finam API server clock" },
  { name: "finam_get_constituents", description: "Get constituents for a Finam index" },
  { name: "finam_get_options_chain", description: "Get Finam options chain for an underlying" },
  { name: "finam_generate_report", description: "Start Finam account report generation" },
  { name: "finam_get_report_status", description: "Get Finam report generation status" },
  { name: "finam_get_usage", description: "Get Finam API usage metrics" },
];

export const manifest = {
  id: "finam-trade",
  name: "Finam Trade Pro",
  version: "1.0.0",
  description: "Finam Trade API integration for trading, market data, account analytics, reports, and portfolio operations.",
  author: { name: "Teleton Community", url: "https://github.com/xlabtg" },
  license: "MIT",
  entry: "index.js",
  teleton: ">=1.0.0",
  sdkVersion: ">=1.0.0",
  permissions: ["network", "secrets", "database"],
  secrets: {
    FINAM_SECRET: {
      required: true,
      description: "Permanent Finam API secret used to request temporary JWT sessions.",
    },
  },
  defaultConfig: {
    api_base: "https://api.finam.ru",
    grpc_base: "api.finam.ru:443",
    rate_limit_rps: 3,
    rate_limit_per_minute: 200,
    timeout_ms: 30000,
    cache_ttl_seconds: 3600,
  },
  tags: ["trading", "finam", "stocks", "futures", "forex", "moex", "market-data"],
  tools: TOOL_METADATA,
  repository: "https://github.com/TONresistor/teleton-plugins",
  funding: null,
};

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
  const config = { ...manifest.defaultConfig, ...(sdk?.pluginConfig ?? {}) };
  const apiBase = config.api_base ?? manifest.defaultConfig.api_base;
  const rateLimitPerMinute = resolveRateLimit(config);
  const timeoutMs = Number(config.timeout_ms ?? 30000);
  const auth = new FinamAuth({ sdk, apiBase, timeoutMs });
  const client = new FinamClient({
    sdk,
    auth,
    apiBase,
    rateLimitPerMinute,
    timeoutMs,
  });
  const cacheTtlMs = Number(config.cache_ttl_seconds ?? 3600) * 1000;
  const deps = { sdk, auth, client, cacheTtlMs };

  return [
    ...accountTools(deps),
    ...orderTools(deps),
    ...marketTools(deps),
    ...instrumentTools(deps),
    ...reportTools(deps),
  ];
};

export function start(ctx) {
  ctx?.sdk?.log?.info?.("finam-trade plugin ready");
}

export function stop() {}

function resolveRateLimit(config) {
  const perMinute = Number(config.rate_limit_per_minute);
  if (Number.isFinite(perMinute) && perMinute > 0) return Math.min(200, perMinute);

  const rps = Number(config.rate_limit_rps);
  if (Number.isFinite(rps) && rps > 0) return Math.min(200, Math.floor(rps * 60));

  return 200;
}
