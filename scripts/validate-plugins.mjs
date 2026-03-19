/**
 * validate-plugins.mjs
 *
 * Validates that every plugin in the plugins/ directory:
 *   1. Has a manifest.json with required fields
 *   2. Has an index.js that exports `tools` (array or function)
 *   3. Tools have required fields: name, description, execute
 *
 * Used by CI / Build (Runtime) workflow.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGINS_DIR = resolve("plugins");
const REQUIRED_MANIFEST_FIELDS = [
  "id",
  "name",
  "version",
  "description",
  "author",
  "license",
  "entry",
  "teleton",
  "tools",
  "permissions",
];

// Minimal mock SDK for plugins that export tools(sdk)
const MOCK_SDK = {
  ton: {
    getAddress: () => null,
    getPublicKey: () => null,
    getWalletVersion: () => "v5r1",
    getBalance: async () => null,
    getPrice: async () => null,
    sendTON: async () => { throw new Error("mock"); },
    getTransactions: async () => [],
    verifyPayment: async () => ({ verified: false }),
    getJettonBalances: async () => [],
    getJettonInfo: async () => null,
    sendJetton: async () => { throw new Error("mock"); },
    createJettonTransfer: async () => { throw new Error("mock"); },
    getJettonWalletAddress: async () => null,
    getNftItems: async () => [],
    getNftInfo: async () => null,
    toNano: (v) => BigInt(Math.round(parseFloat(v) * 1e9)),
    fromNano: (v) => String(Number(v) / 1e9),
    validateAddress: () => false,
    getJettonPrice: async () => null,
    getJettonHolders: async () => [],
    getJettonHistory: async () => null,
    dex: {
      quote: async () => { throw new Error("mock"); },
      quoteSTONfi: async () => null,
      quoteDeDust: async () => null,
      swap: async () => { throw new Error("mock"); },
      swapSTONfi: async () => { throw new Error("mock"); },
      swapDeDust: async () => { throw new Error("mock"); },
    },
    dns: {
      check: async () => ({ available: false }),
      resolve: async () => null,
      getAuctions: async () => [],
      startAuction: async () => { throw new Error("mock"); },
      bid: async () => { throw new Error("mock"); },
      link: async () => { throw new Error("mock"); },
      unlink: async () => { throw new Error("mock"); },
      setSiteRecord: async () => { throw new Error("mock"); },
    },
  },
  telegram: {
    sendMessage: async () => 0,
    editMessage: async () => 0,
    deleteMessage: async () => {},
    forwardMessage: async () => 0,
    pinMessage: async () => {},
    sendDice: async () => ({ value: 1, messageId: 0 }),
    sendReaction: async () => {},
    getMessages: async () => [],
    searchMessages: async () => [],
    getReplies: async () => [],
    scheduleMessage: async () => 0,
    getScheduledMessages: async () => [],
    deleteScheduledMessage: async () => {},
    sendScheduledNow: async () => {},
    getDialogs: async () => [],
    getHistory: async () => [],
    getMe: async () => null,
    isAvailable: () => false,
    getRawClient: () => null,
    sendPhoto: async () => 0,
    sendVideo: async () => 0,
    sendVoice: async () => 0,
    sendFile: async () => 0,
    sendGif: async () => 0,
    sendSticker: async () => 0,
    downloadMedia: async () => null,
    setTyping: async () => {},
    getChatInfo: async () => null,
    getUserInfo: async () => null,
    resolveUsername: async () => null,
    getParticipants: async () => [],
    createPoll: async () => 0,
    createQuiz: async () => 0,
    banUser: async () => {},
    unbanUser: async () => {},
    muteUser: async () => {},
    kickUser: async () => {},
    getStarsBalance: async () => 0,
    sendGift: async () => {},
    getAvailableGifts: async () => [],
    getMyGifts: async () => [],
    getResaleGifts: async () => [],
    buyResaleGift: async () => {},
    getStarsTransactions: async () => [],
    transferCollectible: async () => { throw new Error("mock"); },
    setCollectiblePrice: async () => {},
    getCollectibleInfo: async () => null,
    getUniqueGift: async () => null,
    getUniqueGiftValue: async () => null,
    sendGiftOffer: async () => {},
    sendStory: async () => 0,
  },
  bot: {
    onInlineQuery: () => {},
    onCallback: () => {},
    answerInline: async () => {},
    answerCallback: async () => {},
  },
  db: null,
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
  pluginConfig: {},
  secrets: { get: async () => null },
};

let errors = 0;
let warnings = 0;

function error(plugin, msg) {
  console.error(`  [ERROR] ${plugin}: ${msg}`);
  errors++;
}

function warn(plugin, msg) {
  console.warn(`  [WARN]  ${plugin}: ${msg}`);
  warnings++;
}

function ok(plugin, msg) {
  console.log(`  [OK]    ${plugin}: ${msg}`);
}

const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
const pluginDirs = entries
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

console.log(`\nValidating ${pluginDirs.length} plugins...\n`);

for (const name of pluginDirs) {
  const dir = join(PLUGINS_DIR, name);
  const manifestPath = join(dir, "manifest.json");
  const indexPath = join(dir, "index.js");

  process.stdout.write(`Plugin: ${name}\n`);

  // 1. Check manifest.json
  if (!existsSync(manifestPath)) {
    error(name, "missing manifest.json");
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (e) {
    error(name, `invalid manifest.json JSON: ${e.message}`);
    continue;
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (manifest[field] === undefined) {
      error(name, `manifest.json missing required field: ${field}`);
    }
  }

  if (manifest.id && manifest.id !== name) {
    error(name, `manifest.json id "${manifest.id}" does not match folder name "${name}"`);
  }

  // 2. Check index.js exists
  if (!existsSync(indexPath)) {
    error(name, "missing index.js");
    continue;
  }

  // 3. Import and validate exports
  let mod;
  try {
    mod = await import(pathToFileURL(indexPath).href);
  } catch (e) {
    error(name, `failed to import index.js: ${e.message}`);
    continue;
  }

  if (!mod.tools) {
    error(name, "index.js does not export `tools`");
    continue;
  }

  // 4. Resolve tools (array or function)
  let toolList;
  if (typeof mod.tools === "function") {
    try {
      toolList = mod.tools(MOCK_SDK);
    } catch (e) {
      error(name, `tools(sdk) threw during initialization: ${e.message}`);
      continue;
    }
    if (!Array.isArray(toolList)) {
      error(name, "tools(sdk) must return an array");
      continue;
    }
  } else if (Array.isArray(mod.tools)) {
    toolList = mod.tools;
  } else {
    error(name, "`tools` export must be an array or a function returning an array");
    continue;
  }

  if (toolList.length === 0) {
    warn(name, "tools array is empty");
  }

  // 5. Validate each tool
  for (const tool of toolList) {
    if (!tool.name) {
      error(name, `tool missing required field: name`);
    }
    if (!tool.description) {
      error(name, `tool "${tool.name ?? "?"}" missing required field: description`);
    }
    if (typeof tool.execute !== "function") {
      error(name, `tool "${tool.name ?? "?"}" missing required field: execute (must be a function)`);
    }
  }

  ok(name, `${toolList.length} tool(s) validated`);
}

console.log(`\nResult: ${pluginDirs.length} plugins, ${errors} error(s), ${warnings} warning(s)\n`);

if (errors > 0) {
  process.exit(1);
}
