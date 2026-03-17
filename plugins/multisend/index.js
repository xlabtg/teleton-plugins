/**
 * Multisend plugin -- batch TON & jetton transfers via Highload Wallet v3
 *
 * Send TON or jettons to up to 254 recipients in a single transaction.
 * Uses @tonkite/highload-wallet-v3 for on-chain batch operations.
 * Agent wallet at ~/.teleton/wallet.json provides the signing key.
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

const { HighloadWalletV3 } = _pluginRequire("@tonkite/highload-wallet-v3");
const { Address, SendMode, beginCell } = _require("@ton/core");
const { WalletContractV5R1, TonClient, toNano, internal } = _require("@ton/ton");
const { mnemonicToPrivateKey } = _require("@ton/crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WALLET_FILE = join(homedir(), ".teleton", "wallet.json");

// ---------------------------------------------------------------------------
// Database migration
// ---------------------------------------------------------------------------

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS multisend_sequence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_query_id TEXT NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve TON RPC endpoint. */
async function getEndpoint() {
  try {
    const { getHttpEndpoint } = _pluginRequire("@orbs-network/ton-access");
    return await getHttpEndpoint({ network: "mainnet" });
  } catch {
    return "https://toncenter.com/api/v2/jsonRPC";
  }
}

/** Create TonClient instance. */
async function getClient() {
  const endpoint = await getEndpoint();
  return new TonClient({ endpoint });
}

/** Load agent mnemonic and derive keypair. */
async function getWalletData() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  } catch {
    throw new Error("Agent wallet not found at " + WALLET_FILE);
  }
  if (!raw.mnemonic || !Array.isArray(raw.mnemonic)) {
    throw new Error("Invalid wallet file: missing mnemonic array");
  }
  const keyPair = await mnemonicToPrivateKey(raw.mnemonic);
  return { keyPair, mnemonic: raw.mnemonic };
}

/** Create HighloadWalletV3 instance with persisted sequence. */
async function getMultisendWallet(db) {
  const { keyPair } = await getWalletData();

  let sequence;
  const row = db.prepare("SELECT last_query_id FROM multisend_sequence WHERE id = 1").get();
  if (row) {
    sequence = HighloadWalletV3.restoreSequence(row.last_query_id);
  } else {
    sequence = HighloadWalletV3.newSequence();
  }

  const wallet = new HighloadWalletV3(sequence, keyPair.publicKey);
  return { wallet, keyPair, sequence };
}

/** Persist sequence state to database. */
function saveSequence(db, sequence) {
  db.prepare(
    "INSERT INTO multisend_sequence (id, last_query_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_query_id = excluded.last_query_id"
  ).run(sequence.current());
}

