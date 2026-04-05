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

const _require = createRequire(realpathSync(process.argv[1]));
const _pluginRequire = createRequire(import.meta.url);

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

function formatAmount(raw, decimals = 9) {
  if (!raw && raw !== 0n) return "0";
  const s = String(raw);
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function formatUsd(val) {
  if (!val) return "0";
  const n = parseFloat(val);
  if (isNaN(n)) return "0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

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
    "Discover and list TONCO liquidity pools. Optionally filter