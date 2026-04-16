/**
 * Unit tests for ton-bridge plugin
 *
 * Tests manifest exports, tool definitions, and tool execute behavior
 * using Node's built-in test runner (node:test).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

const PLUGIN_DIR = resolve("plugins/ton-bridge");
const PLUGIN_URL = pathToFileURL(join(PLUGIN_DIR, "index.js")).href;

// ─── Minimal mock SDK ────────────────────────────────────────────────────────

function makeSdk(overrides = {}) {
  return {
    pluginConfig: {
      buttonText: "TON Bridge No1",
      startParam: "",
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    telegram: {
      sendMessage: async () => 42,
      ...overrides.telegram,
    },
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    chatId: 123456789,
    senderId: 987654321,
    ...overrides,
  };
}

function makeCircularContext(overrides = {}) {
  const context = makeContext(overrides);
  context.client = { context };
  return context;
}

// ─── Load plugin once ─────────────────────────────────────────────────────────

let mod;

before(async () => {
  mod = await import(PLUGIN_URL);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ton-bridge plugin", () => {
  describe("manifest", () => {
    it("exports manifest object", () => {
      assert.ok(mod.manifest, "manifest should be exported");
      assert.equal(typeof mod.manifest, "object");
    });

    it("manifest has required name field", () => {
      assert.equal(mod.manifest.name, "ton-bridge");
    });

    it("manifest has version", () => {
      assert.ok(mod.manifest.version, "manifest.version should exist");
    });

    it("manifest has sdkVersion", () => {
      assert.ok(mod.manifest.sdkVersion, "manifest.sdkVersion should exist");
    });

    it("manifest has defaultConfig with buttonText", () => {
      assert.ok(mod.manifest.defaultConfig, "defaultConfig should exist");
      assert.ok(mod.manifest.defaultConfig.buttonText, "defaultConfig.buttonText should exist");
    });
  });

  describe("tools export", () => {
    it("exports tools as a function", () => {
      assert.equal(typeof mod.tools, "function", "tools should be a function");
    });

    it("tools(sdk) returns an array", () => {
      const sdk = makeSdk();
      const toolList = mod.tools(sdk);
      assert.ok(Array.isArray(toolList), "tools(sdk) should return an array");
    });

    it("returns 3 tools", () => {
      const sdk = makeSdk();
      const toolList = mod.tools(sdk);
      assert.equal(toolList.length, 3, "should have 3 tools");
    });

    it("all tools have required fields: name, description, execute", () => {
      const sdk = makeSdk();
      const toolList = mod.tools(sdk);
      for (const tool of toolList) {
        assert.ok(tool.name, `tool.name must exist (got: ${JSON.stringify(tool.name)})`);
        assert.ok(tool.description, `tool "${tool.name}" must have description`);
        assert.equal(typeof tool.execute, "function", `tool "${tool.name}" must have execute function`);
      }
    });

    it("tool names match expected set", () => {
      const sdk = makeSdk();
      const names = mod.tools(sdk).map((t) => t.name);
      assert.ok(names.includes("ton_bridge_open"), "should have ton_bridge_open");
      assert.ok(names.includes("ton_bridge_about"), "should have ton_bridge_about");
      assert.ok(names.includes("ton_bridge_custom_message"), "should have ton_bridge_custom_message");
    });
  });

  describe("ton_bridge_open", () => {
    it("returns success when sendMessage succeeds", async () => {
      let capturedChatId, capturedText;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text) => {
            capturedChatId = chatId;
            capturedText = text;
            return 55;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      const result = await tool.execute(
        { chatId: "111" },
        makeContext({ chatId: 222 })
      );

      assert.equal(result.success, true);
      assert.equal(result.data.message_id, 55);
      assert.equal(result.data.chat_id, "111");
      assert.equal(capturedChatId, "111");
      assert.ok(capturedText, "message text should be provided");
    });

    it("requires chatId parameter in schema", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      assert.ok(tool.parameters?.required?.includes("chatId"), "chatId should be required");
    });

    it("uses explicit chatId param and does not serialize circular context", async () => {
      let capturedChatId;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId) => {
            capturedChatId = chatId;
            return 55;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      const result = await tool.execute(
        { chatId: "chat-123" },
        makeCircularContext({ chatId: undefined })
      );

      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "chat-123");
      assert.equal(capturedChatId, "chat-123");
    });

    it("uses custom message when provided", async () => {
      let capturedText;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text) => {
            capturedText = text;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789", message: "Custom text" }, makeContext());
      assert.ok(capturedText.startsWith("Custom text"), "message should start with custom text");
    });

    it("uses custom buttonText when provided", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789", buttonText: "Open Bridge" }, makeContext());
      assert.ok(
        capturedOpts?.inlineKeyboard?.[0]?.[0]?.text === "Open Bridge",
        "inline keyboard button should have custom button text"
      );
    });

    it("falls back to sdk.pluginConfig.buttonText when no buttonText param", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        pluginConfig: { buttonText: "My Bridge Button", startParam: "" },
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789" }, makeContext());
      assert.ok(
        capturedOpts?.inlineKeyboard?.[0]?.[0]?.text === "My Bridge Button",
        "inline keyboard button should have config button text"
      );
    });

    it("passes inlineKeyboard with TON Bridge URL button to sendMessage", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789" }, makeContext());
      assert.ok(capturedOpts, "opts should be passed to sendMessage");
      assert.ok(capturedOpts.inlineKeyboard, "opts should have inlineKeyboard");
      assert.ok(Array.isArray(capturedOpts.inlineKeyboard), "inlineKeyboard should be an array");
      const button = capturedOpts.inlineKeyboard[0][0];
      assert.ok(button, "should have at least one button in first row");
      assert.ok(button.url, "button should have a url property");
      assert.ok(button.url.includes("TONBridge_robot"), `button url should include Mini App link, got: ${button.url}`);
    });

    it("returns failure when sendMessage throws", async () => {
      const sdk = makeSdk({
        telegram: {
          sendMessage: async () => { throw new Error("Telegram error"); },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      const result = await tool.execute({ chatId: "123456789" }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("falls back to current context chatId when chatId param is missing", async () => {
      let capturedChatId;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId) => {
            capturedChatId = chatId;
            return 55;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      const result = await tool.execute({}, makeContext({ chatId: 111 }));
      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "111");
      assert.equal(capturedChatId, "111");
    });

    it("returns success when context is undefined and chatId param is provided", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      const result = await tool.execute({ chatId: "123456789" }, undefined);
      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "123456789");
    });
  });

  describe("ton_bridge_about", () => {
    it("returns success when sendMessage succeeds", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      const result = await tool.execute({ chatId: "123456789" }, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.message_id != null);
      assert.equal(result.data.chat_id, "123456789");
    });

    it("requires chatId parameter in schema", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      assert.ok(tool.parameters?.required?.includes("chatId"), "chatId should be required");
    });

    it("uses explicit chatId param and does not serialize circular context", async () => {
      let capturedChatId;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId) => {
            capturedChatId = chatId;
            return 66;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      const result = await tool.execute(
        { chatId: "chat-456" },
        makeCircularContext({ chatId: undefined })
      );

      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "chat-456");
      assert.equal(capturedChatId, "chat-456");
    });

    it("message contains TON Bridge info", async () => {
      let capturedText;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text) => {
            capturedText = text;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      await tool.execute({ chatId: "123456789" }, makeContext());
      assert.ok(capturedText.toLowerCase().includes("bridge"), "about message should mention bridge");
    });

    it("passes inlineKeyboard with URL button to sendMessage", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      await tool.execute({ chatId: "123456789" }, makeContext());
      assert.ok(capturedOpts?.inlineKeyboard, "opts should have inlineKeyboard");
      const button = capturedOpts.inlineKeyboard[0][0];
      assert.ok(button.url, "button should have a url property");
      assert.ok(button.url.includes("TONBridge_robot"), `button url should include Mini App link, got: ${button.url}`);
    });

    it("returns failure when sendMessage throws", async () => {
      const sdk = makeSdk({
        telegram: {
          sendMessage: async () => { throw new Error("network error"); },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      const result = await tool.execute({ chatId: "123456789" }, makeContext());
      assert.equal(result.success, false);
    });

    it("falls back to current context chatId when chatId param is missing", async () => {
      let capturedChatId;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId) => {
            capturedChatId = chatId;
            return 66;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      const result = await tool.execute({}, makeContext({ chatId: 111 }));
      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "111");
      assert.equal(capturedChatId, "111");
    });
  });

  describe("ton_bridge_custom_message", () => {
    it("sends customMessage as text", async () => {
      let capturedText, capturedOpts;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedText = text;
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      await tool.execute({ chatId: "123456789", customMessage: "Hello TON!" }, makeContext());
      assert.ok(capturedText.startsWith("Hello TON!"), "message should start with custom message");
      assert.ok(capturedOpts?.inlineKeyboard?.[0]?.[0]?.url?.includes("TONBridge_robot"), "inline keyboard button url should include Mini App link");
    });

    it("returns success with message_id and chat_id", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      const result = await tool.execute(
        { chatId: "999", customMessage: "Bridge now" },
        makeContext({ chatId: undefined })
      );
      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "999");
      assert.equal(result.data.message_id, 42);
    });

    it("uses explicit chatId param and does not serialize circular context", async () => {
      let capturedChatId;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId) => {
            capturedChatId = chatId;
            return 77;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      const result = await tool.execute(
        { chatId: "chat-789", customMessage: "Bridge now" },
        makeCircularContext({ chatId: undefined })
      );

      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "chat-789");
      assert.equal(capturedChatId, "chat-789");
    });

    it("accepts dispatcher-wrapped params for chatId and customMessage", async () => {
      let capturedChatId, capturedText;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text) => {
            capturedChatId = chatId;
            capturedText = text;
            return 88;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      const result = await tool.execute(
        { params: { chatId: "wrapped-chat", customMessage: "Wrapped message" } },
        makeContext({ chatId: undefined })
      );

      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "wrapped-chat");
      assert.equal(capturedChatId, "wrapped-chat");
      assert.equal(capturedText, "Wrapped message");
    });

    it("returns failure when sendMessage throws", async () => {
      const sdk = makeSdk({
        telegram: {
          sendMessage: async () => { throw new Error("flood"); },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      const result = await tool.execute({ chatId: "123456789", customMessage: "test" }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("falls back to current context chatId when chatId param is missing", async () => {
      let capturedChatId;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId) => {
            capturedChatId = chatId;
            return 77;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      const result = await tool.execute({ customMessage: "test" }, makeContext({ chatId: 111 }));
      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, "111");
      assert.equal(capturedChatId, "111");
    });

    it("uses chatId and customMessage parameters as required", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      assert.ok(tool.parameters?.required?.includes("chatId"), "chatId should be required");
      assert.ok(tool.parameters?.required?.includes("customMessage"), "customMessage should be required");
    });

    it("falls back to sdk.pluginConfig.customMessage when customMessage param is missing", async () => {
      let capturedText;
      const sdk = makeSdk({
        pluginConfig: { buttonText: "TON Bridge No1", startParam: "", customMessage: "Config fallback message" },
        telegram: {
          sendMessage: async (chatId, text) => {
            capturedText = text;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      await tool.execute({ chatId: "123456789" }, makeContext());
      assert.ok(capturedText.startsWith("Config fallback message"), "message should start with config fallback");
    });

    it("falls back to default message when both customMessage param and pluginConfig.customMessage are missing", async () => {
      let capturedText;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text) => {
            capturedText = text;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      const result = await tool.execute({ chatId: "123456789" }, makeContext());
      assert.equal(result.success, true, "should succeed even without customMessage param");
      assert.ok(capturedText, "should send a non-empty fallback message");
      assert.ok(capturedText.toLowerCase().includes("bridge"), "fallback message should mention bridge");
    });
  });

  describe("inline keyboard URL button", () => {
    it("button text matches configured buttonText", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        pluginConfig: { buttonText: "🚀 TON Bridge", startParam: "" },
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789" }, makeContext());
      assert.equal(capturedOpts?.inlineKeyboard?.[0]?.[0]?.text, "🚀 TON Bridge", "button text should include emoji when configured");
    });

    it("button text works without emoji", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789", buttonText: "TON Bridge" }, makeContext());
      assert.equal(capturedOpts?.inlineKeyboard?.[0]?.[0]?.text, "TON Bridge", "button text should work without emoji");
    });

    it("inline keyboard has exactly one row with one button", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789" }, makeContext());
      assert.equal(capturedOpts.inlineKeyboard.length, 1, "should have one row");
      assert.equal(capturedOpts.inlineKeyboard[0].length, 1, "should have one button in the row");
    });
  });

  describe("startParam URL building", () => {
    it("appends startParam to URL in button when set", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        pluginConfig: { buttonText: "Bridge", startParam: "myref" },
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789" }, makeContext());
      const buttonUrl = capturedOpts?.inlineKeyboard?.[0]?.[0]?.url;
      assert.ok(buttonUrl?.includes("myref"), `button url should include startParam, got: ${buttonUrl}`);
    });

    it("does not append startParam when empty", async () => {
      let capturedOpts;
      const sdk = makeSdk({
        pluginConfig: { buttonText: "Bridge", startParam: "" },
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedOpts = opts;
            return 1;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      await tool.execute({ chatId: "123456789" }, makeContext());
      const buttonUrl = capturedOpts?.inlineKeyboard?.[0]?.[0]?.url;
      assert.ok(buttonUrl?.includes("startapp"), `button url should include base URL ending with 'startapp'`);
      assert.ok(!buttonUrl?.includes("startapp="), `button url should not have startParam appended, got: ${buttonUrl}`);
    });
  });
});
