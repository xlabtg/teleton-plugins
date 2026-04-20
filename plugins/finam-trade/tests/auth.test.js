import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { FinamAuth } from "../src/auth.js";
import { FinamGrpcJwtRenewal, normalizeGrpcTarget } from "../src/grpc.js";

function jwtWithExp(exp) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createSdk(secret = "test-secret") {
  const calls = [];
  return {
    calls,
    secrets: {
      require: async (name) => {
        calls.push(["require", name]);
        return secret;
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

test("FinamAuth gets FINAM_SECRET through sdk.secrets.require and reuses a valid JWT", async () => {
  const token = jwtWithExp(2_000);
  const requests = [];
  const auth = new FinamAuth({
    sdk: createSdk(),
    apiBase: "https://api.finam.ru",
    now: () => 1_000_000,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ token });
    },
  });

  assert.equal(await auth.getToken(), token);
  assert.equal(await auth.getToken(), token);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.finam.ru/v1/sessions");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), { secret: "test-secret" });
});

test("FinamAuth refreshes a JWT that is inside the refresh window", async () => {
  const tokens = [jwtWithExp(1_030), jwtWithExp(2_000)];
  const auth = new FinamAuth({
    sdk: createSdk(),
    apiBase: "https://api.finam.ru",
    now: () => 1_000_000,
    fetchImpl: async () => Response.json({ token: tokens.shift() }),
  });

  assert.equal(await auth.getToken(), jwtWithExp(1_030));
  assert.equal(await auth.getToken(), jwtWithExp(2_000));
});

test("FinamAuth fetches token details without exposing the secret", async () => {
  const token = jwtWithExp(2_000);
  const requests = [];
  const auth = new FinamAuth({
    sdk: createSdk(),
    apiBase: "https://api.finam.ru",
    now: () => 1_000_000,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/sessions")) return Response.json({ token });
      return Response.json({ account_ids: ["ACC1"], readonly: false });
    },
  });

  const details = await auth.getTokenDetails();

  assert.deepEqual(details.account_ids, ["ACC1"]);
  assert.equal(requests[1].url, "https://api.finam.ru/v1/sessions/details");
  assert.deepEqual(JSON.parse(requests[1].init.body), { token });
});

test("FinamAuth can accept fresh JWTs from the gRPC renewal stream", async () => {
  const stream = new EventEmitter();
  let cancelled = false;
  stream.cancel = () => {
    cancelled = true;
  };

  const calls = [];
  class AuthService {
    constructor(target, credentials) {
      calls.push(["client", target, credentials]);
    }

    SubscribeJwtRenewal(request) {
      calls.push(["subscribe", request]);
      return stream;
    }

    close() {
      calls.push(["close"]);
    }
  }

  const fakeGrpc = {
    credentials: {
      createSsl: () => "ssl-credentials",
    },
    loadPackageDefinition: () => ({
      grpc: { tradeapi: { v1: { auth: { AuthService } } } },
    }),
  };
  const fakeProtoLoader = {
    loadSync: (protoPath, options) => {
      calls.push(["load", protoPath, options.keepCase]);
      return {};
    },
  };
  const token = jwtWithExp(2_000);
  const auth = new FinamAuth({
    sdk: createSdk(),
    now: () => 1_000_000,
    fetchImpl: async () => {
      throw new Error("REST auth should not be called when the gRPC token is fresh.");
    },
    grpcRenewal: new FinamGrpcJwtRenewal({
      grpcBase: "api.finam.ru:443",
      grpcLib: fakeGrpc,
      protoLoaderLib: fakeProtoLoader,
    }),
  });

  assert.equal(await auth.startJwtRenewal(), true);
  stream.emit("data", { token });

  assert.equal(await auth.getToken(), token);
  assert.deepEqual(calls[1], ["client", "api.finam.ru:443", "ssl-credentials"]);
  assert.deepEqual(calls[2], ["subscribe", { secret: "test-secret" }]);

  auth.stopJwtRenewal();
  assert.equal(cancelled, true);
  assert.deepEqual(calls.at(-1), ["close"]);
});

test("normalizeGrpcTarget keeps only a safe gRPC authority", () => {
  assert.equal(normalizeGrpcTarget("api.finam.ru:443"), "api.finam.ru:443");
  assert.equal(normalizeGrpcTarget("https://api.finam.ru:443/v1/auth?debug=1#renewal"), "api.finam.ru:443");
  assert.equal(normalizeGrpcTarget(`https://api.finam.ru:443/${"#".repeat(10_000)}`), "api.finam.ru:443");

  assert.throws(() => normalizeGrpcTarget("http://api.finam.ru:443"), /HTTPS/);
  assert.throws(() => normalizeGrpcTarget("https://[::1]:443"), /local|private/i);
});
