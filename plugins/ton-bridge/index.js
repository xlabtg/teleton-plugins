/**
 * TON Bridge Plugin
 *
 * Provides a beautiful inline button to open TON Bridge Mini App
 * Official Mini App: https://t.me/TONBridge_robot?startapp
 *
 * DEVELOPED BY TONY (AI AGENT) UNDER SUPERVISION OF ANTON POROSHIN
 * DEVELOPMENT STUDIO: https://github.com/xlabtg
 */

export const manifest = {
  name: "ton-bridge",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "TON Bridge plugin with inline button for Mini App access. Opens https://t.me/TONBridge_robot?startapp with beautiful button 'TON Bridge No1'. Developed by Tony (AI Agent) under supervision of Anton Poroshin.",
  author: {
    name: "Tony (AI Agent)",
    role: "AI Developer",
    supervisor: "Anton Poroshin",
    link: "https://github.com/xlabtg"
  },
  defaultConfig: {
    enabled: true,
    buttonText: "TON Bridge No1",
    buttonEmoji: "",  // Empty emoji - no icon on button
    startParam: "",
  },
};

export function migrate(db) {
  // No database required for this plugin
}

export const tools = (sdk) => [
  // ── Tool: ton_bridge_open ──────────────────────────────────────────────
  {
    name: "ton_bridge_open",
    description:
      "Open TON Bridge Mini App with a beautiful inline button. The button will be added to the message with text 'TON Bridge No1' as per your request.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Optional message to send before the button",
          minLength: 1,
          maxLength: 500,
        },
      },
    },
    execute: async (params, context) => {
      const { message = "" } = params;

      try {
        // Mini App URL
        const miniAppUrl = "https://t.me/TONBridge_robot?startapp";

        // Get button text from config
        const buttonText = sdk.pluginConfig.buttonText || "TON Bridge No1";
        const buttonEmoji = sdk.pluginConfig.buttonEmoji || "";

        // Create button with inline keyboard
        const keyboard = {
          inline_keyboard: [
            [
              {
                text: `${buttonEmoji} ${buttonText}`,
                url: miniAppUrl,
              },
            ],
          ],
        };

        // Send message with button using inline send
        if (message) {
          await sdk.inline.send({
            chatId: context.chatId,
            text: message,
            keyboard: keyboard,
          });
        } else {
          await sdk.inline.send({
            chatId: context.chatId,
            text: `🌉 **TON Bridge** - The #1 Bridge in TON Catalog\n\nClick the button below to open TON Bridge Mini App.`,
            keyboard: keyboard,
            parse_mode: "Markdown",
          });
        }

        sdk.log.info(
          `TON Bridge opened for user ${context.chatId} with button: "${buttonText}"`
        );

        return {
          success: true,
          data: {
            message_id: context.messageId,
            mini_app_url: miniAppUrl,
            button_text: buttonText,
            button_emoji: buttonEmoji,
            message_sent: message || "Welcome message with button",
          },
        };
      } catch (err) {
        sdk.log.error("ton_bridge_open failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool: ton_bridge_button_text ────────────────────────────────────────
  {
    name: "ton_bridge_button_text",
    description:
      "Get current button text configuration for TON Bridge. Useful for displaying what button will be shown to users.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (params, context) => {
      try {
        const buttonText = sdk.pluginConfig.buttonText || "TON Bridge No1";
        const buttonEmoji = sdk.pluginConfig.buttonEmoji || "";
        const miniAppUrl = "https://t.me/TONBridge_robot?startapp";

        return {
          success: true,
          data: {
            button_text: buttonText,
            button_emoji: buttonEmoji,
            mini_app_url: miniAppUrl,
            config: {
              text: buttonText,
              emoji: buttonEmoji,
              url: miniAppUrl,
            },
          },
        };
      } catch (err) {
        sdk.log.error("ton_bridge_button_text failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool: ton_bridge_custom_message ─────────────────────────────────────
  {
    name: "ton_bridge_custom_message",
    description:
      "Send a custom message with TON Bridge button. Use this to provide context before showing the bridge button.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        customMessage: {
          type: "string",
          description: "Custom message to display before the button",
          minLength: 1,
          maxLength: 500,
        },
        showWelcome: {
          type: "boolean",
          description: "Show welcome message after button (default: false)",
          default: false,
        },
      },
    },
    execute: async (params, context) => {
      const { customMessage, showWelcome = false } = params;

      try {
        const miniAppUrl = "https://t.me/TONBridge_robot?startapp";
        const buttonText = sdk.pluginConfig.buttonText || "TON Bridge No1";
        const buttonEmoji = sdk.pluginConfig.buttonEmoji || "";

        // Create button with inline keyboard
        const keyboard = {
          inline_keyboard: [
            [
              {
                text: `${buttonEmoji} ${buttonText}`,
                url: miniAppUrl,
              },
            ],
          ],
        };

        // Send custom message with button using inline send
        await sdk.inline.send({
          chatId: context.chatId,
          text: customMessage,
          keyboard: keyboard,
        });

        // Optionally send welcome message
        if (showWelcome) {
          await sdk.inline.send({
            chatId: context.chatId,
            text: `🌉 **TON Bridge**\n\nClick the button above to open the Mini App.\n\nThis is the #1 bridge in TON catalog according to your configuration.`,
            parse_mode: "Markdown",
          });
        }

        sdk.log.info(
          `Custom TON Bridge message sent to user ${context.chatId}`
        );

        return {
          success: true,
          data: {
            message_id: context.messageId,
            mini_app_url: miniAppUrl,
            button_text: buttonText,
            button_emoji: buttonEmoji,
            custom_message: customMessage,
            welcome_message: showWelcome ? "Sent" : "Not sent",
          },
        };
      } catch (err) {
        sdk.log.error("ton_bridge_custom_message failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },
];
