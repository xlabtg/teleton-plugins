/**
 * TONCO DEX plugin — concentrated liquidity AMM on TON
 *
 * Browse pools, get swap quotes, execute swaps, and view liquidity positions
 * on TONCO — a next-generation AMM with concentrated liquidity on TON.
 *
 * TONCO SDK: https://github.com/cryptoalgebra/tonco-sdk
 * TONCO Protocol: https://tonco.io
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

// ---------------------------------------------------------------------------
// CJS dependencies
// ---------------------------------------------------------------------------

const _require = createRequire(realpathSync(process.argv[1]));    // core: @ton/core, @ton/ton, @ton/crypto
const _pluginRequire = createRequire(import.meta.url);             // local: plugin-specific deps

const { Address } = _require("@ton/core");
const { TonClient } = _require("@ton/ton");

// TONCO SDK — loaded from plugin's local node_modules
let ToncoSDK = null;
try {
  ToncoSDK = _pluginRequire("@toncodex/sdk");
} catch {
  // SDK not available; swap estimation and on-chain tools will use API fallback
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TONCO GraphQL indexer endpoint */
const INDEXER_URL = "https://indexer.tonco.io/graphql";

/** TONCO farming APR API */
const FARMING_API = "https://api-farming.tonco.io";

/** Module-level SDK reference (set in tools(sdk) factory) */
let _sdk = null;

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

/**
 * Execute a GraphQL query against the TONCO indexer.
 * @param {string} query - GraphQL query string
 * @param {object} [variables] - Query variables
 * @returns {Promise<any>} Parsed response data
 */
async function gqlQuery(query, variables = {}) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TONCO indexer error: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// TonClient helper (lazy, cached)
// ---------------------------------------------------------------------------

let _tonClient = null;

/**
 * Get or create a TonClient instance.
 * Uses @orbs-network/ton-access for decentralized endpoints when available.
 * @returns {Promise<TonClient>}
 */
