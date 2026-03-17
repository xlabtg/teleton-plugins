/**
 * Webdom plugin -- .ton domain and Telegram username marketplace
 *
 * Buy, sell, auction, and manage domains on webdom.market.
 * Read-only tools use the public API; action tools sign on-chain
 * transactions from the agent's wallet at ~/.teleton/wallet.json.
 *
 * Uses Plugin SDK exclusively:
 * - sdk.storage for API response caching
 * - sdk.ton for address/balance lookups
 * - sdk.log for prefixed logging
 */

import { initApi } from "./lib/api.js";
import { readTools } from "./tools/read.js";
import { actionTools } from "./tools/actions.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const manifest = {
  name: "webdom",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Buy, sell, auction, and manage .ton domains and Telegram usernames on webdom.market",
};

// ---------------------------------------------------------------------------
// Tools export (SDK format)
// ---------------------------------------------------------------------------

export const tools = (sdk) => {
  initApi(sdk);
  return [...readTools(sdk), ...actionTools(sdk)];
};
