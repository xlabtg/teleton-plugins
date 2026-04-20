import assert from "node:assert/strict";
import test from "node:test";

import { FinamClient, RateLimiter } from "../src/client.js";

test("FinamClient attaches bearer auth and reauthenticates once on 401", async () => {
  const calls = [];
  const auth = {
    forceRefreshes: 0,
    clearToken() {},
    getToken: async ({ force = false } = {}) => {
      if (force) auth.forceRefreshes += 1;
      return force ? "second-token" : "first-token";
    },
  };
  const client = new FinamClient({
    auth,
    apiBase: "https://api.finam.ru",
    rateLimitPerMinute: 200,
    timeoutMs: 1000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return Response.json({ message: "expired" }, { status: 401 });
      return Response.json({ ok: true });
    },
  });

  const data = await client.get("/v1/usage");

  assert.deepEqual(data, { ok: true });
  assert.equal(auth.forceRefreshes, 1);
  assert.equal(calls[0].init.headers.Authorization, "Bearer first-token");
  assert.equal(calls[1].init.headers.Authorization, "Bearer second-token");
});

test("RateLimiter queues when the 200-per-minute window is exhausted", async () => {
  let now = 0;
  const waits = [];
  const limiter = new RateLimiter({
    limit: 2,
    windowMs: 60_000,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });

  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();

  assert.deepEqual(waits, [60_000]);
});
