import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createVkFullAdminTools } from "../index.js";

function makeStorage() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    delete: (key) => values.delete(key),
    has: (key) => values.has(key),
  };
}

function makeSdk({ userToken = "user-token", communityTokens = { 123: "group-token" }, pluginConfig = {} } = {}) {
  return {
    pluginConfig,
    storage: makeStorage(),
    secrets: {
      get: async (name) => {
        if (name === "vk_user_token") return userToken;
        if (name === "vk_community_tokens") return JSON.stringify(communityTokens);
        return null;
      },
      require: async (name) => {
        if (name === "vk_user_token" && userToken) return userToken;
        if (name === "vk_community_tokens" && communityTokens) return JSON.stringify(communityTokens);
        throw new Error(`${name} missing`);
      },
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

function makeMockVK({ calls, onCall } = {}) {
  return class MockVK {
    constructor(options) {
      this.options = options;
      this.api = {
        call: async (method, params) => {
          calls.push({ token: options.token, method, params });
          if (onCall) return onCall(method, params, options.token);
          if (method === "users.get") return [{ id: 42, first_name: "Ada" }];
          if (method === "groups.isMember") {
            return { member: 1, user_id: 42, is_admin: 1, manager_role: "administrator" };
          }
          if (method === "wall.post") return { post_id: 77 };
          return { ok: 1 };
        },
      };
      this.upload = {
        wallPhoto: async (params) => {
          calls.push({ token: options.token, method: "upload.wallPhoto", params });
          return { toString: () => "photo-123_1" };
        },
      };
    }
  };
}

function getTool(tools, name) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

describe("vk-full-admin", () => {
  it("registers the expected VK administration tools with unique names", () => {
    const calls = [];
    const tools = createVkFullAdminTools(makeSdk(), { VKClass: makeMockVK({ calls }) });
    const names = tools.map((tool) => tool.name);

    assert.equal(names.length, new Set(names).size);
    assert.ok(names.includes("vk_group_wall_post"));
    assert.ok(names.includes("vk_group_ban_user"));
    assert.ok(names.includes("vk_group_msg_send"));
    assert.ok(names.includes("vk_auth_user_url"));
    assert.equal(names.length, 34);
  });

  it("builds a default user OAuth URL without restricted message access", async () => {
    const calls = [];
    const tools = createVkFullAdminTools(makeSdk(), { VKClass: makeMockVK({ calls }) });
    const result = await getTool(tools, "vk_auth_user_url").execute({ client_id: "12345" });

    assert.equal(result.success, true);
    assert.equal(result.data.scopes.includes("messages"), false);

    const url = new URL(result.data.url);
    assert.equal(url.origin, "https://oauth.vk.ru");
    assert.equal(url.searchParams.get("client_id"), "12345");
    assert.equal(url.searchParams.get("scope"), "offline,wall,friends,photos,groups,stats,notifications");
  });

  it("builds OAuth URLs with comma-separated scope names", async () => {
    const calls = [];
    const tools = createVkFullAdminTools(makeSdk(), { VKClass: makeMockVK({ calls }) });
    const result = await getTool(tools, "vk_auth_group_url").execute({
      client_id: "12345",
      group_ids: [123, -456],
    });

    assert.equal(result.success, true);

    const url = new URL(result.data.url);
    assert.equal(url.searchParams.get("scope"), "manage,messages,photos,docs");
    assert.equal(url.searchParams.get("group_ids"), "123,456");
  });

  it("checks admin rights before posting to a community with the community token", async () => {
    const calls = [];
    const tools = createVkFullAdminTools(makeSdk(), { VKClass: makeMockVK({ calls }) });
    const result = await getTool(tools, "vk_group_wall_post").execute({
      owner_id: -123,
      message: "Launch post",
      close_comments: true,
    });

    assert.equal(result.success, true);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["users.get", "groups.isMember", "wall.post"]
    );
    assert.equal(calls[2].token, "group-token");
    assert.equal(calls[2].params.owner_id, -123);
    assert.equal(calls[2].params.from_group, 1);
    assert.equal(calls[2].params.close_comments, 1);
  });

  it("returns a clear rights error when the VK user is not a community manager", async () => {
    const calls = [];
    const VKClass = makeMockVK({
      calls,
      onCall: (method) => {
        if (method === "users.get") return [{ id: 42 }];
        if (method === "groups.isMember") return { member: 1, user_id: 42 };
        if (method === "groups.getById") return [{ id: 123, is_admin: 0 }];
        return { ok: 1 };
      },
    });
    const tools = createVkFullAdminTools(makeSdk(), { VKClass });
    const result = await getTool(tools, "vk_group_wall_post").execute({
      owner_id: -123,
      message: "Should not post",
    });

    assert.equal(result.success, false);
    assert.match(result.error, /Insufficient rights/);
    assert.equal(calls.some((call) => call.method === "wall.post"), false);
  });

  it("omits the manager role parameter when removing community manager rights", async () => {
    const calls = [];
    const tools = createVkFullAdminTools(makeSdk(), { VKClass: makeMockVK({ calls }) });
    const result = await getTool(tools, "vk_group_set_role").execute({
      group_id: 123,
      user_id: 99,
      role: "none",
    });

    assert.equal(result.success, true);
    const editCall = calls.find((call) => call.method === "groups.editManager");
    assert.ok(editCall);
    assert.equal(Object.hasOwn(editCall.params, "role"), false);
  });

  it("does not expose access tokens in formatted VK errors", async () => {
    const calls = [];
    const VKClass = makeMockVK({
      calls,
      onCall: () => {
        const err = new Error("request failed access_token=user-token&token=group-token");
        err.code = 5;
        throw err;
      },
    });
    const tools = createVkFullAdminTools(makeSdk(), { VKClass });
    const result = await getTool(tools, "vk_user_info").execute({});

    assert.equal(result.success, false);
    assert.doesNotMatch(result.error, /user-token/);
    assert.doesNotMatch(result.error, /group-token/);
    assert.match(result.error, /\[redacted\]/);
  });

  it("applies the per-token rate gate before API calls", async () => {
    const calls = [];
    let currentTime = 0;
    let slept = 0;
    const tools = createVkFullAdminTools(
      makeSdk({ pluginConfig: { rate_limit_per_second: 1 } }),
      {
        VKClass: makeMockVK({ calls }),
        now: () => currentTime,
        sleep: async (ms) => {
          slept += ms;
          currentTime += ms;
        },
      }
    );
    await getTool(tools, "vk_user_info").execute({});
    await getTool(tools, "vk_user_info").execute({});

    assert.ok(slept >= 1000);
    assert.equal(calls.filter((call) => call.method === "users.get").length, 2);
  });
});
