/**
 * swap.coffee plugin -- DEX aggregator on TON
 *
 * Find optimal swap routes, execute token swaps, browse pools, and check
 * token prices across all major TON DEXes (StonFi, DeDust, etc.).
 * Agent wallet at ~/.teleton/wallet.json signs all swap transactions.
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

const { Cell, Address, SendMode } = _require("@ton/core");
const { WalletContractV5R1, TonClient, internal } = _require("@ton/ton");
const { mnemonicToPrivateKey } = _require("@ton/crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://backend.swap.coffee";
const WALLET_FILE = join(homedir(), ".teleton", "wallet.json");

let _sdk = null;

// ---------------------------------------------------------------------------
// Shared API helper
// ---------------------------------------------------------------------------

async function swapFetch(path, opts = {}) {
  const url =
    typeof path === "string" && path.startsWith("http")
      ? path
      : new URL(path, API_BASE);
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `swap.coffee API error: ${res.status} ${text.slice(0, 200)}`
    );
  }
  return res.json();
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
// Tool 1: swap_quote
// ---------------------------------------------------------------------------

const swapQuote = {
  name: "swap_quote",
  description:
    "Get a swap quote -- find the optimal route between two tokens on TON with expected output amount, price impact, and gas estimate. Use token addresses (e.g. 'EQCxE6...') or 'native' for TON.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      input_token: {
        type: "string",
        description:
          'Source token address or "native" for TON (e.g. "EQCxE6...")',
      },
      output_token: {
        type: "string",
        description:
          'Destination token address or "native" for TON (e.g. "EQCxE6...")',
      },
      input_amount: {
        type: "string",
        description:
          'Amount to swap in human-readable units (e.g. "10" for 10 TON)',
      },
      max_splits: {
        type: "integer",
        description: "Route splits for better price (1-20, default 4)",
        minimum: 1,
        maximum: 20,
      },
    },
    required: ["input_token", "output_token", "input_amount"],
  },

  execute: async (params) => {
    try {
      const maxSplits = params.max_splits ?? 4;
      const inputAmount = Number(params.input_amount);
      if (!Number.isFinite(inputAmount) || inputAmount <= 0) {
        throw new Error("input_amount must be a positive number");
      }

      _sdk?.log?.info(`Swap quote: ${params.input_amount} ${params.input_token} -> ${params.output_token}`);

      const body = {
        input_token: { blockchain: "ton", address: params.input_token },
        output_token: { blockchain: "ton", address: params.output_token },
        input_amount: inputAmount,
        max_splits: maxSplits,
        max_length: 3,
      };

      const data = await swapFetch("/v1/route", {
        method: "POST",
        body: JSON.stringify(body),
      });

      // Summarize the route paths for the LLM
      const dexes = new Set();
      let totalHops = 0;
      if (Array.isArray(data.paths)) {
        for (const path of data.paths) {
          if (path.dex) dexes.add(path.dex);
          totalHops++;
        }
      }

      return {
        success: true,
        data: {
          input_amount: data.input_amount,
          output_amount: data.output_amount,
          input_usd: data.input_usd,
          output_usd: data.output_usd,
          price_impact: data.price_impact,
          recommended_gas: data.recommended_gas,
          route_summary: {
            dexes_used: [...dexes],
            total_hops: totalHops,
            num_paths: Array.isArray(data.paths) ? data.paths.length : 0,
          },
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
// Tool 2: swap_execute
// ---------------------------------------------------------------------------

const swapExecute = {
  name: "swap_execute",
  description:
    "Execute a token swap on TON via swap.coffee aggregator. Finds the best route and sends the transaction from the agent wallet. Call swap_quote first to preview the rate.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      input_token: {
        type: "string",
        description:
          'Source token address or "native" for TON (e.g. "EQCxE6...")',
      },
      output_token: {
        type: "string",
        description:
          'Destination token address or "native" for TON (e.g. "EQCxE6...")',
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
      max_splits: {
        type: "integer",
        description: "Route splits for better price (1-20, default 4)",
        minimum: 1,
        maximum: 20,
      },
    },
    required: ["input_token", "output_token", "input_amount"],
  },

  execute: async (params) => {
    try {
      const slippage = params.slippage ?? 0.05;
      const maxSplits = params.max_splits ?? 4;
      const inputAmount = Number(params.input_amount);
      if (!Number.isFinite(inputAmount) || inputAmount <= 0) {
        throw new Error("input_amount must be a positive number");
      }

      _sdk?.log?.info(`Executing swap: ${params.input_amount} ${params.input_token} -> ${params.output_token} (slippage: ${slippage})`);

      // Step 1: Get the route
      const routeBody = {
        input_token: { blockchain: "ton", address: params.input_token },
        output_token: { blockchain: "ton", address: params.output_token },
        input_amount: inputAmount,
        max_splits: maxSplits,
        max_length: 3,
      };

      const routeData = await swapFetch("/v1/route", {
        method: "POST",
        body: JSON.stringify(routeBody),
      });

      if (!routeData.paths || !Array.isArray(routeData.paths) || routeData.paths.length === 0) {
        throw new Error("No swap route found for the given token pair");
      }

      // Step 2: Get wallet
      const { wallet, keyPair, contract } = await getWalletAndClient();
      const senderAddress = wallet.address.toString();

      // Step 3: Get transactions from the route
      const txBody = {
        sender_address: senderAddress,
        slippage,
        paths: routeData.paths,
      };

      const txData = await swapFetch("/v2/route/transactions", {
        method: "POST",
        body: JSON.stringify(txBody),
      });

      if (
        !txData.transactions ||
        !Array.isArray(txData.transactions) ||
        txData.transactions.length === 0
      ) {
        throw new Error("No transactions returned from route builder");
      }

      // Step 4: Build messages
      const messages = txData.transactions.map((tx) => {
        const body = Cell.fromBoc(Buffer.from(tx.cell, "base64"))[0];
        return internal({
          to: Address.parse(tx.address),
          value: BigInt(tx.value),
          body,
          bounce: true,
        });
      });

      // Step 5: Send transfer
      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages,
      });

      return {
        success: true,
        data: {
          route_id: txData.route_id,
          output_amount: routeData.output_amount,
          price_impact: routeData.price_impact,
          slippage,
          transactions_sent: txData.transactions.length,
          seqno,
          wallet_address: senderAddress,
          message:
            "Swap transaction sent. Use swap_status with route_id to check completion (~30 seconds).",
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
// Tool 3: swap_status
// ---------------------------------------------------------------------------

const swapStatus = {
  name: "swap_status",
  description:
    "Check the status of a swap execution. Poll this after swap_execute to see if the swap completed successfully.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      route_id: {
        type: "integer",
        description: "Route ID returned from swap_execute",
      },
    },
    required: ["route_id"],
  },

  execute: async (params) => {
    try {
      const data = await swapFetch(
        `/v2/route/result?route_id=${params.route_id}`
      );

      // Derive overall status from splits
      let overallStatus = "pending";
      if (data.terminal) {
        const statuses = (data.splits ?? []).map((s) => s.status);
        if (statuses.every((s) => s === "succeeded")) {
          overallStatus = "succeeded";
        } else if (statuses.some((s) => s === "failed")) {
          overallStatus = "failed";
        } else if (statuses.some((s) => s === "timed_out")) {
          overallStatus = "timed_out";
        } else if (statuses.some((s) => s === "succeeded")) {
          overallStatus = "partially_complete";
        } else {
          overallStatus = "failed";
        }
      }

      const splitsSummary = (data.splits ?? []).map((split, i) => ({
        split_index: i,
        status: split.status,
        steps: Array.isArray(split.steps) ? split.steps.length : 0,
        input: split.input,
        output: split.output,
        gas_sent: split.gas_sent,
        gas_received: split.gas_received,
      }));

      return {
        success: true,
        data: {
          route_id: params.route_id,
          overall_status: overallStatus,
          terminal: data.terminal ?? false,
          splits: splitsSummary,
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
// Tool 4: swap_tokens
// ---------------------------------------------------------------------------

const swapTokens = {
  name: "swap_tokens",
  description:
    "Search for tokens on the TON blockchain -- by symbol name (e.g. 'USDT', 'NOT') or by address. Returns token metadata and USD price.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          'Token symbol (e.g. "USDT", "NOT") or token address (e.g. "EQCxE6...")',
      },
    },
    required: ["search"],
  },

  execute: async (params) => {
    try {
      const search = params.search.trim();
      const isAddress =
        search.includes(":") ||
        search.startsWith("EQ") ||
        search.startsWith("UQ") ||
        search.length > 30;

      let tokens;
      if (isAddress) {
        // Direct address lookup
        const token = await swapFetch(`/v1/token/ton/${encodeURIComponent(search)}`);
        tokens = Array.isArray(token) ? token : [token];
      } else {
        // Symbol search
        const result = await swapFetch(
          `/v1/token/ton/by-symbol/${encodeURIComponent(search.toUpperCase())}`
        );
        tokens = Array.isArray(result) ? result : [result];
      }

      // Filter out nulls/undefined
      tokens = tokens.filter(Boolean);
      if (tokens.length === 0) {
        return { success: false, error: "No tokens found for: " + search };
      }

      // Extract address strings for price lookup
      // API returns nested: { address: { blockchain, address }, metadata: { name, symbol, ... } }
      const addresses = tokens
        .map((t) => t.address?.address ?? t.address)
        .filter((a) => typeof a === "string");

      let priceMap = {};
      if (addresses.length > 0) {
        try {
          const priceData = await swapFetch("/v1/token/price", {
            method: "POST",
            body: JSON.stringify({
              blockchain: "ton",
              addresses,
            }),
          });
          if (Array.isArray(priceData)) {
            for (const p of priceData) {
              priceMap[p.address] = p.usd_price;
            }
          }
        } catch {
          // Price fetch failed; continue without prices
        }
      }

      const result = tokens.map((t) => {
        const addr = t.address?.address ?? t.address ?? "";
        const meta = t.metadata ?? t;
        return {
          address: addr,
          name: meta.name,
          symbol: meta.symbol,
          decimals: meta.decimals,
          image_url: meta.image_url,
          verification: meta.verification,
          usd_price: priceMap[addr] ?? null,
        };
      });

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
// Tool 5: swap_price
// ---------------------------------------------------------------------------

const swapPrice = {
  name: "swap_price",
  description:
    'Get current USD prices for TON tokens. Use "native" for TON itself.',
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      tokens: {
        type: "array",
        items: { type: "string" },
        description:
          'Token addresses to price. Use "native" for TON. (e.g. ["native", "EQCxE6..."])',
      },
    },
    required: ["tokens"],
  },

  execute: async (params) => {
    try {
      if (
        !Array.isArray(params.tokens) ||
        params.tokens.length === 0
      ) {
        throw new Error("tokens must be a non-empty array of addresses");
      }

      const data = await swapFetch("/v1/token/price", {
        method: "POST",
        body: JSON.stringify({
          blockchain: "ton",
          addresses: params.tokens,
        }),
      });

      let prices;
      if (Array.isArray(data)) {
        prices = data.map((p) => ({
          address: p.address,
          usd_price: p.usd_price,
        }));
      } else if (data && typeof data === "object") {
        prices = Object.entries(data).map(([address, usd_price]) => ({
          address,
          usd_price,
        }));
      } else {
        prices = [];
      }

      return { success: true, data: prices };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).slice(0, 500),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: swap_pools
// ---------------------------------------------------------------------------

const swapPools = {
  name: "swap_pools",
  description:
    "Browse liquidity pools on TON DEXes -- search by token, sort by TVL, volume, or APR.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Search by token address or ticker (optional)",
      },
      order: {
        type: "string",
        enum: ["tvl", "volume", "apr"],
        description: 'Sort order (default: "tvl")',
      },
      limit: {
        type: "integer",
        description: "Number of results (1-50, default 10)",
        minimum: 1,
        maximum: 50,
      },
      page: {
        type: "integer",
        description: "Page number (default 1)",
        minimum: 1,
      },
      dexes: {
        type: "array",
        items: { type: "string" },
        description:
          'Filter by DEX names (e.g. ["stonfi", "dedust"])',
      },
    },
  },

  execute: async (params) => {
    try {
      const order = params.order ?? "tvl";
      const limit = params.limit ?? 10;
      const page = params.page ?? 1;

      const queryParams = new URLSearchParams({
        order,
        descending_order: "true",
        size: String(limit),
        page: String(page),
        trusted: "true",
      });

      if (params.search) {
        queryParams.set("search_text", params.search);
      }
      if (Array.isArray(params.dexes) && params.dexes.length > 0) {
        for (const dex of params.dexes) {
          queryParams.append("dexes", dex);
        }
      }

      const data = await swapFetch(`/v1/pools?${queryParams.toString()}`);

      // Response is [{ total_count, pools: [{ pool: {...}, info: {...} }] }]
      const wrapper = Array.isArray(data) ? data[0] : data;
      const poolEntries = wrapper?.pools ?? [];

      const pools = poolEntries.map((entry) => {
        const p = entry.pool ?? entry;
        const info = entry.info ?? {};

        // Token symbols: nested { address: {...}, metadata: { symbol } }
        const tokenSymbols = [];
        if (Array.isArray(p.tokens)) {
          for (const t of p.tokens) {
            tokenSymbols.push(t.metadata?.symbol ?? "?");
          }
        }

        return {
          pool_address: p.address,
          dex: p.dex,
          tokens: tokenSymbols,
          tvl_usd: info.tvl_usd,
          volume_usd: info.volume_usd,
          apr: info.apr ?? info.lp_apr,
          fee_usd: info.fee_usd,
        };
      });

      return {
        success: true,
        data: {
          pools,
          count: pools.length,
          page,
          order,
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
// Export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "swapcoffee",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "swap.coffee DEX aggregator on TON — find optimal swap routes, execute token swaps, browse pools, and check token prices.",
};

export const tools = (sdk) => {
  _sdk = sdk;
  return [
    swapQuote,
    swapExecute,
    swapStatus,
    swapTokens,
    swapPrice,
    swapPools,
  ];
};
