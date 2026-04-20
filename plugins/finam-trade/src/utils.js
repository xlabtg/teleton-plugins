const FINAM_SYMBOL_RE = /^[A-Z0-9._-]+@[A-Z0-9._-]+$/i;
const DECIMAL_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const SENSITIVE_KEY_RE = /authorization|token|secret|password|api[-_]?key/i;

const SIDE_MAP = {
  buy: "SIDE_BUY",
  bid: "SIDE_BUY",
  long: "SIDE_BUY",
  sell: "SIDE_SELL",
  ask: "SIDE_SELL",
  short: "SIDE_SELL",
};

const ORDER_TYPE_MAP = {
  market: "ORDER_TYPE_MARKET",
  limit: "ORDER_TYPE_LIMIT",
  stop: "ORDER_TYPE_STOP",
  stop_market: "ORDER_TYPE_STOP",
  stop_limit: "ORDER_TYPE_STOP_LIMIT",
  multi_leg: "ORDER_TYPE_MULTI_LEG",
};

const TIME_IN_FORCE_MAP = {
  day: "TIME_IN_FORCE_DAY",
  gtc: "TIME_IN_FORCE_GOOD_TILL_CANCEL",
  good_till_cancel: "TIME_IN_FORCE_GOOD_TILL_CANCEL",
  good_till_crossing: "TIME_IN_FORCE_GOOD_TILL_CROSSING",
  ext: "TIME_IN_FORCE_EXT",
  on_open: "TIME_IN_FORCE_ON_OPEN",
  on_close: "TIME_IN_FORCE_ON_CLOSE",
  ioc: "TIME_IN_FORCE_IOC",
  fok: "TIME_IN_FORCE_FOK",
};

const TIMEFRAME_MAP = {
  m1: "TIME_FRAME_M1",
  "1m": "TIME_FRAME_M1",
  m5: "TIME_FRAME_M5",
  "5m": "TIME_FRAME_M5",
  m15: "TIME_FRAME_M15",
  "15m": "TIME_FRAME_M15",
  m30: "TIME_FRAME_M30",
  "30m": "TIME_FRAME_M30",
  h1: "TIME_FRAME_H1",
  "1h": "TIME_FRAME_H1",
  h2: "TIME_FRAME_H2",
  "2h": "TIME_FRAME_H2",
  h4: "TIME_FRAME_H4",
  "4h": "TIME_FRAME_H4",
  h8: "TIME_FRAME_H8",
  "8h": "TIME_FRAME_H8",
  d: "TIME_FRAME_D",
  "1d": "TIME_FRAME_D",
  day: "TIME_FRAME_D",
  w: "TIME_FRAME_W",
  "1w": "TIME_FRAME_W",
  week: "TIME_FRAME_W",
  mn: "TIME_FRAME_MN",
  month: "TIME_FRAME_MN",
  qr: "TIME_FRAME_QR",
  quarter: "TIME_FRAME_QR",
};

const STOP_CONDITION_MAP = {
  last_up: "STOP_CONDITION_LAST_UP",
  up: "STOP_CONDITION_LAST_UP",
  last_down: "STOP_CONDITION_LAST_DOWN",
  down: "STOP_CONDITION_LAST_DOWN",
};

const VALID_BEFORE_MAP = {
  day: "VALID_BEFORE_END_OF_DAY",
  end_of_day: "VALID_BEFORE_END_OF_DAY",
  gtc: "VALID_BEFORE_GOOD_TILL_CANCEL",
  good_till_cancel: "VALID_BEFORE_GOOD_TILL_CANCEL",
  till_cancelled: "VALID_BEFORE_GOOD_TILL_CANCEL",
  till_canceled: "VALID_BEFORE_GOOD_TILL_CANCEL",
  date: "VALID_BEFORE_GOOD_TILL_DATE",
  specified: "VALID_BEFORE_GOOD_TILL_DATE",
  good_till_date: "VALID_BEFORE_GOOD_TILL_DATE",
};

