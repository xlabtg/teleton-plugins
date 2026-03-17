/**
 * StonFi plugin -- DEX on TON
 *
 * Search tokens, check prices, browse pools/farms, get swap quotes,
 * and execute swaps on StonFi DEX. Uses @ston-fi/api (StonApiClient)
 * for all API calls. Agent wallet at ~/.teleton/wallet.json signs swaps.
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

const { Address, SendMode } = _require("@ton/core");
const { WalletContractV5R1, TonClient, internal } = _require("@ton/ton");
const { mnemonicToPrivateKey } = _require("@ton/crypto");

// StonFi API client (from plugin's local node_modules)
const { StonApiClient } = _pluginRequire("@ston-fi/api");
const stonApi = new StonApiClient();

// StonFi SDK (for swap execution)
let dexFactory;
try {
  const stonfi = _pluginRequire("@ston-fi/sdk");
  dexFactory = stonfi.dexFactory ?? stonfi.DEX;
} catch {
  // SDK not available -- swap execution will fail with clear error
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TON_ADDRESS = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WALLET_FILE = join(homedir(), ".teleton", "wallet.json");

// ---------------------------------------------------------------------------
// Asset cache (5-minute TTL via sdk.storage)
// queryAssets text search doesn't work, so we cache getAssets() and filter.
// ---------------------------------------------------------------------------

let _sdk = null;

async function getCachedAssets() {
  const cached = _sdk?.storage?.get("stonfi_assets");
  if (cached) return cached;
  const data = await stonApi.getAssets();
  _sdk?.storage?.set("stonfi_assets", data, { ttl: 5 * 60 * 1000 });
  return data;
}

// ---------------------------------------------------------------------------
// Amount conversion helpers
// ---------------------------------------------------------------------------

function toUnits(amount, decimals) {
  return BigInt(Math.round(Number(amount) * 10 ** decimals)).toString();
}

function fromUnits(units, decimals) {
  return (Number(units) / 10 ** decimals).toString();
}

// Format an asset from StonApiClient (camelCase) to plugin output
function fmtAsset(a) {
  return {
    address: a.contractAddress,
    name: a.displayName ?? null,
    symbol: a.symbol ?? null,
    decimals: a.decimals ?? null,
    kind: a.kind ?? null,
    price_usd: a.dexPriceUsd ?? null,
    tags: a.tags ?? [],
  };
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

// ---------------------------------------------------------------------------
// Tool 1: stonfi_search
// ---------------------------------------------------------------------------

const stonfiSearch = {
  name: "stonfi_search",
  description:
    "Search tokens on StonFi DEX by name, symbol, or contract address. Returns matching tokens with price and metadata.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          'Token name, symbol, or address to search (e.g. "USDT", "NOT", "EQCxE6...")',
      },
      limit: {
        type: "integer",
        description: "Max results to return (default 5)",
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["search"],
  },

  execute: async (params) => {
    try {
      const limit = params.limit ?? 5;
      const search = params.search.trim();

      const isAddress =
        search.startsWith("EQ") ||
        search.startsWith("UQ") ||
        search.startsWith("0:") ||
        search.length > 40;

      if (isAddress) {
        const a = await stonApi.getAsset(search);
        return { success: true, data: [fmtAsset(a)] };
      }

      // Text search -- filter cached asset list
      const assets = await getCachedAssets();
      const q = search.toLowerCase();
      const matches = assets.filter(
        (a) =>
          (a.symbol && a.symbol.toLowerCase().includes(q)) ||
          (a.displayName && a.displayName.toLowerCase().includes(q))
      );
      matches.sort(
        (a, b) => (b.popularityIndex ?? 0) - (a.popularityIndex ?? 0)
      );

      return { success: true, data: matches.slice(0, limit).map(fmtAsset) };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: stonfi_price
// ---------------------------------------------------------------------------

const stonfiPrice = {
  name: "stonfi_price",
  description:
    "Get the current USD price for a token on StonFi. Use the TON address EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c for native TON.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Token contract address",
      },
    },
    required: ["address"],
  },

  execute: async (params) => {
    try {
      const a = await stonApi.getAsset(params.address);

      return {
        success: true,
        data: {
          address: a.contractAddress ?? params.address,
          name: a.displayName ?? null,
          symbol: a.symbol ?? null,
          decimals: a.decimals ?? null,
          dex_price_usd: a.dexPriceUsd ?? null,
          third_party_price_usd: a.thirdPartyPriceUsd ?? null,
          tags: a.tags ?? [],
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
// Tool 3: stonfi_pools
// ---------------------------------------------------------------------------

const stonfiPools = {
  name: "stonfi_pools",
  description:
    "Search and list liquidity pools on StonFi. Returns pool addresses, token pairs, reserves, APY, and volume.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          "Search by token name, symbol, or address (optional)",
      },
      limit: {
        type: "integer",
        description: "Max results (default 10)",
        minimum: 1,
        maximum: 50,
      },
      sort_by: {
        type: "string",
        enum: ["popularityIndex:desc", "volume24hUsd:desc"],
        description: 'Sort order (default "popularityIndex:desc")',
      },
    },
  },

  execute: async (params) => {
    try {
      const limit = params.limit ?? 10;
      const sortBy = params.sort_by ?? "popularityIndex:desc";
      const search = (params.search ?? "").trim().toLowerCase();

      // getPools returns all pools (camelCase fields)
      let pools = (await stonApi.getPools()).slice();

      // Filter by token address or symbol
      if (search) {
        const assets = await getCachedAssets();
        const addrToMeta = new Map();
        for (const a of assets) {
          if (a.contractAddress) {
            addrToMeta.set(a.contractAddress, {
              symbol: a.symbol ?? "",
              name: a.displayName ?? "",
            });
          }
        }

        pools = pools.filter((p) => {
          const t0 = p.token0Address ?? "";
          const t1 = p.token1Address ?? "";
          if (t0.toLowerCase().includes(search) || t1.toLowerCase().includes(search)) {
            return true;
          }
          const m0 = addrToMeta.get(t0);
          const m1 = addrToMeta.get(t1);
          return (
            (m0 && (m0.symbol.toLowerCase().includes(search) || m0.name.toLowerCase().includes(search))) ||
            (m1 && (m1.symbol.toLowerCase().includes(search) || m1.name.toLowerCase().includes(search)))
          );
        });
      }

      // Sort
      const [field, dir] = sortBy.split(":");
      pools.sort((a, b) => {
        const va = parseFloat(a[field] ?? "0") || 0;
        const vb = parseFloat(b[field] ?? "0") || 0;
        return dir === "asc" ? va - vb : vb - va;
      });

      const result = pools.slice(0, limit).map((p) => ({
        address: p.address,
        router_address: p.routerAddress ?? null,
        token0_address: p.token0Address ?? null,
        token1_address: p.token1Address ?? null,
        reserve0: p.reserve0 ?? null,
        reserve1: p.reserve1 ?? null,
        lp_total_supply_usd: p.lpTotalSupplyUsd ?? null,
        lp_fee: p.lpFee ?? null,
        apy_1d: p.apy1D ?? null,
        apy_7d: p.apy7D ?? null,
        apy_30d: p.apy30D ?? null,
        volume_24h_usd: p.volume24hUsd ?? null,
        tags: p.tags ?? [],
      }));

      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: stonfi_pool_info
// ---------------------------------------------------------------------------

const stonfiPoolInfo = {
  name: "stonfi_pool_info",
  description:
    "Get detailed info for a specific StonFi liquidity pool including reserves, fees, APY, and volume.",
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
      const p = await stonApi.getPool(params.pool_address);

      return {
        success: true,
        data: {
          address: p.address,
          router_address: p.routerAddress ?? null,
          token0_address: p.token0Address ?? null,
          token1_address: p.token1Address ?? null,
          reserve0: p.reserve0 ?? null,
          reserve1: p.reserve1 ?? null,
          lp_total_supply: p.lpTotalSupply ?? null,
          lp_total_supply_usd: p.lpTotalSupplyUsd ?? null,
          lp_fee: p.lpFee ?? null,
          protocol_fee: p.protocolFee ?? null,
          lp_price_usd: p.lpPriceUsd ?? null,
          apy_1d: p.apy1D ?? null,
          apy_7d: p.apy7D ?? null,
          apy_30d: p.apy30D ?? null,
          volume_24h_usd: p.volume24hUsd ?? null,
          deprecated: p.deprecated ?? false,
          tags: p.tags ?? [],
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
// Tool 5: stonfi_farms
// ---------------------------------------------------------------------------

const stonfiFarms = {
  name: "stonfi_farms",
  description:
    "List active farming opportunities on StonFi. Optionally filter by pool address.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      pool_address: {
        type: "string",
        description: "Filter farms by pool address (optional)",
      },
    },
  },

  execute: async (params) => {
    try {
      let rawFarms;
      if (params.pool_address) {
        rawFarms = await stonApi.getFarmsByPool(params.pool_address);
      } else {
        rawFarms = await stonApi.getFarms();
      }

      const farms = rawFarms.map((f) => ({
        minter_address: f.minterAddress ?? null,
        pool_address: f.poolAddress ?? null,
        version: f.version ?? null,
        status: f.status ?? null,
        apy: f.apy ?? null,
        locked_total_lp: f.lockedTotalLp ?? null,
        locked_total_lp_usd: f.lockedTotalLpUsd ?? null,
        min_stake_duration_s: f.minStakeDurationS ?? null,
        rewards: (f.rewards ?? []).map((r) => ({
          address: r.address ?? null,
          status: r.status ?? null,
          reward_rate_24h: r.rewardRate24h ?? null,
        })),
      }));

      return { success: true, data: farms };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: stonfi_dex_stats
// ---------------------------------------------------------------------------

const stonfiDexStats = {
  name: "stonfi_dex_stats",
  description:
    "Get overall StonFi DEX statistics including TVL, total volume, unique wallets, and trade count.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async () => {
    try {
      // No StonApiClient method for stats -- use raw fetch
      const res = await fetch("https://api.ston.fi/v1/stats/dex", {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`StonFi API error: ${res.status}`);
      const data = await res.json();

      return {
        success: true,
        data: {
          since: data.since ?? null,
          until: data.until ?? null,
          tvl: data.stats?.tvl ?? null,
          volume_usd: data.stats?.volume_usd ?? null,
          unique_wallets: data.stats?.unique_wallets ?? null,
          trades: data.stats?.trades ?? null,
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
// Tool 7: stonfi_swap_quote
// ---------------------------------------------------------------------------

const stonfiSwapQuote = {
  name: "stonfi_swap_quote",
  description:
    "Get a swap quote on StonFi -- simulates a swap between two tokens and returns expected output, price impact, fees, and gas estimate. Use TON address EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c for native TON.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      offer_address: {
        type: "string",
        description: "Source token contract address",
      },
      ask_address: {
        type: "string",
        description: "Destination token contract address",
      },
      amount: {
        type: "string",
        description:
          'Amount to swap in human-readable units (e.g. "10" for 10 TON)',
      },
      slippage: {
        type: "number",
        description: "Slippage tolerance (0.01 = 1%, default 0.01)",
        minimum: 0.001,
        maximum: 0.5,
      },
    },
    required: ["offer_address", "ask_address", "amount"],
  },

  execute: async (params) => {
    try {
      const slippage = params.slippage ?? 0.01;
      const inputAmount = Number(params.amount);
      if (!Number.isFinite(inputAmount) || inputAmount <= 0) {
        throw new Error("amount must be a positive number");
      }

      // Look up both asset decimals in parallel
      const [offerAsset, askAsset] = await Promise.all([
        stonApi.getAsset(params.offer_address),
        stonApi.getAsset(params.ask_address),
      ]);
      const offerDecimals = offerAsset.decimals ?? 9;
      const askDecimals = askAsset.decimals ?? 9;

      _sdk?.log?.info(`Swap quote: ${params.amount} ${offerAsset.symbol} -> ${askAsset.symbol}`);

      // Convert to smallest units
      const units = toUnits(params.amount, offerDecimals);

      // Simulate via StonApiClient
      const sim = await stonApi.simulateSwap({
        offerAddress: params.offer_address,
        askAddress: params.ask_address,
        offerUnits: units,
        slippageTolerance: String(slippage),
      });

      return {
        success: true,
        data: {
          offer_address: sim.offerAddress,
          ask_address: sim.askAddress,
          offer_amount: params.amount,
          offer_units: sim.offerUnits,
          ask_units: sim.askUnits,
          ask_amount: fromUnits(sim.askUnits, askDecimals),
          min_ask_units: sim.minAskUnits,
          min_ask_amount: fromUnits(sim.minAskUnits, askDecimals),
          swap_rate: sim.swapRate ?? null,
          price_impact: sim.priceImpact ?? null,
          fee_percent: sim.feePercent ?? null,
          fee_units: sim.feeUnits ?? null,
          slippage_tolerance: sim.slippageTolerance,
          forward_gas: sim.gasParams?.forwardGas ?? null,
          estimated_gas: sim.gasParams?.estimatedGasConsumption ?? null,
          router_address: sim.routerAddress ?? null,
          pool_address: sim.poolAddress ?? null,
          offer_symbol: offerAsset.symbol ?? null,
          ask_symbol: askAsset.symbol ?? null,
        },
      };
    } catch (err) {
      _sdk?.log?.error(`Swap quote failed: ${err.message}`);
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 8: stonfi_swap
// ---------------------------------------------------------------------------

const stonfiSwap = {
  name: "stonfi_swap",
  description:
    "Execute a token swap on StonFi DEX. Simulates the swap via @ston-fi/api, builds the transaction via @ston-fi/sdk, and signs with the agent wallet. Call stonfi_swap_quote first to preview.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      offer_address: {
        type: "string",
        description: "Source token contract address",
      },
      ask_address: {
        type: "string",
        description: "Destination token contract address",
      },
      amount: {
        type: "string",
        description:
          'Amount to swap in human-readable units (e.g. "10" for 10 TON)',
      },
      slippage: {
        type: "number",
        description: "Slippage tolerance (0.01 = 1%, default 0.01)",
        minimum: 0.001,
        maximum: 0.5,
      },
    },
    required: ["offer_address", "ask_address", "amount"],
  },

  execute: async (params) => {
    try {
      if (!dexFactory) {
        throw new Error(
          "@ston-fi/sdk is not installed. Install it to execute swaps."
        );
      }

      const slippage = params.slippage ?? 0.01;
      const inputAmount = Number(params.amount);
      if (!Number.isFinite(inputAmount) || inputAmount <= 0) {
        throw new Error("amount must be a positive number");
      }

      // Step 1: Look up offer + ask asset decimals in parallel
      const [offerAsset, askAsset] = await Promise.all([
        stonApi.getAsset(params.offer_address),
        stonApi.getAsset(params.ask_address),
      ]);
      const offerDecimals = offerAsset.decimals ?? 9;
      const askDecimals = askAsset.decimals ?? 9;

      _sdk?.log?.info(`Executing swap: ${params.amount} ${offerAsset.symbol} -> ${askAsset.symbol} (slippage: ${slippage})`);

      // Step 2: Simulate swap via StonApiClient
      const units = toUnits(params.amount, offerDecimals);
      const sim = await stonApi.simulateSwap({
        offerAddress: params.offer_address,
        askAddress: params.ask_address,
        offerUnits: units,
        slippageTolerance: String(slippage),
      });

      if (!sim.router) {
        throw new Error("Swap simulation did not return router info");
      }

      // Step 3: Get wallet
      const { wallet, keyPair, client, contract } =
        await getWalletAndClient();
      const walletAddr = wallet.address.toString();

      // Step 4: Build transaction via SDK (dexFactory auto-detects version)
      const dexContracts = dexFactory(sim.router);
      const router = client.open(
        dexContracts.Router.create(sim.router.address)
      );
      const proxyTon = dexContracts.pTON.create(
        sim.router.ptonMasterAddress
      );

      const offerIsTon = params.offer_address === TON_ADDRESS;
      const askIsTon = params.ask_address === TON_ADDRESS;

      let txParams;
      if (offerIsTon) {
        txParams = await router.getSwapTonToJettonTxParams({
          userWalletAddress: walletAddr,
          offerAmount: sim.offerUnits,
          minAskAmount: sim.minAskUnits,
          askJettonAddress: params.ask_address,
          proxyTon,
        });
      } else if (askIsTon) {
        txParams = await router.getSwapJettonToTonTxParams({
          userWalletAddress: walletAddr,
          offerJettonAddress: params.offer_address,
          offerAmount: sim.offerUnits,
          minAskAmount: sim.minAskUnits,
          proxyTon,
        });
      } else {
        txParams = await router.getSwapJettonToJettonTxParams({
          userWalletAddress: walletAddr,
          offerJettonAddress: params.offer_address,
          askJettonAddress: params.ask_address,
          offerAmount: sim.offerUnits,
          minAskAmount: sim.minAskUnits,
        });
      }

      // Step 5: Send transaction
      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: txParams.to,
            value: txParams.value,
            body: txParams.body,
            bounce: true,
          }),
        ],
      });

      return {
        success: true,
        data: {
          offer_amount: params.amount,
          offer_symbol: offerAsset.symbol ?? null,
          expected_output: fromUnits(sim.askUnits, askDecimals),
          min_output: fromUnits(sim.minAskUnits, askDecimals),
          ask_symbol: askAsset.symbol ?? null,
          swap_rate: sim.swapRate ?? null,
          price_impact: sim.priceImpact ?? null,
          slippage,
          seqno,
          wallet_address: walletAddr,
          router_address: sim.routerAddress ?? null,
          pool_address: sim.poolAddress ?? null,
          message:
            "Swap transaction sent. Confirmation typically takes ~30 seconds on TON.",
        },
      };
    } catch (err) {
      _sdk?.log?.error(`Swap execution failed: ${err.message}`);
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
  name: "stonfi",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "StonFi DEX on TON — search tokens, check prices, browse pools/farms, get swap quotes, and execute swaps.",
};

export const tools = (sdk) => {
  _sdk = sdk;
  return [
    stonfiSearch,
    stonfiPrice,
    stonfiPools,
    stonfiPoolInfo,
    stonfiFarms,
    stonfiDexStats,
    stonfiSwapQuote,
    stonfiSwap,
  ];
};
