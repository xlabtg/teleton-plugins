/**
 * Storm Trade plugin -- Perpetual futures on TON
 *
 * Trade crypto, stocks, forex, and commodities with up to 100x leverage.
 * Uses @storm-trade/sdk for on-chain writes and REST API for reads.
 * Agent wallet at ~/.teleton/wallet.json signs all transactions.
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
const { WalletContractV5R1, TonClient, toNano, internal } = _require("@ton/ton");
const { mnemonicToPrivateKey } = _require("@ton/crypto");
const {
  StormSDK,
  Direction,
  numToNano,
  numFromNano,
  toStablecoin,
  fromStablecoin,
} = _pluginRequire("@storm-trade/sdk");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api5.storm.tg/api";
const WALLET_FILE = join(homedir(), ".teleton", "wallet.json");

let _sdk = null;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Fetch from Storm Trade REST API (public, no auth needed). */
async function stormFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Storm API ${res.status}: ${text.slice(0, 300)}`.trim());
  }
  return res.json();
}

/** Read agent wallet, create TonClient, open wallet contract. */
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

/** Get agent's friendly wallet address. */
function getAgentAddress() {
  const data = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  return data.address;
}

/** Return StormSDK instance for the given vault type. */
function getSDK(vault, client) {
  switch ((vault || "usdt").toLowerCase()) {
    case "usdt":
      return StormSDK.asMainnetUSDT(client);
    case "not":
      return StormSDK.asMainnetNOT(client);
    case "native":
    case "ton":
      return StormSDK.asMainnetNative(client);
    default:
      throw new Error("Unknown vault type: " + vault + ". Use usdt, not, or native.");
  }
}

/** Validate and convert a user-facing numeric string to Number.
 *  Rejects NaN, Infinity, and non-positive values. */
function parseNum(val, name = "value") {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`Invalid ${name} — must be a positive number, got: ${val}`);
  return n;
}

/** Convert user-facing amount to correct bigint for the vault's token decimals.
 *  USDT = 6 decimals (toStablecoin), NOT/TON = 9 decimals (numToNano). */
function parseAmount(amount, vault) {
  const n = parseNum(amount, "amount");
  const v = (vault || "usdt").toLowerCase();
  if (v === "usdt") return toStablecoin(n);
  return numToNano(n); // NOT and native are 9 decimals
}

/** Extract base asset from market name (e.g. "BTC/USD" -> "BTC"). */
function parseBaseAsset(market) {
  return market.split("/")[0].toUpperCase();
}

/** Parse direction string to SDK Direction enum. */
function parseDirection(dir) {
  const d = (dir || "").toLowerCase();
  if (d === "long" || d === "0") return Direction.long;
  if (d === "short" || d === "1") return Direction.short;
  throw new Error("Invalid direction: " + dir + ". Use 'long' or 'short'.");
}

// ---------------------------------------------------------------------------
// Tool 1: storm_markets
// ---------------------------------------------------------------------------

const stormMarkets = {
  name: "storm_markets",
  description:
    "List all available markets on Storm Trade with prices, funding rates, open interest, and trading config.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Filter by vault type (default: show all)",
      },
    },
  },

  execute: async (params) => {
    try {
      const data = await stormFetch("/markets");
      let markets = Array.isArray(data) ? data : data.markets || [];
      if (params.vault) {
        const v = params.vault.toLowerCase();
        markets = markets.filter((m) => {
          const settlement = (m.config?.settlementToken || "").toLowerCase();
          return settlement.includes(v) || (v === "native" && settlement === "ton");
        });
      }
      return {
        success: true,
        data: markets.map((m) => ({
          name: m.config?.name,
          base_asset: m.config?.baseAsset,
          settlement: m.config?.settlementToken,
          index_price: m.amm?.indexPrice,
          open_interest_long: m.amm?.openInterestLong,
          open_interest_short: m.amm?.openInterestShort,
          long_funding_rate: m.incentive?.longFundingRate,
          short_funding_rate: m.incentive?.shortFundingRate,
          tags: m.config?.tags,
        })),
        count: markets.length,
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: storm_market_info
// ---------------------------------------------------------------------------

const stormMarketInfo = {
  name: "storm_market_info",
  description:
    "Get detailed info for a specific market: price, funding, OI, trading limits, fee structure.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      market: {
        type: "string",
        description: "Market name, e.g. 'BTC/USD' or 'ETH/USD'",
      },
    },
    required: ["market"],
  },

  execute: async (params) => {
    try {
      const allMarkets = await stormFetch("/markets");
      const markets = Array.isArray(allMarkets) ? allMarkets : allMarkets.markets || [];
      const target = params.market.toUpperCase();
      const market =
        markets.find((m) => (m.config?.name || m.name || "").toUpperCase() === target) ||
        markets.find((m) => {
          const name = (m.config?.name || m.name || "").toUpperCase();
          return name.startsWith(target.split("/")[0] + "/");
        });
      if (!market) {
        return { success: false, error: "Market not found: " + params.market };
      }
      return { success: true, data: market };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: storm_positions
// ---------------------------------------------------------------------------

const stormPositions = {
  name: "storm_positions",
  description:
    "List open positions with unrealized P&L. Defaults to agent wallet if no address given.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      trader_address: {
        type: "string",
        description: "Trader's TON address (default: agent wallet)",
      },
      asset: {
        type: "string",
        description: "Filter by asset, e.g. 'BTC' (optional)",
      },
    },
  },

  execute: async (params) => {
    try {
      const trader = params.trader_address || getAgentAddress();
      const path = params.asset
        ? `/positions/${trader}/${params.asset.toUpperCase()}/active`
        : `/positions/${trader}/active`;
      const data = await stormFetch(path);
      return { success: true, data, trader };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: storm_orders
// ---------------------------------------------------------------------------

const stormOrders = {
  name: "storm_orders",
  description:
    "List active or historical orders for a trader.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      trader_address: {
        type: "string",
        description: "Trader's TON address (default: agent wallet)",
      },
      asset: {
        type: "string",
        description: "Filter by asset, e.g. 'BTC' (optional)",
      },
      status: {
        type: "string",
        enum: ["active", "history"],
        description: "Order status filter (default: active)",
      },
    },
  },

  execute: async (params) => {
    try {
      const trader = params.trader_address || getAgentAddress();
      const status = params.status || "active";
      let path;
      if (params.asset) {
        path = `/orders/${trader}/${params.asset.toUpperCase()}/${status}`;
      } else {
        path = `/orders/${trader}/${status}`;
      }
      const data = await stormFetch(path);
      return { success: true, data, trader, status };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: storm_trader_stats
// ---------------------------------------------------------------------------

const stormTraderStats = {
  name: "storm_trader_stats",
  description:
    "Get trader performance stats, P&L history, or the leaderboard.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      trader_address: {
        type: "string",
        description: "Trader's TON address (default: agent wallet). Ignored for leaderboard.",
      },
      view: {
        type: "string",
        enum: ["stats", "pnl_history", "leaderboard"],
        description: "What to fetch (default: stats)",
      },
      period: {
        type: "integer",
        description: "Time period in days for leaderboard/stats (default: 7)",
      },
    },
  },

  execute: async (params) => {
    try {
      const view = params.view || "stats";
      const period = params.period || 7;
      if (view === "leaderboard") {
        const data = await stormFetch("/trader-stats/leaderboard", { period });
        return { success: true, data: data.data || data, view, period };
      }
      const trader = params.trader_address || getAgentAddress();
      const path =
        view === "pnl_history"
          ? `/trader-stats/${trader}/pnl-history`
          : `/trader-stats/${trader}/stats`;
      const data = await stormFetch(path, { period });
      return { success: true, data, trader, view };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: storm_open_position
// ---------------------------------------------------------------------------

const stormOpenPosition = {
  name: "storm_open_position",
  description:
    "Open a long or short perpetual position. Specify market, direction, amount (USDT), and leverage.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      market: { type: "string", description: "Market name, e.g. 'BTC/USD'" },
      direction: { type: "string", enum: ["long", "short"], description: "Position direction" },
      amount: { type: "string", description: "Margin amount in USDT (e.g. '100')" },
      leverage: { type: "string", description: "Leverage multiplier (e.g. '10')" },
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Vault type (default: usdt)",
      },
      stop_loss: { type: "string", description: "Stop-loss price (optional)" },
      take_profit: { type: "string", description: "Take-profit price (optional)" },
    },
    required: ["market", "direction", "amount", "leverage"],
  },

  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const sdk = getSDK(params.vault, client);
      const traderAddress = wallet.address;
      const baseAsset = parseBaseAsset(params.market);
      const direction = parseDirection(params.direction);

      _sdk?.log?.info(`Opening ${params.direction} position: ${params.market} ${params.amount} x${params.leverage}`);

      const increaseOpts = {
        baseAsset,
        traderAddress,
        direction,
        amount: parseAmount(params.amount, params.vault),
        leverage: numToNano(parseNum(params.leverage, "leverage")),
      };
      if (params.stop_loss) increaseOpts.stopTriggerPrice = numToNano(parseNum(params.stop_loss, "stop_loss"));
      if (params.take_profit) increaseOpts.takeTriggerPrice = numToNano(parseNum(params.take_profit, "take_profit"));

      const txParams = await sdk.increasePosition(increaseOpts);

      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true }),
        ],
      });

      return {
        success: true,
        data: {
          market: params.market,
          direction: params.direction,
          amount: params.amount,
          leverage: params.leverage,
          seqno,
          walletAddress: wallet.address.toString(),
          has_stop_loss: !!params.stop_loss,
          has_take_profit: !!params.take_profit,
          message: "Position open tx sent. Check status after ~15 seconds with storm_positions.",
        },
      };
    } catch (err) {
      _sdk?.log?.error(`Open position failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 7: storm_close_position
