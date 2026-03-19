/**
 * TON Bridge plugin
 *
 * Provides LLM-callable tools to share the TON Bridge Mini App link.
 * Pattern B (SDK) — uses sdk.pluginConfig, sdk.log
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
    buttonEmoji: "🌉",
    startParam: "",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MINI_APP_URL = "https://t.me/TONBridge_robot?startapp";

function buildReplyMarkup(buttonText, buttonEmoji, startParam) {
  const label = buttonEmoji ? `${buttonEmoji} ${buttonText}` : buttonText;
  const url = startParam
    ? `${MINI_APP_URL}=${encodeURIComponent(startParam)}`
    : MINI_APP_URL;
  return {
    inline_keyboard: [[{ text: label, url }]],
  };
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export const tools = (sdk) => [
  // ── Tool: ton_bridge_open ─────────────────────────────────────────────────
  {
    name: "ton_bridge_open",
    description:
      "Send a message with a TON Bridge Mini App link. Use when the user asks to open or access TON Bridge.",
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
      },
    },
    execute: async (params, context) => {
      try {
        const buttonText = sdk.pluginConfig?.buttonText ?? "TON Bridge No1";
        const buttonEmoji = sdk.pluginConfig?.buttonEmoji ?? "🌉";
        const startParam = sdk.pluginConfig?.startParam ?? "";

        const content =
          params.message ??
          "🌉 **TON Bridge** — The #1 Bridge in the TON Catalog\n\nClick the button below to open TON Bridge Mini App.";

        sdk.log?.info(
          `ton_bridge_open called by ${context?.senderId ?? "unknown"}`
        );

        return {
          success: true,
          data: {
            content,
            reply_markup: buildReplyMarkup(buttonText, buttonEmoji, startParam),
          },
        };
      } catch (err) {
        sdk.log?.error("ton_bridge_open failed:", err.message);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },

  // ── Tool: ton_bridge_about ────────────────────────────────────────────────
  {
    name: "ton_bridge_about",
    description:
      "Send an info message about TON Bridge with a link to the Mini App. Use when the user asks about TON Bridge or wants more information.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (params, context) => {
      try {
        const buttonText = sdk.pluginConfig?.buttonText ?? "TON Bridge No1";
        const buttonEmoji = sdk.pluginConfig?.buttonEmoji ?? "🌉";
        const startParam = sdk.pluginConfig?.startParam ?? "";

        sdk.log?.info(
          `ton_bridge_about called by ${context?.senderId ?? "unknown"}`
        );

        return {
          success: true,
          data: {
            content:
              "ℹ️ **About TON Bridge**\n\nTON Bridge is the #1 bridge in the TON Catalog. Transfer assets across chains seamlessly via the official Mini App.",
            reply_markup: buildReplyMarkup(buttonText, buttonEmoji, startParam),
          },
        };
      } catch (err) {
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
      },
      required: ["customMessage"],
    },
    execute: async (params, context) => {
      try {
        const buttonText = sdk.pluginConfig?.buttonText ?? "TON Bridge No1";
        const buttonEmoji = sdk.pluginConfig?.buttonEmoji ?? "🌉";
        const startParam = sdk.pluginConfig?.startParam ?? "";

        sdk.log?.info(
          `ton_bridge_custom_message called by ${context?.senderId ?? "unknown"}`
        );

        return {
          success: true,
          data: {
            content: params.customMessage,
            reply_markup: buildReplyMarkup(buttonText, buttonEmoji, startParam),
          },
        };
      } catch (err) {
        sdk.log?.error("ton_bridge_custom_message failed:", err.message);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },
];
