<div align="center">

# teleton-plugins

[![GitHub stars](https://img.shields.io/github/stars/TONresistor/teleton-plugins?style=flat&logo=github)](https://github.com/TONresistor/teleton-plugins/stargazers)
[![Plugins](https://img.shields.io/badge/plugins-28-8B5CF6.svg)](#available-plugins)
[![Tools](https://img.shields.io/badge/tools-249-E040FB.svg)](#available-plugins)
[![SDK](https://img.shields.io/badge/SDK-v1.0.0-00C896.svg)](#plugin-sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![SKILL.md](https://img.shields.io/badge/SKILL.md-AI%20prompt-F97316.svg)](https://github.com/TONresistor/teleton-plugins/blob/main/SKILL.md)
[![Telegram](https://img.shields.io/badge/Telegram-community-26A5E4.svg?logo=telegram)](https://t.me/ResistanceForum)

Community plugin directory for [Teleton](https://github.com/TONresistor/teleton-agent), the Telegram AI agent on TON.<br>
Drop a plugin in `~/.teleton/plugins/` and it's live. No build step, no config.

</div>

---

<details>
<summary><strong>Table of Contents</strong></summary>

- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Available Plugins](#available-plugins)
- [Build Your Own](#build-your-own)
- [Plugin SDK](#plugin-sdk)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Community](#community)
- [Contributors](#contributors)
- [License](#license)

</details>

## How It Works

```
User message
  → LLM reads tool descriptions
  → picks and calls a tool
  → execute(params, context) runs
  → result JSON → LLM
  → LLM responds to user
```

Teleton loads every folder from `~/.teleton/plugins/` at startup. Each plugin exports a `tools` array (or a function that receives the [Plugin SDK](#plugin-sdk)). The `execute` function receives the LLM's parameters and a `context` with Telegram bridge access. The returned `data` object is serialized to JSON and fed back to the LLM.

**Plugin lifecycle:** `manifest.json` is read first, then `migrate(db)` runs if exported (for database setup), then `tools` are registered, `start(ctx)` is called if exported, and `stop()` on shutdown.

## Quick Start

### Option 1 — WebUI Marketplace (recommended)

```bash
teleton start --webui
```

Open the WebUI in your browser, go to **Plugins** > **Marketplace** tab, and install any community plugin with one click. No manual copy, no git clone — browse, install, done.

### Option 2 — Manual install

```bash
# 1. Create the plugins directory
mkdir -p ~/.teleton/plugins

# 2. Clone and copy any plugin
git clone https://github.com/TONresistor/teleton-plugins.git
cp -r teleton-plugins/plugins/example ~/.teleton/plugins/

# 3. Restart Teleton — the plugin loads automatically
```

No build step. Just copy and go. Plugins with npm dependencies are auto-installed at startup.

## Available Plugins

> **28 plugins** · **249 tools** · [Browse the registry](registry.json)

### DeFi & Trading

| Plugin | Description | Tools | Author |
|--------|-------------|:-----:|--------|
| [ton-trading-bot](plugins/ton-trading-bot/) | Atomic TON trading tools — market data, portfolio, risk validation, simulation, DEX swap | 6 | xlabtg |
| [gaspump](plugins/gaspump/) | Launch, trade, and manage meme tokens on Gas111/TON | 13 | teleton |
| [stormtrade](plugins/stormtrade/) | Perpetual futures — crypto, stocks, forex, commodities | 13 | teleton |
| [evaa](plugins/evaa/) | EVAA Protocol — supply, borrow, withdraw, repay, liquidate | 11 | teleton |
| [stonfi](plugins/stonfi/) | StonFi DEX — tokens, pools, farms, swap | 8 | teleton |
| [dedust](plugins/dedust/) | DeDust DEX — pools, assets, trades, on-chain swaps | 8 | teleton |
| [swapcoffee](plugins/swapcoffee/) | swap.coffee aggregator — best rates across all DEXes | 6 | teleton |
| [giftindex](plugins/giftindex/) | GiftIndex ODROB — trade Telegram Gifts index on TON | 6 | teleton |

### Market Data & Analytics

| Plugin | Description | Tools | Author |
|--------|-------------|:-----:|--------|
| [tonapi](plugins/tonapi/) | TON blockchain data — accounts, jettons, NFTs, DNS, staking | 20 | teleton |
| [giftstat](plugins/giftstat/) | Telegram gift market data from Giftstat API | 11 | teleton |
| [dyor](plugins/dyor/) | DYOR.io — trust score, price, metrics, holders, pools | 11 | teleton |
| [geckoterminal](plugins/geckoterminal/) | TON DEX pools — trending, OHLCV, batch prices | 10 | teleton |
| [crypto-prices](plugins/crypto-prices/) | Real-time prices for 5000+ coins | 2 | walged |

### Social & Messaging

| Plugin | Description | Tools | Author |
|--------|-------------|:-----:|--------|
| [twitter](plugins/twitter/) | X/Twitter API v2 — search, post, like, retweet, follow | 24 | teleton |
| [pic](plugins/pic/) | Image search via @pic inline bot | 1 | teleton |
| [vid](plugins/vid/) | YouTube search via @vid inline bot | 1 | teleton |
| [deezer](plugins/deezer/) | Music search via @DeezerMusicBot | 1 | teleton |
| [voice-notes](plugins/voice-notes/) | Transcribe voice messages (Premium STT) | 1 | walged |

### TON Infrastructure

| Plugin | Description | Tools | Author |
|--------|-------------|:-----:|--------|
| [ton-bridge](plugins/ton-bridge/) | Share TON Bridge Mini App link with an inline button | 3 | xlabtg |
| [multisend](plugins/multisend/) | Batch send TON/jettons to 254 recipients in one TX | 5 | teleton |
| [sbt](plugins/sbt/) | Deploy and mint Soulbound Tokens (TEP-85) | 2 | teleton |

### Marketplace & NFTs

| Plugin | Description | Tools | Author |
|--------|-------------|:-----:|--------|
| [fragment](plugins/fragment/) | Fragment marketplace — usernames, numbers, collectible gifts | 6 | teleton |
| [webdom](plugins/webdom/) | TON domain marketplace — search, buy, sell, auction, DNS bid | 12 | teleton |

### Developer Tools

| Plugin | Description | Tools | Author |
|--------|-------------|:-----:|--------|
| [github-dev-assistant](plugins/github-dev-assistant/) | Complete GitHub workflow — repos, files, branches, PRs, issues, Actions, security, discussions | 57 | xlabtg |

### Utilities & Games

| Plugin | Description | Tools | Author |
|--------|-------------|:-----:|--------|
| [casino](plugins/casino/) | Slot machine and dice games with TON payments and auto-payout | 4 | teleton |
| [example](plugins/example/) | Dice roller and random picker | 2 | teleton |
| [example-sdk](plugins/example-sdk/) | SDK example — greeting counter, balance check, announcements | 3 | teleton |
| [weather](plugins/weather/) | Weather and 7-day forecast via Open-Meteo | 2 | walged |

## Build Your Own

Three files. No build step. ESM only.

```
plugins/your-plugin/
├── index.js         # exports tools[] or tools(sdk)
├── manifest.json    # registry metadata (marketplace, discovery)
└── README.md        # documentation
```

### Pattern A — Simple (static array)

For plugins that only call external APIs and return data to the LLM. No TON, no Telegram messaging, no state.

```js
// index.js
export const tools = [
  {
    name: "myplugin_search",
    description: "Search for something — the LLM reads this to decide when to call the tool",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    execute: async (params, context) => {
      try {
        const res = await fetch(`https://api.example.com/search?q=${encodeURIComponent(params.query)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { success: false, error: `API returned ${res.status}` };
        const data = await res.json();
        return { success: true, data };
      } catch (err) {
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },
];
```

### Pattern B — SDK plugin (function)

For plugins that need TON blockchain, Telegram messaging, database, inline bot mode, or secrets. Export `tools` as a **function** that receives the SDK, and add an inline `manifest` for runtime config:

```js
// index.js
export const manifest = {
  name: "my-plugin",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "What this plugin does",
  defaultConfig: { threshold: 50 },
  // bot: { inline: true, callbacks: true },  // uncomment for inline mode
};

// Optional: enables sdk.db (isolated SQLite per plugin)
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS scores (
    user_id TEXT PRIMARY KEY,
    points INTEGER NOT NULL DEFAULT 0
  )`);
}

export const tools = (sdk) => [
  {
    name: "myplugin_balance",
    description: "Check TON wallet balance and current price",
    parameters: { type: "object", properties: {} },
    scope: "dm-only",         // "always" | "dm-only" | "group-only" | "admin-only"
    category: "data-bearing", // "data-bearing" (reads) | "action" (writes)
    execute: async (params, context) => {
      try {
        const balance = await sdk.ton.getBalance();
        const price = await sdk.ton.getPrice();
        sdk.log.info(`Balance: ${balance?.balance ?? "unknown"} TON`);
        return {
          success: true,
          data: {
            balance: balance?.balance,
            usd: price?.usd,
          },
        };
      } catch (err) {
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },
];

// Optional lifecycle hooks
export async function start(ctx) { /* ctx.bridge, ctx.db, ctx.config, ctx.pluginConfig, ctx.log */ }
export async function stop() { /* cleanup timers, connections */ }
```

> See [`plugins/example/`](plugins/example/) for Pattern A and [`plugins/example-sdk/`](plugins/example-sdk/) for Pattern B.

### Two manifests

Plugins have **two** manifest sources with different roles:

| File | Purpose | Required |
|------|---------|----------|
| `manifest.json` | Registry & marketplace (discovery, listing, metadata) | **Yes** |
| `export const manifest` in `index.js` | Runtime config (SDK version, defaults, secrets, bot) | Only for Pattern B |

**manifest.json** (for registry):

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "One-line description",
  "author": { "name": "your-name", "url": "https://github.com/your-name" },
  "license": "MIT",
  "entry": "index.js",
  "teleton": ">=1.0.0",
  "tools": [{ "name": "myplugin_balance", "description": "Check TON balance" }],
  "permissions": [],
  "tags": ["defi", "ton"]
}
```

Add `"sdkVersion": ">=1.0.0"` for Pattern B plugins. Add `"secrets"` if your plugin needs API keys (see below).

### Secrets

Declare secrets in `manifest.json` so users know what to configure:

```json
"secrets": {
  "api_key": { "required": true, "description": "API key for the service" },
  "webhook_url": { "required": false, "description": "Optional webhook endpoint" }
}
```

**Env var naming is automatic** — derived from plugin name + key:
- Plugin `my-plugin`, key `api_key` → env var `MY_PLUGIN_API_KEY`
- Convention: plugin name uppercased, hyphens → underscores, then `_KEY_UPPERCASE`

Users can set secrets via:
- **Environment variable**: `MY_PLUGIN_API_KEY=sk-xxx` (Docker, CI)
- **WebUI**: Plugins → Manage Secrets
- **Telegram**: `/plugin set my-plugin api_key sk-xxx`

In code: `sdk.secrets.require("api_key")` (throws if missing) or `sdk.secrets.get("api_key")` (returns `undefined`).

### npm dependencies

Plugins can have their own npm packages beyond what Teleton provides (`@ton/core`, `@ton/ton`, `@ton/crypto`, `telegram`):

```bash
cd plugins/your-plugin
npm init -y
npm install some-package
# Commit BOTH package.json AND package-lock.json (lockfile is required)
```

Teleton auto-installs deps at startup via `npm ci --ignore-scripts`. Use the dual-require pattern for CJS packages:

```js
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

const _require = createRequire(realpathSync(process.argv[1]));       // core deps
const _pluginRequire = createRequire(import.meta.url);                // plugin-local deps

const { Address } = _require("@ton/core");                           // from teleton runtime
const { getHttpEndpoint } = _pluginRequire("@orbs-network/ton-access"); // from plugin node_modules
```

### Test locally

```bash
# Pattern A — verify tools load
node -e "import('./plugins/your-plugin/index.js').then(m => console.log(m.tools.length, 'tools'))"

# Pattern B — verify tools is a function
node -e "import('./plugins/your-plugin/index.js').then(m => console.log(typeof m.tools === 'function' ? 'SDK plugin OK' : m.tools.length + ' tools'))"

# Live test — copy and restart
cp -r plugins/your-plugin ~/.teleton/plugins/
```

Check the console output after restart:
```
Plugin "my-plugin": 3 tools registered    ← success
Plugin "my-plugin": no 'tools' exported   ← missing export
Plugin "my-plugin" failed to load: ...    ← syntax error
```

### Submission checklist

- [ ] Three files: `index.js`, `manifest.json`, `README.md`
- [ ] `manifest.json` has `id`, `name`, `version`, `description`, `author`, `tools`
- [ ] Tool names are `snake_case`, prefixed with plugin name (e.g. `myplugin_action`)
- [ ] `sdkVersion` declared in both manifests if using Pattern B
- [ ] Secrets declared with `required` + `description` (no `env` field needed — auto-derived)
- [ ] All `fetch()` calls use `AbortSignal.timeout(15_000)`
- [ ] All `execute` functions have try/catch and return `{ success, data/error }`
- [ ] Error messages sliced to 500 chars: `String(err.message || err).slice(0, 500)`
- [ ] Tested locally (see above)
- [ ] Added to `registry.json`

### Submit

1. Fork this repo
2. Create `plugins/your-plugin/` with the three files
3. Add your plugin to `registry.json`
4. Open a PR

Full guide — manifest fields, context API, lifecycle hooks, best practices: **[CONTRIBUTING.md](CONTRIBUTING.md)**

## Plugin SDK

> **[@teleton-agent/sdk](https://github.com/TONresistor/teleton-agent/tree/main/packages/sdk)** — full TypeScript types, interfaces, and API reference

The SDK gives your plugin access to TON blockchain, Telegram messaging, inline bot mode, secrets, storage, and more — without touching any internals. Export `tools` as a function to receive it:

```js
export const tools = (sdk) => [{ execute: async (params, context) => { /* sdk.* available here */ } }];
```

### Namespaces

| Namespace | What it does |
|-----------|-------------|
| [`sdk.ton`](#sdkton--ton-blockchain) | Wallet, balance, send TON/jettons, NFTs, payment verification, jetton analytics |
| [`sdk.ton.dex`](#sdktondex--dex-aggregator) | STON.fi + DeDust — quotes, swaps, auto-select best DEX |
| [`sdk.ton.dns`](#sdktondns--ton-domains) | .ton domain check, auctions, bids, link/unlink, ADNL site records |
| [`sdk.telegram`](#sdktelegram--telegram-messaging) | Messages, media, scheduling, moderation, polls, stars, gifts, collectibles, stories |
| [`sdk.bot`](#sdkbot--inline-bot-mode) | Inline queries, callback buttons, colored styled keyboards |
| [`sdk.db`](#sdkdb--isolated-database) | Isolated SQLite per plugin (requires `migrate()` export) |
| [`sdk.storage`](#sdkstorage--key-value-store) | Key-value store with TTL — no `migrate()` needed |
| [`sdk.secrets`](#sdksecrets--secret-management) | 3-tier resolution: ENV → secrets store → pluginConfig |
| `sdk.log` | Prefixed logger — `info()`, `warn()`, `error()`, `debug()` |
| `sdk.config` | Sanitized app config (no secrets) |
| `sdk.pluginConfig` | Plugin-specific config merged with `manifest.defaultConfig` |

### `sdk.ton` — TON Blockchain

```js
// Wallet
const address = sdk.ton.getAddress();                      // string | null
const balance = await sdk.ton.getBalance(address?);        // { balance, balanceNano } | null
const price = await sdk.ton.getPrice();                    // { usd, source, timestamp } | null
const valid = sdk.ton.validateAddress("EQx...");           // boolean

// Transfers (throw PluginSDKError on failure)
await sdk.ton.sendTON("EQx...", 1.5, "memo");             // { txRef, amount }
await sdk.ton.sendJetton(jettonAddr, toAddr, amount);      // { success, seqno }

// Payment verification
const result = await sdk.ton.verifyPayment({
  amount: 1.0, memo: "order-42", maxAgeMinutes: 30
});  // { verified, txHash?, amount?, playerWallet?, error? }

// Jettons & NFTs
const jettons = await sdk.ton.getJettonBalances();         // JettonBalance[]
const info = await sdk.ton.getJettonInfo(jettonAddr);      // JettonInfo | null
const wallet = await sdk.ton.getJettonWalletAddress(owner, jettonAddr); // string | null
const nfts = await sdk.ton.getNftItems();                  // NftItem[]
const nft = await sdk.ton.getNftInfo(nftAddr);             // NftItem | null
const txs = await sdk.ton.getTransactions(addr, 50);       // TonTransaction[]

// Jetton analytics
const price = await sdk.ton.getJettonPrice(jettonAddr);    // { usd, ton, change24h, change7d, change30d } | null
const holders = await sdk.ton.getJettonHolders(addr, 100); // JettonHolder[]
const history = await sdk.ton.getJettonHistory(addr);      // { volume24h, fdv, marketCap } | null

// Utilities
const nano = sdk.ton.toNano(1.5);                         // bigint
const ton = sdk.ton.fromNano(1500000000n);                 // "1.5"
```

### `sdk.ton.dex` — DEX Aggregator

Compares STON.fi and DeDust to find the best rate.

```js
// Get quotes from both DEXes
const quote = await sdk.ton.dex.quote({
  fromAsset: "ton",
  toAsset: jettonAddress,
  amount: 10,
  slippage: 0.01,
});  // DexQuoteResult — includes recommendation

// Execute swap (auto-selects best DEX)
const swap = await sdk.ton.dex.swap({
  fromAsset: "ton",
  toAsset: jettonAddress,
  amount: 10,
  slippage: 0.01,
});  // DexSwapResult

// Or target a specific DEX
const stonQuote = await sdk.ton.dex.quoteSTONfi(params);
const dedustQuote = await sdk.ton.dex.quoteDeDust(params);
await sdk.ton.dex.swapSTONfi(params);
await sdk.ton.dex.swapDeDust(params);
```

### `sdk.ton.dns` — .ton Domains

```js
const domain = await sdk.ton.dns.check("mybot.ton");       // { available, owner?, auction? }
const resolved = await sdk.ton.dns.resolve("mybot.ton");   // { address } | null
const auctions = await sdk.ton.dns.getAuctions(10);        // DnsAuction[]

// Domain management (throw PluginSDKError on failure)
await sdk.ton.dns.startAuction("mybot.ton");               // ~0.06 TON min bid
await sdk.ton.dns.bid("mybot.ton", 5.0);
await sdk.ton.dns.link("mybot.ton", walletAddress);
await sdk.ton.dns.unlink("mybot.ton");
await sdk.ton.dns.setSiteRecord("mybot.ton", adnlAddress); // TON Site ADNL record
```

### `sdk.telegram` — Telegram Messaging

**Messages:**

```js
const msgId = await sdk.telegram.sendMessage(chatId, "Hello!", {
  replyToId: 123,
  inlineKeyboard: [[{ text: "Click me", callback_data: "action" }]],
});
await sdk.telegram.editMessage(chatId, msgId, "Updated!");
await sdk.telegram.deleteMessage(chatId, msgId);
await sdk.telegram.forwardMessage(fromChat, toChat, msgId);
await sdk.telegram.pinMessage(chatId, msgId);
```

**Scheduling:**

```js
await sdk.telegram.scheduleMessage(chatId, "Reminder!", unixTimestamp);
const scheduled = await sdk.telegram.getScheduledMessages(chatId);
await sdk.telegram.sendScheduledNow(chatId, msgId);
await sdk.telegram.deleteScheduledMessage(chatId, msgId);
```

**Media:**

```js
await sdk.telegram.sendPhoto(chatId, filePath, { caption: "Check this!" });
await sdk.telegram.sendVideo(chatId, filePath);
await sdk.telegram.sendVoice(chatId, filePath);
await sdk.telegram.sendFile(chatId, filePath, { caption: "Report" });
await sdk.telegram.sendGif(chatId, filePath);
await sdk.telegram.sendSticker(chatId, filePath);
const buffer = await sdk.telegram.downloadMedia(chatId, msgId); // Buffer | null
await sdk.telegram.setTyping(chatId);
```

**Search & history:**

```js
const messages = await sdk.telegram.getMessages(chatId, 50);
const results = await sdk.telegram.searchMessages(chatId, "keyword", 20);
const replies = await sdk.telegram.getReplies(chatId, msgId, 20);
const dialogs = await sdk.telegram.getDialogs(100);
const history = await sdk.telegram.getHistory(chatId, 100);
```

**Social & chat info:**

```js
const chat = await sdk.telegram.getChatInfo(chatId);
const user = await sdk.telegram.getUserInfo(userId);
const resolved = await sdk.telegram.resolveUsername("username");
const members = await sdk.telegram.getParticipants(chatId, 200);
const me = await sdk.telegram.getMe();
```

**Interactive:**

```js
await sdk.telegram.sendDice(chatId, "🎲");
await sdk.telegram.sendReaction(chatId, msgId, "👍");
await sdk.telegram.createPoll(chatId, "Best DEX?", ["STON.fi", "DeDust"]);
await sdk.telegram.createQuiz(chatId, "1+1=?", ["1", "2", "3"], 1, "It's 2!");
```

**Moderation:**

```js
await sdk.telegram.banUser(chatId, userId);
await sdk.telegram.unbanUser(chatId, userId);
await sdk.telegram.muteUser(chatId, userId, untilDate); // Unix timestamp, 0 = forever
await sdk.telegram.kickUser(chatId, userId);             // ban + immediate unban
```

**Stars & gifts:**

```js
const stars = await sdk.telegram.getStarsBalance();
const gifts = await sdk.telegram.getAvailableGifts();
const myGifts = await sdk.telegram.getMyGifts(50);
await sdk.telegram.sendGift(userId, giftId, { message: "For you!" });
const resale = await sdk.telegram.getResaleGifts(giftId, 10);
await sdk.telegram.buyResaleGift(giftId);
const txs = await sdk.telegram.getStarsTransactions(50);
```

**Collectibles:**

```js
await sdk.telegram.transferCollectible(msgId, toUserId);
await sdk.telegram.setCollectiblePrice(msgId, 100);       // 0 to unlist
const info = await sdk.telegram.getCollectibleInfo(slug);
const unique = await sdk.telegram.getUniqueGift(slug);
const value = await sdk.telegram.getUniqueGiftValue(slug);
await sdk.telegram.sendGiftOffer(userId, giftSlug, price);
```

**Stories & raw client:**

```js
await sdk.telegram.sendStory(mediaPath, { caption: "New!", pinned: true });
const client = sdk.telegram.getRawClient(); // GramJS TelegramClient | null
```

### `sdk.bot` — Inline Bot Mode

Enables `@botname query` inline queries and callback button handling. Requires `bot` in manifest:

```js
export const manifest = {
  name: "my-bot",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  bot: {
    inline: true,
    callbacks: true,
    rateLimits: { inlinePerMinute: 30, callbackPerMinute: 60 }, // optional
  },
};

export const tools = (sdk) => {
  // Handle inline queries — user types @botname <query>
  sdk.bot.onInlineQuery(async (ctx) => {
    return [{
      id: "1",
      type: "article",
      title: `Result: ${ctx.query}`,
      description: "Tap to send",
      content: { text: `You searched: ${ctx.query}` },
      replyMarkup: sdk.bot.keyboard([
        [{ text: "✓ Yes", callback: "pick:yes", style: "success" }],  // green
        [{ text: "✗ No", callback: "pick:no", style: "danger" }],     // red
      ]).toTL(),  // .toTL() = GramJS colored buttons, .toGrammy() = Bot API
    }];
  });

  // Handle button presses — glob pattern matching
  sdk.bot.onCallback("pick:*", async (ctx) => {
    await ctx.answer("Selected!");        // toast notification
    await ctx.editMessage("Choice made."); // update the message
  });

  // Track which inline results users select
  sdk.bot.onChosenResult(async (ctx) => {
    sdk.log.info(`User ${ctx.userId} chose ${ctx.resultId}`);
  });

  return [/* regular tools alongside inline mode */];
};
```

Button styles: `"success"` (green), `"danger"` (red), `"primary"` (blue) — colored via GramJS Layer 222, graceful fallback on Bot API.

Properties: `sdk.bot.isAvailable` (boolean), `sdk.bot.username` (string).

> **Important:** `sdk.bot` is `null` unless the manifest declares `bot` capabilities.

### `sdk.db` — Isolated Database

Each plugin gets its own SQLite database. Export `migrate()` to enable it:

```js
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS scores (
    user_id TEXT PRIMARY KEY,
    points INTEGER NOT NULL DEFAULT 0
  )`);
}

// sdk.db is a full better-sqlite3 instance
sdk.db.prepare("INSERT INTO scores ...").run(userId);
const row = sdk.db.prepare("SELECT * FROM scores WHERE user_id = ?").get(userId);
```

If you don't export `migrate`, `sdk.db` is `null`.

### `sdk.storage` — Key-Value Store

No setup needed. Supports TTL (auto-expiry):

```js
sdk.storage.set("price", 42.5, { ttl: 3_600_000 }); // expires in 1 hour
const val = sdk.storage.get("price");                 // 42.5 or undefined if expired
sdk.storage.has("price");                              // boolean
sdk.storage.delete("price");                           // boolean
sdk.storage.clear();                                   // delete all keys
```

### `sdk.secrets` — Secret Management

3-tier resolution: **ENV variable** → **secrets store** → **pluginConfig fallback**.

```js
const key = sdk.secrets.require("api_key"); // throws SECRET_NOT_FOUND if missing
const opt = sdk.secrets.get("webhook_url"); // undefined if not set
sdk.secrets.has("premium_key");             // boolean
```

Declare in `manifest.json` for validation at load time:

```json
{ "secrets": { "api_key": { "required": true, "description": "API key for the service" } } }
```

### Plugin Lifecycle

| Export | When | Purpose |
|--------|------|---------|
| `manifest` | Load time | Plugin metadata, `defaultConfig`, `sdkVersion`, `bot` config |
| `migrate(db)` | Before tools | Database schema setup (enables `sdk.db`) |
| `tools` / `tools(sdk)` | After migrate | Tool definitions |
| `start(ctx)` | After Telegram connects | Background tasks, intervals, initialization |
| `stop()` | On shutdown | Cleanup timers, connections |

### Error Handling

**Read methods** (`getBalance`, `getMessages`, etc.) return `null` or `[]` — never throw.

**Write methods** (`sendTON`, `sendMessage`, `banUser`, etc.) throw `PluginSDKError` with `.code`:

| Code | Meaning |
|------|---------|
| `WALLET_NOT_INITIALIZED` | Wallet not set up |
| `INVALID_ADDRESS` | Bad TON address |
| `BRIDGE_NOT_CONNECTED` | Telegram not ready |
| `SECRET_NOT_FOUND` | `sdk.secrets.require()` failed |
| `OPERATION_FAILED` | Generic failure |

```js
try {
  await sdk.ton.sendTON(address, 1.0);
} catch (err) {
  if (err.name === "PluginSDKError") {
    return { success: false, error: `${err.code}: ${err.message}` };
  }
  return { success: false, error: String(err.message || err).slice(0, 500) };
}
```

> Complete SDK reference with TypeScript types and interfaces: **[@teleton-agent/sdk](https://github.com/TONresistor/teleton-agent/tree/main/packages/sdk)**<br>
> Contribution guide with best practices and testing: **[CONTRIBUTING.md](CONTRIBUTING.md)**

## Troubleshooting

**Plugin not loading?**

- Check that `manifest.json` exists and has valid JSON
- Verify the plugin exports `tools` (array or function): `node -e "import('./plugins/name/index.js').then(m => console.log(m.tools))"`
- Look for errors in the Teleton console output at startup
- Make sure the plugin folder name matches the `id` in `manifest.json`

**Common errors:**

| Error | Cause | Fix |
|-------|-------|-----|
| `Cannot find module` | Missing dependency | Add a `package.json` — deps are auto-installed at startup |
| `tools is not iterable` | `tools` export is not an array or function | Check your export: `export const tools = [...]` or `export const tools = (sdk) => [...]` |
| `Plugin name collision` | Two plugins share the same `id` | Rename one of the plugins in its `manifest.json` |
| `SDK not available` | Using `sdk.*` without the SDK pattern | Switch to Pattern B: `export const tools = (sdk) => [...]` |

## FAQ

**Can I use npm packages?**
Yes. Add a `package.json` (and `package-lock.json`) to your plugin folder. Teleton auto-installs dependencies at startup.

**How do I store data?**
Use `sdk.db` for SQL (requires exporting a `migrate(db)` function) or `sdk.storage` for simple key-value pairs with optional TTL.

**How do I access TON or Telegram?**
Use the SDK (Pattern B): `export const tools = (sdk) => [...]`. Then call `sdk.ton.*` for wallet/blockchain operations and `sdk.telegram.*` for messaging.

**How do I manage API keys?**
Declare them in `manifest.json` with the `env` field so users know exactly what to set. In your code, use `sdk.secrets.require("key_name")`. Secrets resolve in order: environment variable → secrets store (`/plugin set`) → `pluginConfig` (config.yaml).

**Why is my plugin not showing tools?**
Make sure your `tools` export is either an array of tool objects or a function that returns one. Each tool needs at least `name`, `description`, and `execute`.

## Community

- **[Telegram Group](https://t.me/ResistanceForum)**: questions, plugin ideas, support
- **[GitHub Issues](https://github.com/TONresistor/teleton-plugins/issues)**: bug reports, feature requests
- **[Contributing Guide](CONTRIBUTING.md)**: how to build and submit plugins

## Contributors

This project exists thanks to everyone who contributes.

<a href="https://github.com/TONresistor/teleton-plugins/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=TONresistor/teleton-plugins&max=100&columns=12" />
</a>

Want to see your name here? Check out the [Contributing Guide](CONTRIBUTING.md).

## License

[MIT](LICENSE) — use it, fork it, build on it.

---

<div align="center">

**[teleton-plugins](https://github.com/TONresistor/teleton-plugins)** — open source plugins for the TON ecosystem

[Report Bug](https://github.com/TONresistor/teleton-plugins/issues) · [Request Plugin](https://github.com/TONresistor/teleton-plugins/issues/new) · [Contributing Guide](CONTRIBUTING.md)

</div>
