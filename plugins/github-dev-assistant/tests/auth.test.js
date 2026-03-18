/**
 * Tests for github_check_auth tool.
 *
 * The github-dev-assistant plugin now uses Personal Access Token (PAT)
 * authentication instead of OAuth. This file tests that the auth check
 * correctly validates the stored token and returns friendly messages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tools } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSdk(token = null, config = {}) {
  return {
    secrets: {
      get: (key) => (key === "github_token" ? token : null),
      set: vi.fn(),
      delete: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: {
      default_branch: "main",
      ...config,
    },
    llm: { confirm: vi.fn() },
  };
}

function findTool(toolList, name) {
  const tool = toolList.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let originalFetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

describe("github_check_auth", () => {
  it("returns not-connected message when no token is set", async () => {
    const sdk = makeSdk(null); // no token
    const toolList = tools(sdk);
    const tool = findTool(toolList, "github_check_auth");

    const result = await tool.execute({});

    expect(result.content).toMatch(/not connected/i);
    expect(result.content).toMatch(/github_token/);
  });

  it("returns authenticated username when token is valid", async () => {
    const sdk = makeSdk("ghp_validtoken");
    const toolList = tools(sdk);
    const tool = findTool(toolList, "github_check_auth");

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ login: "octocat", name: "The Octocat" }),
    });

    const result = await tool.execute({});

    expect(result.content).toMatch(/octocat/);
    expect(result.content).toMatch(/connected/i);
  });

  it("returns token expired message on 401", async () => {
    const sdk = makeSdk("ghp_expiredtoken");
    const toolList = tools(sdk);
    const tool = findTool(toolList, "github_check_auth");

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: "Bad credentials" }),
    });

    const result = await tool.execute({});

    expect(result.content).toMatch(/invalid or expired/i);
    expect(result.content).toMatch(/github_token/);
  });
});

describe("tools() export", () => {
  it("returns 14 tools", () => {
    const sdk = makeSdk("ghp_test");
    const toolList = tools(sdk);
    expect(toolList).toHaveLength(14);
  });

  it("all tools have name, description, parameters, and execute", () => {
    const sdk = makeSdk("ghp_test");
    const toolList = tools(sdk);
    for (const tool of toolList) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.execute).toBe("function");
      expect(tool.parameters).toBeDefined();
    }
  });

  it("all tool names are prefixed with github_", () => {
    const sdk = makeSdk("ghp_test");
    const toolList = tools(sdk);
    for (const tool of toolList) {
      expect(tool.name).toMatch(/^github_/);
    }
  });
});