const REPORT_FORM_MAP = {
  short: "REPORT_FORM_SHORT",
  long: "REPORT_FORM_LONG",
  unknown: "REPORT_FORM_UNKNOWN",
};

const TP_SPREAD_MEASURE_MAP = {
  percent: "TP_SPREAD_MEASURE_PERCENT",
  value: "TP_SPREAD_MEASURE_VALUE",
  points: "TP_SPREAD_MEASURE_VALUE",
  price: "TP_SPREAD_MEASURE_VALUE",
};

function normalizeEnum(value, prefix, aliases, fieldName) {
  if (value == null || value === "") return undefined;
  const raw = String(value).trim();
  const upper = raw.toUpperCase();
  if (upper.startsWith(prefix)) return upper;
  const mapped = aliases[raw.toLowerCase()];
  if (mapped) return mapped;
  throw new Error(`Invalid ${fieldName}: ${value}`);
}

export function normalizeSymbol(symbol) {
  const normalized = String(symbol ?? "").trim().toUpperCase();
  if (!FINAM_SYMBOL_RE.test(normalized)) {
    throw new Error('Invalid symbol. Use Finam "ticker@mic" format, for example SBER@MISX.');
  }
  return normalized;
}

export function normalizeOrderSide(value) {
  return normalizeEnum(value, "SIDE_", SIDE_MAP, "side");
}

export function normalizeOrderType(value) {
  return normalizeEnum(value, "ORDER_TYPE_", ORDER_TYPE_MAP, "type");
}

export function normalizeTimeInForce(value) {
  return normalizeEnum(value, "TIME_IN_FORCE_", TIME_IN_FORCE_MAP, "time_in_force");
}

export function normalizeTimeframe(value) {
  return normalizeEnum(value ?? "TIME_FRAME_D", "TIME_FRAME_", TIMEFRAME_MAP, "timeframe");
}

export function normalizeStopCondition(value) {
  return normalizeEnum(value, "STOP_CONDITION_", STOP_CONDITION_MAP, "stop_condition");
}

export function normalizeValidBefore(value) {
  return normalizeEnum(value, "VALID_BEFORE_", VALID_BEFORE_MAP, "valid_before");
}

export function normalizeReportForm(value) {
  return normalizeEnum(value ?? "REPORT_FORM_SHORT", "REPORT_FORM_", REPORT_FORM_MAP, "report_form");
}

export function normalizeTpSpreadMeasure(value) {
  return normalizeEnum(value, "TP_SPREAD_MEASURE_", TP_SPREAD_MEASURE_MAP, "tp_spread_measure");
}

export function decimalValue(value, fieldName = "decimal") {
  if (value == null || value === "") return undefined;
  if (typeof value === "object" && value.value != null) return decimalValue(value.value, fieldName);
  const text = String(value).trim();
  if (!DECIMAL_RE.test(text)) {
    throw new Error(`Invalid ${fieldName}. Expected a decimal string with "." as separator.`);
  }
  return { value: text };
}

export function decimalString(value) {
  if (value == null) return null;
  if (typeof value === "object" && value.value != null) return String(value.value);
  return String(value);
}

export function decimalNumber(value) {
  const text = decimalString(value);
  if (text == null || text === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function moneyValue(value) {
  if (value == null) return null;
  if (typeof value === "object" && value.value != null) return decimalNumber(value.value);
  if (typeof value === "object" && (value.units != null || value.nanos != null)) {
    const units = Number(value.units ?? 0);
    const nanos = Number(value.nanos ?? 0);
    if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
    return units + nanos / 1e9;
  }
  return decimalNumber(value);
}

export function compact(object) {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

export function withIntervalQuery(params = {}) {
  return compact({
    limit: params.limit,
    "interval.start_time": params.start_time ?? params.interval?.start_time,
    "interval.end_time": params.end_time ?? params.interval?.end_time,
  });
}

export function parseJwtExpiration(token) {
  const payload = String(token ?? "").split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = Number(decoded.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^bearer\s+/i.test(value)) return "[REDACTED]";
    return value;
  }

  const result = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactSensitive(nestedValue);
  }
  return result;
}

export function formatError(err) {
  const message = err?.message || String(err);
  return String(message).replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]").slice(0, 500);
}

