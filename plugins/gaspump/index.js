/**
 * Gaspump plugin -- Gas111 token launchpad on TON
 *
 * Launch tokens with a single tool call. Query and manage tokens.
 * Auth is obtained automatically via Telegram WebApp (gasPump_bot).
 * Public endpoints (info, search, user list, stats) need no auth.
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { buildGaspumpStateInit, buildDeployBody, sendDeploy, getAgentWalletAddress, sendBuy, sendSell, getJettonWalletAddress } from "./deploy.js";

// Resolve "telegram" from teleton's own node_modules (not the plugin directory).
const _require = createRequire(realpathSync(process.argv[1]));
const { Api } = _require("telegram");

const API_BASE = "https://api.gas111.com/api/v1";

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

async function gasFetch(path, { method = "GET", params = {}, body = null, auth = null } = {}) {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (auth) headers["Authorization"] = auth;
  const opts = { method, headers, signal: AbortSignal.timeout(15000) };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gas111 API error: ${res.status} ${text.slice(0, 200)}`.trim());
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Auto-auth via Telegram WebApp initData
// ---------------------------------------------------------------------------

let cachedAuth = null;
let cachedAuthTime = 0;

const AUTH_TTL = 30 * 60 * 1000; // 30 minutes

async function getGasAuth(bridge) {
  if (cachedAuth && Date.now() - cachedAuthTime < AUTH_TTL) {
    return cachedAuth;
  }
  let result;
  try {
    const client = bridge.getClient().getClient();
    const bot = await client.getEntity("gasPump_bot");
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("RequestWebView timed out (10s)")), 10000)
    );
    result = await Promise.race([
      client.invoke(
        new Api.messages.RequestWebView({
          peer: bot,
          bot,
          platform: "android",
          url: "https://gas111.com",
        })
      ),
      timeout,
    ]);
  } catch (err) {
    throw new Error("WebApp auth failed: " + String(err.message || err).slice(0, 300));
  }
  const fragment = new URL(result.url).hash.slice(1);
  const initData = new URLSearchParams(fragment).get("tgWebAppData");
  if (!initData) {
    throw new Error("Failed to extract tgWebAppData from WebView response");
  }
  cachedAuth = initData;
  cachedAuthTime = Date.now();
  return cachedAuth;
}

async function gasAuthFetch(bridge, path, opts = {}) {
  const auth = await getGasAuth(bridge);
  try {
    return await gasFetch(path, { ...opts, auth });
  } catch (err) {
    if (err.message && err.message.includes("Permission denied")) {
      cachedAuth = null;
      cachedAuthTime = 0;
      const freshAuth = await getGasAuth(bridge);
      return gasFetch(path, { ...opts, auth: freshAuth });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tool 1: gas_launch_token (unified deploy pipeline)
// ---------------------------------------------------------------------------

const gasLaunchToken = {
  name: "gas_launch_token",
  description:
    "Launch a new token on Gas111 in one step. Logs in, uploads the image, deploys the contract on-chain from the agent's wallet, and registers on the API. Provide name, ticker, and image (base64 or URL). Returns the token address.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Token name" },
      ticker: { type: "string", description: "Token ticker symbol" },
      image_base64: { type: "string", description: "Base64-encoded token image (use this OR image_url)" },
      image_url: { type: "string", description: "Already-hosted image URL (use this OR image_base64)" },
      description: { type: "string", description: "Token description (optional, suffix added automatically)" },
      dex_type: { type: "string", description: "DEX type: 'dedust' or 'stonfi' (default: dedust)" },
      buy_ton: { type: "string", description: "TON amount for initial buy (default: '5', min 0.3)" },
      nonce: { type: "integer", description: "Nonce for unique address (default: 0, increment on collision)" },
      tg_channel_link: { type: "string", description: "Telegram channel link (optional)" },
      tg_chat_link: { type: "string", description: "Telegram chat link (optional)" },
      twitter_link: { type: "string", description: "Twitter/X link (optional)" },
      website_link: { type: "string", description: "Website URL (optional)" },
    },
    required: ["name", "ticker"],
  },

  execute: async (params, context) => {
    const steps = [];

    try {
      // --- Step 1: Login with WebApp auth (same identity as token creation) ---
      try {
        await gasAuthFetch(context.bridge, "/users/login", {
          method: "POST",
        });
        steps.push("login: ok");
      } catch (err) {
        steps.push("login: failed (" + String(err.message).slice(0, 100) + ")");
      }

      // --- Step 2: Resolve image URL ---
      let imageUrl = params.image_url || null;

      if (!imageUrl && params.image_base64) {
        try {
          const uploadResult = await gasAuthFetch(context.bridge, "/images/upload", {
            method: "POST",
            body: { image_base64: params.image_base64 },
          });
          imageUrl = uploadResult.image_url;
          steps.push("upload: ok (" + imageUrl + ")");
        } catch (err) {
          steps.push("upload: failed (" + String(err.message).slice(0, 100) + ")");
        }
      } else if (imageUrl) {
        steps.push("upload: skipped (image_url provided)");
      }

      if (!imageUrl) {
        return {
          success: false,
          error: "No image available. Provide image_base64 or image_url.",
          steps,
        };
      }

      // --- Step 3: Build state init + deploy on-chain ---
      const ownerAddress = getAgentWalletAddress();
      const description = params.description || "";
      const dexType = params.dex_type || "dedust";
      const nonce = params.nonce ?? 0;
      const buyTon = params.buy_ton || "5";

      const { stateInit, address } = buildGaspumpStateInit(
        ownerAddress, nonce,
        params.name, params.ticker, imageUrl,
        description, dexType,
      );

      const body = buildDeployBody(true);
      const { seqno, walletAddress } = await sendDeploy(address, stateInit, body, buyTon);
      steps.push("deploy: ok (seqno " + seqno + ")");

      // --- Step 4: Register on Gas111 API (best-effort) ---
      let apiRegistered = false;
      try {
        const createBody = {
          name: params.name,
          ticker: params.ticker,
          token_address: address.toString(),
          image_url: imageUrl,
          contract_version: 9,
          description: description + " (launched on \u26FD\uFE0F GasPump)",
          dextype: dexType,
        };
        for (const field of ["tg_channel_link", "tg_chat_link", "twitter_link", "website_link"]) {
          if (params[field]) createBody[field] = params[field];
        }
        await gasAuthFetch(context.bridge, "/tokens/create", {
          method: "POST",
          body: createBody,
        });
        apiRegistered = true;
        steps.push("register: ok");
      } catch (err) {
        steps.push("register: failed (" + String(err.message).slice(0, 100) + ")");
      }

      return {
        success: true,
        data: {
          token_address: address.toString(),
          wallet_address: walletAddress,
          seqno,
          buy_ton: buyTon,
          image_url: imageUrl,
          api_registered: apiRegistered,
          steps,
          message: apiRegistered
            ? "Token launched! Check status with gas_token_info after ~15 seconds."
            : "Token deployed on-chain but API registration failed. The token is live on TON. Try gas_update_token later.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500), steps };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: gas_token_info
// ---------------------------------------------------------------------------

const gasTokenInfo = {
  name: "gas_token_info",
  description:
    "Get full details on a token: name, ticker, market cap, status, holders count, liquidity progress, deployed date, and social links.",
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
      const result = await gasFetch("/tokens/info", {
        params: { token_address: params.token_address },
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: gas_token_search
// ---------------------------------------------------------------------------

const gasTokenSearch = {
  name: "gas_token_search",
  description:
    "Search and list tokens. Sort by market cap, volume, or creation date. Filter by name, creator, or audio tokens.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "Search by token name or ticker" },
      sorting_field: {
        type: "string",
        enum: ["market_cap", "volume_24h", "volume_1h", "created_at", "last_traded_at"],
        description: "Sort field (default: market_cap)",
      },
      limit: { type: "integer", description: "Max results (default: 100)" },
      offset: { type: "integer", description: "Pagination offset" },
      telegram_id: { type: "integer", description: "Filter by creator Telegram ID" },
      is_audio: { type: "boolean", description: "Filter for audio tokens only" },
      is_full: { type: "boolean", description: "Filter for fully bonded tokens" },
    },
  },

  execute: async (params) => {
    try {
      const result = await gasFetch("/tokens/list", {
        params: {
          search: params.search,
          sorting_field: params.sorting_field,
          limit: params.limit,
          offset: params.offset,
          telegram_id: params.telegram_id,
          is_audio: params.is_audio,
          is_full: params.is_full,
        },
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: gas_user_tokens
// ---------------------------------------------------------------------------

const gasUserTokens = {
  name: "gas_user_tokens",
  description: "List all tokens created by a specific user.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      telegram_id: { type: "integer", description: "Telegram user ID" },
      limit: { type: "integer", description: "Max results (default: 100)" },
      offset: { type: "integer", description: "Pagination offset" },
    },
    required: ["telegram_id"],
  },

  execute: async (params) => {
    try {
      const result = await gasFetch("/tokens/user-list", {
        params: {
          telegram_id: params.telegram_id,
          limit: params.limit,
          offset: params.offset,
        },
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: gas_token_stats
// ---------------------------------------------------------------------------

const gasTokenStats = {
  name: "gas_token_stats",
  description:
    "Get trading statistics for a token: volume, number of trades, and other metrics.",
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
      const result = await gasFetch("/transactions/token-stats", {
        params: { token_address: params.token_address },
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: gas_update_token
// ---------------------------------------------------------------------------

const gasUpdateToken = {
  name: "gas_update_token",
  description:
    "Update social links on an existing token (Telegram channel, chat, Twitter, website). Auth is automatic.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      token_address: { type: "string", description: "Token contract address" },
      tg_channel_link: { type: "string", description: "Telegram channel link" },
      tg_chat_link: { type: "string", description: "Telegram chat link" },
      twitter_link: { type: "string", description: "Twitter/X link" },
      website_link: { type: "string", description: "Website URL" },
    },
    required: ["token_address"],
  },

  execute: async (params, context) => {
    try {
      const body = {};
      for (const field of ["tg_channel_link", "tg_chat_link", "twitter_link", "website_link"]) {
        if (params[field] !== undefined) body[field] = params[field];
      }
      const result = await gasAuthFetch(context.bridge, "/tokens/update", {
        method: "PATCH",
        params: { token_address: params.token_address },
        body: Object.keys(body).length > 0 ? body : null,
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 7: gas_buy
// ---------------------------------------------------------------------------

const gasBuy = {
  name: "gas_buy",
  description:
    "Buy tokens on a GasPump bonding curve. Sends TON to the token contract.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      token_address: { type: "string", description: "Token contract address" },
      buy_ton: { type: "string", description: "TON amount to spend (default: 1)" },
    },
    required: ["token_address"],
  },

  execute: async (params) => {
    try {
      const { seqno, walletAddress } = await sendBuy(params.token_address, params.buy_ton || "1");
      return {
        success: true,
        data: {
          token_address: params.token_address,
          seqno,
          walletAddress,
          buy_ton: params.buy_ton || "1",
          message: "Buy transaction sent. Check balance after ~15 seconds.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 8: gas_sell
// ---------------------------------------------------------------------------

const gasSell = {
  name: "gas_sell",
  description:
    "Sell tokens back to the GasPump bonding curve. Transfers jettons to get TON back.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      token_address: { type: "string", description: "Token contract address" },
      sell_amount: { type: "string", description: "Amount of jettons to sell (in base units)" },
    },
    required: ["token_address", "sell_amount"],
  },

  execute: async (params) => {
    try {
      const { seqno, walletAddress, jettonWalletAddress } = await sendSell(params.token_address, BigInt(params.sell_amount));
      return {
        success: true,
        data: {
          token_address: params.token_address,
          seqno,
          walletAddress,
          jettonWalletAddress,
          sell_amount: params.sell_amount,
          message: "Sell transaction sent. Check balance after ~15 seconds.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 9: gas_portfolio
// ---------------------------------------------------------------------------

const gasPortfolio = {
  name: "gas_portfolio",
  description:
    "Get the agent's token portfolio: balances, prices, and total value.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async (_params, context) => {
    try {
      const client = context.bridge.getClient().getClient();
      const me = await client.getMe();
      const result = await gasFetch("/users/portfolio/info", {
        params: { telegram_id: Number(me.id) },
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 10: gas_holders
// ---------------------------------------------------------------------------

const gasHolders = {
  name: "gas_holders",
  description:
    "List token holders with balances and developer info.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      token_address: { type: "string", description: "Token contract address" },
      limit: { type: "integer", description: "Max results (default: 50)" },
    },
    required: ["token_address"],
  },

  execute: async (params) => {
    try {
      const result = await gasFetch("/holders/list", {
        params: { token_address: params.token_address, limit: params.limit || 50 },
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 11: gas_top_traders
// ---------------------------------------------------------------------------

const gasTopTraders = {
  name: "gas_top_traders",
  description:
    "Top traders for a token: PnL, buy/sell volume, transaction count.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      token_address: { type: "string", description: "Token contract address" },
      limit: { type: "integer", description: "Max results (default: 20)" },
    },
    required: ["token_address"],
  },

  execute: async (params) => {
    try {
      const result = await gasFetch("/transactions/top-traders", {
        params: { token_address: params.token_address, limit: params.limit || 20 },
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 12: gas_price_chart
// ---------------------------------------------------------------------------

const gasPriceChart = {
  name: "gas_price_chart",
  description:
    "Price history chart data for a token. Returns timestamp/price pairs.",
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
      const result = await gasFetch("/transactions/price-chart", {
        params: { token_address: params.token_address },
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 13: gas_king
// ---------------------------------------------------------------------------

const gasKing = {
  name: "gas_king",
  description:
    "Get the current 'King of the Hill' token on Gas111.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async () => {
    try {
      const result = await gasFetch("/tokens/king");
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const tools = [
  gasLaunchToken,
  gasTokenInfo,
  gasTokenSearch,
  gasUserTokens,
  gasTokenStats,
  gasUpdateToken,
  gasBuy,
  gasSell,
  gasPortfolio,
  gasHolders,
  gasTopTraders,
  gasPriceChart,
  gasKing,
];