/** Format nanotons to human-readable TON string. */
function formatTON(nano) {
  const n = typeof nano === "bigint" ? nano : BigInt(nano);
  const whole = n / 1000000000n;
  const frac = (n % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ---------------------------------------------------------------------------
// Export (SDK v1.0.0)
// ---------------------------------------------------------------------------

export const manifest = {
  name: "multisend",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Batch TON and jetton transfers via Highload Wallet v3 — send to up to 254 recipients in a single transaction.",
};

export const tools = (sdk) => {
  const { db, log, ton } = sdk;

// ---------------------------------------------------------------------------
// Tool 1: multisend_info
// ---------------------------------------------------------------------------

const multisendInfo = {
  name: "multisend_info",
  description:
    "Show the multisend wallet address derived from the agent mnemonic, its TON balance, deployment status, and query sequence state. Use to check if the multisend wallet exists and is funded.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  execute: async (_params, _context) => {
    try {
      const { wallet, sequence } = await getMultisendWallet(db);
      const client = await getClient();
      const balance = await client.getBalance(wallet.address);
      const state = await client.getContractState(wallet.address);
      const deployed = state.state === "active";

      const seqInfo = { lastQueryId: sequence.current(), hasNext: sequence.hasNext() };
      const row = db.prepare("SELECT last_query_id FROM multisend_sequence WHERE id = 1").get();
      if (row) seqInfo.savedQueryId = row.last_query_id;

      return {
        success: true,
        data: {
          address: wallet.address.toString({ bounceable: !deployed }),
          address_raw: wallet.address.toRawString(),
          balance: formatTON(balance),
          balance_nano: balance.toString(),
          deployed,
          sequence: seqInfo,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: multisend_fund
// ---------------------------------------------------------------------------

const multisendFund = {
  name: "multisend_fund",
  description:
    "Transfer TON from the agent's main wallet (V5R1) to the multisend wallet to fund it for batch operations.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      amount: {
        type: "string",
        description: "Amount in TON to transfer (e.g. '5' or '0.5')",
      },
    },
    required: ["amount"],
  },

  execute: async (params, _context) => {
    try {
      const { wallet: multisendWallet, keyPair } = await getMultisendWallet(db);

      const v5Wallet = WalletContractV5R1.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
      });

      const client = await getClient();
      const contract = client.open(v5Wallet);
      const seqno = await contract.getSeqno();

      // Check if multisend wallet is deployed to set bounce correctly
      const state = await client.getContractState(multisendWallet.address);
      const deployed = state.state === "active";

      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: multisendWallet.address,
            value: toNano(params.amount),
            bounce: deployed,
          }),
        ],
      });

      return {
        success: true,
        data: {
          seqno,
          from: v5Wallet.address.toString({ bounceable: false }),
          to: multisendWallet.address.toString({ bounceable: !deployed }),
          amount: params.amount,
          bounce: deployed,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: multisend_batch_ton
// ---------------------------------------------------------------------------

const multisendBatchTon = {
  name: "multisend_batch_ton",
  description:
    "Send TON to up to 254 recipients in a single transaction via the multisend wallet. Ideal for airdrops, mass payments, and rewards distribution.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      recipients: {
        type: "array",
        description: "List of recipients (max 254)",
        maxItems: 254,
        items: {
          type: "object",
          properties: {
            address: { type: "string", description: "Recipient TON address" },
            amount: { type: "string", description: "Amount in TON" },
            memo: { type: "string", description: "Comment to attach (optional)" },
          },
          required: ["address", "amount"],
        },
      },
    },
    required: ["recipients"],
  },

  execute: async (params, _context) => {
    try {
      const recipients = params.recipients;
      if (!Array.isArray(recipients) || recipients.length === 0) {
        return { success: false, error: "recipients must be a non-empty array" };
      }
      if (recipients.length > 254) {
        return { success: false, error: "Maximum 254 recipients per batch" };
      }

      // Validate all recipient addresses
      for (const r of recipients) {
        if (!ton.validateAddress(r.address)) {
          return { success: false, error: `Invalid recipient address: ${r.address}` };
        }
      }

      const { wallet, keyPair, sequence } = await getMultisendWallet(db);
      const client = await getClient();

      // Calculate total and verify balance (wallet auto-deploys on first sendBatch)
      let totalNano = 0n;
      for (const r of recipients) {
        totalNano += toNano(r.amount);
      }
      const balance = await client.getBalance(wallet.address);
      const gasBuffer = toNano("0.15");
      if (balance < totalNano + gasBuffer) {
        return {
          success: false,
          error: `Insufficient balance: ${formatTON(balance)} TON, need ~${formatTON(totalNano + gasBuffer)} TON (${formatTON(totalNano)} + gas)`,
        };
      }

      // Build messages
      const messages = recipients.map((r) => ({
        mode: SendMode.PAY_GAS_SEPARATELY,
        message: internal({
          to: Address.parse(r.address),
          value: toNano(r.amount),
          body: r.memo
            ? beginCell().storeUint(0, 32).storeStringTail(r.memo).endCell()
            : undefined,
          bounce: false,
        }),
      }));

      // Send batch (client.open auto-injects provider as first arg)
      const opened = client.open(wallet);
      await opened.sendBatch(keyPair.secretKey, {
        messages,
        createdAt: Math.floor(Date.now() / 1000) - 60,
        valuePerBatch: toNano("0.05"),
      });

      // Advance sequence and persist
      sequence.next();
      saveSequence(db, sequence);
      log.info(`Batch TON sent to ${recipients.length} recipients, total ${formatTON(totalNano)} TON`);

      return {
        success: true,
        data: {
          recipient_count: recipients.length,
          total_ton: formatTON(totalNano),
          multisend_address: wallet.address.toString({ bounceable: true }),
          query_id: sequence.current(),
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: multisend_batch_jetton
// ---------------------------------------------------------------------------

const multisendBatchJetton = {
  name: "multisend_batch_jetton",
  description:
    "Send a jetton (fungible token) to up to 254 recipients in a single transaction via the multisend wallet. All transfers go through the multisend wallet's jetton wallet contract.",
  category: "action",
  scope: "admin-only",

  parameters: {
    type: "object",
    properties: {
      jetton_master: {
        type: "string",
        description: "Jetton master contract address",
      },
      recipients: {
        type: "array",
        description: "List of recipients (max 254)",
        maxItems: 254,
        items: {
          type: "object",
          properties: {
            address: { type: "string", description: "Recipient TON address" },
            amount: { type: "string", description: "Amount in human units" },
          },
          required: ["address", "amount"],
        },
      },
      decimals: {
        type: "integer",
        description: "Jetton decimals (6 for USDT, 9 for most tokens)",
        minimum: 0,
        maximum: 18,
      },
      forward_ton: {
        type: "string",
        description: "TON to attach per transfer for gas forwarding (default '0.05')",
      },
    },
    required: ["jetton_master", "recipients"],
  },

  execute: async (params, _context) => {
    try {
      const recipients = params.recipients;
      if (!Array.isArray(recipients) || recipients.length === 0) {
        return { success: false, error: "recipients must be a non-empty array" };
      }
      if (recipients.length > 254) {
        return { success: false, error: "Maximum 254 recipients per batch" };
      }

      // Validate jetton master and all recipient addresses
      if (!ton.validateAddress(params.jetton_master)) {
        return { success: false, error: `Invalid jetton master address: ${params.jetton_master}` };
      }
      for (const r of recipients) {
        if (!ton.validateAddress(r.address)) {
          return { success: false, error: `Invalid recipient address: ${r.address}` };
        }
      }

      const { wallet, keyPair, sequence } = await getMultisendWallet(db);
      const client = await getClient();

      // Jetton batch requires the wallet to be deployed -- it must already hold
      // jetton tokens, which means it was funded and deployed via a prior TON batch.
      const walletState = await client.getContractState(wallet.address);
      if (walletState.state !== "active") {
        return {
          success: false,
          error: "Multisend wallet is not deployed. Fund it with multisend_fund, then send a TON batch (multisend_batch_ton) to trigger deployment. After that, transfer jettons to the multisend wallet before using this tool.",
        };
      }

      // Resolve the multisend wallet's jetton wallet address
      const jettonMaster = Address.parse(params.jetton_master);
      const result = await client.runMethod(jettonMaster, "get_wallet_address", [
        { type: "slice", cell: beginCell().storeAddress(wallet.address).endCell() },
      ]);
      const jettonWallet = result.stack.readAddress();

      const decimals = params.decimals ?? 9;
      const forwardTon = toNano(params.forward_ton ?? "0.05");

      // Check TON balance covers gas (forwardTon per recipient + buffer)
      const balance = await client.getBalance(wallet.address);
      const gasNeeded = forwardTon * BigInt(recipients.length) + toNano("0.1");
      if (balance < gasNeeded) {
        return {
          success: false,
          error: `Insufficient TON for gas: ${formatTON(balance)} TON, need ~${formatTON(gasNeeded)} TON`,
        };
      }

      // Build jetton transfer messages
      const messages = recipients.map((r, i) => {
        const parsedAmount = Number(r.amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          throw new Error(`Invalid amount for recipient #${i + 1} (${r.address}): ${r.amount}`);
        }
        const jettonAmount = BigInt(Math.round(parsedAmount * 10 ** decimals));
        const body = beginCell()
          .storeUint(0xf8a7ea5, 32) // op: jetton transfer
          .storeUint(i, 64) // query_id
          .storeCoins(jettonAmount) // jetton amount
          .storeAddress(Address.parse(r.address)) // destination
          .storeAddress(wallet.address) // response_destination (excess back to multisend)
          .storeBit(false) // no custom payload
          .storeCoins(1n) // forward_ton_amount (1 nanoton for notification)
          .storeBit(false) // no forward payload
          .endCell();

        return {
          mode: SendMode.PAY_GAS_SEPARATELY,
          message: internal({
            to: jettonWallet,
            value: forwardTon,
            body,
            bounce: true,
          }),
        };
      });

      // Send batch (client.open auto-injects provider as first arg)
      const opened = client.open(wallet);
      await opened.sendBatch(keyPair.secretKey, {
        messages,
        createdAt: Math.floor(Date.now() / 1000) - 60,
        valuePerBatch: toNano("0.05"),
      });

      // Advance sequence and persist
      sequence.next();
      saveSequence(db, sequence);
      log.info(`Batch jetton sent to ${recipients.length} recipients, master ${jettonMaster.toString()}`);

      return {
        success: true,
        data: {
          recipient_count: recipients.length,
          jetton_master: jettonMaster.toString(),
          jetton_wallet: jettonWallet.toString(),
          multisend_address: wallet.address.toString({ bounceable: true }),
          decimals,
          query_id: sequence.current(),
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: multisend_status
// ---------------------------------------------------------------------------

const multisendStatus = {
  name: "multisend_status",
  description:
    "Check the on-chain state of the multisend wallet: balance, timeout configuration, last cleanup timestamp, and subwallet ID.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  execute: async (_params, _context) => {
    try {
      const { wallet, sequence } = await getMultisendWallet(db);
      const client = await getClient();
      const balance = await client.getBalance(wallet.address);
      const contractState = await client.getContractState(wallet.address);
      const deployed = contractState.state === "active";

      const data = {
        address: wallet.address.toString({ bounceable: !deployed }),
        address_raw: wallet.address.toRawString(),
        balance: formatTON(balance),
        balance_nano: balance.toString(),
        deployed,
        sequence: {
          current_query_id: sequence.current(),
          has_next: sequence.hasNext(),
        },
      };

      // Read on-chain state if deployed
      if (deployed) {
        const opened = client.open(wallet);
        try {
          data.timeout = await opened.getTimeout();
        } catch { /* method may not exist on older versions */ }
        try {
          data.last_cleaned = await opened.getLastCleaned();
          if (data.last_cleaned > 0) {
            data.last_cleaned_date = new Date(data.last_cleaned * 1000).toISOString();
          }
        } catch { /* ignore */ }
        try {
          data.subwallet_id = await opened.getSubwalletId();
        } catch { /* ignore */ }
      }

      return { success: true, data };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

  return [multisendInfo, multisendFund, multisendBatchTon, multisendBatchJetton, multisendStatus];
}; // end tools(sdk)
