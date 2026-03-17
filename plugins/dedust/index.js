/**
 * DeDust plugin -- DEX on TON
 *
 * Browse pools, search assets, view trades, get prices, estimate swaps,
 * and execute on-chain swaps on the DeDust protocol.
 * Agent wallet at ~/.teleton/wallet.json signs swap transactions.
 */

import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// CJS dependencies
// ---------------------------------------------------------------------------

const _require = createRequire(realpathSync(process.argv[1]));       // core: @ton/core, @ton/ton, @ton/crypto
const _pluginRequire = createRequire(import.meta.url);                // local: plugin-specific deps

const { Address, beginCell, toNano, fromNano, SendMode } = _require("@ton/core");
const { WalletContractV5R1, TonClient, internal } = _require("@ton/ton");
const { mnemonicToPrivateKey } = _require("@ton/crypto");

// DeDust SDK -- loaded from plugin's local node_modules
let DedustSDK = null;
try {
  DedustSDK = _pluginRequire("@dedust/sdk");
} catch {
  // SDK not available; on-chain tools will throw a clear error
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.dedust.io";
const WALLET_FILE = join(homedir(), ".teleton", "wallet.json");
const FACTORY_ADDR = "EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67";

// ---------------------------------------------------------------------------
// Shared API helper
// ---------------------------------------------------------------------------

async function dedustFetch(path, opts = {}) {
  const url =
    typeof path === "string" && path.startsWith("http")
      ? path
      : new URL(path, API_BASE);
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `DeDust API error: ${res.status} ${text.slice(0, 200)}`
    );
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Asset cache (5-minute TTL via sdk.storage)
// ---------------------------------------------------------------------------

let _sdk = null;

async function getAssets() {
  const cached = _sdk?.storage?.get("dedust_assets");
  if (cached) return cached;
  // Direct URL avoids 301 redirect from api.dedust.io/v2/assets
  const res = await fetch("https://assets.dedust.io/list.json", {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`DeDust API error: ${res.status}`);
  const data = await res.json();
  _sdk?.storage?.set("dedust_assets", data, { ttl: 5 * 60 * 1000 });
  return data;
}

function findAssetDecimals(assets, type, address) {
  if (type === "native") {
    const a = assets.find((a) => a.type === "native");
    return a?.decimals ?? 9;
  }
  if (!address) return 9;
  const a = assets.find(
    (a) => a.type === "jetton" && a.address === address
  );
  return a?.decimals ?? 9;
}

function formatAmount(raw, decimals) {
  if (!raw) return "0";
  const s = String(raw);
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

// ---------------------------------------------------------------------------
// Wallet helper
// ---------------------------------------------------------------------------

async function getWalletAndClient() {
  let walletData;
  try {
    walletData = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  } catch {
    throw new Error("Agent wallet not found at " + WALLET_FILE);
  }
  if (!walletData.mnemonic || !Array.isArray(walletData.mnemonic)) {
    throw new Error("Invalid wallet file: missing mnemonic array");
  }

  const keyPair = await mnemonicToPrivateKey(walletData.mnemonic);
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  let endpoint;
  try {
    const { getHttpEndpoint } = _pluginRequire("@orbs-network/ton-access");
    endpoint = await getHttpEndpoint({ network: "mainnet" });
  } catch {
    endpoint = "https://toncenter.com/api/v2/jsonRPC";
  }

  const client = new TonClient({ endpoint });
  const contract = client.open(wallet);

  return { wallet, keyPair, client, contract };
}

function requireSDK() {
  if (!DedustSDK) {
    throw new Error(
      "@dedust/sdk is not installed in the teleton runtime. " +
      "Install it with: npm install @dedust/sdk"
    );
  }
  return DedustSDK;
}

// ---------------------------------------------------------------------------
// Tool 1: dedust_assets
// ---------------------------------------------------------------------------

const dedustAssets = {
  name: "dedust_assets",
  description:
    "Search or list tokens available on DeDust by symbol name or address. Returns token metadata including address, name, symbol, decimals, image, and type.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          'Token symbol (e.g. "USDT", "TON") or address (e.g. "EQCxE6...")',
      },
    },
    required: ["search"],
  },

  execute: async (params) => {
    try {
      const search = (params.search ?? "").trim();
      if (!search) throw new Error("search parameter is required");

      const assets = await getAssets();

      const isAddress =
        search.includes(":") ||
        search.startsWith("EQ") ||
        search.startsWith("UQ") ||
        search.length > 30;

      let results;
      if (isAddress) {
        results = assets.filter(
          (a) => a.address && a.address.toLowerCase() === search.toLowerCase()
        );
      } else {
        const q = search.toLowerCase();
        results = assets.filter(
          (a) =>
            (a.symbol && a.symbol.toLowerCase().includes(q)) ||
            (a.name && a.name.toLowerCase().includes(q))
        );
      }

      if (results.length === 0) {
        return { success: false, error: "No assets found for: " + search };
      }

      const data = results.slice(0, 20).map((a) => ({
        type: a.type,
        address: a.address ?? null,
        name: a.name,
        symbol: a.symbol,
        decimals: a.decimals,
        image: a.image ?? null,
      }));

      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: dedust_pools
// ---------------------------------------------------------------------------

const dedustPools = {
  name: "dedust_pools",
  description:
    "List top DeDust liquidity pools sorted by reserves, volume, or fees. Optionally filter by token symbol or address.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          "Filter pools by token symbol or address (optional)",
      },
      limit: {
        type: "integer",
        description: "Number of results (1-50, default 10)",
        minimum: 1,
        maximum: 50,
      },
      sort_by: {
        type: "string",
        enum: ["reserves", "volume", "fees"],
        description: 'Sort by metric (default: "reserves")',
      },
    },
  },

  execute: async (params) => {
    try {
      const limit = params.limit ?? 10;
      const sortBy = params.sort_by ?? "reserves";
      const search = (params.search ?? "").trim().toLowerCase();

      // Fetch assets for symbol resolution and decimals
      const assets = await getAssets();
      const assetMap = new Map();
      for (const a of assets) {
        if (a.type === "native") {
          assetMap.set("native", a);
        } else if (a.address) {
          assetMap.set(a.address, a);
        }
      }

      // Fetch pools-lite (much smaller than /v2/pools)
      const pools = await dedustFetch("/v2/pools-lite");

      // Parse asset strings from pools-lite format: "native" or "jetton:EQ..."
      function parsePoolAsset(assetStr) {
        if (assetStr === "native") return { type: "native", address: null };
        if (typeof assetStr === "string" && assetStr.startsWith("jetton:")) {
          return { type: "jetton", address: assetStr.slice(7) };
        }
        return { type: "unknown", address: null };
      }

      // Filter
      let filtered = pools;
      if (search) {
        filtered = pools.filter((p) => {
          if (!Array.isArray(p.assets)) return false;
          return p.assets.some((assetStr) => {
            const parsed = parsePoolAsset(assetStr);
            if (parsed.address && parsed.address.toLowerCase().includes(search)) return true;
            const meta = parsed.type === "native"
              ? assetMap.get("native")
              : assetMap.get(parsed.address);
            if (meta) {
              return (
                (meta.symbol && meta.symbol.toLowerCase().includes(search)) ||
                (meta.name && meta.name.toLowerCase().includes(search))
              );
            }
            return false;
          });
        });
      }

      // Sort
      const sortFn = (a, b) => {
        const getVal = (pool) => {
          if (sortBy === "reserves") {
            return (BigInt(pool.reserves?.[0] ?? "0") + BigInt(pool.reserves?.[1] ?? "0"));
          }
          if (sortBy === "volume") {
            return (BigInt(pool.volume?.[0] ?? "0") + BigInt(pool.volume?.[1] ?? "0"));
          }
          if (sortBy === "fees") {
            return (BigInt(pool.fees?.[0] ?? "0") + BigInt(pool.fees?.[1] ?? "0"));
          }
          return 0n;
        };
        const va = getVal(a);
        const vb = getVal(b);
        if (vb > va) return 1;
        if (vb < va) return -1;
        return 0;
      };

      filtered.sort(sortFn);

      const result = filtered.slice(0, limit).map((p) => {
        const assetsParsed = (p.assets ?? []).map(parsePoolAsset);
        const symbols = assetsParsed.map((a) => {
          if (a.type === "native") return "TON";
          const meta = assetMap.get(a.address);
          return meta?.symbol ?? a.address?.slice(0, 10) ?? "?";
        });
        const decimals = assetsParsed.map((a) => {
          if (a.type === "native") return 9;
          const meta = assetMap.get(a.address);
          return meta?.decimals ?? 9;
        });

        return {
          address: p.address,
          type: p.type,
          pair: symbols.join("/"),
          reserves: [
            formatAmount(p.reserves?.[0], decimals[0]),
            formatAmount(p.reserves?.[1], decimals[1]),
          ],
          volume_24h: [
            formatAmount(p.volume?.[0], decimals[0]),
            formatAmount(p.volume?.[1], decimals[1]),
          ],
          fees_24h: [
            formatAmount(p.fees?.[0], decimals[0]),
            formatAmount(p.fees?.[1], decimals[1]),
          ],
          tradeFee: p.tradeFee,
        };
      });

      return { success: true, data: { pools: result, count: result.length } };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: dedust_pool_trades
// ---------------------------------------------------------------------------

const dedustPoolTrades = {
  name: "dedust_pool_trades",
  description:
    "Get recent trades for a specific DeDust pool by its address.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool_address: {
        type: "string",
        description: "Pool contract address",
      },
      limit: {
        type: "integer",
        description: "Number of trades to return (1-100, default 20)",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["pool_address"],
  },

  execute: async (params) => {
    try {
      const addr = params.pool_address;
      const limit = params.limit ?? 20;

      const trades = await dedustFetch(
        `/v2/pools/${encodeURIComponent(addr)}/trades?page_size=${limit}`
      );

      if (!Array.isArray(trades) || trades.length === 0) {
        return { success: true, data: { trades: [], count: 0 } };
      }

      // Get assets for decimals
      const assets = await getAssets();

      const result = trades.map((t) => {
        const inType = t.assetIn?.type ?? "unknown";
        const outType = t.assetOut?.type ?? "unknown";
        const inAddr = t.assetIn?.address ?? null;
        const outAddr = t.assetOut?.address ?? null;
        const inDecimals = findAssetDecimals(assets, inType, inAddr);
        const outDecimals = findAssetDecimals(assets, outType, outAddr);

        return {
          sender: t.sender,
          asset_in: inType === "native" ? "TON" : inAddr,
          asset_out: outType === "native" ? "TON" : outAddr,
          amount_in: formatAmount(t.amountIn, inDecimals),
          amount_out: formatAmount(t.amountOut, outDecimals),
          time: t.createdAt,
          lt: t.lt,
        };
      });

      return { success: true, data: { trades: result, count: result.length } };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: dedust_pool_info
// ---------------------------------------------------------------------------

const dedustPoolInfo = {
  name: "dedust_pool_info",
  description:
    "Get detailed info for a specific DeDust pool including metadata, reserves, volume, fees, and trade fee.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool_address: {
        type: "string",
        description: "Pool contract address",
      },
    },
    required: ["pool_address"],
  },

  execute: async (params) => {
    try {
      const addr = params.pool_address;

      // Fetch metadata and full pool data in parallel
      const [metadata, allPools] = await Promise.all([
        dedustFetch(`/v2/pools/${encodeURIComponent(addr)}/metadata`),
        dedustFetch("/v2/pools-lite"),
      ]);

      const pool = allPools.find((p) => p.address === addr);
      if (!pool) {
        return { success: false, error: "Pool not found: " + addr };
      }

      const assets = await getAssets();

      // Parse assets from pools-lite format
      function parsePoolAsset(assetStr) {
        if (assetStr === "native") return { type: "native", address: null };
        if (typeof assetStr === "string" && assetStr.startsWith("jetton:")) {
          return { type: "jetton", address: assetStr.slice(7) };
        }
        return { type: "unknown", address: null };
      }

      const assetsParsed = (pool.assets ?? []).map(parsePoolAsset);
      const symbols = assetsParsed.map((a) => {
        if (a.type === "native") return "TON";
        const meta = assets.find((x) => x.address === a.address);
        return meta?.symbol ?? a.address?.slice(0, 10) ?? "?";
      });
      const decimals = assetsParsed.map((a) => {
        if (a.type === "native") return 9;
        const meta = assets.find((x) => x.address === a.address);
        return meta?.decimals ?? 9;
      });

      return {
        success: true,
        data: {
          address: pool.address,
          name: metadata?.name ?? null,
          type: pool.type,
          tradeFee: pool.tradeFee,
          pair: symbols.join("/"),
          assets: assetsParsed.map((a, i) => ({
            type: a.type,
            address: a.address,
            symbol: symbols[i],
            decimals: decimals[i],
          })),
          reserves: [
            formatAmount(pool.reserves?.[0], decimals[0]),
            formatAmount(pool.reserves?.[1], decimals[1]),
          ],
          volume_24h: [
            formatAmount(pool.volume?.[0], decimals[0]),
            formatAmount(pool.volume?.[1], decimals[1]),
          ],
          fees_24h: [
            formatAmount(pool.fees?.[0], decimals[0]),
            formatAmount(pool.fees?.[1], decimals[1]),
          ],
          totalSupply: pool.totalSupply,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: dedust_jetton_info
// ---------------------------------------------------------------------------

const dedustJettonInfo = {
  name: "dedust_jetton_info",
  description:
    "Get jetton (token) metadata, top holders, and top traders from DeDust.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Jetton minter address (e.g. EQCxE6...)",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const addr = params.address;

      // Fetch all three in parallel
      const [metadata, holders, topTraders] = await Promise.all([
        dedustFetch(`/v2/jettons/${encodeURIComponent(addr)}/metadata`),
        dedustFetch(`/v2/jettons/${encodeURIComponent(addr)}/holders`),
        dedustFetch(`/v2/jettons/${encodeURIComponent(addr)}/top-traders`),
      ]);

      const decimals = metadata?.decimals ?? 9;

      const topHolders = (Array.isArray(holders) ? holders : [])
        .slice(0, 10)
        .map((h) => ({
          owner: h.owner,
          balance: formatAmount(h.balance, decimals),
        }));

      const traders = (Array.isArray(topTraders) ? topTraders : [])
        .slice(0, 10)
        .map((t) => ({
          wallet: t.walletAddress,
          volume: formatAmount(t.volume, decimals),
          swaps: t.swaps,
        }));

      return {
        success: true,
        data: {
          address: addr,
          name: metadata?.name ?? null,
          symbol: metadata?.symbol ?? null,
          decimals,
          image: metadata?.image ?? null,
          description: metadata?.description ?? null,
          top_holders: topHolders,
          top_traders: traders,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: dedust_prices
// ---------------------------------------------------------------------------

const dedustPrices = {
  name: "dedust_prices",
  description:
    'Get prices and liquidity data for tokens from DeDust CoinGecko tickers. Use token addresses or "native" for TON.',
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      tokens: {
        type: "array",
        items: { type: "string" },
        description:
          'Token addresses to look up. Use "native" for TON. (e.g. ["native", "EQCxE6..."])',
      },
    },
    required: ["tokens"],
  },

  execute: async (params) => {
    try {
      if (!Array.isArray(params.tokens) || params.tokens.length === 0) {
        throw new Error("tokens must be a non-empty array");
      }

      const TON_ZERO_ADDR = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

      // Normalize addresses: "native" -> TON zero address
      const lookupAddrs = params.tokens.map((t) =>
        t === "native" ? TON_ZERO_ADDR : t
      );

      const tickers = await dedustFetch("/v2/gcko/tickers");

      if (!Array.isArray(tickers)) {
        return { success: true, data: [] };
      }

      // Find tickers where base or target matches any requested token
      const results = [];
      const seen = new Set();

      for (const addr of lookupAddrs) {
        const addrLower = addr.toLowerCase();
        const matching = tickers.filter((t) => {
          const base = (t.base_currency ?? "").toLowerCase();
          const target = (t.target_currency ?? "").toLowerCase();
          return base === addrLower || target === addrLower;
        });

        // Take top tickers by liquidity for this token
        matching.sort(
          (a, b) =>
            parseFloat(b.liquidity_in_usd ?? "0") -
            parseFloat(a.liquidity_in_usd ?? "0")
        );

        for (const t of matching.slice(0, 3)) {
          const key = t.ticker_id;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            ticker_id: t.ticker_id,
            base: t.base_currency === TON_ZERO_ADDR ? "TON (native)" : t.base_currency,
            target: t.target_currency === TON_ZERO_ADDR ? "TON (native)" : t.target_currency,
            last_price: t.last_price,
            base_volume: t.base_volume,
            target_volume: t.target_volume,
            liquidity_usd: t.liquidity_in_usd,
            pool_id: t.pool_id,
          });
        }
      }

      return { success: true, data: results };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 7: dedust_swap_estimate
// ---------------------------------------------------------------------------

const dedustSwapEstimate = {
  name: "dedust_swap_estimate",
  description:
    'Estimate swap output on DeDust using on-chain pool get-methods. Returns expected output amount and trade fee. Use "native" for TON or a jetton address.',
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      input_token: {
        type: "string",
        description: 'Input token address or "native" for TON',
      },
      output_token: {
        type: "string",
        description: 'Output token address or "native" for TON',
      },
      input_amount: {
        type: "string",
        description:
          'Amount to swap in human-readable units (e.g. "10" for 10 TON)',
      },
    },
    required: ["input_token", "output_token", "input_amount"],
  },

  execute: async (params) => {
    try {
      const sdk = requireSDK();
      const { Factory, PoolType, Asset } = sdk;

      const inputAmount = Number(params.input_amount);
      if (!Number.isFinite(inputAmount) || inputAmount <= 0) {
        throw new Error("input_amount must be a positive number");
      }

      _sdk?.log?.info(`Estimating swap: ${params.input_amount} ${params.input_token} -> ${params.output_token}`);

      // Resolve assets
      const assets = await getAssets();
      const isInputNative = params.input_token === "native";
      const isOutputNative = params.output_token === "native";

      const inputDecimals = isInputNative
        ? 9
        : findAssetDecimals(assets, "jetton", params.input_token);
      const outputDecimals = isOutputNative
        ? 9
        : findAssetDecimals(assets, "jetton", params.output_token);

      const inputAsset = isInputNative
        ? Asset.native()
        : Asset.jetton(Address.parse(params.input_token));
      const outputAsset = isOutputNative
        ? Asset.native()
        : Asset.jetton(Address.parse(params.output_token));

      // Convert to raw amount
      const rawInput = BigInt(
        Math.round(inputAmount * 10 ** inputDecimals)
      );

      // Connect to chain
      const { client } = await getWalletAndClient();
      const factory = client.open(
        Factory.createFromAddress(Address.parse(FACTORY_ADDR))
      );

      // Resolve pool
      const pool = client.open(
        await factory.getPool(PoolType.VOLATILE, [inputAsset, outputAsset])
      );

      // Check readiness
      const { ReadinessStatus } = sdk;
      const readiness = await pool.getReadinessStatus();
      if (readiness !== ReadinessStatus.READY) {
        throw new Error(
          "Pool is not ready. It may not exist for this pair or pool type."
        );
      }

      // Estimate
      const estimate = await pool.getEstimatedSwapOut({
        assetIn: inputAsset,
        amountIn: rawInput,
      });

      return {
        success: true,
        data: {
          input_token: params.input_token,
          output_token: params.output_token,
          input_amount: params.input_amount,
          estimated_output: formatAmount(
            estimate.amountOut.toString(),
            outputDecimals
          ),
          trade_fee: formatAmount(
            estimate.tradeFee.toString(),
            inputDecimals
          ),
          trade_fee_token: params.input_token,
          pool_address: pool.address.toString(),
        },
      };
    } catch (err) {
      _sdk?.log?.error(`Swap estimate failed: ${err.message}`);
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 8: dedust_swap
// ---------------------------------------------------------------------------

const dedustSwap = {
  name: "dedust_swap",
  description:
    'Execute a swap on DeDust from the agent wallet. Supports TON->Jetton and Jetton->TON swaps. Use "native" for TON. Call dedust_swap_estimate first to preview the output.',
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      input_token: {
        type: "string",
        description: 'Input token address or "native" for TON',
      },
      output_token: {
        type: "string",
        description: 'Output token address or "native" for TON',
      },
      input_amount: {
        type: "string",
        description:
          'Amount to swap in human-readable units (e.g. "10" for 10 TON)',
      },
      slippage: {
        type: "number",
        description:
          "Slippage tolerance (0.05 = 5%, default 0.05, range 0.001-0.5)",
        minimum: 0.001,
        maximum: 0.5,
      },
    },
    required: ["input_token", "output_token", "input_amount"],
  },

  execute: async (params) => {
    try {
      const sdk = requireSDK();
      const {
        Factory,
        PoolType,
        Asset,
        VaultNative,
        VaultJetton,
        JettonRoot,
        ReadinessStatus,
      } = sdk;

      const slippage = params.slippage ?? 0.05;
      const inputAmount = Number(params.input_amount);
      if (!Number.isFinite(inputAmount) || inputAmount <= 0) {
        throw new Error("input_amount must be a positive number");
      }

      const isInputNative = params.input_token === "native";
      const isOutputNative = params.output_token === "native";

      if (isInputNative && isOutputNative) {
        throw new Error("Cannot swap TON to TON");
      }

      _sdk?.log?.info(`Executing swap: ${params.input_amount} ${params.input_token} -> ${params.output_token} (slippage: ${slippage})`);

      // Resolve assets and decimals
      const allAssets = await getAssets();
      const inputDecimals = isInputNative
        ? 9
        : findAssetDecimals(allAssets, "jetton", params.input_token);

      const inputAsset = isInputNative
        ? Asset.native()
        : Asset.jetton(Address.parse(params.input_token));
      const outputAsset = isOutputNative
        ? Asset.native()
        : Asset.jetton(Address.parse(params.output_token));

      const rawInput = BigInt(
        Math.round(inputAmount * 10 ** inputDecimals)
      );

      // Connect
      const { wallet, keyPair, client, contract } =
        await getWalletAndClient();
      const factory = client.open(
        Factory.createFromAddress(Address.parse(FACTORY_ADDR))
      );

      // Resolve pool
      const pool = client.open(
        await factory.getPool(PoolType.VOLATILE, [inputAsset, outputAsset])
      );

      const readiness = await pool.getReadinessStatus();
      if (readiness !== ReadinessStatus.READY) {
        throw new Error(
          "Pool is not ready. It may not exist for this pair."
        );
      }

      // Estimate to calculate min output with slippage
      const estimate = await pool.getEstimatedSwapOut({
        assetIn: inputAsset,
        amountIn: rawInput,
      });

      const minOut =
        (estimate.amountOut * BigInt(Math.round((1 - slippage) * 10000))) /
        10000n;

      const sender = contract.sender(keyPair.secretKey);

      if (isInputNative) {
        // TON -> Jetton: use VaultNative
        const tonVault = client.open(await factory.getNativeVault());

        const vaultReadiness = await tonVault.getReadinessStatus();
        if (vaultReadiness !== ReadinessStatus.READY) {
          throw new Error("Native vault is not ready");
        }

        await tonVault.sendSwap(sender, {
          poolAddress: pool.address,
          amount: rawInput,
          gasAmount: toNano("0.25"),
          limit: minOut,
        });
      } else {
        // Jetton -> TON or Jetton -> Jetton: use VaultJetton
        const jettonVault = client.open(
          await factory.getJettonVault(Address.parse(params.input_token))
        );

        const vaultReadiness = await jettonVault.getReadinessStatus();
        if (vaultReadiness !== ReadinessStatus.READY) {
          throw new Error("Jetton vault is not ready");
        }

        const jettonRoot = client.open(
          JettonRoot.createFromAddress(Address.parse(params.input_token))
        );
        const jettonWallet = client.open(
          await jettonRoot.getWallet(wallet.address)
        );

        const forwardPayload = VaultJetton.createSwapPayload({
          poolAddress: pool.address,
          limit: minOut,
        });

        await jettonWallet.sendTransfer(sender, toNano("0.3"), {
          amount: rawInput,
          destination: jettonVault.address,
          responseAddress: wallet.address,
          forwardAmount: toNano("0.25"),
          forwardPayload,
        });
      }

      const outputDecimals = isOutputNative
        ? 9
        : findAssetDecimals(allAssets, "jetton", params.output_token);

      return {
        success: true,
        data: {
          input_token: params.input_token,
          output_token: params.output_token,
          input_amount: params.input_amount,
          estimated_output: formatAmount(
            estimate.amountOut.toString(),
            outputDecimals
          ),
          min_output: formatAmount(minOut.toString(), outputDecimals),
          slippage,
          pool_address: pool.address.toString(),
          wallet_address: wallet.address.toString(),
          message:
            "Swap transaction sent. Allow ~30 seconds for on-chain confirmation.",
        },
      };
    } catch (err) {
      _sdk?.log?.error(`Swap failed: ${err.message}`);
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "dedust",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "DeDust DEX on TON — browse pools, search assets, view trades, get prices, and execute on-chain swaps.",
};

export const tools = (sdk) => {
  _sdk = sdk;
  return [
    dedustAssets,
    dedustPools,
    dedustPoolTrades,
    dedustPoolInfo,
    dedustJettonInfo,
    dedustPrices,
    dedustSwapEstimate,
    dedustSwap,
  ];
};
