/**
 * TON SBT plugin — deploy and mint Soulbound Tokens (TEP-85)
 *
 * Uses @ton/core for cell building and the agent wallet
 * at ~/.teleton/wallet.json for signing transactions.
 *
 * Dependencies (provided by teleton runtime):
 *   @ton/core, @ton/ton, @ton/crypto, @orbs-network/ton-access
 */

import { createHash } from "crypto";
import { readFileSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { dirname, join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// TON dependencies (CJS packages — use createRequire for ESM compat)
// ---------------------------------------------------------------------------

const require = createRequire(realpathSync(process.argv[1]));
const _pluginRequire = createRequire(import.meta.url);

const { Cell, Address, beginCell, Dictionary, contractAddress, SendMode } = require("@ton/core");
const { WalletContractV5R1, TonClient, toNano, internal } = require("@ton/ton");
const { mnemonicToPrivateKey } = require("@ton/crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLET_FILE = join(homedir(), ".teleton", "wallet.json");

const SBT_ITEM_CODE = Cell.fromBoc(
  Buffer.from(readFileSync(join(__dirname, "sbt_item_code.boc.b64"), "utf-8").trim(), "base64"),
)[0];

const COLLECTION_CODE = Cell.fromBoc(
  Buffer.from(readFileSync(join(__dirname, "nft_collection_code.boc.b64"), "utf-8").trim(), "base64"),
)[0];

// ---------------------------------------------------------------------------
// On-chain content helpers (TEP-64)
// ---------------------------------------------------------------------------

function sha256(str) {
  return createHash("sha256").update(str).digest();
}

function buildSnakeCell(data) {
  const MAX = 127;
  if (data.length <= MAX) {
    return beginCell().storeBuffer(data).endCell();
  }
  const chunks = [];
  for (let i = 0; i < data.length; i += MAX) {
    chunks.push(data.subarray(i, Math.min(i + MAX, data.length)));
  }
  let cell = beginCell().storeBuffer(chunks[chunks.length - 1]).endCell();
  for (let i = chunks.length - 2; i >= 0; i--) {
    cell = beginCell().storeBuffer(chunks[i]).storeRef(cell).endCell();
  }
  return cell;
}

function buildContentDict(fields) {
  const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    const buf = Buffer.concat([Buffer.from([0x00]), Buffer.from(String(value), "utf-8")]);
    dict.set(sha256(key), buildSnakeCell(buf));
  }
  return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

function readSnakeCell(cell) {
  let result = Buffer.alloc(0);
  let cs = cell.beginParse();
  while (true) {
    const bits = cs.remainingBits;
    if (bits > 0) result = Buffer.concat([result, cs.loadBuffer(bits / 8)]);
    if (cs.remainingRefs > 0) cs = cs.loadRef().beginParse();
    else break;
  }
  return result;
}

function extractCollectionImage(metaCell) {
  try {
    const cs = metaCell.beginParse();
    if (cs.loadUint(8) !== 0) return null;
    const dict = cs.loadDict(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    const imageCell = dict.get(sha256("image"));
    if (!imageCell) return null;
    return readSnakeCell(imageCell).subarray(1).toString("utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wallet setup
// ---------------------------------------------------------------------------

async function getWalletAndClient() {
  let walletData;
  try {
    walletData = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  } catch {
    throw new Error("Agent wallet not found at " + WALLET_FILE);
  }
  if (!walletData.mnemonic || !Array.isArray(walletData.mnemonic)) {
    throw new Error("Invalid wallet file: missing mnemonic");
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

// ═══════════════════════════════════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════════════════════════════════

// ── Export -- SDK wrapper ────────────────────────────────────────────────

export const manifest = {
  name: "sbt",
  version: "2.0.0",
  sdkVersion: ">=1.0.0",
  description: "Deploy and mint Soulbound Tokens (TEP-85) on TON — non-transferable NFTs permanently bound to their owners.",
};

export const tools = (sdk) => {

// ── 1. sbt_deploy_collection ─────────────────────────────────────────────

const sbtDeployCollection = {
  name: "sbt_deploy_collection",
  description:
    "Deploy a new SBT (Soulbound Token) collection on TON. Creates the collection contract from the agent's wallet. Returns the collection address for minting items. Cost: ~0.05 TON.",
  category: "action",
  scope: "admin-only",
  parameters: {
    type: "object",
    required: ["name", "description", "image"],
    properties: {
      name: { type: "string", description: "Collection name" },
      description: { type: "string", description: "Collection description" },
      image: { type: "string", description: "URL to collection image" },
    },
  },
  execute: async (params) => {
    try {
      const { wallet, keyPair, contract } = await getWalletAndClient();
      const seqno = await contract.getSeqno();

      const collectionMetaCell = buildContentDict({
        name: params.name,
        description: params.description,
        image: params.image,
      });

      const contentCell = beginCell()
        .storeRef(collectionMetaCell)
        .storeRef(beginCell().endCell())
        .endCell();

      const royaltyCell = beginCell()
        .storeUint(0, 16)
        .storeUint(1000, 16)
        .storeAddress(wallet.address)
        .endCell();

      const data = beginCell()
        .storeAddress(wallet.address)
        .storeUint(0, 64)
        .storeRef(contentCell)
        .storeRef(SBT_ITEM_CODE)
        .storeRef(royaltyCell)
        .endCell();

      const stateInit = { code: COLLECTION_CODE, data };
      const address = contractAddress(0, stateInit);

      sdk.log.info("sbt_deploy_collection: deploying collection", params.name, "from wallet", wallet.address.toString());

      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: address,
            value: toNano("0.05"),
            init: stateInit,
            bounce: false,
          }),
        ],
      });

      sdk.log.info("sbt_deploy_collection: deployed at", address.toString());

      return {
        success: true,
        data: {
          collection_address: address.toString(),
          seqno,
          wallet_address: wallet.address.toString(),
          explorer: "https://tonviewer.com/" + address.toString(),
        },
      };
    } catch (err) {
      sdk.log.error("sbt_deploy_collection:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ── 2. sbt_mint ──────────────────────────────────────────────────────────

const sbtMint = {
  name: "sbt_mint",
  description:
    "Mint a new SBT (Soulbound Token) item in an existing collection. The SBT is non-transferable and permanently bound to the owner. Optionally set an authority address that can revoke it. Cost: ~0.1 TON.",
  category: "action",
  scope: "admin-only",
  parameters: {
    type: "object",
    required: ["collection_address", "owner_address", "name"],
    properties: {
      collection_address: { type: "string", description: "Address of SBT collection to mint from" },
      owner_address: { type: "string", description: "Who receives the SBT (permanent owner)" },
      name: { type: "string", description: "SBT item name" },
      description: { type: "string", description: "SBT item description" },
      image: { type: "string", description: "URL to SBT item image (defaults to collection image)" },
      authority_address: { type: "string", description: "Who can revoke the SBT (defaults to agent wallet)" },
    },
  },
  execute: async (params) => {
    try {
      const { wallet, keyPair, client, contract } = await getWalletAndClient();
      const seqno = await contract.getSeqno();

      const collectionAddr = Address.parse(params.collection_address);
      const result = await client.runMethod(collectionAddr, "get_collection_data");
      const nextItemIndex = result.stack.readBigNumber();
      const collectionContent = result.stack.readCell();

      let image = params.image;
      if (!image) {
        image = extractCollectionImage(collectionContent);
      }

      const individualContentCell = buildContentDict({
        name: params.name,
        description: params.description,
        image,
      });

      const authority = params.authority_address
        ? Address.parse(params.authority_address)
        : wallet.address;

      const itemPayloadCell = beginCell()
        .storeAddress(Address.parse(params.owner_address))
        .storeRef(individualContentCell)
        .storeAddress(authority)
        .endCell();

      sdk.log.info("sbt_mint: minting item #" + nextItemIndex.toString(), "to", params.owner_address, "in collection", params.collection_address);

      const mintBody = beginCell()
        .storeUint(1, 32)
        .storeUint(0, 64)
        .storeUint(nextItemIndex, 64)
        .storeCoins(toNano("0.05"))
        .storeRef(itemPayloadCell)
        .endCell();

      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: collectionAddr,
            value: toNano("0.1"),
            body: mintBody,
            bounce: true,
          }),
        ],
      });

      sdk.log.info("sbt_mint: minted item #" + nextItemIndex.toString(), "seqno", seqno);

      return {
        success: true,
        data: {
          item_index: nextItemIndex.toString(),
          collection_address: params.collection_address,
          owner: params.owner_address,
          authority: authority.toString(),
          image: image || null,
          seqno,
          wallet_address: wallet.address.toString(),
        },
      };
    } catch (err) {
      sdk.log.error("sbt_mint:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Return tools array
// ═══════════════════════════════════════════════════════════════════════════

return [sbtDeployCollection, sbtMint];

}; // end tools(sdk)
