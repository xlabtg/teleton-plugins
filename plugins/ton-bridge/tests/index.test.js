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
      let capturedChatId, capturedText, capturedOpts;
      const sdk = makeSdk({
        telegram: {
          sendMessage: async (chatId, text, opts) => {
            capturedChatId = chatId;
            capturedText = text;
            capturedOpts = opts;
            return 55;
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      const result = await tool.execute({}, makeContext({ chatId: 111 }));

      assert.equal(result.success, true);
      assert.equal(result.data.message_id, 55);
      assert.equal(result.data.chat_id, 111);
      assert.equal(capturedChatId, 111);
      assert.ok(capturedText, "message text should be provided");
      assert.ok(capturedOpts.inlineKeyboard, "inline keyboard should be included");
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
      await tool.execute({ message: "Custom text" }, makeContext());
      assert.equal(capturedText, "Custom text");
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
      await tool.execute({ buttonText: "Open Bridge" }, makeContext());
      assert.equal(capturedOpts.inlineKeyboard[0][0].text, "Open Bridge");
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
      await tool.execute({}, makeContext());
      assert.equal(capturedOpts.inlineKeyboard[0][0].text, "My Bridge Button");
    });

    it("button URL points to TON Bridge", async () => {
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
      await tool.execute({}, makeContext());
      const url = capturedOpts.inlineKeyboard[0][0].url;
      assert.ok(url.includes("TONBridge_robot"), `URL should reference TONBridge_robot, got: ${url}`);
    });

    it("returns failure when sendMessage throws", async () => {
      const sdk = makeSdk({
        telegram: {
          sendMessage: async () => { throw new Error("Telegram error"); },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_open");
      const result = await tool.execute({}, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });

  describe("ton_bridge_about", () => {
    it("returns success when sendMessage succeeds", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      const result = await tool.execute({}, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.message_id != null);
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
      await tool.execute({}, makeContext());
      assert.ok(capturedText.toLowerCase().includes("bridge"), "about message should mention bridge");
    });

    it("returns failure when sendMessage throws", async () => {
      const sdk = makeSdk({
        telegram: {
          sendMessage: async () => { throw new Error("network error"); },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_about");
      const result = await tool.execute({}, makeContext());
      assert.equal(result.success, false);
    });
  });

  describe("ton_bridge_custom_message", () => {
    it("sends customMessage as text", async () => {
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
      await tool.execute({ customMessage: "Hello TON!" }, makeContext());
      assert.equal(capturedText, "Hello TON!");
    });

    it("returns success with message_id and chat_id", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      const result = await tool.execute({ customMessage: "Bridge now" }, makeContext({ chatId: 999 }));
      assert.equal(result.success, true);
      assert.equal(result.data.chat_id, 999);
      assert.equal(result.data.message_id, 42);
    });

    it("returns failure when sendMessage throws", async () => {
      const sdk = makeSdk({
        telegram: {
          sendMessage: async () => { throw new Error("flood"); },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      const result = await tool.execute({ customMessage: "test" }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("uses customMessage parameter as required", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_bridge_custom_message");
      assert.ok(tool.parameters?.required?.includes("customMessage"), "customMessage should be required");
    });
  });

  describe("startParam URL building", () => {
    it("appends startParam to URL when set", async () => {
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
      await tool.execute({}, makeContext());
      const url = capturedOpts.inlineKeyboard[0][0].url;
      assert.ok(url.includes("myref"), `URL should include startParam, got: ${url}`);
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
      await tool.execute({}, makeContext());
      const url = capturedOpts.inlineKeyboard[0][0].url;
      // URL should be the base URL without extra params appended via =
      assert.ok(url.endsWith("startapp"), `URL without startParam should end with 'startapp', got: ${url}`);
    });
  });
});
