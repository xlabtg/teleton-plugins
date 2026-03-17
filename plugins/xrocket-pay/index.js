/**
 * xRocket Pay plugin — transfers, multi-cheques, invoices, withdrawals
 *
 * Wraps the xRocket Pay API (https://pay.xrocket.tg) with 11 tools.
 * Zero external dependencies — native fetch only.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://pay.xrocket.tg";
const NETWORKS = ["TON", "BSC", "ETH", "BTC", "TRX", "SOL"];
const CURRENCY_TTL = 5 * 60 * 1000; // 5 min

// ---------------------------------------------------------------------------
// Plugin export (SDK v1.0.0)
// ---------------------------------------------------------------------------

export const manifest = {
  name: "xrocket-pay",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "xRocket Pay API — transfers, multi-cheques, invoices, and withdrawals for Telegram crypto payments",
};

export const tools = (sdk) => {
  const log = sdk.log;

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  function validateAmount(val, name = "amount") {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`Invalid ${name}: must be a positive number`);
    return n;
  }

  function validateNetwork(val) {
    const v = String(val).toUpperCase();
    if (!NETWORKS.includes(v))
      throw new Error(`Invalid network: ${val}. Must be one of: ${NETWORKS.join(", ")}`);
    return v;
  }

  function validateString(val, name, maxLen) {
    const s = String(val);
    if (!s.trim()) throw new Error(`${name} must not be empty`);
    if (maxLen && s.length > maxLen)
      throw new Error(`${name} must be at most ${maxLen} characters`);
    return s;
  }

  // -------------------------------------------------------------------------
  // API fetch helper
  // -------------------------------------------------------------------------

  async function rocketFetch(path, { method = "GET", body = null, params = {} } = {}) {
    const apiKey = sdk.secrets.require("api_key");
    const url = new URL(path, API_BASE);
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    const opts = {
      method,
      headers: { "Rocket-Pay-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    };

    if (body && method !== "GET") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      const msg = json?.message || (await res.text().catch(() => `HTTP ${res.status}`));
      throw new Error(`xRocket ${res.status}: ${String(msg).slice(0, 500)}`);
    }
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Currency cache
  // -------------------------------------------------------------------------

  let currencyCache = null;
  let currencyCacheTime = 0;

  async function getCurrencies() {
    if (currencyCache && Date.now() - currencyCacheTime < CURRENCY_TTL)
      return currencyCache;

    const url = new URL("/currencies/available", API_BASE);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`xRocket ${res.status}: failed to fetch currencies`);
    const json = await res.json();
    currencyCache = json.data?.results ?? json.data ?? json;
    currencyCacheTime = Date.now();
    return currencyCache;
  }

  // -------------------------------------------------------------------------
  // Tools (11)
  // -------------------------------------------------------------------------

  return [
    // === App / Wallet (3) ================================================

    {
      name: "xpay_app_info",
      description: "Get xRocket Pay app info — name, fee %, and currency balances.",
      category: "data-bearing",
      scope: "always",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const json = await rocketFetch("/app/info");
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xpay_transfer",
      description:
        "Transfer funds to a Telegram user via xRocket. Recipient must have started @xRocket bot.",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          tg_user_id: { type: "number", description: "Telegram user ID of recipient" },
          currency: { type: "string", description: 'Currency code (e.g. "TONCOIN", "USDT")' },
          amount: { type: "number", description: "Amount to transfer" },
          transfer_id: { type: "string", description: "Idempotency key (auto-generated if omitted)" },
          transfer_description: { type: "string", description: "Transfer description" },
        },
        required: ["tg_user_id", "currency", "amount"],
      },
      execute: async (params) => {
        try {
          const amount = validateAmount(params.amount, "amount");
          const transferId = params.transfer_id || randomUUID();
          const body = {
            tgUserId: Number(params.tg_user_id),
            currency: String(params.currency),
            amount,
            transferId,
          };
          if (params.transfer_description) body.description = String(params.transfer_description);

          const json = await rocketFetch("/app/transfer", { method: "POST", body });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xpay_withdraw",
      description: "Withdraw funds to an external wallet on TON, BSC, ETH, BTC, TRX, or SOL.",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          network: { type: "string", description: "Network: TON, BSC, ETH, BTC, TRX, SOL" },
          address: { type: "string", description: "Destination wallet address" },
          currency: { type: "string", description: "Currency code" },
          amount: { type: "number", description: "Amount to withdraw" },
          withdrawal_id: { type: "string", description: "Idempotency key (auto-generated if omitted)" },
          comment: { type: "string", description: "Comment (max 50 chars)" },
        },
        required: ["network", "address", "currency", "amount"],
      },
      execute: async (params) => {
        try {
          const amount = validateAmount(params.amount, "amount");
          const network = validateNetwork(params.network);
          const address = validateString(params.address, "address");
          const withdrawalId = params.withdrawal_id || randomUUID();
          const body = { network, address, currency: String(params.currency), amount, withdrawalId };
          if (params.comment) body.comment = validateString(params.comment, "comment", 50);

          const json = await rocketFetch("/app/withdrawal", { method: "POST", body });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    // === Reference (1) ===================================================

    {
      name: "xpay_currencies",
      description: "List all available currencies with transfer/cheque/invoice/withdrawal limits and fees. Cached 5min.",
      category: "data-bearing",
      scope: "always",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const data = await getCurrencies();
          return { success: true, data };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    // === Multi-Cheques (3) ===============================================

    {
      name: "xpay_cheque_create",
      description: "Create a multi-cheque to distribute crypto to multiple users.",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          currency: { type: "string", description: "Currency code" },
          cheque_per_user: { type: "number", description: "Amount per user" },
          users_number: { type: "number", description: "Number of activations" },
          ref_program: { type: "number", description: "Referral % (0-100)" },
          password: { type: "string", description: "Password to claim (max 100)" },
          cheque_description: { type: "string", description: "Cheque description (max 1000)" },
          send_notifications: { type: "boolean", description: "Notify on activation" },
          enable_captcha: { type: "boolean", description: "Enable captcha" },
          telegram_resources_ids: { type: "array", items: { type: "string" }, description: "Required channel/group IDs to join" },
          for_premium: { type: "boolean", description: "Telegram Premium users only" },
          linked_wallet: { type: "boolean", description: "Require linked wallet" },
          disabled_languages: { type: "array", items: { type: "string" }, description: "Blocked language codes" },
          enabled_countries: { type: "array", items: { type: "string" }, description: "Allowed country codes" },
        },
        required: ["currency", "cheque_per_user", "users_number"],
      },
      execute: async (params) => {
        try {
          const chequePerUser = validateAmount(params.cheque_per_user, "cheque_per_user");
          const usersNumber = Math.floor(Number(params.users_number));
          if (!Number.isFinite(usersNumber) || usersNumber <= 0)
            throw new Error("Invalid users_number: must be a positive integer");

          const body = { currency: String(params.currency), chequePerUser, usersNumber };

          if (params.ref_program !== undefined) body.refProgram = Number(params.ref_program);
          if (params.password) body.password = String(params.password);
          if (params.cheque_description) body.description = String(params.cheque_description);
          if (params.send_notifications !== undefined) body.sendNotifications = Boolean(params.send_notifications);
          if (params.enable_captcha !== undefined) body.enableCaptcha = Boolean(params.enable_captcha);
          if (params.telegram_resources_ids) body.telegramResourcesIds = params.telegram_resources_ids;
          if (params.for_premium !== undefined) body.forPremium = Boolean(params.for_premium);
          if (params.linked_wallet !== undefined) body.linkedWallet = Boolean(params.linked_wallet);
          if (params.disabled_languages) body.disabledLanguages = params.disabled_languages;
          if (params.enabled_countries) body.enabledCountries = params.enabled_countries;

          const json = await rocketFetch("/multi-cheque", { method: "POST", body });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xpay_cheque_list",
      description: "List multi-cheques with pagination.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Results per page (1-1000, default 100)" },
          offset: { type: "number", description: "Pagination offset (default 0)" },
        },
      },
      execute: async (params) => {
        try {
          const qs = {};
          if (params.limit !== undefined) qs.limit = Math.min(Math.max(1, Math.floor(Number(params.limit))), 1000);
          if (params.offset !== undefined) qs.offset = Math.max(0, Math.floor(Number(params.offset)));
          const json = await rocketFetch("/multi-cheque", { params: qs });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xpay_cheque_delete",
      description: "Delete a multi-cheque. Remaining balance is refunded.",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          cheque_id: { type: "string", description: "Cheque ID" },
        },
        required: ["cheque_id"],
      },
      execute: async (params) => {
        try {
          const id = validateString(params.cheque_id, "cheque_id");
          const json = await rocketFetch(`/multi-cheque/${encodeURIComponent(id)}`, { method: "DELETE" });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    // === Invoices (4) ====================================================

    {
      name: "xpay_invoice_create",
      description: "Create an invoice for receiving payments.",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Invoice amount" },
          currency: { type: "string", description: "Currency code" },
          num_payments: { type: "number", description: "Max payments (default 1)" },
          invoice_description: { type: "string", description: "Invoice description (max 1000)" },
          hidden_message: { type: "string", description: "Message shown after payment (max 2000)" },
          comments_enabled: { type: "boolean", description: "Allow payer comments" },
          expired_in: { type: "number", description: "Expiration in seconds (max 86400)" },
        },
        required: ["amount", "currency"],
      },
      execute: async (params) => {
        try {
          const amount = validateAmount(params.amount, "amount");
          const body = { amount, currency: String(params.currency) };

          if (params.num_payments !== undefined) body.numPayments = Math.floor(Number(params.num_payments));
          if (params.invoice_description) body.description = String(params.invoice_description);
          if (params.hidden_message) body.hiddenMessage = String(params.hidden_message);
          if (params.comments_enabled !== undefined) body.commentsEnabled = Boolean(params.comments_enabled);
          if (params.expired_in !== undefined) {
            const exp = Math.floor(Number(params.expired_in));
            if (exp < 0 || exp > 86400) throw new Error("expired_in must be 0-86400 seconds");
            body.expiredIn = exp;
          }

          const json = await rocketFetch("/tg-invoices", { method: "POST", body });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xpay_invoice_list",
      description: "List invoices with pagination.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Results per page (1-1000, default 100)" },
          offset: { type: "number", description: "Pagination offset (default 0)" },
        },
      },
      execute: async (params) => {
        try {
          const qs = {};
          if (params.limit !== undefined) qs.limit = Math.min(Math.max(1, Math.floor(Number(params.limit))), 1000);
          if (params.offset !== undefined) qs.offset = Math.max(0, Math.floor(Number(params.offset)));
          const json = await rocketFetch("/tg-invoices", { params: qs });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xpay_invoice_info",
      description: "Get invoice details — activations, payments received, status.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          invoice_id: { type: "string", description: "Invoice ID" },
        },
        required: ["invoice_id"],
      },
      execute: async (params) => {
        try {
          const id = validateString(params.invoice_id, "invoice_id");
          const json = await rocketFetch(`/tg-invoices/${encodeURIComponent(id)}`);
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },

    {
      name: "xpay_invoice_delete",
      description: "Delete an invoice.",
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          invoice_id: { type: "string", description: "Invoice ID" },
        },
        required: ["invoice_id"],
      },
      execute: async (params) => {
        try {
          const id = validateString(params.invoice_id, "invoice_id");
          const json = await rocketFetch(`/tg-invoices/${encodeURIComponent(id)}`, { method: "DELETE" });
          return { success: true, data: json.data ?? json };
        } catch (e) {
          return { success: false, error: String(e.message).slice(0, 500) };
        }
      },
    },
  ];
};
