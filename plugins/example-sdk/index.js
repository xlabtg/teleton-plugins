/**
 * Example SDK plugin -- demonstrates the Plugin SDK features
 *
 * This plugin shows how to use tools(sdk) instead of tools[].
 * The SDK gives you high-level access to TON, Telegram, logging,
 * and an isolated database -- without touching GramJS or raw bridge.
 *
 * Copy this folder to start a new SDK plugin:
 *   cp -r plugins/example-sdk plugins/your-plugin
 */

// ─── Manifest (inline) ─────────────────────────────────────────────────
// The runtime reads this export for sdkVersion, defaultConfig, and dependencies.
// The manifest.json file is used by the registry for discovery and listing.

export const manifest = {
  name: "example-sdk",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "SDK example — greeting counter with TON balance check",
  defaultConfig: {
    greeting: "Hello",
  },
};

// ─── Database Migration ────────────────────────────────────────────────
// Export migrate() to get an isolated SQLite database in sdk.db.
// If you don't need persistence, skip this — sdk.db will be null.

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS greetings (
      user_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      last_greeted_at INTEGER
    )
  `);
}

// ─── Tools ─────────────────────────────────────────────────────────────
// Export tools as a function to receive the SDK.
// The context object is still available in execute().

export const tools = (sdk) => [
  // ── Tool 1: sdk_greet ───────────────────────────────────────────────
  // Demonstrates: sdk.db, sdk.pluginConfig, sdk.log, context.senderId
  {
    name: "sdk_greet",
    description:
      "Greet a user and track how many times they've been greeted. Returns greeting count from the plugin's isolated database.",
    category: "action",
    scope: "always",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name to greet" },
      },
      required: ["name"],
    },
    execute: async (params, context) => {
      const userId = String(context.senderId);
      const greeting = sdk.pluginConfig.greeting ?? "Hello";

      // sdk.db is a full better-sqlite3 instance, isolated to this plugin
      sdk.db
        .prepare(
          `INSERT INTO greetings (user_id, count, last_greeted_at)
           VALUES (?, 1, unixepoch())
           ON CONFLICT(user_id) DO UPDATE SET
             count = count + 1,
             last_greeted_at = unixepoch()`
        )
        .run(userId);

      const row = sdk.db
        .prepare("SELECT count FROM greetings WHERE user_id = ?")
        .get(userId);

      sdk.log.info(`Greeted ${params.name} (${row.count} times total)`);

      return {
        success: true,
        data: {
          message: `${greeting}, ${params.name}!`,
          greet_count: row.count,
          user_id: userId,
        },
      };
    },
  },

  // ── Tool 2: sdk_balance ─────────────────────────────────────────────
  // Demonstrates: sdk.ton.getAddress(), sdk.ton.getBalance(), sdk.ton.getPrice()
  {
    name: "sdk_balance",
    description:
      "Check the bot's TON wallet balance and current TON/USD price. No parameters needed.",
    category: "data-bearing",
    scope: "always",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (params, context) => {
      const address = sdk.ton.getAddress();
      if (!address) {
        return { success: false, error: "Wallet not initialized" };
      }

      // SDK read methods return null on failure (never throw)
      const balance = await sdk.ton.getBalance();
      const price = await sdk.ton.getPrice();

      const tonAmount = balance ? parseFloat(balance.balance) : 0;
      const usdValue =
        price && balance ? (tonAmount * price.usd).toFixed(2) : null;

      sdk.log.info(`Balance: ${balance?.balance ?? "unknown"} TON`);

      return {
        success: true,
        data: {
          address,
          balance: balance?.balance ?? "unknown",
          price_usd: price?.usd ?? null,
          value_usd: usdValue,
          price_source: price?.source ?? null,
        },
      };
    },
  },

  // ── Tool 3: sdk_announce ────────────────────────────────────────────
  // Demonstrates: sdk.telegram.sendMessage() with inline keyboard
  {
    name: "sdk_announce",
    description:
      "Send an announcement message to the current chat with optional inline buttons. Use this to demonstrate the Telegram SDK.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Announcement text" },
        with_buttons: {
          type: "boolean",
          description: "Include example inline buttons",
        },
      },
      required: ["text"],
    },
    scope: "admin-only",
    category: "action",
    execute: async (params, context) => {
      const opts = {};

      if (params.with_buttons) {
        opts.inlineKeyboard = [
          [
            { text: "Yes", callback_data: "sdk_yes" },
            { text: "No", callback_data: "sdk_no" },
          ],
        ];
      }

      try {
        const messageId = await sdk.telegram.sendMessage(
          context.chatId,
          params.text,
          opts
        );

        sdk.log.info(`Announcement sent (msg ${messageId})`);

        return {
          success: true,
          data: {
            message_id: messageId,
            chat_id: context.chatId,
            has_buttons: !!params.with_buttons,
          },
        };
      } catch (err) {
        // SDK write methods throw PluginSDKError with .code
        sdk.log.error("sendMessage failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },
];
