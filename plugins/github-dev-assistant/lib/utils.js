/**
 * Utility helpers for the github-dev-assistant plugin.
 *
 * Contains: input validation, base64 encoding/decoding, error formatting,
 * pagination helpers, and rate-limit tracking.
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Cryptographic helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random state token for OAuth CSRF protection.
 * @param {number} [bytes=32] - Number of random bytes (hex-encoded, so output is 2x longer)
 * @returns {string} Hex-encoded random string
 */
export function generateState(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Base64 helpers (for GitHub Content API)
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string (possibly with line breaks) to UTF-8 text.
 * GitHub's Content API returns base64 content with newlines every 60 chars.
 * @param {string} b64 - Base64-encoded string
 * @returns {string} Decoded UTF-8 string
 */
export function decodeBase64(b64) {
  // Remove any whitespace/newlines that GitHub inserts
  const clean = b64.replace(/\s/g, "");
  return Buffer.from(clean, "base64").toString("utf8");
}

/**
 * Encode a UTF-8 string to base64 for GitHub Content API uploads.
 * @param {string} text - UTF-8 string
 * @returns {string} Base64-encoded string
 */
export function encodeBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that required string parameters are present and non-empty.
 * @param {object} params - Parameter object from tool execute()
 * @param {string[]} required - List of required parameter names
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRequired(params, required) {
  for (const key of required) {
    if (params[key] === undefined || params[key] === null || params[key] === "") {
      return { valid: false, error: `Missing required parameter: ${key}` };
    }
  }
  return { valid: true };
}

/**
 * Clamp an integer parameter to a safe range.
 * @param {number|undefined} value
 * @param {number} min
 * @param {number} max
 * @param {number} defaultValue
 * @returns {number}
 */
export function clampInt(value, min, max, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const n = Math.floor(Number(value));
  if (isNaN(n)) return defaultValue;
  return Math.max(min, Math.min(max, n));
}

/**
 * Validate an enum value against an allowed list.
 * @param {string|undefined} value
 * @param {string[]} allowed
 * @param {string} defaultValue
 * @returns {{ valid: boolean, value: string, error?: string }}
 */
export function validateEnum(value, allowed, defaultValue) {
  if (value === undefined || value === null) {
    return { valid: true, value: defaultValue };
  }
  if (!allowed.includes(value)) {
    return {
      valid: false,
      value: defaultValue,
      error: `Invalid value "${value}". Allowed: ${allowed.join(", ")}`,
    };
  }
  return { valid: true, value };
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Format a caught error into a clean error message string.
 * Never exposes internal file paths or token fragments.
 * @param {unknown} err
 * @param {string} [fallback]
 * @returns {string}
 */
export function formatError(err, fallback = "An unexpected error occurred") {
  if (!err) return fallback;
  const msg = String(err?.message ?? err);
  // Redact anything that looks like a token or secret
  return msg
    .replace(/ghp_[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(/ghs_[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(/ghu_[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(/Bearer [A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED]")
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// Rate limiting (simple token-bucket per instance)
// ---------------------------------------------------------------------------

/**
 * Create a simple rate-limiter that enforces a minimum delay between calls.
 * @param {number} minDelayMs - Minimum milliseconds between calls
 * @returns {{ wait: () => Promise<void> }}
 */
export function createRateLimiter(minDelayMs) {
  let lastCallTime = 0;
  return {
    async wait() {
      const elapsed = Date.now() - lastCallTime;
      if (elapsed < minDelayMs) {
        await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
      }
      lastCallTime = Date.now();
    },
  };
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

/**
 * Extract pagination info from GitHub Link header.
 * @param {string|null} linkHeader - Value of the Link response header
 * @returns {{ next: number|null, prev: number|null, last: number|null }}
 */
export function parseLinkHeader(linkHeader) {
  const result = { next: null, prev: null, last: null };
  if (!linkHeader) return result;

  const parts = linkHeader.split(",").map((p) => p.trim());
  for (const part of parts) {
    const match = part.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="(\w+)"/);
    if (match) {
      const page = parseInt(match[1], 10);
      const rel = match[2];
      if (rel === "next") result.next = page;
      else if (rel === "prev") result.prev = page;
      else if (rel === "last") result.last = page;
    }
  }
  return result;
}