// ---------------------------------------------------------------------------

const stormClosePosition = {
  name: "storm_close_position",
  description:
    "Close an existing position (full or partial). Specify market and direction.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      market: { type: "string", description: "Market name, e.g. 'BTC/USD'" },
      direction: { type: "string", enum: ["long", "short"], description: "Position direction" },
      size: {
        type: "string",
        description: "Base asset size to close (e.g. '0.5' for 0.5 BTC). Omit for full close.",
      },
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Vault type (default: usdt)",
      },
    },
    required: ["market", "direction"],
  },

  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const sdk = getSDK(params.vault, client);
      const traderAddress = wallet.address;
      const baseAsset = parseBaseAsset(params.market);
      const direction = parseDirection(params.direction);

      _sdk?.log?.info(`Closing ${params.direction} position: ${params.market}${params.size ? ' size=' + params.size : ' (full)'}`);

      let size;
      if (params.size) {
        size = numToNano(parseNum(params.size, "size"));
      } else {
        // Full close: query position to get actual size
        const posData = await sdk.getPositionAccountData(traderAddress, baseAsset);
        const record = direction === Direction.long ? posData?.longPosition : posData?.shortPosition;
        if (!record?.positionData?.size) throw new Error("No open position found for " + params.market + " " + params.direction);
        size = record.positionData.size;
      }

      const txParams = await sdk.closePosition({
        baseAsset,
        traderAddress,
        direction,
        size,
      });

      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true }),
        ],
      });

      return {
        success: true,
        data: {
          market: params.market,
          direction: params.direction,
          size: params.size || "1",
          seqno,
          walletAddress: wallet.address.toString(),
          message: "Close position tx sent. Check status after ~15 seconds.",
        },
      };
    } catch (err) {
      _sdk?.log?.error(`Close position failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 8: storm_add_margin
// ---------------------------------------------------------------------------

const stormAddMargin = {
  name: "storm_add_margin",
  description: "Add margin to an existing position to reduce liquidation risk.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      market: { type: "string", description: "Market name, e.g. 'BTC/USD'" },
      direction: { type: "string", enum: ["long", "short"], description: "Position direction" },
      amount: { type: "string", description: "Margin to add in USDT (e.g. '50')" },
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Vault type (default: usdt)",
      },
    },
    required: ["market", "direction", "amount"],
  },

  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const sdk = getSDK(params.vault, client);
      const traderAddress = wallet.address;
      const baseAsset = parseBaseAsset(params.market);
      const direction = parseDirection(params.direction);

      const txParams = await sdk.addMargin({
        baseAsset,
        traderAddress,
        direction,
        amount: parseAmount(params.amount, params.vault),
      });

      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true }),
        ],
      });

      return {
        success: true,
        data: {
          market: params.market,
          direction: params.direction,
          amount: params.amount,
          seqno,
          walletAddress: wallet.address.toString(),
          message: "Add margin tx sent. Check position after ~15 seconds.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 9: storm_remove_margin
// ---------------------------------------------------------------------------

const stormRemoveMargin = {
  name: "storm_remove_margin",
  description: "Remove excess margin from a position.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      market: { type: "string", description: "Market name, e.g. 'BTC/USD'" },
      direction: { type: "string", enum: ["long", "short"], description: "Position direction" },
      amount: { type: "string", description: "Margin to remove in USDT (e.g. '50')" },
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Vault type (default: usdt)",
      },
    },
    required: ["market", "direction", "amount"],
  },

  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const sdk = getSDK(params.vault, client);
      const traderAddress = wallet.address;
      const baseAsset = parseBaseAsset(params.market);
      const direction = parseDirection(params.direction);

      const txParams = await sdk.removeMargin({
        baseAsset,
        traderAddress,
        direction,
        amount: numToNano(parseNum(params.amount, "amount")),
      });

      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true }),
        ],
      });

      return {
        success: true,
        data: {
          market: params.market,
          direction: params.direction,
          amount: params.amount,
          seqno,
          walletAddress: wallet.address.toString(),
          message: "Remove margin tx sent. Check position after ~15 seconds.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 10: storm_create_order
// ---------------------------------------------------------------------------

const stormCreateOrder = {
  name: "storm_create_order",
  description:
    "Create a limit, stop-limit, stop-loss, or take-profit order.\n" +
    "For stopLoss/takeProfit: requires trigger_price and amount (base asset size to close).\n" +
    "For stopLimit/market: requires limit_price, amount (margin), and leverage.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      market: { type: "string", description: "Market name, e.g. 'BTC/USD'" },
      direction: { type: "string", enum: ["long", "short"], description: "Order direction" },
      order_type: {
        type: "string",
        enum: ["stopLoss", "takeProfit", "stopLimit", "market"],
        description: "Order type",
      },
      amount: {
        type: "string",
        description: "For SL/TP: base asset size to close (e.g. '0.5'). For limit/stopLimit: margin amount.",
      },
      trigger_price: {
        type: "string",
        description: "Trigger price for SL/TP orders (e.g. '50000')",
      },
      limit_price: {
        type: "string",
        description: "Limit price for stopLimit/market orders (e.g. '60000')",
      },
      stop_price: {
        type: "string",
        description: "Stop price for stopLimit orders",
      },
      leverage: {
        type: "string",
        description: "Leverage for stopLimit/market orders (e.g. '10')",
      },
      stop_trigger_price: {
        type: "string",
        description: "Auto stop-loss trigger price for limit orders (optional)",
      },
      take_trigger_price: {
        type: "string",
        description: "Auto take-profit trigger price for limit orders (optional)",
      },
      expiration: {
        type: "integer",
        description: "Order expiration in seconds (default: 2592000 = 30 days)",
      },
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Vault type (default: usdt)",
      },
    },
    required: ["market", "direction", "order_type", "amount"],
  },

  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const sdk = getSDK(params.vault, client);
      const traderAddress = wallet.address;
      const baseAsset = parseBaseAsset(params.market);
      const direction = parseDirection(params.direction);
      const expiration = params.expiration || 86400 * 30;

      _sdk?.log?.info(`Creating ${params.order_type} order: ${params.market} ${params.direction}`);

      let orderOpts;
      if (params.order_type === "stopLoss" || params.order_type === "takeProfit") {
        if (!params.trigger_price) throw new Error("trigger_price required for " + params.order_type);
        orderOpts = {
          baseAsset,
          traderAddress,
          orderType: params.order_type,
          direction,
          amount: numToNano(parseNum(params.amount, "amount")),
          trigerPrice: numToNano(parseNum(params.trigger_price, "trigger_price")),
          expiration,
        };
      } else {
        if (!params.limit_price) throw new Error("limit_price required for " + params.order_type);
        if (!params.leverage) throw new Error("leverage required for " + params.order_type);
        orderOpts = {
          baseAsset,
          traderAddress,
          orderType: params.order_type,
          direction,
          amount: parseAmount(params.amount, params.vault),
          leverage: numToNano(parseNum(params.leverage, "leverage")),
          limitPrice: numToNano(parseNum(params.limit_price, "limit_price")),
          stopTriggerPrice: numToNano(params.stop_trigger_price ? parseNum(params.stop_trigger_price, "stop_trigger_price") : 0),
          takeTriggerPrice: numToNano(params.take_trigger_price ? parseNum(params.take_trigger_price, "take_trigger_price") : 0),
          expiration,
        };
        if (params.order_type === "stopLimit" && params.stop_price) {
          orderOpts.stopPrice = numToNano(parseNum(params.stop_price, "stop_price"));
        }
      }

      const txParams = await sdk.createOrder(orderOpts);

      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true }),
        ],
      });

      return {
        success: true,
        data: {
          market: params.market,
          direction: params.direction,
          order_type: params.order_type,
          seqno,
          walletAddress: wallet.address.toString(),
          message: "Order creation tx sent. Check orders after ~15 seconds.",
        },
      };
    } catch (err) {
      _sdk?.log?.error(`Create order failed: ${err.message}`);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 11: storm_cancel_order
// ---------------------------------------------------------------------------

const stormCancelOrder = {
  name: "storm_cancel_order",
  description: "Cancel a pending order by market, direction, order type, and index.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      market: { type: "string", description: "Market name, e.g. 'BTC/USD'" },
      direction: { type: "string", enum: ["long", "short"], description: "Order direction" },
      order_type: {
        type: "string",
        enum: ["stopLoss", "takeProfit", "stopLimit", "market"],
        description: "Order type to cancel",
      },
      order_index: {
        type: "integer",
        description: "Order index (default: 0)",
      },
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Vault type (default: usdt)",
      },
    },
    required: ["market", "direction", "order_type"],
  },

  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const sdk = getSDK(params.vault, client);
      const traderAddress = wallet.address;
      const baseAsset = parseBaseAsset(params.market);
      const direction = parseDirection(params.direction);

      const txParams = await sdk.cancelOrder({
        baseAsset,
        traderAddress,
        orderType: params.order_type,
        orderIndex: params.order_index ?? 0,
        direction,
      });

      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true }),
        ],
      });

      return {
        success: true,
        data: {
          market: params.market,
          direction: params.direction,
          order_type: params.order_type,
          order_index: params.order_index ?? 0,
          seqno,
          walletAddress: wallet.address.toString(),
          message: "Cancel order tx sent. Check orders after ~15 seconds.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 12: storm_stake
// ---------------------------------------------------------------------------

const stormStake = {
  name: "storm_stake",
  description: "Stake USDT/TON/NOT in a Storm Trade vault to earn trading fees.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      amount: { type: "string", description: "Amount to stake (e.g. '100')" },
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Vault type (default: usdt)",
      },
    },
    required: ["amount"],
  },

  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const sdk = getSDK(params.vault, client);
      const userAddress = wallet.address;

      const txParams = await sdk.stake({
        amount: parseAmount(params.amount, params.vault),
        userAddress,
      });

      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true }),
        ],
      });

      return {
        success: true,
        data: {
          amount: params.amount,
          vault: params.vault || "usdt",
          seqno,
          walletAddress: wallet.address.toString(),
          message: "Stake tx sent. Check vault balance after ~15 seconds.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 13: storm_unstake
// ---------------------------------------------------------------------------

const stormUnstake = {
  name: "storm_unstake",
  description: "Unstake from a Storm Trade vault. Omit amount to unstake full balance.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      amount: { type: "string", description: "LP token amount to unstake (omit for full unstake)" },
      vault: {
        type: "string",
        enum: ["usdt", "not", "native"],
        description: "Vault type (default: usdt)",
      },
    },
  },

  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const sdk = getSDK(params.vault, client);
      const userAddress = wallet.address;

      const unstakeOpts = { userAddress };
      if (params.amount) unstakeOpts.amount = numToNano(parseNum(params.amount, "amount"));
      const txParams = await sdk.unstake(unstakeOpts);

      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({ to: txParams.to, value: txParams.value, body: txParams.body, bounce: true }),
        ],
      });

      return {
        success: true,
        data: {
          amount: params.amount,
          vault: params.vault || "usdt",
          seqno,
          walletAddress: wallet.address.toString(),
          message: "Unstake tx sent. Check vault balance after ~15 seconds.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "stormtrade",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Storm Trade perpetual futures on TON — trade crypto, stocks, forex, and commodities with up to 100x leverage.",
};

export const tools = (sdk) => {
  _sdk = sdk;
  return [
    stormMarkets,
    stormMarketInfo,
    stormPositions,
    stormOrders,
    stormTraderStats,
    stormOpenPosition,
    stormClosePosition,
    stormAddMargin,
    stormRemoveMargin,
    stormCreateOrder,
    stormCancelOrder,
    stormStake,
    stormUnstake,
  ];
};
