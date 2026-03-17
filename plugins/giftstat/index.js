/**
 * Giftstat plugin -- Telegram gift market data from giftstat.app
 *
 * Provides real-time and historical data on Telegram gift collections,
 * floor prices, model variants, backdrops, symbols, and TON exchange rates.
 * All data comes from the public Giftstat API (no auth required).
 */

const API_BASE = "https://api.giftstat.app";

// Shared fetch helper. Builds the URL, attaches query params, and returns
// parsed JSON. Throws on non-2xx responses so callers can catch uniformly.
async function giftstatFetch(path, params = {}) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Giftstat API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Pagination schema fragment -- reused by most tools
// ---------------------------------------------------------------------------

const paginationProps = {
  limit: {
    type: "integer",
    description: "Maximum number of results to return",
  },
  offset: {
    type: "integer",
    description: "Number of results to skip (for pagination)",
  },
};

// ---------------------------------------------------------------------------
// Factory for simple paginated endpoints (limit + offset only)
// ---------------------------------------------------------------------------

function makePaginatedTool(name, description, path, sdk) {
  return {
    name,
    description,
    category: "data-bearing",
    scope: "always",
    parameters: {
      type: "object",
      properties: { ...paginationProps },
    },
    execute: async (params) => {
      try {
        const result = await giftstatFetch(path, {
          limit: params.limit,
          offset: params.offset,
        });
        return { success: true, data: result };
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
  name: "giftstat",
  version: "1.0.1",
  sdkVersion: ">=1.0.0",
  description: "Telegram gift market data -- collections, floor prices, models, stats, history",
};

export const tools = (sdk) => {

// ---------------------------------------------------------------------------
// Tool 1: gift_collections
// Lists all gift collections with supply, pricing, and mint data.
// ---------------------------------------------------------------------------

const giftCollections = {
  name: "gift_collections",
  description:
    "List all Telegram gift collections with supply, pricing, and mint data. Use to browse available collections or check if a collection is sold out.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      fields: {
        type: "string",
        description: "Comma-separated list of fields to return (filters the response)",
      },
      ...paginationProps,
    },
  },

  execute: async (params) => {
    try {
      const result = await giftstatFetch("/current/collections", {
        fields: params.fields,
        limit: params.limit,
        offset: params.offset,
      });
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_collections:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: gift_floor_prices
// Floor prices per marketplace. Has an extra marketplace param.
// ---------------------------------------------------------------------------

const giftFloorPrices = {
  name: "gift_floor_prices",
  description:
    "Get current floor prices for gift collections on a specific marketplace. Supports portals, tonnel, fragment, and getgems.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "fragment", "getgems"],
        description: "Marketplace to query (default: portals)",
      },
      ...paginationProps,
    },
  },

  execute: async (params) => {
    try {
      const result = await giftstatFetch("/current/collections/floor", {
        marketplace: params.marketplace ?? "portals",
        limit: params.limit,
        offset: params.offset,
      });
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_floor_prices:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: gift_models
// Model variants with rarity levels.
// ---------------------------------------------------------------------------

const giftModels = makePaginatedTool(
  "gift_models",
  "List gift model variants with their rarity levels. Models are the specific visual variants within a collection.",
  "/current/collections/models",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 4: gift_model_stats
// Per-model statistics: count, total amount, rarity, market share.
// ---------------------------------------------------------------------------

const giftModelStats = makePaginatedTool(
  "gift_model_stats",
  "Get statistics per gift model: count, total amount, rarity, and market share percentage.",
  "/current/collections/models/stat",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 5: gift_model_floor
// Floor price for each model variant.
// ---------------------------------------------------------------------------

const giftModelFloor = makePaginatedTool(
  "gift_model_floor",
  "Get the current floor price for each gift model variant.",
  "/current/collections/models/floor",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 6: gift_backdrops
// Background variants with rarity data.
// ---------------------------------------------------------------------------

const giftBackdrops = makePaginatedTool(
  "gift_backdrops",
  "List available gift background variants with rarity data.",
  "/current/collections/backdrops",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 7: gift_symbols
// Symbol/pattern variants with rarity data.
// ---------------------------------------------------------------------------

const giftSymbols = makePaginatedTool(
  "gift_symbols",
  "List available gift symbol/pattern variants with rarity data.",
  "/current/collections/symbols",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 8: gift_thematics
// Thematic gift categories. No params at all.
// ---------------------------------------------------------------------------

const giftThematics = {
  name: "gift_thematics",
  description: "List all thematic gift categories.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async () => {
    try {
      const result = await giftstatFetch("/current/thematics");
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_thematics:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 9: gift_thematic_lines
// Lines grouped by thematic category. Paginated.
// ---------------------------------------------------------------------------

const giftThematicLines = makePaginatedTool(
  "gift_thematic_lines",
  "List curated gift lines grouped by thematic category.",
  "/current/thematics/lines",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 10: gift_ton_rate
// Current TON/USDT exchange rate. No params.
// ---------------------------------------------------------------------------

const giftTonRate = {
  name: "gift_ton_rate",
  description: "Get the current TON to USDT exchange rate.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async () => {
    try {
      const result = await giftstatFetch("/current/ton-rate");
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_ton_rate:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 11: gift_price_history
// Historical floor prices. Extra params: marketplace, scale, days.
// ---------------------------------------------------------------------------

const giftPriceHistory = {
  name: "gift_price_history",
  description:
    "Get historical floor price data for gift collections. Supports different time scales and date ranges.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "getgems"],
        description: "Marketplace to query (default: portals)",
      },
      scale: {
        type: "string",
        enum: ["day", "hour"],
        description: "Time granularity for data points (default: day)",
      },
      days: {
        type: "integer",
        description: "Number of days of history to return",
      },
      ...paginationProps,
    },
  },

  execute: async (params) => {
    try {
      const result = await giftstatFetch("/history/collections/floor", {
        marketplace: params.marketplace ?? "portals",
        scale: params.scale ?? "day",
        days: params.days,
        limit: params.limit,
        offset: params.offset,
      });
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_price_history:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Return tools array
// ---------------------------------------------------------------------------

return [
  giftCollections,
  giftFloorPrices,
  giftModels,
  giftModelStats,
  giftModelFloor,
  giftBackdrops,
  giftSymbols,
  giftThematics,
  giftThematicLines,
  giftTonRate,
  giftPriceHistory,
];

}; // end tools(sdk)
