import assert from "node:assert/strict";
import test from "node:test";

import { manifest, tools } from "../index.js";

function jwtWithExp(exp) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createSdk() {
  return {
    pluginConfig: {
      api_base: "https://api.finam.ru",
      rate_limit_per_minute: 200,
      timeout_ms: 1000,
    },
    secrets: {
      require: async () => "test-secret",
    },
    db: null,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

test("finam-trade exports every issue-required tool without duplicates", () => {
  const names = tools(createSdk()).map((tool) => tool.name);
  assert.equal(manifest.id, "finam-trade");
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 21);
  for (const name of [
    "finam_get_accounts",
    "finam_get_positions",
    "finam_place_order",
    "finam_cancel_order",
    "finam_get_bars",
    "finam_get_instrument",
    "finam_get_instruments_list",
    "finam_generate_report",
    "finam_get_usage",
  ]) {
    assert.ok(names.includes(name), `${name} is exported`);
  }
});

test("finam_place_order maps friendly params to the REST request body", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/v1/sessions")) {
      return Response.json({ token: jwtWithExp(2_000) });
    }
    return Response.json({ order_id: "ORDER1" });
  });

  const tool = tools(createSdk()).find((candidate) => candidate.name === "finam_place_order");
  const result = await tool.execute({
    account_id: "ACC1",
    symbol: "sber@misx",
    quantity: "10",
    side: "buy",
    type: "limit",
    limit_price: "150.50",
    time_in_force: "day",
  });

  assert.equal(result.success, true);
  assert.equal(requests[1].url, "https://api.finam.ru/v1/accounts/ACC1/orders");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    symbol: "SBER@MISX",
    quantity: { value: "10" },
    side: "SIDE_BUY",
    type: "ORDER_TYPE_LIMIT",
    time_in_force: "TIME_IN_FORCE_DAY",
    limit_price: { value: "150.50" },
  });
});
