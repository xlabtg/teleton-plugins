/**
 * TON Bridge plugin
 *
 * Provides LLM-callable tools to share the TON Bridge Mini App link.
 * Pattern B (SDK) — uses sdk.pluginConfig, sdk.log, sdk.telegram.sendMessage
 *
 * Actively sends messages with URL inline buttons so the button renders
 * correctly in DMs, groups, and channels.
 */

// ─── Manifest (inline) ────────────────────────────────────────────────────────
// The runtime reads this export for sdkVersion and defaultConfig.
// The manifest.json file is used by the registry for discovery.

export const manifest = {
  name: "ton-bridge",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Share TON Bridge Mini App link with a button. Opens https://t.me/TONBridge_robot?startapp",
  defaultConfig: {
    buttonText: "TON Bridge No1",
    startParam: "",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MINI_APP_URL = "https://t.me/TONBridge_robot?startapp";

function buildUrl(startParam) {
  return startParam
    ? `${MINI_APP_URL}=${encodeURIComponent(startParam)}`
    : MINI_APP_URL;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export const tools = (sdk) => [
  // ── Tool: ton_bridge_open ─────────────────────────────────────────────────
  {
    name: "ton_bridge_open",
    description:
      "Send a message with a TON Bridge Mini App button. Use when the user asks to open or access TON Bridge. Sends the message directly to the current chat.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Optional message text to show with the button",
          minLength: 1,
          maxLength: 500,
        },
        buttonText: {
          type: "string",
          description: "Button label text. Omit to use the configured default. Do NOT include emoji here unless the user explicitly requested one.",
          minLength: 1,
          maxLength: 64,
        },
      },
    },
    execute: async (params, context) => {
      try {
        const buttonText = params.buttonText ?? sdk.pluginConfig?.buttonText ?? "TON Bridge No1";
        const startParam = sdk.pluginConfig?.startParam ?? "";
        const url = buildUrl(startParam);

        const text =
          params.message ??
          "TON Bridge — The #1 Bridge in the TON Catalog\n\nClick the button below to open TON Bridge Mini App.";

        sdk.log?.info(
          `ton_bridge_open called by ${context?.senderId ?? "unknown"}`
        );

        const messageId = await sdk.telegram.sendMessage(
          context.chatId,
          text,
          {
            inlineKeyboard: [[{ text: buttonText, url }]],
          }
        );

        return {
          success: true,
          data: { message_id: messageId, chat_id: context.chatId },
        };
      } catch (err) {
        if (err.name === "PluginSDKError") {
          sdk.log?.error(`ton_bridge_open failed: ${err.code}: ${err.message}`);
          return { success: false, error: `${err.code}: ${String(err.message).slice(0, 500)}` };
        }
        sdk.log?.error("ton_bridge_open failed:", err.message);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },

  // ── Tool: ton_bridge_about ────────────────────────────────────────────────
  {
    name: "ton_bridge_about",
    description:
      "Send an info message about TON Bridge with a Mini App button. Use when the user asks about TON Bridge or wants more information.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        buttonText: {
          type: "string",
          description: "Button label text. Omit to use the configured default. Do NOT include emoji here unless the user explicitly requested one.",
          minLength: 1,
          maxLength: 64,
        },
      },
    },
    execute: async (params, context) => {
      try {
        const buttonText = params.buttonText ?? sdk.pluginConfig?.buttonText ?? "TON Bridge No1";
        const startParam = sdk.pluginConfig?.startParam ?? "";
        const url = buildUrl(startParam);

        sdk.log?.info(
          `ton_bridge_about called by ${context?.senderId ?? "unknown"}`
        );

        const messageId = await sdk.telegram.sendMessage(
          context.chatId,
          "About TON Bridge\n\nTON Bridge is the #1 bridge in the TON Catalog. Transfer assets across chains seamlessly via the official Mini App.",
          {
            inlineKeyboard: [[{ text: buttonText, url }]],
          }
        );

        return {
          success: true,
          data: { message_id: messageId, chat_id: context.chatId },
        };
      } catch (err) {
        if (err.name === "PluginSDKError") {
          sdk.log?.error(`ton_bridge_about failed: ${err.code}: ${err.message}`);
          return { success: false, error: `${err.code}: ${String(err.message).slice(0, 500)}` };
        }
        sdk.log?.error("ton_bridge_about failed:", err.message);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },

  // ── Tool: ton_bridge_custom_message ──────────────────────────────────────
  {
    name: "ton_bridge_custom_message",
    description:
      "Send a custom message alongside a TON Bridge button. Use when the user wants to share a specific message with the TON Bridge link.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        customMessage: {
          type: "string",
          description: "Custom message text to display with the button",
          minLength: 1,
          maxLength: 500,
        },
        buttonText: {
          type: "string",
          description: "Button label text. Omit to use the configured default. Do NOT include emoji here unless the user explicitly requested one.",
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ["customMessage"],
    },
    execute: async (params, context) => {
      try {
        const buttonText = params.buttonText ?? sdk.pluginConfig?.buttonText ?? "TON Bridge No1";
        const startParam = sdk.pluginConfig?.startParam ?? "";
        const url = buildUrl(startParam);

        sdk.log?.info(
          `ton_bridge_custom_message called by ${context?.senderId ?? "unknown"}`
        );

        const messageId = await sdk.telegram.sendMessage(
          context.chatId,
          params.customMessage,
          {
            inlineKeyboard: [[{ text: buttonText, url }]],
          }
        );

        return {
          success: true,
          data: { message_id: messageId, chat_id: context.chatId },
        };
      } catch (err) {
        if (err.name === "PluginSDKError") {
          sdk.log?.error(`ton_bridge_custom_message failed: ${err.code}: ${err.message}`);
          return { success: false, error: `${err.code}: ${String(err.message).slice(0, 500)}` };
        }
        sdk.log?.error("ton_bridge_custom_message failed:", err.message);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },
];
