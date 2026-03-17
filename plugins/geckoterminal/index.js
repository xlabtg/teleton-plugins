/**
 * GeckoTerminal plugin -- TON DEX pool and token data from GeckoTerminal
 *
 * Provides trending, new, and top pools, pool search, detailed pool info,
 * trade history, OHLCV candles, token info, token pools, and batch price
 * lookups. All data comes from the public GeckoTerminal API (no auth required).
 */

const API_BASE = "https://api.geckoterminal.com/api/v2/";

// Shared fetch helper. Builds the URL, attaches query params, sets JSON accept
// header, and returns parsed JSON. Throws on non-2xx responses.
async function geckoFetch(path, params = {}) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`GeckoTerminal API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Formatting helpers -- flatten JSON:API responses for the LLM
// ---------------------------------------------------------------------------

function formatPools(response) {
  const included = response.included ?? [];
  const tokenMap = Object.fromEntries(
    included.filter((i) => i.type === "token").map((t) => [t.id, t.attributes]),
  );
  const dexMap = Object.fromEntries(
    included.filter((i) => i.type === "dex").map((d) => [d.id, d.attributes]),
  );

  const pools = Array.isArray(response.data) ? response.data : [response.data];
  return pools.map((p) => {
    const a = p.attributes;
    const baseTokenId = p.relationships?.base_token?.data?.id;
    const quoteTokenId = p.relationships?.quote_token?.data?.id;
    const dexId = p.relationships?.dex?.data?.id;
    return {
      address: a.address,
      name: a.name,
      created_at: a.pool_created_at,
      base_token: tokenMap[baseTokenId] ?? { address: baseTokenId?.replace("ton_", "") },
      quote_token: tokenMap[quoteTokenId] ?? { address: quoteTokenId?.replace("ton_", "") },
      dex: dexMap[dexId]?.name ?? dexId,
      price_usd: a.base_token_price_usd,
      fdv_usd: a.fdv_usd,
      market_cap_usd: a.market_cap_usd,
      liquidity_usd: a.reserve_in_usd,
      volume_usd_24h: a.volume_usd?.h24,
      price_change_24h: a.price_change_percentage?.h24,
      buys_24h: a.transactions?.h24?.buys,
      sells_24h: a.transactions?.h24?.sells,
    };
  });
}

function formatTrades(response) {
  const trades = Array.isArray(response.data) ? response.data : [response.data];
  return trades.map((t) => {
    const a = t.attributes;
    return {
      kind: a.kind,
      volume_usd: a.volume_in_usd,
      from_token: a.from_token_address,
      to_token: a.to_token_address,
      from_amount: a.from_token_amount,
      to_amount: a.to_token_amount,
      price_from_usd: a.price_from_in_usd,
      price_to_usd: a.price_to_in_usd,
      tx_hash: a.tx_hash,
      timestamp: a.block_timestamp,
    };
  });
}

// ---------------------------------------------------------------------------
// Factory for pool list endpoints (tools 1-3 share the same pattern)
// ---------------------------------------------------------------------------

function makePoolListTool(name, description, pathSuffix, sdk) {
  return {
    name,
    description,
    category: "data-bearing",
    scope: "always",
    parameters: {
      type: "object",
      properties: {
        page: { type: "integer", description: "Page number (1-indexed)", minimum: 1 },
      },
    },
    execute: async (params) => {
      try {
        const data = await geckoFetch(`networks/ton${pathSuffix}`, {
          page: params.page,
          include: "base_token,quote_token,dex",
        });
        return { success: true, data: formatPools(data) };
      } catch (err) {
        sdk.log.error(`${name}:`, err.message);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Export -- SDK wrapper
// ---------------------------------------------------------------------------

export const manifest = {
  name: "geckoterminal",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "TON DEX pool and token data -- trending, new, and top pools, trades, OHLCV, token info, batch prices",
};

export const tools = (sdk) => {

// ---------------------------------------------------------------------------
// Tool 1: gecko_trending_pools
// ---------------------------------------------------------------------------

const geckoTrendingPools = makePoolListTool(
  "gecko_trending_pools",
  "Get trending pools on the TON network ranked by recent visits and trading activity. Use to discover popular or hot pools.",
  "/trending_pools",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 2: gecko_new_pools
// ---------------------------------------------------------------------------

const geckoNewPools = makePoolListTool(
  "gecko_new_pools",
  "Get newly created pools on the TON network (last 48 hours). Use to discover freshly launched tokens and new liquidity pools.",
  "/new_pools",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 3: gecko_top_pools
// ---------------------------------------------------------------------------

const geckoTopPools = makePoolListTool(
  "gecko_top_pools",
  "Get top pools on the TON network sorted by liquidity and volume. Use to find the largest and most liquid trading pairs.",
  "/pools",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 4: gecko_search_pools
// ---------------------------------------------------------------------------

const geckoSearchPools = {
  name: "gecko_search_pools",
  description:
    "Search for pools on the TON network by token name, symbol, or contract address. Use when the user asks about a specific token or wants to find a pool.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (token name, symbol, or address)" },
      page: { type: "integer", description: "Page number (1-indexed)", minimum: 1 },
    },
    required: ["query"],
  },

  execute: async (params) => {
    try {
      const data = await geckoFetch("search/pools", {
        query: params.query,
        network: "ton",
        page: params.page,
      });
      return { success: true, data: formatPools(data) };
    } catch (err) {
      sdk.log.error("gecko_search_pools:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: gecko_pool_info
// ---------------------------------------------------------------------------

const geckoPoolInfo = {
  name: "gecko_pool_info",
  description:
    "Get detailed information for a specific pool on TON by its contract address. Returns price, volume, liquidity, fees, and token data.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool_address: { type: "string", description: "Pool contract address" },
    },
    required: ["pool_address"],
  },

  execute: async (params) => {
    try {
      const data = await geckoFetch(`networks/ton/pools/${params.pool_address}`, {
        include: "base_token,quote_token,dex",
      });
      const pools = formatPools(data);
      const pool = pools[0];
      // Add extra fields available on single-pool endpoint
      const a = data.data.attributes;
      pool.fee_percentage = a.pool_fee_percentage;
      pool.locked_liquidity_percentage = a.locked_liquidity_percentage;
      pool.volume_usd = a.volume_usd;
      pool.price_change = a.price_change_percentage;
      pool.transactions = a.transactions;
      return { success: true, data: pool };
    } catch (err) {
      sdk.log.error("gecko_pool_info:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: gecko_pool_trades
// ---------------------------------------------------------------------------

const geckoPoolTrades = {
  name: "gecko_pool_trades",
  description:
    "Get recent trades for a specific pool on TON. Returns up to 300 trades from the last 24 hours with buy/sell type, amounts, and USD values.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool_address: { type: "string", description: "Pool contract address" },
      min_usd: {
        type: "number",
        description: "Minimum trade volume in USD to filter by",
      },
    },
    required: ["pool_address"],
  },

  execute: async (params) => {
    try {
      const data = await geckoFetch(`networks/ton/pools/${params.pool_address}/trades`, {
        trade_volume_in_usd_greater_than: params.min_usd,
      });
      return { success: true, data: formatTrades(data) };
    } catch (err) {
      sdk.log.error("gecko_pool_trades:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 7: gecko_pool_ohlcv
// ---------------------------------------------------------------------------

const geckoPoolOhlcv = {
  name: "gecko_pool_ohlcv",
  description:
    "Get OHLCV candlestick data for a pool on TON. Supports day, hour, and minute timeframes with configurable aggregation. Use for charting and price analysis.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool_address: { type: "string", description: "Pool contract address" },
      timeframe: {
        type: "string",
        enum: ["day", "hour", "minute"],
        description: "Candle timeframe (default: day)",
      },
      aggregate: {
        type: "integer",
        description: "Number of periods to aggregate per candle (e.g. 4 with hour = 4h candles)",
      },
      limit: {
        type: "integer",
        description: "Number of candles to return (max 1000)",
        minimum: 1,
        maximum: 1000,
      },
      before_timestamp: {
        type: "integer",
        description: "Unix timestamp — return candles before this time",
      },
      currency: {
        type: "string",
        enum: ["usd", "token"],
        description: "Price denomination (default: usd)",
      },
    },
    required: ["pool_address"],
  },

  execute: async (params) => {
    try {
      const timeframe = params.timeframe ?? "day";
      const data = await geckoFetch(
        `networks/ton/pools/${params.pool_address}/ohlcv/${timeframe}`,
        {
          aggregate: params.aggregate,
          limit: params.limit,
          before_timestamp: params.before_timestamp,
          currency: params.currency,
        },
      );

      const ohlcvList = data.data?.attributes?.ohlcv_list ?? [];
      const candles = ohlcvList.map((c) => ({
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));

      return {
        success: true,
        data: {
          base: data.meta?.base ?? null,
          quote: data.meta?.quote ?? null,
          timeframe,
          candles,
        },
      };
    } catch (err) {
      sdk.log.error("gecko_pool_ohlcv:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 8: gecko_token_info
// ---------------------------------------------------------------------------

const geckoTokenInfo = {
  name: "gecko_token_info",
  description:
    "Get full token data on TON by contract address: price, 24h volume, FDV, market cap, total supply, and top pools.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      token_address: { type: "string", description: "Token contract address" },
    },
    required: ["token_address"],
  },

  execute: async (params) => {
    try {
      const data = await geckoFetch(`networks/ton/tokens/${params.token_address}`);
      const a = data.data.attributes;
      const topPools = data.data.relationships?.top_pools?.data?.map((p) =>
        p.id.replace("ton_", ""),
      ) ?? [];
      return {
        success: true,
        data: {
          address: a.address,
          name: a.name,
          symbol: a.symbol,
          decimals: a.decimals,
          image_url: a.image_url,
          coingecko_coin_id: a.coingecko_coin_id,
          price_usd: a.price_usd,
          fdv_usd: a.fdv_usd,
          market_cap_usd: a.market_cap_usd,
          total_supply: a.total_supply,
          volume_usd_24h: a.volume_usd?.h24,
          total_reserve_usd: a.total_reserve_in_usd,
          top_pools: topPools,
        },
      };
    } catch (err) {
      sdk.log.error("gecko_token_info:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 9: gecko_token_pools
// ---------------------------------------------------------------------------

const geckoTokenPools = {
  name: "gecko_token_pools",
  description:
    "Get all pools trading a specific token on TON. Use to find which DEX pools exist for a given token address.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      token_address: { type: "string", description: "Token contract address" },
      page: { type: "integer", description: "Page number (1-indexed)", minimum: 1 },
    },
    required: ["token_address"],
  },

  execute: async (params) => {
    try {
      const data = await geckoFetch(`networks/ton/tokens/${params.token_address}/pools`, {
        page: params.page,
        include: "base_token,quote_token,dex",
      });
      return { success: true, data: formatPools(data) };
    } catch (err) {
      sdk.log.error("gecko_token_pools:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 10: gecko_token_prices
// ---------------------------------------------------------------------------

const geckoTokenPrices = {
  name: "gecko_token_prices",
  description:
    "Batch price lookup for multiple tokens on TON (up to 30 addresses). Returns price, name, symbol, and top pools for each token.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      addresses: {
        type: "string",
        description: "Comma-separated token contract addresses (max 30)",
      },
    },
    required: ["addresses"],
  },

  execute: async (params) => {
    try {
      const data = await geckoFetch(`networks/ton/tokens/multi/${params.addresses}`, {
        include: "top_pools",
      });
      const tokens = (Array.isArray(data.data) ? data.data : [data.data]).map((t) => {
        const a = t.attributes;
        return {
          address: a.address,
          name: a.name,
          symbol: a.symbol,
          price_usd: a.price_usd,
          fdv_usd: a.fdv_usd,
          market_cap_usd: a.market_cap_usd,
          volume_usd_24h: a.volume_usd?.h24,
          total_reserve_usd: a.total_reserve_in_usd,
        };
      });
      return { success: true, data: tokens };
    } catch (err) {
      sdk.log.error("gecko_token_prices:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Return tools array
// ---------------------------------------------------------------------------

return [
  geckoTrendingPools,
  geckoNewPools,
  geckoTopPools,
  geckoSearchPools,
  geckoPoolInfo,
  geckoPoolTrades,
  geckoPoolOhlcv,
  geckoTokenInfo,
  geckoTokenPools,
  geckoTokenPrices,
];

}; // end tools(sdk)
