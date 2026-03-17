/**
 * DYOR plugin -- TON jetton analytics from DYOR.io
 *
 * Provides token search, detailed info, trust scores, pricing, charts,
 * metrics, statistics, holder data, DEX transactions, market pools, and
 * trending token discovery. All data comes from the public DYOR.io API
 * (no auth required).
 */

const API_BASE = "https://api.dyor.io";
const RATE_LIMIT_MS = 1000; // free plan: 1 req/s

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function dyorFetch(path, params = {}) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();

  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`DYOR API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function parseDecimal(obj) {
  if (!obj || obj.value === undefined || obj.decimals === undefined) return null;
  return Number(obj.value) * Math.pow(10, -obj.decimals);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatJettonSummary(j) {
  return {
    address: j.metadata?.address ?? j.address,
    name: j.metadata?.name ?? j.name,
    symbol: j.metadata?.symbol ?? j.symbol,
    price_usd: parseDecimal(j.priceUsd) ?? parseDecimal(j.price),
    trustScore: j.trustScore ?? null,
    holdersCount: j.holdersCount ?? null,
    fdmc: parseDecimal(j.fdmc),
    liquidityUsd: parseDecimal(j.liquidityUsd),
    verification: j.verification ?? null,
  };
}

function formatJettonDetails(d) {
  const m = d.metadata ?? {};
  return {
    address: m.address,
    name: m.name,
    symbol: m.symbol,
    decimals: m.decimals,
    image: m.image ?? null,
    description: m.description ?? null,
    links: m.links ?? [],
    createdAt: m.createdAt ?? null,
    admin: d.admin?.address ?? null,
    totalSupply: parseDecimal(d.totalSupply),
    mintable: d.mintable ?? null,
    modifiedContract: d.modifiedContract ?? null,
    verification: d.verification ?? null,
    price_ton: parseDecimal(d.price),
    price_usd: parseDecimal(d.priceUsd),
    holdersCount: d.holdersCount ?? null,
    liquidityUsd: parseDecimal(d.liquidityUsd),
    fdmc: parseDecimal(d.fdmc),
    mcap: parseDecimal(d.mcap),
    trustScore: d.trustScore ?? null,
    circulatingSupply: parseDecimal(d.circulatingSupply),
  };
}

function formatMetrics(m) {
  return {
    address: m.address ?? null,
    price_ton: parseDecimal(m.price),
    price_usd: parseDecimal(m.priceUsd),
    price_currency: parseDecimal(m.priceCurrency),
    holdersCount: m.holdersCount ?? null,
    liquidityUsd: parseDecimal(m.liquidityUsd),
    liquidityCurrency: parseDecimal(m.liquidityCurrency),
    fdmc: parseDecimal(m.fdmc),
    fdmcCurrency: parseDecimal(m.fdmcCurrency),
    mcap: parseDecimal(m.mcap),
    mcapCurrency: parseDecimal(m.mcapCurrency),
    circulatingSupply: parseDecimal(m.circulatingSupply),
    trustScore: m.trustScore ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sort field enums
// ---------------------------------------------------------------------------

const SORT_FIELDS = [
  "createdAt", "fdmc", "tvl", "liquidityUsd", "trustScore",
  "volume24h", "holders", "traders24h", "transactions24h",
  "tonPriceChangeHour", "tonPriceChangeHour6", "tonPriceChangeDay",
  "tonPriceChangeWeek", "tonPriceChangeMonth",
];

const TRENDING_SORT_FIELDS = [
  "volume24h", "tonPriceChangeHour", "tonPriceChangeDay",
  "tonPriceChangeWeek", "holders", "trustScore", "fdmc",
];

const TX_TYPE_MAP = {
  buy: "TT_BUY",
  sell: "TT_SELL",
  liquidity_deposit: "TT_LIQUIDITY_DEPOSIT",
  liquidity_withdraw: "TT_LIQUIDITY_WITHDRAW",
};

// ---------------------------------------------------------------------------
// Export -- SDK wrapper
// ---------------------------------------------------------------------------

export const manifest = {
  name: "dyor",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "TON token analytics from DYOR.io -- search, price, trust score, metrics, DEX trades, holders, pools",
};

export const tools = (sdk) => {

// ---------------------------------------------------------------------------
// Tool 1: dyor_search
// ---------------------------------------------------------------------------

const dyorSearch = {
  name: "dyor_search",
  description:
    "Search TON jettons by name or symbol on DYOR.io. Use when the user wants to find a token by keyword. Requires at least 3 characters. Returns address, name, symbol, price, trust score, holders, FDMC, and verification status.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Search query (token name or symbol, min 3 characters)",
      },
      sort: {
        type: "string",
        enum: SORT_FIELDS,
        description: "Sort field (default: fdmc)",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort order (default: desc)",
      },
      limit: {
        type: "integer",
        description: "Number of results, 1-100 (default: 20)",
        minimum: 1,
        maximum: 100,
      },
      excludeScam: {
        type: "boolean",
        description: "Exclude tokens flagged as scam (default: true)",
      },
    },
    required: ["search"],
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch("/v1/jettons", {
        search: params.search,
        sort: params.sort ?? "fdmc",
        order: params.order ?? "desc",
        limit: params.limit ?? 20,
        excludeScam: params.excludeScam ?? true,
      });
      const jettons = (data.jettons ?? []).map(formatJettonSummary);
      return { success: true, data: { jettons, next: data.next ?? null } };
    } catch (err) {
      sdk.log.error("dyor_search:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: dyor_details
// ---------------------------------------------------------------------------

const dyorDetails = {
  name: "dyor_details",
  description:
    "Get full details for a TON jetton by its contract address on DYOR.io. Returns metadata (name, symbol, decimals, image, description, links, creation date), admin address, total supply, mintability, verification status, prices in TON and USD, holders, liquidity, FDMC, market cap, trust score, and circulating supply.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch(`/v1/jettons/${params.address}`);
      return { success: true, data: formatJettonDetails(data.details ?? data) };
    } catch (err) {
      sdk.log.error("dyor_details:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: dyor_trust_score
// ---------------------------------------------------------------------------

const dyorTrustScore = {
  name: "dyor_trust_score",
  description:
    "Get the DYOR.io trust score for a TON jetton. Use to quickly assess token legitimacy. Returns a score from 0-100 and the last update time.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch(`/v1/jettons/${params.address}/trust-score`);
      return {
        success: true,
        data: {
          address: data.address ?? params.address,
          score: data.score ?? null,
          updatedAt: data.updatedAt ?? null,
        },
      };
    } catch (err) {
      sdk.log.error("dyor_trust_score:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: dyor_price
// ---------------------------------------------------------------------------

const dyorPrice = {
  name: "dyor_price",
  description:
    "Get the current price of a TON jetton in TON, USD, and an optional currency. Use when the user needs the latest price for a specific token address.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
      currency: {
        type: "string",
        description: "Additional currency code (default: usd)",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch(`/v1/jettons/${params.address}/price`, {
        currency: params.currency ?? "usd",
      });
      return {
        success: true,
        data: {
          ton: data.ton ? { value: parseDecimal(data.ton), changedAt: data.ton.changedAt } : null,
          usd: data.usd ? { value: parseDecimal(data.usd), changedAt: data.usd.changedAt } : null,
          currency: data.currency ? { value: parseDecimal(data.currency), changedAt: data.currency.changedAt } : null,
        },
      };
    } catch (err) {
      sdk.log.error("dyor_price:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: dyor_price_chart
// ---------------------------------------------------------------------------

const dyorPriceChart = {
  name: "dyor_price_chart",
  description:
    "Get price chart data points for a TON jetton over time. Supports different resolutions: min1 (max 24h), min15 (max 7d), hour1 (max 30d), day1 (max 365d). Use for price trend analysis and charting.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
      resolution: {
        type: "string",
        enum: ["min1", "min15", "hour1", "day1"],
        description: "Chart resolution (default: hour1). Max ranges: min1=24h, min15=7d, hour1=30d, day1=365d",
      },
      from: {
        type: "string",
        description: "Start time as ISO 8601 datetime (optional)",
      },
      to: {
        type: "string",
        description: "End time as ISO 8601 datetime (optional)",
      },
      currency: {
        type: "string",
        description: "Price currency (default: usd)",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch(`/v1/jettons/${params.address}/price/chart`, {
        resolution: params.resolution ?? "hour1",
        from: params.from,
        to: params.to,
        currency: params.currency ?? "usd",
      });
      const points = (data.points ?? []).map((p) => ({
        value: parseDecimal(p.value) ?? p.value,
        time: p.time,
      }));
      return { success: true, data: { points } };
    } catch (err) {
      sdk.log.error("dyor_price_chart:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: dyor_metrics
// ---------------------------------------------------------------------------

const dyorMetrics = {
  name: "dyor_metrics",
  description:
    "Get consolidated metrics for a TON jetton: price (TON/USD), holders, liquidity, FDMC, market cap, circulating supply, and trust score. Use for a quick overview of key token metrics.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
      currency: {
        type: "string",
        description: "Currency for values (default: usd)",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch(`/v1/jettons/${params.address}/metrics`, {
        currency: params.currency ?? "usd",
      });
      return { success: true, data: formatMetrics(data.metrics ?? data) };
    } catch (err) {
      sdk.log.error("dyor_metrics:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 7: dyor_stats
// ---------------------------------------------------------------------------

const dyorStats = {
  name: "dyor_stats",
  description:
    "Get percentage change statistics for a TON jetton: price changes, volume, traders, and transactions broken down by hour, 6h, day, week, and month. Use to analyze token momentum and trends.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch(`/v1/jettons/${params.address}/stats`);
      return { success: true, data: data.stats ?? data };
    } catch (err) {
      sdk.log.error("dyor_stats:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 8: dyor_holders
// ---------------------------------------------------------------------------

const dyorHolders = {
  name: "dyor_holders",
  description:
    "Get holder data for a TON jetton. By default returns the current holder count. Set history=true to get holder count over time (ticks). Use to track holder growth or check current holder numbers.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
      history: {
        type: "boolean",
        description: "If true, return holder count history ticks instead of current count (default: false)",
      },
      limit: {
        type: "integer",
        description: "Number of history ticks to return (only used when history=true)",
        minimum: 1,
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const history = params.history ?? false;
      if (history) {
        const data = await dyorFetch(`/v1/jettons/${params.address}/holders/ticks`, {
          limit: params.limit,
        });
        return { success: true, data: data };
      }
      const data = await dyorFetch(`/v1/jettons/${params.address}/holders`);
      return {
        success: true,
        data: {
          value: data.value ?? null,
          changedAt: data.changedAt ?? null,
        },
      };
    } catch (err) {
      sdk.log.error("dyor_holders:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 9: dyor_transactions
// ---------------------------------------------------------------------------

const dyorTransactions = {
  name: "dyor_transactions",
  description:
    "Get recent DEX transactions for a TON jetton. Supports filtering by transaction type (buy/sell/liquidity_deposit/liquidity_withdraw), exchange (dedust/stonfi/tonco), and wallet address. Use to analyze trading activity.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
      limit: {
        type: "integer",
        description: "Number of transactions, 1-100 (default: 20)",
        minimum: 1,
        maximum: 100,
      },
      type: {
        type: "string",
        enum: ["buy", "sell", "liquidity_deposit", "liquidity_withdraw"],
        description: "Filter by transaction type",
      },
      exchangeId: {
        type: "string",
        enum: ["dedust", "stonfi", "tonco"],
        description: "Filter by DEX exchange",
      },
      who: {
        type: "string",
        description: "Filter by wallet address",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const apiType = params.type ? TX_TYPE_MAP[params.type] : undefined;
      const data = await dyorFetch(`/v1/jettons/${params.address}/transactions`, {
        limit: params.limit ?? 20,
        type: apiType,
        exchangeId: params.exchangeId,
        who: params.who,
      });
      return { success: true, data: data.transactions ?? data };
    } catch (err) {
      sdk.log.error("dyor_transactions:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 10: dyor_markets
// ---------------------------------------------------------------------------

const dyorMarkets = {
  name: "dyor_markets",
  description:
    "Get DEX pool/market data for a TON jetton. Returns available trading pools with liquidity, prices, and counterpart tokens. Optionally filter by exchange (dedust/stonfi/tonco).",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton contract address",
      },
      exchangeId: {
        type: "string",
        enum: ["dedust", "stonfi", "tonco"],
        description: "Filter by DEX exchange",
      },
      limit: {
        type: "integer",
        description: "Number of markets, 1-100 (default: 20)",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch(`/v1/jettons/${params.address}/markets`, {
        exchangeId: params.exchangeId,
        limit: params.limit ?? 20,
      });
      return { success: true, data: data.markets ?? data };
    } catch (err) {
      sdk.log.error("dyor_markets:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 11: dyor_trending
// ---------------------------------------------------------------------------

const dyorTrending = {
  name: "dyor_trending",
  description:
    "Get trending TON jettons sorted by a chosen metric. Use to discover top tokens by volume, price change, holders, trust score, or market cap. Does NOT search by name -- use dyor_search for that.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      sort: {
        type: "string",
        enum: TRENDING_SORT_FIELDS,
        description: "Metric to sort by (default: volume24h)",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort order (default: desc)",
      },
      limit: {
        type: "integer",
        description: "Number of results, 1-100 (default: 20)",
        minimum: 1,
        maximum: 100,
      },
      excludeScam: {
        type: "boolean",
        description: "Exclude tokens flagged as scam (default: true)",
      },
    },
  },

  execute: async (params) => {
    try {
      const data = await dyorFetch("/v1/jettons", {
        sort: params.sort ?? "volume24h",
        order: params.order ?? "desc",
        limit: params.limit ?? 20,
        excludeScam: params.excludeScam ?? true,
      });
      const jettons = (data.jettons ?? []).map(formatJettonSummary);
      return { success: true, data: { jettons, next: data.next ?? null } };
    } catch (err) {
      sdk.log.error("dyor_trending:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Return tools array
// ---------------------------------------------------------------------------

return [
  dyorSearch,
  dyorDetails,
  dyorTrustScore,
  dyorPrice,
  dyorPriceChart,
  dyorMetrics,
  dyorStats,
  dyorHolders,
  dyorTransactions,
  dyorMarkets,
  dyorTrending,
];

}; // end tools(sdk)
