/**
 * Webdom read-only tools -- search, info, stats, portfolio, auction history
 *
 * These tools query the webdom.market API without sending on-chain transactions.
 */

import { webdomGet, webdomGetCached } from "../lib/api.js";
import { CACHE_TTL } from "../lib/constants.js";

// ---------------------------------------------------------------------------
// TONAPI fallback — check on-chain sale status when webdom API is stale
// ---------------------------------------------------------------------------

async function tonapiNftSale(nftAddress) {
  try {
    const url = `https://tonapi.io/v2/nfts/${encodeURIComponent(nftAddress)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.sale) return null;
    return {
      sale_address: data.sale.address,
      sale_price_ton: data.sale.price?.value ? Number(data.sale.price.value) / 1e9 : null,
      marketplace: data.sale.market?.name || null,
    };
  } catch {
    return null;
  }
}

const SORT_MAP = {
  price_asc: "last_price_ton",
  price_desc: "-last_price_ton",
  recent: "-last_sale_time",
  name: "name",
};

function formatDomain(d) {
  const si = d.sale_info || null;
  return {
    name: d.name,
    zone: d.name?.endsWith('.t.me') ? '.t.me' : '.ton',
    address: d.address,
    owner: d.owner_address,
    on_sale: d.on_sale || false,
    on_auction: d.on_auction || false,
    sale_address: d.sale_address || si?.address || null,
    last_price_ton: d.last_price_ton != null ? d.last_price_ton / 1e9 : null,
    sale_price_ton: si?.price != null ? si.price / 1e9 : null,
    sale_state: si?.state || null,
    sale_type: si?.type || si?.deal_type || null,
    cancellation_available: si?.cancellation_available ?? null,
    renewal_time: d.last_renewal_time || null,
  };
}

/**
 * @param {import("../../../packages/sdk").PluginSDK} sdk
 * @returns {Array}
 */
export function readTools(sdk) {
  return [
    // ── 1. webdom_search_domains ────────────────────────────────────────
    {
      name: "webdom_search_domains",
      description:
        "Search and filter .ton domains and .t.me usernames listed on the webdom marketplace. " +
        "Supports filtering by price range, name length, auction status, and sorting. " +
        "Use this to browse available domains or find specific listings.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search text to match against domain names.",
          },
          domain_zone: {
            type: "string",
            enum: [".ton", ".t.me"],
            description: "Filter by domain zone: .ton domains or .t.me usernames.",
          },
          min_price: {
            type: "number",
            description: "Minimum price in TON.",
          },
          max_price: {
            type: "number",
            description: "Maximum price in TON.",
          },
          min_length: {
            type: "integer",
            description: "Minimum domain name length (characters).",
          },
          max_length: {
            type: "integer",
            description: "Maximum domain name length (characters).",
          },
          on_auction: {
            type: "boolean",
            description: "If true, only show domains currently in auction.",
          },
          sort_by: {
            type: "string",
            enum: ["price_asc", "price_desc", "name", "recent"],
            description: "Sort order for results. Defaults to price_desc.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Number of results to return (1-50, default 20).",
          },
          cursor: {
            type: "string",
            description: "Cursor for next page, from previous search result's next_cursor field.",
          },
        },
        additionalProperties: false,
      },
      execute: async (params) => {
        try {
          const apiParams = { marketplaces: "webdom" };
          if (params.query) apiParams.search_query = params.query;
          if (params.domain_zone) apiParams.domain_zone = params.domain_zone;
          if (params.min_price !== undefined) apiParams.min_price = params.min_price;
          if (params.max_price !== undefined) apiParams.max_price = params.max_price;
          if (params.min_length !== undefined) apiParams.min_length = params.min_length;
          if (params.max_length !== undefined) apiParams.max_length = params.max_length;
          if (params.on_auction !== undefined) apiParams.on_auction = params.on_auction;
          apiParams.order_by = SORT_MAP[params.sort_by] || "-last_price_ton";
          apiParams.limit = Math.min(Math.max(params.limit || 20, 1), 50);
          if (params.cursor) apiParams.cursor = params.cursor;

          const result = await webdomGet("/domains", apiParams);
          const domains = (result.domains || []).map(formatDomain);

          return {
            success: true,
            data: {
              domains,
              total_results: result.total_results ?? domains.length,
              has_more: result.has_more ?? false,
              next_cursor: result.next_cursor || null,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // ── 2. webdom_domain_info ───────────────────────────────────────────
    {
      name: "webdom_domain_info",
      description:
        "Get detailed information about a specific .ton domain or .t.me username, " +
        "including owner, price, sale status, auction state, and expiry. " +
        'Provide the full name like "example.ton" or "username.t.me".',
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'The full domain name including zone, e.g. "wallet.ton" or "alice.t.me".',
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      execute: async (params) => {
        try {
          const result = await webdomGet("/domains", {
            marketplaces: "webdom",
            search_query: params.name,
            limit: 20,
          });

          const domains = result.domains || [];
          // Verify exact match (case-insensitive, normalized)
          const normalizedQuery = params.name.toLowerCase();
          const d = domains.find(
            (x) => (x.name || "").toLowerCase() === normalizedQuery
          );

          if (!d) {
            return {
              success: true,
              data: { found: false, message: `Domain "${params.name}" not found on webdom marketplace.` },
            };
          }

          const si = d.sale_info || null;
          let saleAddress = d.sale_address || si?.address || null;
          let salePriceTon = si?.price != null ? si.price / 1e9 : null;
          let onSale = d.on_sale || false;
          let saleType = si?.type || si?.deal_type || null;

          // Fallback: if webdom API shows no sale, check on-chain via TONAPI
          if (!saleAddress && d.address) {
            const onChain = await tonapiNftSale(d.address);
            if (onChain?.sale_address) {
              saleAddress = onChain.sale_address;
              salePriceTon = onChain.sale_price_ton || salePriceTon;
              onSale = true;
              saleType = saleType || "on-chain (webdom API not synced)";
            }
          }

          return {
            success: true,
            data: {
              found: true,
              name: d.name,
              zone: d.name?.endsWith('.t.me') ? '.t.me' : '.ton',
              address: d.address,
              owner: d.owner_address,
              on_sale: onSale,
              on_auction: d.on_auction || false,
              sale_address: saleAddress,
              last_price_ton: d.last_price_ton != null ? d.last_price_ton / 1e9 : null,
              sale_price_ton: salePriceTon,
              sale_state: si?.state || null,
              sale_type: saleType,
              seller: si?.seller_address || null,
              valid_until: si?.valid_until || null,
              cancellation_available: si?.cancellation_available ?? null,
              categories: d.categories || [],
              renewal_time: d.last_renewal_time || null,
              registration_time: d.registration_time || null,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // ── 3. webdom_my_domains ────────────────────────────────────────────
    {
      name: "webdom_my_domains",
      description:
        "List .ton domains and .t.me usernames owned by the agent wallet or a specified address. " +
        "Shows sale status for each domain. If no address is given, uses the agent's own wallet.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "TON wallet address to look up. Omit to use the agent wallet.",
          },
        },
        additionalProperties: false,
      },
      execute: async (params) => {
        try {
          let address = params.address;
          if (!address) {
            address = await sdk.ton.getAddress();
          }

          const result = await webdomGet("/domains", { marketplaces: "webdom", owner_address: address });
          const domains = (result.domains || []).map(formatDomain);

          // Enrich domains with on-chain sale info when webdom API is stale
          for (const d of domains) {
            if (!d.sale_address && d.address) {
              const onChain = await tonapiNftSale(d.address);
              if (onChain?.sale_address) {
                d.sale_address = onChain.sale_address;
                d.sale_price_ton = onChain.sale_price_ton || d.sale_price_ton;
                d.on_sale = true;
                d.sale_type = d.sale_type || "on-chain (webdom API not synced)";
              }
            }
          }

          return {
            success: true,
            data: {
              address,
              count: domains.length,
              domains,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // ── 4. webdom_market_stats ──────────────────────────────────────────
    {
      name: "webdom_market_stats",
      description:
        "Get marketplace statistics from webdom: overall market overview, recent sales, " +
        "all-time top sales, or historical price trends. " +
        "Use stat_type to choose which stats to fetch.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          stat_type: {
            type: "string",
            enum: ["overview", "recent_sales", "top_sales", "price_history"],
            description:
              "Type of statistics: overview (global counts/floors), recent_sales, top_sales, or price_history.",
          },
          domain_zone: {
            type: "string",
            enum: [".ton", ".t.me"],
            description: "Filter stats by domain zone (optional, used by price_history).",
          },
        },
        required: ["stat_type"],
        additionalProperties: false,
      },
      execute: async (params) => {
        try {
          const cacheKey = `stats_${params.stat_type}_${params.domain_zone || "all"}`;

          const ENDPOINT_MAP = {
            overview: "/analytics/statistics/common",
            recent_sales: "/analytics/statistics/last_sales",
            top_sales: "/analytics/statistics/top_sales",
            price_history: "/analytics/statistics/price_history",
          };

          const path = ENDPOINT_MAP[params.stat_type];
          if (!path) {
            return { success: false, error: `Unknown stat_type: ${params.stat_type}` };
          }

          const qp = {};
          if (params.domain_zone) qp.domain_zone = params.domain_zone;

          const data = await webdomGetCached(cacheKey, path, qp, CACHE_TTL);

          return { success: true, data };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // ── 5. webdom_auction_history ───────────────────────────────────────
    {
      name: "webdom_auction_history",
      description:
        "Get the bid history for a specific domain auction on webdom. " +
        "Requires the auction deal contract address (starts with EQ or UQ). " +
        "Returns a chronological list of bids with bidder address, amount, and timestamp.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          deal_address: {
            type: "string",
            description: "The auction deal contract address (e.g. EQ... or UQ...).",
          },
        },
        required: ["deal_address"],
        additionalProperties: false,
      },
      execute: async (params) => {
        try {
          const result = await webdomGet("/deals/get_auction_history", {
            deal_address: params.deal_address,
          });

          const bids = (result.bids || result.history || result.data || []).map((b) => ({
            bidder: b.bidder || b.bidder_address || b.address,
            amount_ton: b.amount != null ? b.amount / 1e9 : (b.price != null ? b.price / 1e9 : null),
            timestamp: b.timestamp || b.date || b.created_at || null,
          }));

          return {
            success: true,
            data: {
              deal_address: params.deal_address,
              bid_count: bids.length,
              bids,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
  ];
}
