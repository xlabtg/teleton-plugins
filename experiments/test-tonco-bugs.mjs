/**
 * Experiment: identify bugs in tonco-dex plugin
 * Tests the plugin behavior with a mock SDK
 */

import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

const PLUGIN_DIR = resolve("plugins/tonco-dex");
const PLUGIN_URL = pathToFileURL(join(PLUGIN_DIR, "index.js")).href;

function makeSdk(overrides = {}) {
  return {
    pluginConfig: {},
    log: {
      info: (...a) => console.log("[INFO]", ...a),
      warn: (...a) => console.warn("[WARN]", ...a),
      error: (...a) => console.error("[ERROR]", ...a),
      debug: (...a) => console.log("[DEBUG]", ...a),
    },
    ton: {
      getAddress: () => "EQDemo_Address",
      getBalance: async () => ({ balance: "5.5" }),
      sendTON: async (to, amount, body) => {
        console.log(`[SDK] sendTON(${to}, ${amount}, ${body})`);
        return "mock-tx-hash";
      },
    },
    storage: {
      get: () => null,
      set: () => {},
    },
    ...overrides,
  };
}

console.log("Loading tonco-dex plugin...");
let mod;
try {
  mod = await import(PLUGIN_URL);
  console.log("Plugin loaded OK");
} catch (err) {
  console.error("ERROR loading plugin:", err.message);
  process.exit(1);
}

// Test: can we call tools(sdk)?
const sdk = makeSdk();
let toolList;
try {
  toolList = mod.tools(sdk);
  console.log(`tools(sdk) returned ${toolList.length} tools`);
} catch (err) {
  console.error("ERROR calling tools(sdk):", err.message);
  process.exit(1);
}

// Test: does it export manifest?
console.log("manifest export:", mod.manifest ?? "NOT EXPORTED (bug!)");

// Check for known bug: tonco_execute_swap uses await on getAddress
const execSwap = toolList.find(t => t.name === "tonco_execute_swap");
console.log("\nChecking tonco_execute_swap...");
if (execSwap) {
  const src = execSwap.execute.toString();
  // Check if it awaits getAddress
  if (src.includes("await _sdk.ton.getAddress()")) {
    console.log("BUG FOUND: tonco_execute_swap awaits _sdk.ton.getAddress() — should be synchronous");
  } else if (src.includes("_sdk.ton.getAddress()")) {
    console.log("OK: getAddress() called without await (correct)");
  }
  
  // Check sendTON usage
  if (src.includes("_sdk.ton.sendTON")) {
    console.log("INFO: Uses _sdk.ton.sendTON for execution");
    // Check the args pattern
    const sendTonMatch = src.match(/_sdk\.ton\.sendTON\([^)]+\)/);
    if (sendTonMatch) {
      console.log("sendTON call:", sendTonMatch[0]);
    }
  }
}

// Run tonco_list_pools - should work without SDK
console.log("\n--- Testing tonco_list_pools ---");
const listPools = toolList.find(t => t.name === "tonco_list_pools");
if (listPools) {
  try {
    const result = await listPools.execute({ limit: 3 });
    if (result.success) {
      console.log(`SUCCESS: found ${result.data.pools.length} pools`);
      if (result.data.pools[0]) {
        const p = result.data.pools[0];
        console.log(`  First pool: ${p.name} (${p.address?.slice(0,10)}...) TVL: ${p.tvl_usd}`);
      }
    } else {
      console.log("FAILED:", result.error);
    }
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}

// Run tonco_swap_quote - test with TON -> USDT
console.log("\n--- Testing tonco_swap_quote (TON -> USDT) ---");
const swapQuote = toolList.find(t => t.name === "tonco_swap_quote");
if (swapQuote) {
  try {
    const result = await swapQuote.execute({ 
      token_in: "TON", 
      token_out: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", // USDT
      amount_in: "1" 
    });
    if (result.success) {
      console.log(`SUCCESS: 1 TON -> ${result.data.expected_output} USDT`);
      console.log(`  pool: ${result.data.pool?.address?.slice(0,10)}...`);
      console.log(`  note: ${result.data.note}`);
    } else {
      console.log("FAILED:", result.error);
    }
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}

// Run tonco_get_token_info
console.log("\n--- Testing tonco_get_token_info (TON) ---");
const tokenInfo = toolList.find(t => t.name === "tonco_get_token_info");
if (tokenInfo) {
  try {
    const result = await tokenInfo.execute({ token: "TON" });
    if (result.success) {
      console.log(`SUCCESS:`, JSON.stringify(result.data).slice(0, 200));
    } else {
      console.log("FAILED:", result.error);
    }
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}

console.log("\nDone.");
