/**
 * Unit tests for formatError() secret redaction.
 *
 * Verifies that all known secret patterns are redacted from error messages
 * before they are returned to callers.
 *
 * Uses Node's built-in test runner (node:test). No network access required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatError } from "../lib/utils.js";

describe("formatError — existing redactions", () => {
  it("redacts ghp_ tokens", () => {
    const result = formatError(new Error("token ghp_ABCdef123456 is invalid"));
    assert.ok(!result.includes("ghp_"), `Expected ghp_ to be redacted, got: ${result}`);
    assert.ok(result.includes("[REDACTED]"));
  });

  it("redacts ghs_ tokens", () => {
    const result = formatError(new Error("server token ghs_XYZabc789 rejected"));
    assert.ok(!result.includes("ghs_"), `Expected ghs_ to be redacted, got: ${result}`);
    assert.ok(result.includes("[REDACTED]"));
  });

  it("redacts ghu_ tokens", () => {
    const result = formatError(new Error("user token ghu_DEF456 not found"));
    assert.ok(!result.includes("ghu_"), `Expected ghu_ to be redacted, got: ${result}`);
    assert.ok(result.includes("[REDACTED]"));
  });

  it("redacts Bearer tokens", () => {
    const result = formatError(new Error("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc failed"));
    assert.ok(!result.includes("eyJhbGciOiJIUzI1NiJ9.abc"), `Expected Bearer token to be redacted, got: ${result}`);
    assert.ok(result.includes("Bearer [REDACTED]"));
  });
});

describe("formatError — OAuth token (gho_)", () => {
  it("redacts gho_ OAuth App tokens", () => {
    const result = formatError(new Error("OAuth token gho_OAUTH123abc is expired"));
    assert.ok(!result.includes("gho_"), `Expected gho_ to be redacted, got: ${result}`);
    assert.ok(result.includes("[REDACTED]"));
  });
});

describe("formatError — fine-grained PAT (github_pat_)", () => {
  it("redacts github_pat_ fine-grained PATs", () => {
    const result = formatError(new Error("token github_pat_11ABCDEF_someRandomChars123 is invalid"));
    assert.ok(!result.includes("github_pat_"), `Expected github_pat_ to be redacted, got: ${result}`);
    assert.ok(result.includes("[REDACTED]"));
  });
});

describe("formatError — private key headers", () => {
  it("redacts -----BEGIN RSA PRIVATE KEY-----", () => {
    const result = formatError(new Error("key: -----BEGIN RSA PRIVATE KEY-----\nMIIEo..."));
    assert.ok(!result.includes("-----BEGIN RSA PRIVATE KEY-----"), `Expected private key header to be redacted, got: ${result}`);
    assert.ok(result.includes("[REDACTED PRIVATE KEY]"));
  });

  it("redacts -----BEGIN PRIVATE KEY-----", () => {
    const result = formatError(new Error("embedded -----BEGIN PRIVATE KEY----- in error"));
    assert.ok(!result.includes("-----BEGIN PRIVATE KEY-----"), `Expected private key header to be redacted, got: ${result}`);
    assert.ok(result.includes("[REDACTED PRIVATE KEY]"));
  });
});

describe("formatError — generic key/secret/password patterns", () => {
  it("redacts api_key=<value>", () => {
    const result = formatError(new Error("request failed: api_key=supersecret123"));
    assert.ok(!result.includes("supersecret123"), `Expected api_key value to be redacted, got: ${result}`);
  });

  it("redacts apikey=<value>", () => {
    const result = formatError(new Error("request failed: apikey=mysecretvalue"));
    assert.ok(!result.includes("mysecretvalue"), `Expected apikey value to be redacted, got: ${result}`);
  });

  it("redacts secret=<value>", () => {
    const result = formatError(new Error("auth error: secret=topsecret99"));
    assert.ok(!result.includes("topsecret99"), `Expected secret value to be redacted, got: ${result}`);
  });

  it("redacts password=<value>", () => {
    const result = formatError(new Error("login failed: password=hunter2"));
    assert.ok(!result.includes("hunter2"), `Expected password value to be redacted, got: ${result}`);
  });

  it("redacts SECRET: <value> (colon separator, case-insensitive)", () => {
    const result = formatError(new Error("SECRET: myTopSecretValue"));
    assert.ok(!result.includes("myTopSecretValue"), `Expected SECRET value to be redacted, got: ${result}`);
  });
});

describe("formatError — safe strings are not over-redacted", () => {
  it("plain error message is not altered", () => {
    const result = formatError(new Error("File not found"));
    assert.equal(result, "File not found");
  });

  it("undefined err returns fallback", () => {
    assert.equal(formatError(undefined), "An unexpected error occurred");
  });

  it("null err returns fallback", () => {
    assert.equal(formatError(null), "An unexpected error occurred");
  });

  it("message longer than 500 chars is truncated", () => {
    const long = "x".repeat(600);
    const result = formatError(new Error(long));
    assert.equal(result.length, 500);
  });
});