export function assertSafeHttpsUrl(input) {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("Finam API base URL must use HTTPS.");
  if (url.username || url.password) throw new Error("Finam API base URL must not include credentials.");

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Finam API base URL must not point to a local host.");
  }

  const parts = host.split(".").map((part) => Number(part));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts;
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0;
    if (isPrivate) throw new Error("Finam API base URL must not point to a local or private network.");
  }
}

export function buildUrl(apiBase, path, query = {}) {
  assertSafeHttpsUrl(apiBase);
  const url = new URL(path, apiBase);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export function encodePath(value) {
  return encodeURIComponent(String(value));
}

export function mapPosition(position) {
  return {
    symbol: position.symbol ?? null,
    quantity: decimalString(position.quantity),
    qty: decimalNumber(position.quantity),
    average_price: decimalString(position.average_price),
    avg_price: decimalNumber(position.average_price),
    current_price: decimalNumber(position.current_price),
    maintenance_margin: decimalNumber(position.maintenance_margin),
    daily_pnl: decimalNumber(position.daily_pnl),
    unrealized_pnl: decimalNumber(position.unrealized_pnl),
  };
}

export function mapCash(cash) {
  return {
    currency: cash.currency_code ?? cash.currency ?? null,
    amount: moneyValue(cash),
    available: moneyValue(cash.available ?? cash),
    units: cash.units ?? null,
    nanos: cash.nanos ?? null,
  };
}

export function mapAsset(asset) {
  return {
    symbol: asset.symbol ?? null,
    id: asset.id ?? null,
    ticker: asset.ticker ?? null,
    mic: asset.mic ?? null,
    isin: asset.isin ?? null,
    type: asset.type ?? null,
    name: asset.name ?? null,
    board: asset.board ?? null,
    currency: asset.quote_currency ?? asset.currency ?? null,
    lot_size: decimalString(asset.lot_size),
    min_step: asset.min_step ?? null,
    decimals: asset.decimals ?? null,
    is_archived: asset.is_archived ?? null,
  };
}

export function mapTrade(trade) {
  return {
    trade_id: trade.trade_id ?? null,
    order_id: trade.order_id ?? null,
    account_id: trade.account_id ?? null,
    symbol: trade.symbol ?? null,
    qty: decimalNumber(trade.size ?? trade.quantity),
    quantity: decimalString(trade.size ?? trade.quantity),
    price: decimalNumber(trade.price),
    side: trade.side ?? null,
    timestamp: trade.timestamp ?? null,
    comment: trade.comment ?? null,
  };
}

export function mapOrder(order) {
  return {
    order_id: order.order_id ?? order.id ?? null,
    symbol: order.symbol ?? null,
    side: order.side ?? null,
    type: order.type ?? null,
    status: order.status ?? null,
    qty: decimalNumber(order.quantity ?? order.size),
    quantity: decimalString(order.quantity ?? order.size),
    price: decimalNumber(order.price ?? order.limit_price),
    filled_qty: decimalNumber(order.filled_quantity ?? order.filled_qty),
    avg_price: decimalNumber(order.average_price ?? order.avg_price),
    reject_reason: order.reject_reason ?? null,
    created_at: order.created_at ?? null,
    updated_at: order.updated_at ?? null,
    comment: order.comment ?? null,
  };
}

export function getCache(sdk, key, now = Date.now()) {
  if (!sdk?.db?.prepare) return null;
  try {
    const row = sdk.db
      .prepare("SELECT value, expires_at FROM finam_cache WHERE key = ?")
      .get(key);
    if (!row || Number(row.expires_at) <= now) return null;
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function setCache(sdk, key, value, ttlMs, now = Date.now()) {
  if (!sdk?.db?.prepare) return;
  try {
    sdk.db
      .prepare("INSERT OR REPLACE INTO finam_cache (key, value, expires_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), now + ttlMs);
  } catch {
    // Cache failures must not break trading tools.
  }
}
