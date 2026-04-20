import { assertSafeHttpsUrl, buildUrl, formatError, parseJwtExpiration } from "./utils.js";

const DEFAULT_REFRESH_SKEW_MS = 60_000;
const FALLBACK_TOKEN_TTL_MS = 50 * 60_000;

export class FinamAuth {
  constructor({
    sdk,
    apiBase = "https://api.finam.ru",
    fetchImpl = globalThis.fetch,
    now = Date.now,
    refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
    timeoutMs = 30_000,
  } = {}) {
    assertSafeHttpsUrl(apiBase);
    this.sdk = sdk ?? {};
    this.apiBase = apiBase;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.refreshSkewMs = refreshSkewMs;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  clearToken() {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async getToken({ force = false } = {}) {
    if (!force && this.token && this.tokenExpiresAt - this.now() > this.refreshSkewMs) {
      return this.token;
    }

    const secret = await this.requireSecret();
    const data = await this.postJson("/v1/sessions", { secret });
    if (!data?.token) throw new Error("Finam auth response did not include a token.");

    this.token = data.token;
    this.tokenExpiresAt = parseJwtExpiration(data.token) ?? (this.now() + FALLBACK_TOKEN_TTL_MS);
    return this.token;
  }

  async getTokenDetails() {
    const token = await this.getToken();
    return this.postJson("/v1/sessions/details", { token });
  }

  async requireSecret() {
    const secrets = this.sdk?.secrets;
    let secret = null;
    if (typeof secrets?.require === "function") {
      secret = await secrets.require("FINAM_SECRET");
    } else if (typeof secrets?.get === "function") {
      secret = (await secrets.get("FINAM_SECRET")) ?? (await secrets.get("finam_secret"));
    }

    if (!secret) {
      throw new Error("FINAM_SECRET is required. Add a Finam API secret to Teleton secrets.");
    }
    return secret;
  }

  async postJson(path, body) {
    const url = buildUrl(this.apiBase, path);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const data = await readJsonOrText(res);
    if (!res.ok) {
      throw new Error(`Finam auth error ${res.status}: ${formatError(data?.message ?? data)}`);
    }
    return data;
  }
}

async function readJsonOrText(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
