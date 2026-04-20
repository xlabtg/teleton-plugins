import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeHttpsUrl,
  decimalValue,
  moneyValue,
  normalizeOrderSide,
  normalizeOrderType,
  normalizeTpSpreadMeasure,
  normalizeValidBefore,
  normalizeSymbol,
  parseJwtExpiration,
  redactSensitive,
} from "../src/utils.js";

function jwtWithPayload(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("parseJwtExpiration reads exp from a JWT payload in milliseconds", () => {
  assert.equal(parseJwtExpiration(jwtWithPayload({ exp: 1_777 })), 1_777_000);
  assert.equal(parseJwtExpiration("not-a-jwt"), null);
});

test("normalizers accept friendly values and emit Finam enum values", () => {
  assert.equal(normalizeSymbol("sber@misx"), "SBER@MISX");
  assert.equal(normalizeOrderSide("buy"), "SIDE_BUY");
  assert.equal(normalizeOrderSide("SIDE_SELL"), "SIDE_SELL");
  assert.equal(normalizeOrderType("stop_limit"), "ORDER_TYPE_STOP_LIMIT");
  assert.equal(normalizeValidBefore("gtc"), "VALID_BEFORE_GOOD_TILL_CANCEL");
  assert.equal(normalizeTpSpreadMeasure("points"), "TP_SPREAD_MEASURE_VALUE");
  assert.throws(() => normalizeSymbol("SBER"), /ticker@mic/i);
});

test("decimalValue and moneyValue preserve API decimal strings", () => {
  assert.deepEqual(decimalValue("150.50"), { value: "150.50" });
  assert.equal(decimalValue(null), undefined);
  assert.equal(moneyValue({ units: "12", nanos: 250_000_000 }), 12.25);
});

test("redactSensitive removes secrets and authorization values recursively", () => {
  assert.deepEqual(
    redactSensitive({
      Authorization: "Bearer token",
      nested: { secret: "abc", safe: "ok" },
    }),
    {
      Authorization: "[REDACTED]",
      nested: { secret: "[REDACTED]", safe: "ok" },
    }
  );
});

test("assertSafeHttpsUrl rejects non-HTTPS and local network targets", () => {
  assertSafeHttpsUrl("https://api.finam.ru");
  assert.throws(() => assertSafeHttpsUrl("http://api.finam.ru"), /HTTPS/);
  assert.throws(() => assertSafeHttpsUrl("https://localhost"), /local/i);
  assert.throws(() => assertSafeHttpsUrl("https://[::1]"), /local|private/i);
  assert.throws(() => assertSafeHttpsUrl("https://[fc00::1]"), /local|private/i);
  assert.throws(() => assertSafeHttpsUrl("https://[fd00::1]"), /local|private/i);
  assert.throws(() => assertSafeHttpsUrl("https://[fe80::1]"), /local|private/i);
  assert.throws(() => assertSafeHttpsUrl("https://[::ffff:127.0.0.1]"), /local|private/i);
});
