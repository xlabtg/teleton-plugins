/**
 * xRocket Trade plugin — spot trading, market data, account management
 *
 * Wraps the xRocket Exchange API (https://trade.xrocket.tg) with 12 tools.
 * Zero external dependencies — native fetch only.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://trade.xrocket.tg";
const NETWORKS = ["TON", "BSC", "ETH", "BTC", "TRX", "SOL"];
const ORDER_TYPES = ["BUY", "SELL"];
const EXECUTE_TYPES = ["LIMIT", "MARKET"];
const PERIODS = [
  "PERIOD_1_MINUTE", "PERIOD_5_MINUTES", "PERIOD_15_MINUTES", "PERIOD_30_MINUTES",
  "PERIOD_1_HOUR", "PERIOD_2_HOURS", "PERIOD_4_HOURS", "PERIOD_5_HOURS",
  "PERIOD_8_HOURS", "PERIOD_12_HOURS", "PERIOD_1_DAY", "PERIOD_2_DAYS",
  "PERIOD_1_WEEK", "PERIOD_1_MONTH",
];

// ---------------------------------------------------------------------------
// Plugin export (SDK v1.0.0)
// ---------------------------------------------------------------------------

export const manifest = {
  name: "xrocket-trade",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "xRocket Exchange API — spot trading, market data, candlesticks, and account management",
};

export const tools = (sdk) => {
  const log = sdk.log;

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  function validateAmount(val, name = "amount") {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`Invalid ${name}: must be a positive number`);
    return n;
  }

  function validateNetwork(val) {
    const v = String(val).toUpperCase();
    if (!NETWORKS.includes(v))
      throw new Error(`Invalid network: ${val}. Must be one of: ${NETWORKS.join(", ")}`);
    return v;
  }

  function validateEnum(val, allowed, name) {
    const v = String(val).toUpperCase();
    if (!allowed.includes(v))
      throw new Error(`Invalid ${name}: ${val}. Must be one of: ${allowed.join(", ")}`);
    return v;
  }

  function validateString(val, name) {
    const s = String(val);
    if (!s.trim()) throw new Error(`${name} must not be empty`);
    return s;
  }

  // -------------------------------------------------------------------------
  // API fetch helper
  // -------------------------------------------------------------------------

  async function tradeFetch(path, { method = "GET", body = null, params = {}, auth = true } = {}) {
    const url = new URL(path, API_BASE);
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    const headers = { Accept: "application/json" };
    if (auth) headers["Rocket-Exchange-Key"] = sdk.secrets.require("exchange_key");

    const opts = { method, headers, signal: AbortSignal.timeout(15000) };

    if (body && method !== "GET") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      const msg = json?.message || (await res.text().catch(() => `HTTP ${res.status}`));
      throw new Error(`xRocket Trade ${res.status}: ${String(msg).slice(0, 500)}`);
    }
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Tools (12)
  // -------------------------------------------------------------------------

  return [
    // === Account (3) =====================================================

    {
      name: "xtrade_balances",
      description: "Get all exchange account balances (non-zero only) with locked-in-orders amounts.",
      category: "data-bearing",
      scope: "always",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const json = await tradeFetch("/account/balance");
          const balances = (json.data?.balances ?? []).filter(
            (b) => b.amount > 0 || b.lockedInOrders > 0
          );
          return { success: true, data: balances };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_fees",
      description: "Get your current maker/taker fee rates (in %).",
      category: "data-bearing",
      scope: "always",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const json = await tradeFetch("/account/fees");
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_withdraw",
      description: "Withdraw funds from exchange to an external wallet (TON, BSC, ETH, BTC, TRX, SOL).",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          network: { type: "string", description: "Network: TON, BSC, ETH, BTC, TRX, SOL" },
          address: { type: "string", description: "Destination wallet address" },
          currency: { type: "string", description: "Currency code" },
          amount: { type: "number", description: "Amount to withdraw (max 9 decimals)" },
          withdrawal_id: { type: "string", description: "Unique withdrawal ID (auto-generated if omitted)" },
          comment: { type: "string", description: "Comment (max 50 chars)" },
        },
        required: ["network", "address", "currency", "amount"],
      },
      execute: async (params) => {
        try {
          const amount = validateAmount(params.amount, "amount");
          const network = validateNetwork(params.network);
          const address = validateString(params.address, "address");
          const withdrawalId = params.withdrawal_id || randomUUID();
          const body = { network, address, currency: String(params.currency), amount, withdrawalId };
          if (params.comment) {
            const c = String(params.comment);
            if (c.length > 50) throw new Error("comment must be at most 50 characters");
            body.comment = c;
          }
          const json = await tradeFetch("/account/withdrawal", { method: "POST", body });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    // === Market Data (5) =================================================

    {
      name: "xtrade_pairs",
      description: "List all available trading pairs with prices, volumes, and minimums.",
      category: "data-bearing",
      scope: "always",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const json = await tradeFetch("/pairs", { auth: false });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_pair",
      description: "Get details for a specific trading pair (price, volume, min amounts, fees).",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          pair: { type: "string", description: 'Pair name (e.g. "TONCOIN-USDT", "BTC-USDT")' },
        },
        required: ["pair"],
      },
      execute: async (params) => {
        try {
          const pair = validateString(params.pair, "pair");
          const json = await tradeFetch(`/pairs/${encodeURIComponent(pair)}`, { auth: false });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_last_trades",
      description: "Get the most recent trades executed on a pair.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          pair: { type: "string", description: 'Pair name (e.g. "TONCOIN-USDT")' },
          limit: { type: "number", description: "Max trades to return" },
        },
        required: ["pair"],
      },
      execute: async (params) => {
        try {
          const pair = validateString(params.pair, "pair");
          const qs = {};
          if (params.limit !== undefined) qs.limit = Math.max(1, Math.floor(Number(params.limit)));
          const json = await tradeFetch(`/trades/last/${encodeURIComponent(pair)}`, { auth: false, params: qs });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_time_series",
      description: "Get OHLCV candlestick data for a pair over a date range.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          pair: { type: "string", description: 'Pair name (e.g. "TONCOIN-USDT")' },
          start_date: { type: "string", description: "Start date (ISO 8601, e.g. 2026-03-01T00:00:00Z)" },
          end_date: { type: "string", description: "End date (ISO 8601)" },
          period: { type: "string", description: "Candle period: PERIOD_1_MINUTE, PERIOD_5_MINUTES, PERIOD_15_MINUTES, PERIOD_30_MINUTES, PERIOD_1_HOUR, PERIOD_2_HOURS, PERIOD_4_HOURS, PERIOD_5_HOURS, PERIOD_8_HOURS, PERIOD_12_HOURS, PERIOD_1_DAY, PERIOD_2_DAYS, PERIOD_1_WEEK, PERIOD_1_MONTH" },
        },
        required: ["pair", "start_date", "end_date", "period"],
      },
      execute: async (params) => {
        try {
          const pair = validateString(params.pair, "pair");
          const period = validateEnum(params.period, PERIODS, "period");
          const startDate = validateString(params.start_date, "start_date");
          const endDate = validateString(params.end_date, "end_date");
          const json = await tradeFetch(`/time-series/${encodeURIComponent(pair)}`, {
            auth: false,
            params: { startDate, endDate, period },
          });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_rate",
      description: "Get the exchange rate between two crypto currencies.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          base: { type: "string", description: 'Base currency (e.g. "TONCOIN")' },
          quote: { type: "string", description: 'Quote currency (e.g. "USDT")' },
        },
        required: ["base", "quote"],
      },
      execute: async (params) => {
        try {
          const base = validateString(params.base, "base");
          const quote = validateString(params.quote, "quote");
          const json = await tradeFetch(
            `/rates/crypto/${encodeURIComponent(base)}/${encodeURIComponent(quote)}`,
            { auth: false }
          );
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    // === Orders (4) ======================================================

    {
      name: "xtrade_order_create",
      description: "Place a buy or sell order (limit or market) on a trading pair.",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          pair: { type: "string", description: 'Trading pair (e.g. "TONCOIN-USDT")' },
          order_type: { type: "string", description: "Order type: BUY or SELL" },
          execute_type: { type: "string", description: "Execution type: LIMIT or MARKET" },
          amount: { type: "number", description: "Order amount" },
          currency: { type: "string", description: "Amount currency" },
          rate: { type: "number", description: "Limit price (required for LIMIT orders)" },
        },
        required: ["pair", "order_type", "execute_type", "amount", "currency"],
      },
      execute: async (params) => {
        try {
          const pair = validateString(params.pair, "pair");
          const type = validateEnum(params.order_type, ORDER_TYPES, "order_type");
          const executeType = validateEnum(params.execute_type, EXECUTE_TYPES, "execute_type");
          const amount = validateAmount(params.amount, "amount");
          const currency = validateString(params.currency, "currency");

          if (executeType === "LIMIT" && (params.rate === undefined || params.rate === null))
            throw new Error("rate is required for LIMIT orders");

          const body = { pair, type, executeType, amount, currency };
          if (params.rate !== undefined && params.rate !== null) {
            const rate = Number(params.rate);
            if (!Number.isFinite(rate) || rate <= 0)
              throw new Error("Invalid rate: must be a positive number");
            body.rate = rate;
          }

          const json = await tradeFetch("/orders", { method: "POST", body });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_order_list",
      description: "List your exchange orders (active or historical).",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          only_active: { type: "boolean", description: "Show only active orders (default true)" },
          limit: { type: "number", description: "Results per page (1-1000, default 100)" },
          offset: { type: "number", description: "Pagination offset (default 0)" },
        },
      },
      execute: async (params) => {
        try {
          const qs = { onlyActive: params.only_active !== false };
          if (params.limit !== undefined)
            qs.limit = Math.min(Math.max(1, Math.floor(Number(params.limit))), 1000);
          if (params.offset !== undefined)
            qs.offset = Math.max(0, Math.floor(Number(params.offset)));
          const json = await tradeFetch("/orders", { params: qs });
          return { success: true, data: { total: json.total, results: json.results ?? json.data ?? [] } };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_order_info",
      description: "Get details of a specific order by ID.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order ID" },
        },
        required: ["order_id"],
      },
      execute: async (params) => {
        try {
          const id = validateString(params.order_id, "order_id");
          const json = await tradeFetch(`/orders/${encodeURIComponent(id)}`);
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xtrade_order_cancel",
      description: "Cancel an active exchange order.",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order ID to cancel" },
        },
        required: ["order_id"],
      },
      execute: async (params) => {
        try {
          const id = validateString(params.order_id, "order_id");
          const json = await tradeFetch(`/orders/${encodeURIComponent(id)}`, { method: "DELETE" });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },
  ];
};
