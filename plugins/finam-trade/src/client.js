import { buildUrl, formatError, redactSensitive } from "./utils.js";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class FinamApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "FinamApiError";
    this.status = status;
    this.body = body;
  }
}

export class RateLimiter {
  constructor({
    limit = 200,
    windowMs = 60_000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.limit = Math.max(1, Number(limit) || 200);
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
    this.timestamps = [];
    this.queue = Promise.resolve();
  }

  async acquire() {
    const run = this.queue.then(
      () => this.acquireNow(),
      () => this.acquireNow()
    );
    this.queue = run.catch(() => {});
    return run;
  }

  async acquireNow() {
    const cutoff = this.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);

    if (this.timestamps.length >= this.limit) {
      const waitMs = Math.max(0, this.timestamps[0] + this.windowMs - this.now());
      if (waitMs > 0) await this.sleep(waitMs);
      return this.acquireNow();
    }

    this.timestamps.push(this.now());
  }
}

export class FinamClient {
  constructor({
    auth,
    apiBase = "https://api.finam.ru",
    fetchImpl = globalThis.fetch,
    rateLimitPerMinute = 200,
    timeoutMs = 30_000,
    maxRetries = 2,
    retryBaseDelayMs = 250,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    sdk = {},
  } = {}) {
    this.auth = auth;
    this.apiBase = apiBase;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.sleep = sleep;
    this.sdk = sdk;
    this.rateLimiter = new RateLimiter({ limit: rateLimitPerMinute, now, sleep });
  }

  get(path, options = {}) {
    return this.request("GET", path, options);
  }

  post(path, body, options = {}) {
    return this.request("POST", path, { ...options, body });
  }

  delete(path, options = {}) {
    return this.request("DELETE", path, options);
  }

  async request(method, path, { query, body, auth = true } = {}) {
    let reauthenticated = false;
    let forceAuth = false;
    let attempt = 0;

    while (true) {
      try {
        await this.rateLimiter.acquire();
        const token = auth && this.auth ? await this.auth.getToken({ force: forceAuth }) : null;
        forceAuth = false;

        const response = await this.fetchImpl(buildUrl(this.apiBase, path, query), {
          method,
          headers: compactHeaders({
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          }),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const data = await readJsonOrText(response);
        if (response.ok) return data;

        if ((response.status === 401 || response.status === 403) && auth && this.auth && !reauthenticated) {
          this.auth.clearToken?.();
          reauthenticated = true;
          forceAuth = true;
          attempt += 1;
          continue;
        }

        if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
          await this.sleep(this.retryDelay(attempt, response));
          attempt += 1;
          continue;
        }

        throw new FinamApiError(
          `Finam API ${response.status}: ${formatError(data?.message ?? data)}`,
          { status: response.status, body: redactSensitive(data) }
        );
      } catch (err) {
        if (err instanceof FinamApiError) throw err;
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelay(attempt));
          attempt += 1;
          continue;
        }
        throw new FinamApiError(`Finam request failed: ${formatError(err)}`, { body: redactSensitive(err) });
      }
    }
  }

  retryDelay(attempt, response = null) {
    const retryAfter = Number(response?.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return this.retryBaseDelayMs * 2 ** attempt;
  }
}

function compactHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) result[key] = value;
  }
  return result;
}

async function readJsonOrText(response) {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