async function getTonClient() {
  if (_tonClient) return _tonClient;
  let endpoint;
  try {
    const { getHttpEndpoint } = _pluginRequire("@orbs-network/ton-access");
    endpoint = await getHttpEndpoint({ network: "mainnet" });
  } catch {
    endpoint = "https://toncenter.com/api/v2/jsonRPC";
  }
  _tonClient = new TonClient({ endpoint });
  return _tonClient;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format a raw token amount (bigint string) to human-readable decimal.
 * @param {string|bigint|number} raw - Raw amount in smallest units
 * @param {number} decimals - Token decimals
 * @returns {string} Human-readable amount
 */
function formatAmount(raw, decimals = 9) {
  if (!raw && raw !== 0n) return "0";
  const s = String(raw);
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Format a USD value string for display.
 * @param {string|number|null} val
 * @returns {string}
 */
function formatUsd(val) {
  if (!val) return "0";
  const n = parseFloat(val);
  if (isNaN(n)) return "0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * Parse a human-readable amount to raw bigint units.
 * @param {string|number} amount - Human-readable amount (e.g. "10.5")
 * @param {number} decimals - Token decimals
 * @returns {bigint}
 */
function parseAmount(amount, decimals = 9) {
  const str = String(amount);
  const [intPart, fracPart = ""] = str.split(".");
  const fracPadded = fracPart.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(intPart + fracPadded);
}

// ---------------------------------------------------------------------------
// Tool 1: tonco_list_pools
// ---------------------------------------------------------------------------

const toncoListPools = {
  name: "tonco_list_pools",
  description:
    "Discover and list TONCO liquidity pools. Optionally filter by token symbol or address. Sort by TVL, volume, APR, or fees. Returns pool address, token pair, fee tier, TVL, 24h volume, fees, and APR.",
  category: "data-bearing",

  parameters: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "Filter pools by token symbol (e.g. 'TON', 'USDT') or contract address (optional)",
      },
      sort_by: {
        type: "string",
        enum: ["tvl", "volume", "apr", "fees"],
        description: "Sort pools by metric: tvl, volume, apr, or fees (default: tvl)",
      },
      limit: {
        type: "integer",
        description: "Number of pools to return (1-50, default: 10)",
        minimum: 1,
        maximum: 50,
      },
      version: {
        type: "string",
        enum: ["v1", "v1_5", "all"],
        description: "Pool version filter: v1, v1_5, or all (default: v1_5)",
      },
    },
  },

  execute: async (params) => {
    try {
      const limit = params.limit ?? 10;
      const sortBy = params.sort_by ?? "tvl";
      const version = params.version ?? "v1_5";
      const tokenFilter = (params.token ?? "").trim().toLowerCase();

      // Map sort_by to GraphQL orderBy field
      const orderByMap = {
        tvl: "totalValueLockedUsd",
        volume: "volume24HUsd",
        apr: "apr",
        fees: "fees24HUsd",
      };
      const orderBy = orderByMap[sortBy] ?? "totalValueLockedUsd";

      // Build pool where clause
      const where = {
        isInitialized: true,
        ...(version === "v1_5" ? { showV1_5: true } : {}),
        ...(version === "v1" ? { showV1_5: false } : {}),
      };

      const query = `
        query ListPools($where: PoolWhere, $filter: Filter) {
          pools(where: $where, filter: $filter) {
            address
            name
            version
            fee
            tick
            tickSpacing
            liquidity
            priceSqrt
            apr
            totalValueLockedUsd
            totalValueLockedTon
            volume24HUsd
            fees24HUsd
            txCount
            jetton0 { address symbol name decimals image }
            jetton1 { address symbol name decimals image }
          }
        }
      `;

      // Fetch a larger set to allow client-side token filtering
      const fetchLimit = tokenFilter ? Math.min(limit * 10, 200) : limit;
      const data = await gqlQuery(query, {
        where,
        filter: { first: fetchLimit, orderBy, orderDirection: "DESC" },
      });

      let pools = data.pools ?? [];

      // Apply token filter
      if (tokenFilter) {
        pools = pools.filter((p) => {
          const j0Symbol = (p.jetton0?.symbol ?? "").toLowerCase();
          const j1Symbol = (p.jetton1?.symbol ?? "").toLowerCase();
          const j0Name = (p.jetton0?.name ?? "").toLowerCase();
          const j1Name = (p.jetton1?.name ?? "").toLowerCase();
          const j0Addr = (p.jetton0?.address ?? "").toLowerCase();
          const j1Addr = (p.jetton1?.address ?? "").toLowerCase();
          return (
            j0Symbol.includes(tokenFilter) ||
            j1Symbol.includes(tokenFilter) ||
            j0Name.includes(tokenFilter) ||
            j1Name.includes(tokenFilter) ||
            j0Addr.includes(tokenFilter) ||
            j1Addr.includes(tokenFilter)
          );
        });
      }

      const result = pools.slice(0, limit).map((p) => ({
        address: p.address,
        name: p.name ?? `${p.jetton0?.symbol ?? "?"}/${p.jetton1?.symbol ?? "?"}`,
        version: p.version,
        fee_tier: p.fee ? `${(p.fee / 10000).toFixed(2)}%` : null,
        fee_raw: p.fee,
        token0: {
          address: p.jetton0?.address,
          symbol: p.jetton0?.symbol,
          name: p.jetton0?.name,
          decimals: p.jetton0?.decimals,
        },
        token1: {
          address: p.jetton1?.address,
          symbol: p.jetton1?.symbol,
          name: p.jetton1?.name,
          decimals: p.jetton1?.decimals,
        },
        tvl_usd: formatUsd(p.totalValueLockedUsd),
        tvl_ton: p.totalValueLockedTon ? parseFloat(p.totalValueLockedTon).toFixed(2) + " TON" : null,
        volume_24h_usd: formatUsd(p.volume24HUsd),
        fees_24h_usd: formatUsd(p.fees24HUsd),
        apr: p.apr ? `${parseFloat(p.apr).toFixed(2)}%` : null,
        tx_count: p.txCount,
        tick_current: p.tick,
        tick_spacing: p.tickSpacing,
        liquidity: p.liquidity,
      }));

      return {
        success: true,
        data: {
          pools: result,
          count: result.length,
          sorted_by: sortBy,
          filter: tokenFilter || null,
        },
      };
    } catch (err) {
      _sdk?.log?.error(`tonco_list_pools failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: tonco_get_pool_stats
// ---------------------------------------------------------------------------

const toncoGetPoolStats = {
  name: "tonco_get_pool_stats",
  description:
    "Get detailed statistics for a specific TONCO pool by address: reserves, current price, 24h/48h volume, fees, APR, liquidity, tick info, and recent swap count.",
  category: "data-bearing",

  parameters: {
    type: "object",
    properties: {
      pool_address: {
        type: "string",
        description: "Pool contract address (e.g. EQC_R1hCuGK8Q8FfHJFbimp0-EHznTuyJsdJjDl7swWYnrF0)",
      },
    },
    required: ["pool_address"],
  },

  execute: async (params) => {
    try {
      const poolAddr = params.pool_address.trim();

      const query = `
        query GetPool($where: PoolWhere) {
          pools(where: $where) {
            address
            name
            version
            fee
            tick
            tickSpacing
            liquidity
            priceSqrt
            apr
            activeTvlUsd
            totalValueLockedUsd
            totalValueLockedTon
            totalValueLockedJetton0
            totalValueLockedJetton1
            volume24HUsd
            fees24HUsd
            volume48HUsd
            fees48HUsd
            volumeUsd
            feesUsd
            txCount
            feeGrowthGlobal0X128
            feeGrowthGlobal1X128
            jetton0Price
            jetton1Price
            positionsCount
            isInitialized
            creationUnix
            jetton0 { address symbol name decimals image }
            jetton1 { address symbol name decimals image }
          }
        }
      `;

      const data = await gqlQuery(query, { where: { address: poolAddr } });
      const pools = data.pools ?? [];
      if (!pools.length) {
        return { success: false, error: `Pool not found: ${poolAddr}` };
      }
      const p = pools[0];
      const dec0 = p.jetton0?.decimals ?? 9;
      const dec1 = p.jetton1?.decimals ?? 9;

      // Fetch farming APR if available
      let farmingApr = null;
      try {
        const farmRes = await fetch(`${FARMING_API}/apr?pool=${encodeURIComponent(poolAddr)}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (farmRes.ok) {
          const farmData = await farmRes.json();
          farmingApr = farmData.apr ?? null;
        }
      } catch {
        // farming data unavailable, continue without it
      }

      return {
        success: true,
        data: {
          address: p.address,
          name: p.name ?? `${p.jetton0?.symbol ?? "?"}/${p.jetton1?.symbol ?? "?"}`,
          version: p.version,
          initialized: p.isInitialized,
          created_at: p.creationUnix ? new Date(p.creationUnix * 1000).toISOString() : null,
          fee_tier: p.fee ? `${(p.fee / 10000).toFixed(2)}%` : null,
          token0: {
            address: p.jetton0?.address,
            symbol: p.jetton0?.symbol,
            name: p.jetton0?.name,
            decimals: dec0,
            reserve: p.totalValueLockedJetton0
              ? formatAmount(p.totalValueLockedJetton0, dec0)
              : null,
          },
          token1: {
            address: p.jetton1?.address,
            symbol: p.jetton1?.symbol,
            name: p.jetton1?.name,
            decimals: dec1,
            reserve: p.totalValueLockedJetton1
              ? formatAmount(p.totalValueLockedJetton1, dec1)
              : null,
          },
          current_price: {
            token0_per_token1: p.jetton0Price,
            token1_per_token0: p.jetton1Price,
          },
          tvl_usd: formatUsd(p.totalValueLockedUsd),
          active_tvl_usd: formatUsd(p.activeTvlUsd),
          volume_24h_usd: formatUsd(p.volume24HUsd),
          volume_48h_usd: formatUsd(p.volume48HUsd),
          fees_24h_usd: formatUsd(p.fees24HUsd),
          fees_48h_usd: formatUsd(p.fees48HUsd),
          total_volume_usd: formatUsd(p.volumeUsd),
          total_fees_usd: formatUsd(p.feesUsd),
          apr: p.apr ? `${parseFloat(p.apr).toFixed(2)}%` : null,
          farming_apr: farmingApr ? `${parseFloat(farmingApr).toFixed(2)}%` : null,
          tx_count: p.txCount,
          positions_count: p.positionsCount,
          tick_current: p.tick,
          tick_spacing: p.tickSpacing,
          liquidity: p.liquidity,
        },
      };
    } catch (err) {
      _sdk?.log?.error(`tonco_get_pool_stats failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: tonco_get_token_info
// ---------------------------------------------------------------------------

const toncoGetTokenInfo = {
  name: "tonco_get_token_info",
  description:
    "Get token metadata and price information from the TONCO indexer. Search by symbol (e.g. 'USDT') or contract address. Returns token name, symbol, decimals, TVL, volume, and derived USD price.",
  category: "data-bearing",

  parameters: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "Token symbol (e.g. 'TON', 'USDT', 'jUSDT') or contract address",
      },
      limit: {
        type: "integer",
        description: "Number of results when searching by symbol (1-20, default: 5)",
        minimum: 1,
        maximum: 20,
      },
    },
    required: ["token"],
  },

  execute: async (params) => {
    try {
      const token = (params.token ?? "").trim();
      const limit = params.limit ?? 5;

      if (!token) throw new Error("token parameter is required");

      // Determine if searching by address or symbol
      const isAddress =
        token.startsWith("EQ") ||
        token.startsWith("UQ") ||
        token.startsWith("0:") ||
        token.length > 40;

      const query = `
        query GetJettons($where: JettonWhere, $filter: Filter) {
          jettons(where: $where, filter: $filter) {
            address
            bounceableAddress
            symbol
            name
            decimals
            image
            description
            totalSupply
            totalValueLocked
            totalValueLockedUsd
            derivedTon
            derivedUsd
            volume
            volumeUsd
            txCount
          }
        }
      `;

      const where = isAddress ? { address: token } : {};
      const data = await gqlQuery(query, {
        where,
        filter: { first: isAddress ? 1 : limit, orderBy: "totalValueLockedUsd", orderDirection: "DESC" },
      });

      let jettons = data.jettons ?? [];

      // Client-side symbol/name filter for non-address search
      if (!isAddress && token) {
        const q = token.toLowerCase();
        jettons = jettons.filter(
          (j) =>
            (j.symbol ?? "").toLowerCase().includes(q) ||
            (j.name ?? "").toLowerCase().includes(q)
        );
        if (!jettons.length) {
          // Retry with a broader server-side search isn't available, return not found
          return { success: false, error: `Token not found: ${token}` };
        }
      }

      if (!jettons.length) {
        return { success: false, error: `Token not found: ${token}` };
      }

      const result = jettons.slice(0, limit).map((j) => ({
        address: j.address,
        bounceable_address: j.bounceableAddress,
        symbol: j.symbol,
        name: j.name,
        decimals: j.decimals,
        image: j.image,
        description: j.description,
        total_supply: j.totalSupply ? formatAmount(j.totalSupply, j.decimals ?? 9) : null,
        price_usd: j.derivedUsd ? `$${parseFloat(j.derivedUsd).toFixed(6)}` : null,
        price_ton: j.derivedTon ? `${parseFloat(j.derivedTon).toFixed(6)} TON` : null,
        tvl_usd: formatUsd(j.totalValueLockedUsd),
        volume_usd: formatUsd(j.volumeUsd),
        tx_count: j.txCount,
      }));

      return { success: true, data: isAddress ? result[0] : { tokens: result, count: result.length } };
    } catch (err) {
      _sdk?.log?.error(`tonco_get_token_info failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: tonco_swap_quote
// ---------------------------------------------------------------------------

const toncoSwapQuote = {
  name: "tonco_swap_quote",
  description:
    "Get a swap quote on TONCO DEX: expected output amount, price impact, minimum received after slippage, and route. Use token contract addresses or 'TON' for native TON.",
  category: "data-bearing",

  parameters: {
    type: "object",
    properties: {
      token_in: {
        type: "string",
        description: "Input token contract address, or 'TON' for native TON",
      },
      token_out: {
        type: "string",
        description: "Output token contract address, or 'TON' for native TON",
      },
      amount_in: {
        type: "string",
        description: "Amount to swap in human-readable units (e.g. '10' for 10 TON, '100.5' for 100.5 USDT)",
      },
      slippage_percent: {
        type: "number",
        description: "Slippage tolerance in percent (default: 1.0, range: 0.01-50)",
        minimum: 0.01,
        maximum: 50,
      },
    },
    required: ["token_in", "token_out", "amount_in"],
  },

  execute: async (params) => {
    try {
      const slippagePercent = params.slippage_percent ?? 1.0;
      const amountInStr = String(params.amount_in).trim();

      if (!amountInStr || isNaN(parseFloat(amountInStr)) || parseFloat(amountInStr) <= 0) {
        throw new Error("amount_in must be a positive number");
      }

      const pTonAddr = ToncoSDK?.pTON_MINTER?.v1_5 ?? "EQBnGWMCf3-FZZq1W4IWcNiZ0_ms1pwhIr0WNCioB99MkA==";

      // Resolve pool containing the token pair from the indexer
      const tokenInAddr = params.token_in.trim();
      const tokenOutAddr = params.token_out.trim();
      const isTonIn = tokenInAddr.toUpperCase() === "TON";
      const isTonOut = tokenOutAddr.toUpperCase() === "TON";

      // Resolve pTON address for TON
      const resolvedInAddr = isTonIn ? pTonAddr : tokenInAddr;
      const resolvedOutAddr = isTonOut ? pTonAddr : tokenOutAddr;

      // Fetch pool data for this pair from indexer
      const query = `
        query GetPools($where: PoolWhere) {
          pools(where: $where) {
            address
            version
            fee
            tick
            tickSpacing
            liquidity
            priceSqrt
            totalValueLockedUsd
            jetton0 { address symbol name decimals }
            jetton1 { address symbol name decimals }
            jetton0Price
            jetton1Price
          }
        }
      `;

      // Try to find pool with both tokens
      const [data0, data1] = await Promise.all([
        gqlQuery(query, { where: { jetton0: resolvedInAddr, jetton1: resolvedOutAddr, isInitialized: true } }),
        gqlQuery(query, { where: { jetton0: resolvedOutAddr, jetton1: resolvedInAddr, isInitialized: true } }),
      ]);

      const pools = [...(data0.pools ?? []), ...(data1.pools ?? [])];
      // Filter v1_5 first, then v1
      const sortedPools = pools.sort((a, b) => {
        if (a.version === "v1_5" && b.version !== "v1_5") return -1;
        if (b.version === "v1_5" && a.version !== "v1_5") return 1;
        return parseFloat(b.totalValueLockedUsd ?? "0") - parseFloat(a.totalValueLockedUsd ?? "0");
      });

      if (!sortedPools.length) {
        return {
          success: false,
          error: `No TONCO pool found for ${params.token_in}/${params.token_out}. Try tonco_list_pools to find available pools.`,
        };
      }

      const poolData = sortedPools[0];
      const j0Data = poolData.jetton0;
      const j1Data = poolData.jetton1;
      const zeroToOne = j0Data.address.toLowerCase() === resolvedInAddr.toLowerCase();
      const tokenInMeta = zeroToOne ? j0Data : j1Data;
      const tokenOutMeta = zeroToOne ? j1Data : j0Data;
      const decimalsIn = tokenInMeta.decimals ?? 9;
      const decimalsOut = tokenOutMeta.decimals ?? 9;

      let rawOut;
      let quotedWithSDK = false;

      if (ToncoSDK) {
        // Full AMM simulation via SDK (accounts for price impact and concentrated liquidity)
        const { Jetton, JettonAmount, Pool } = ToncoSDK;

        const jetton0 = new Jetton(j0Data.address, j0Data.decimals ?? 9, j0Data.symbol ?? "T0", j0Data.name);
        const jetton1 = new Jetton(j1Data.address, j1Data.decimals ?? 9, j1Data.symbol ?? "T1", j1Data.name);

        // Build Pool instance (off-chain simulation)
        const pool = new Pool(
          jetton0,
          jetton1,
          poolData.fee ?? 100,
          poolData.priceSqrt.toString(),
          poolData.liquidity.toString(),
          poolData.tick ?? 0,
          poolData.tickSpacing ?? 1,
          [] // ticks array — simplified, use on-chain for precise routing
        );

        const tokenIn = zeroToOne ? jetton0 : jetton1;
        const rawIn = parseAmount(amountInStr, decimalsIn);
        const amountIn = JettonAmount.fromRawAmount(tokenIn, rawIn.toString());
        const [amountOut] = await pool.getOutputAmount(amountIn);
        rawOut = BigInt(amountOut.quotient.toString());
        quotedWithSDK = true;
      } else {
        // Price-based approximation using current pool price from indexer
        // jetton0Price = price of jetton0 in terms of jetton1 (how many jetton1 per 1 jetton0)
        // jetton1Price = price of jetton1 in terms of jetton0 (how many jetton0 per 1 jetton1)
        const price = zeroToOne
          ? parseFloat(poolData.jetton0Price ?? "0")
          : parseFloat(poolData.jetton1Price ?? "0");
        if (!price || price <= 0) {
          return {
            success: false,
            error: "Pool price data unavailable. Try again or install @toncodex/sdk for precise quotes: cd ~/.teleton/plugins/tonco-dex && npm install",
          };
        }
        const amountInFloat = parseFloat(amountInStr);
        const rawOutFloat = amountInFloat * price * Math.pow(10, decimalsOut);
        rawOut = BigInt(Math.floor(rawOutFloat));
      }

      // Calculate price impact (only meaningful for SDK quotes; price-based is spot price so impact is 0)
      const midPrice = zeroToOne ? parseFloat(poolData.jetton0Price ?? "0") : parseFloat(poolData.jetton1Price ?? "0");
      const expectedOutAtMidPrice = parseFloat(amountInStr) * midPrice;
      const actualOut = parseFloat(formatAmount(rawOut.toString(), decimalsOut));
      const priceImpact = quotedWithSDK && expectedOutAtMidPrice > 0
        ? ((expectedOutAtMidPrice - actualOut) / expectedOutAtMidPrice * 100).toFixed(3)
        : "0";

      // Apply slippage to minimum received
      const slippageBasisPoints = BigInt(Math.round(slippagePercent * 100));
      const minOut = rawOut * (10000n - slippageBasisPoints) / 10000n;

      return {
        success: true,
        data: {
          token_in: {
            symbol: tokenInMeta.symbol,
            address: tokenInMeta.address,
            amount: amountInStr,
          },
          token_out: {
            symbol: tokenOutMeta.symbol,
            address: tokenOutMeta.address,
          },
          expected_output: formatAmount(rawOut.toString(), decimalsOut),
          minimum_output: formatAmount(minOut.toString(), decimalsOut),
          price_impact_percent: priceImpact,
          slippage_percent: slippagePercent,
          pool: {
            address: poolData.address,
            version: poolData.version,
            fee_tier: poolData.fee ? `${(poolData.fee / 10000).toFixed(2)}%` : null,
            tvl_usd: formatUsd(poolData.totalValueLockedUsd),
          },
          note: quotedWithSDK
            ? "Quote is based on current pool state. Execute within 30 seconds for best accuracy."
            : "Quote is a spot price estimate (price impact not calculated). For a precise AMM quote, install @toncodex/sdk: cd ~/.teleton/plugins/tonco-dex && npm install",
        },
      };
    } catch (err) {
      _sdk?.log?.error(`tonco_swap_quote failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: tonco_execute_swap
// ---------------------------------------------------------------------------

const toncoExecuteSwap = {
  name: "tonco_execute_swap",
  description:
    "Execute a token swap on TONCO DEX from the agent wallet. First estimates output, then builds and sends the on-chain transaction. Use tonco_swap_quote first to preview. Scope: DM-only for security.",
  category: "action",
  scope: "dm-only",

  parameters: {
    type: "object",
    properties: {
      token_in: {
        type: "string",
        description: "Input token address or 'TON' for native TON",
      },
      token_out: {
        type: "string",
        description: "Output token address or 'TON' for native TON",
      },
      amount_in: {
        type: "string",
        description: "Amount to swap in human-readable units (e.g. '10' for 10 TON)",
      },
      slippage_percent: {
        type: "number",
        description: "Slippage tolerance in percent (default: 1.0, range: 0.01-50)",
        minimum: 0.01,
        maximum: 50,
      },
    },
    required: ["token_in", "token_out", "amount_in"],
  },

  execute: async (params, _context) => {
    try {
      if (!ToncoSDK) {
        throw new Error(
          "@toncodex/sdk is required for swap execution. " +
          "Install it by running: cd ~/.teleton/plugins/tonco-dex && npm install"
        );
      }

      const slippagePercent = params.slippage_percent ?? 1.0;
      const amountInStr = String(params.amount_in).trim();

      if (!amountInStr || isNaN(parseFloat(amountInStr)) || parseFloat(amountInStr) <= 0) {
        throw new Error("amount_in must be a positive number");
      }

      const {
        Jetton, JettonAmount, Pool, PoolMessageManager, SwapType,
        pTON_MINTER,
      } = ToncoSDK;

      const tokenInAddr = params.token_in.trim();
      const tokenOutAddr = params.token_out.trim();
      const isTonIn = tokenInAddr.toUpperCase() === "TON";
      const isTonOut = tokenOutAddr.toUpperCase() === "TON";

      const pTonAddr = pTON_MINTER?.v1_5 ?? "EQBnGWMCf3-FZZq1W4IWcNiZ0_ms1pwhIr0WNCioB99MkA==";
      const resolvedInAddr = isTonIn ? pTonAddr : tokenInAddr;
      const resolvedOutAddr = isTonOut ? pTonAddr : tokenOutAddr;

      // Fetch pool from indexer
      const query = `
        query GetPools($where: PoolWhere) {
          pools(where: $where) {
            address
            version
            fee
            tick
            tickSpacing
            liquidity
            priceSqrt
            totalValueLockedUsd
            jetton0 { address symbol name decimals wallet walletV1_5 }
            jetton1 { address symbol name decimals wallet walletV1_5 }
          }
        }
      `;

      const [data0, data1] = await Promise.all([
        gqlQuery(query, { where: { jetton0: resolvedInAddr, jetton1: resolvedOutAddr, isInitialized: true } }),
        gqlQuery(query, { where: { jetton0: resolvedOutAddr, jetton1: resolvedInAddr, isInitialized: true } }),
      ]);

      const allPools = [...(data0.pools ?? []), ...(data1.pools ?? [])];
      const sortedPools = allPools.sort((a, b) => {
        if (a.version === "v1_5" && b.version !== "v1_5") return -1;
        if (b.version === "v1_5" && a.version !== "v1_5") return 1;
        return parseFloat(b.totalValueLockedUsd ?? "0") - parseFloat(a.totalValueLockedUsd ?? "0");
      });

      if (!sortedPools.length) {
        return {
          success: false,
          error: `No pool found for ${params.token_in}/${params.token_out}. Try tonco_list_pools first.`,
        };
      }

      const poolData = sortedPools[0];
      const isV1_5 = poolData.version === "v1_5";
      const j0Data = poolData.jetton0;
      const j1Data = poolData.jetton1;
      const zeroToOne = j0Data.address.toLowerCase() === resolvedInAddr.toLowerCase();
      const tokenIn = zeroToOne ? j0Data : j1Data;
      const tokenOut = zeroToOne ? j1Data : j0Data;
      const decimalsIn = tokenIn.decimals ?? 9;
      const decimalsOut = tokenOut.decimals ?? 9;

      // Build Pool and estimate output
      const jetton0 = new Jetton(j0Data.address, j0Data.decimals ?? 9, j0Data.symbol ?? "T0", j0Data.name);
      const jetton1 = new Jetton(j1Data.address, j1Data.decimals ?? 9, j1Data.symbol ?? "T1", j1Data.name);
      const pool = new Pool(
        jetton0, jetton1, poolData.fee ?? 100,
        poolData.priceSqrt.toString(), poolData.liquidity.toString(),
        poolData.tick ?? 0, poolData.tickSpacing ?? 1, []
      );

      const rawIn = parseAmount(amountInStr, decimalsIn);
      const jettonIn = zeroToOne ? jetton0 : jetton1;
      const amountInObj = JettonAmount.fromRawAmount(jettonIn, rawIn.toString());
      const [amountOutObj] = await pool.getOutputAmount(amountInObj);
      const rawOut = BigInt(amountOutObj.quotient.toString());

      // Calculate minimum output with slippage
      const slippageBasisPoints = BigInt(Math.round(slippagePercent * 100));
      const minOut = rawOut * (10000n - slippageBasisPoints) / 10000n;

      // Get wallet address from SDK
      const walletAddress = await _sdk.ton.getAddress();
      if (!walletAddress) {
        return { success: false, error: "Agent wallet not initialized. Set up wallet first." };
      }

      const recipientAddress = Address.parse(walletAddress);

      // Determine swap type and router wallet addresses
      let swapType;
      if (isTonIn) {
        swapType = isV1_5 ? SwapType.TON_TO_JETTON_V1_5 : SwapType.TON_TO_JETTON;
      } else if (isTonOut) {
        swapType = isV1_5 ? SwapType.JETTON_TO_TON_V1_5 : SwapType.JETTON_TO_TON;
      } else {
        swapType = isV1_5 ? SwapType.JETTON_TO_JETTON_V1_5 : SwapType.JETTON_TO_JETTON;
      }

      // Router wallet for output token
      const routerOutWallet = isV1_5
        ? (tokenOut.walletV1_5 ?? tokenOut.wallet)
        : tokenOut.wallet;
      if (!routerOutWallet) {
        return { success: false, error: "Router wallet address not available for output token" };
      }

      // User input jetton wallet (from SDK)
      let userJettonInWallet;
      if (isTonIn) {
        // For TON->Jetton, the "userJettonInWallet" is the pTON wallet
        userJettonInWallet = Address.parse(isV1_5
          ? (j0Data.walletV1_5 ?? j0Data.wallet)
          : j0Data.wallet);
      } else {
        // Get user's jetton wallet from chain
        const client = await getTonClient();
        const { JettonMinter } = ToncoSDK;
        const minter = client.open(new JettonMinter(Address.parse(tokenIn.address)));
        userJettonInWallet = await minter.getWalletAddress(recipientAddress);
      }

      const routerOutWalletAddr = Address.parse(routerOutWallet);

      // Build swap message
      const msg = PoolMessageManager.createSwapExactInMessage(
        userJettonInWallet,
        routerOutWalletAddr,
        recipientAddress,
        rawIn,
        minOut,
        0n,           // no price limit
        swapType,
      );

      // Send transaction via SDK
      await _sdk.ton.sendTON(
        msg.to.toString(),
        parseFloat(msg.value.toString()) / 1e9,
        undefined
      );

      _sdk?.log?.info(`tonco_execute_swap: swap initiated ${amountInStr} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

      return {
        success: true,
        data: {
          token_in: {
            symbol: tokenIn.symbol,
            amount: amountInStr,
          },
          token_out: {
            symbol: tokenOut.symbol,
          },
          estimated_output: formatAmount(rawOut.toString(), decimalsOut),
          minimum_output: formatAmount(minOut.toString(), decimalsOut),
          slippage_percent: slippagePercent,
          pool_address: poolData.address,
          pool_version: poolData.version,
          message: "Swap transaction sent. Allow ~30 seconds for on-chain confirmation. Check your balance after.",
          note: "Transaction hash not available synchronously — check explorer for your wallet address.",
        },
      };
    } catch (err) {
      _sdk?.log?.error(`tonco_execute_swap failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: tonco_get_positions
// ---------------------------------------------------------------------------

const toncoGetPositions = {
  name: "tonco_get_positions",
  description:
    "List liquidity positions on TONCO DEX for a given owner address. Returns position details: pool, token pair, tick range, liquidity, deposited and current amounts, fees earned.",
  category: "data-bearing",

  parameters: {
    type: "object",
    properties: {
      owner_address: {
        type: "string",
        description: "Owner wallet address to query positions for (TON address)",
      },
      pool_address: {
        type: "string",
        description: "Filter positions by pool address (optional)",
      },
      include_closed: {
        type: "boolean",
        description: "Include closed (zero-liquidity) positions (default: false)",
      },
      limit: {
        type: "integer",
        description: "Maximum number of positions to return (1-50, default: 20)",
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["owner_address"],
  },

  execute: async (params) => {
    try {
      const ownerAddr = params.owner_address.trim();
      const includeClosed = params.include_closed ?? false;
      const limit = params.limit ?? 20;

      const query = `
        query GetPositions($where: PositionWhere, $filter: Filter) {
          positions(where: $where, filter: $filter) {
            id
            owner
            nftAddress
            nftImage
            tickLower
            tickUpper
            liquidity
            amount0
            amount1
            depositedJetton0
            depositedJetton1
            withdrawnJetton0
            withdrawnJetton1
            collectedFeesJetton0
            collectedFeesJetton1
            feeGrowthInside0LastX128
            feeGrowthInside1LastX128
            creationTime
            closingTime
            pool {
              address
              version
              fee
              tick
              tickSpacing
              priceSqrt
              liquidity
              jetton0 { address symbol decimals }
              jetton1 { address symbol decimals }
            }
          }
        }
      `;

      const where = {
        owner: ownerAddr,
        ...(params.pool_address ? { pool: params.pool_address.trim() } : {}),
      };

      const data = await gqlQuery(query, {
        where,
        filter: { first: limit, orderBy: "creationTime", orderDirection: "DESC" },
      });

      let positions = data.positions ?? [];

      // Filter closed positions if not requested
      if (!includeClosed) {
        positions = positions.filter(
          (p) => p.liquidity && BigInt(p.liquidity) > 0n
        );
      }

      const result = positions.map((p) => {
        const pool = p.pool ?? {};
        const dec0 = pool.jetton0?.decimals ?? 9;
        const dec1 = pool.jetton1?.decimals ?? 9;
        const liq = p.liquidity ? BigInt(p.liquidity) : 0n;
        const isActive = liq > 0n;
        const tickCurrent = pool.tick ?? 0;
        const inRange = p.tickLower <= tickCurrent && tickCurrent < p.tickUpper;

        return {
          id: p.id,
          nft_address: p.nftAddress,
          status: isActive ? (inRange ? "in-range" : "out-of-range") : "closed",
          pool: {
            address: pool.address,
            version: pool.version,
            fee_tier: pool.fee ? `${(pool.fee / 10000).toFixed(2)}%` : null,
            token0_symbol: pool.jetton0?.symbol,
            token1_symbol: pool.jetton1?.symbol,
          },
          tick_lower: p.tickLower,
          tick_upper: p.tickUpper,
          tick_current: tickCurrent,
          in_range: isActive ? inRange : null,
          liquidity: p.liquidity,
          current_amounts: {
            token0: p.amount0 ? formatAmount(p.amount0, dec0) : null,
            token0_symbol: pool.jetton0?.symbol,
            token1: p.amount1 ? formatAmount(p.amount1, dec1) : null,
            token1_symbol: pool.jetton1?.symbol,
          },
          deposited: {
            token0: p.depositedJetton0 ? formatAmount(p.depositedJetton0, dec0) : null,
            token1: p.depositedJetton1 ? formatAmount(p.depositedJetton1, dec1) : null,
          },
          withdrawn: {
            token0: p.withdrawnJetton0 ? formatAmount(p.withdrawnJetton0, dec0) : null,
            token1: p.withdrawnJetton1 ? formatAmount(p.withdrawnJetton1, dec1) : null,
          },
          fees_collected: {
            token0: p.collectedFeesJetton0 ? formatAmount(p.collectedFeesJetton0, dec0) : null,
            token0_symbol: pool.jetton0?.symbol,
            token1: p.collectedFeesJetton1 ? formatAmount(p.collectedFeesJetton1, dec1) : null,
            token1_symbol: pool.jetton1?.symbol,
          },
          created_at: p.creationTime ? new Date(p.creationTime * 1000).toISOString() : null,
          closed_at: p.closingTime ? new Date(p.closingTime * 1000).toISOString() : null,
        };
      });

      return {
        success: true,
        data: {
          owner: ownerAddr,
          positions: result,
          count: result.length,
          active_count: result.filter((p) => p.status !== "closed").length,
        },
      };
    } catch (err) {
      _sdk?.log?.error(`tonco_get_positions failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 7: tonco_get_position_fees
// ---------------------------------------------------------------------------

const toncoGetPositionFees = {
  name: "tonco_get_position_fees",
  description:
    "Get uncollected (pending) fee amounts for a specific TONCO liquidity position by NFT address or position ID. Uses on-chain pool state for accurate fee calculation.",
  category: "data-bearing",

  parameters: {
    type: "object",
    properties: {
      nft_address: {
        type: "string",
        description: "Position NFT contract address",
      },
      pool_address: {
        type: "string",
        description: "Pool address (required if nft_address is a position NFT)",
      },
    },
    required: ["nft_address"],
  },

  execute: async (params) => {
    try {
      if (!ToncoSDK) {
        throw new Error(
          "@toncodex/sdk is required for on-chain fee queries. " +
          "Install it by running: cd ~/.teleton/plugins/tonco-dex && npm install"
        );
      }

      const { PositionNFTV3Contract, PoolV3Contract } = ToncoSDK;

      const nftAddress = params.nft_address.trim();
      const client = await getTonClient();

      // Read position info from NFT contract
      const positionContract = client.open(
        new PositionNFTV3Contract(Address.parse(nftAddress))
      );

      let positionInfo;
      try {
        positionInfo = await positionContract.getPositionInfo();
      } catch (err) {
        return { success: false, error: `Failed to read position NFT: ${err.message}` };
      }

      const { liquidity, tickLow, tickHigh, feeGrowthInside0LastX128, feeGrowthInside1LastX128 } = positionInfo;

      // Get pool address from indexer if not provided
      let poolAddress = params.pool_address?.trim();
      if (!poolAddress) {
        const nftData = await positionContract.getData();
        const collectionAddr = nftData?.collection?.toString();
        if (!collectionAddr) {
          return { success: false, error: "Pool address required: could not determine pool from NFT collection" };
        }
        poolAddress = collectionAddr;
      }

      // Open pool contract and get current state
      const poolContract = client.open(
        new PoolV3Contract(Address.parse(poolAddress))
      );

      // Query fee amounts from pool
      const collectedFees = await poolContract.getCollectedFees(
        tickLow,
        tickHigh,
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      );

      // Fetch pool token info for formatting
      const query = `
        query GetPool($where: PoolWhere) {
          pools(where: $where) {
            jetton0 { symbol decimals }
            jetton1 { symbol decimals }
          }
        }
      `;
      const data = await gqlQuery(query, { where: { address: poolAddress } });
      const poolMeta = data.pools?.[0];
      const dec0 = poolMeta?.jetton0?.decimals ?? 9;
      const dec1 = poolMeta?.jetton1?.decimals ?? 9;

      return {
        success: true,
        data: {
          nft_address: nftAddress,
          pool_address: poolAddress,
          tick_lower: tickLow,
          tick_upper: tickHigh,
          liquidity: liquidity.toString(),
          uncollected_fees: {
            token0: formatAmount(collectedFees.amount0.toString(), dec0),
            token0_symbol: poolMeta?.jetton0?.symbol ?? "token0",
            token1: formatAmount(collectedFees.amount1.toString(), dec1),
            token1_symbol: poolMeta?.jetton1?.symbol ?? "token1",
          },
          note: "Call tonco_execute_swap or a dedicated claim transaction to collect these fees.",
        },
      };
    } catch (err) {
      _sdk?.log?.error(`tonco_get_position_fees failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const tools = (sdk) => {
  _sdk = sdk;
  return [
    toncoListPools,
    toncoGetPoolStats,
    toncoGetTokenInfo,
    toncoSwapQuote,
    toncoExecuteSwap,
    toncoGetPositions,
    toncoGetPositionFees,
  ];
};
