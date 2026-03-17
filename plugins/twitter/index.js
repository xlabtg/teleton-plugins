/**
 * Twitter/X plugin — X API v2 read + write
 *
 * Read: Bearer token (post lookup, search, user info, timelines, trends)
 * Write: OAuth 1.0a HMAC-SHA1 (post, like, retweet, follow, bookmark)
 *
 * All credentials configured via sdk.secrets (webui / env vars / config).
 * Required secrets: bearer_token (read), consumer_key + consumer_secret +
 * access_token + access_token_secret (write).
 */

import { createHmac, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// OAuth 1.0a HMAC-SHA1 signing
// ---------------------------------------------------------------------------

function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function buildOAuth1Header(method, url, queryParams, creds) {
  const oauthParams = {
    oauth_consumer_key: creds.consumer_key,
    oauth_token: creds.access_token,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_version: "1.0",
  };

  const allParams = { ...oauthParams };
  for (const [k, v] of Object.entries(queryParams)) {
    allParams[k] = v;
  }

  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  const baseUrl = url.split("?")[0];
  const signatureBase = `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(creds.consumer_secret)}&${percentEncode(creds.access_token_secret)}`;
  const signature = createHmac("sha1", signingKey).update(signatureBase).digest("base64");
  oauthParams.oauth_signature = signature;

  const header = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${header}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTweet(t, includes) {
  const author = includes?.users?.find((u) => u.id === t.author_id) ?? null;
  return {
    id: t.id,
    text: t.text,
    author_id: t.author_id,
    author_name: author?.name ?? null,
    author_username: author?.username ?? null,
    created_at: t.created_at ?? null,
    lang: t.lang ?? null,
    source: t.source ?? null,
    conversation_id: t.conversation_id ?? null,
    metrics: t.public_metrics ?? null,
  };
}

function formatUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    description: u.description ?? null,
    location: u.location ?? null,
    url: u.url ?? null,
    verified: u.verified ?? false,
    verified_type: u.verified_type ?? null,
    profile_image_url: u.profile_image_url ?? null,
    created_at: u.created_at ?? null,
    metrics: u.public_metrics ?? null,
  };
}

// ---------------------------------------------------------------------------
// SDK export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "twitter",
  version: "3.0.0",
  sdkVersion: ">=1.0.0",
  description: "X/Twitter API v2 — read (search, lookup, trends) and write (post, like, retweet, follow) with OAuth 1.0a.",
};

export const tools = (sdk) => {
  // ---------------------------------------------------------------------------
  // Credential helpers — all via sdk.secrets
  // ---------------------------------------------------------------------------

  function loadBearerToken() {
    return sdk.secrets.get("bearer_token") ?? null;
  }

  function loadOAuth1Creds() {
    const consumer_key = sdk.secrets.get("consumer_key");
    const consumer_secret = sdk.secrets.get("consumer_secret");
    const access_token = sdk.secrets.get("access_token");
    const access_token_secret = sdk.secrets.get("access_token_secret");

    if (!consumer_key || !consumer_secret || !access_token || !access_token_secret) {
      throw new Error(
        "OAuth not configured. Set all 4 keys in the webui or via env vars: " +
        "TWITTER_CONSUMER_KEY, TWITTER_CONSUMER_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET"
      );
    }
    return { consumer_key, consumer_secret, access_token, access_token_secret };
  }

  // Cache authenticated user ID (fetched once per session)
  let _cachedUserId = null;

  async function getAuthenticatedUserId() {
    if (_cachedUserId) return _cachedUserId;
    const creds = loadOAuth1Creds();
    const meUrl = `${API_BASE}/2/users/me`;
    const oauthHeader = buildOAuth1Header("GET", meUrl, {}, creds);
    const res = await fetch(meUrl, {
      headers: { Authorization: oauthHeader, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch authenticated user: X API ${res.status}`);
    }
    const me = await res.json();
    _cachedUserId = me.data?.id ?? null;
    if (!_cachedUserId) throw new Error("Could not determine authenticated user ID");
    return _cachedUserId;
  }

  // ---------------------------------------------------------------------------
  // API fetch helpers
  // ---------------------------------------------------------------------------

  const API_BASE = "https://api.x.com";
  const TWEET_FIELDS = "text,author_id,created_at,public_metrics,conversation_id,lang,source,entities";
  const USER_FIELDS = "name,username,description,public_metrics,profile_image_url,verified,verified_type,created_at,location,url";

  async function xFetch(path, params = {}) {
    const token = loadBearerToken();
    if (!token) {
      throw new Error(
        "Twitter not configured. Set TWITTER_BEARER_TOKEN in the webui or as an env var."
      );
    }
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`X API ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  async function xFetchOAuth(method, path, body = null) {
    const creds = loadOAuth1Creds();
    const fullUrl = new URL(path, API_BASE).toString();
    const authHeader = buildOAuth1Header(method, fullUrl, {}, creds);
    const opts = {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(fullUrl, opts);
    if (res.status === 204) return {};
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`X API ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  return [
    // Read — Posts
    {
      name: "twitter_post_lookup",
      category: "data-bearing",
      scope: "always",
      description:
        "Get a tweet/post by its ID from X/Twitter. Returns text, author, creation date, language, and engagement metrics (likes, retweets, replies, views).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Tweet ID" },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/tweets/${params.id}`, {
            "tweet.fields": TWEET_FIELDS,
            "user.fields": USER_FIELDS,
            expansions: "author_id",
          });
          if (!data.data) return { success: false, error: "Tweet not found" };
          return { success: true, data: formatTweet(data.data, data.includes) };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_search_recent",
      category: "data-bearing",
      scope: "always",
      description:
        "Search tweets from the last 7 days on X/Twitter. Supports operators: from:user, has:images, has:videos, has:links, lang:en, -is:retweet, -is:reply, is:verified, url:, #hashtag, @mention. Example: '(AI OR crypto) lang:en -is:retweet has:links'",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query with optional operators (max 512 chars)" },
          max_results: { type: "integer", description: "Number of results, 10-100 (default 10)", minimum: 10, maximum: 100 },
        },
        required: ["query"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch("/2/tweets/search/recent", {
            query: params.query,
            max_results: params.max_results ?? 10,
            "tweet.fields": TWEET_FIELDS,
            "user.fields": USER_FIELDS,
            expansions: "author_id",
          });
          const tweets = (data.data ?? []).map((t) => formatTweet(t, data.includes));
          return { success: true, data: { result_count: data.meta?.result_count ?? tweets.length, tweets } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_search_count",
      category: "data-bearing",
      scope: "always",
      description:
        "Get the volume of tweets matching a query over time (histogram). Returns counts per time bucket. Useful to gauge how much a topic is discussed.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          granularity: { type: "string", description: "Time bucket: 'minute', 'hour', or 'day' (default: hour)", enum: ["minute", "hour", "day"] },
        },
        required: ["query"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch("/2/tweets/counts/recent", {
            query: params.query,
            granularity: params.granularity ?? "hour",
          });
          return {
            success: true,
            data: {
              total_count: data.meta?.total_tweet_count ?? null,
              counts: (data.data ?? []).map((c) => ({ start: c.start, end: c.end, count: c.tweet_count })),
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // Read — Users
    {
      name: "twitter_user_lookup",
      category: "data-bearing",
      scope: "always",
      description:
        "Get X/Twitter user info by username. Returns name, bio, location, follower/following counts, tweet count, verified status, profile image, and account creation date.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "Twitter username (without @)" },
        },
        required: ["username"],
      },
      execute: async (params) => {
        try {
          const name = params.username.replace(/^@/, "");
          const data = await xFetch(`/2/users/by/username/${name}`, { "user.fields": USER_FIELDS });
          if (!data.data) return { success: false, error: `User @${name} not found` };
          return { success: true, data: formatUser(data.data) };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_user_lookup_id",
      category: "data-bearing",
      scope: "always",
      description: "Get X/Twitter user info by numeric user ID. Returns name, bio, metrics, verified status, etc.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Twitter user ID" },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/users/${params.id}`, { "user.fields": USER_FIELDS });
          if (!data.data) return { success: false, error: "User not found" };
          return { success: true, data: formatUser(data.data) };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_user_search",
      category: "data-bearing",
      scope: "always",
      description: "Search X/Twitter users by keyword. Returns matching users with their profile info and metrics.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword" },
          max_results: { type: "integer", description: "Number of results, 1-100 (default 10)", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch("/2/users/search", {
            query: params.query,
            max_results: params.max_results ?? 10,
            "user.fields": USER_FIELDS,
          });
          const users = (data.data ?? []).map(formatUser);
          return { success: true, data: { users } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // Read — Timelines
    {
      name: "twitter_user_posts",
      category: "data-bearing",
      scope: "always",
      description: "Get recent tweets posted by a user (by user ID). Returns up to 100 tweets with text, metrics, and dates.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Twitter user ID" },
          max_results: { type: "integer", description: "Number of tweets, 5-100 (default 10)", minimum: 5, maximum: 100 },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/users/${params.id}/tweets`, {
            max_results: params.max_results ?? 10,
            "tweet.fields": TWEET_FIELDS,
            "user.fields": USER_FIELDS,
            expansions: "author_id",
          });
          const tweets = (data.data ?? []).map((t) => formatTweet(t, data.includes));
          return { success: true, data: { tweets } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_user_mentions",
      category: "data-bearing",
      scope: "always",
      description: "Get recent tweets mentioning a user (by user ID). Returns tweets where the user is @mentioned.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Twitter user ID" },
          max_results: { type: "integer", description: "Number of tweets, 5-100 (default 10)", minimum: 5, maximum: 100 },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/users/${params.id}/mentions`, {
            max_results: params.max_results ?? 10,
            "tweet.fields": TWEET_FIELDS,
            "user.fields": USER_FIELDS,
            expansions: "author_id",
          });
          const tweets = (data.data ?? []).map((t) => formatTweet(t, data.includes));
          return { success: true, data: { tweets } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // Read — Social graph
    {
      name: "twitter_user_followers",
      category: "data-bearing",
      scope: "always",
      description: "List followers of a user (by user ID). Returns follower profiles with bios and metrics.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Twitter user ID" },
          max_results: { type: "integer", description: "Number of followers, 1-1000 (default 100)", minimum: 1, maximum: 1000 },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/users/${params.id}/followers`, {
            max_results: params.max_results ?? 100,
            "user.fields": USER_FIELDS,
          });
          const users = (data.data ?? []).map(formatUser);
          return { success: true, data: { result_count: data.meta?.result_count ?? users.length, users } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_user_following",
      category: "data-bearing",
      scope: "always",
      description: "List accounts a user follows (by user ID). Returns followed user profiles with bios and metrics.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Twitter user ID" },
          max_results: { type: "integer", description: "Number of results, 1-1000 (default 100)", minimum: 1, maximum: 1000 },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/users/${params.id}/following`, {
            max_results: params.max_results ?? 100,
            "user.fields": USER_FIELDS,
          });
          const users = (data.data ?? []).map(formatUser);
          return { success: true, data: { result_count: data.meta?.result_count ?? users.length, users } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // Read — Engagement
    {
      name: "twitter_liking_users",
      category: "data-bearing",
      scope: "always",
      description: "Get users who liked a specific tweet (by tweet ID).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Tweet ID" },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/tweets/${params.id}/liking_users`, { "user.fields": USER_FIELDS });
          const users = (data.data ?? []).map(formatUser);
          return { success: true, data: { result_count: data.meta?.result_count ?? users.length, users } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_retweeters",
      category: "data-bearing",
      scope: "always",
      description: "Get users who retweeted a specific tweet (by tweet ID).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Tweet ID" },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/tweets/${params.id}/retweeted_by`, { "user.fields": USER_FIELDS });
          const users = (data.data ?? []).map(formatUser);
          return { success: true, data: { result_count: data.meta?.result_count ?? users.length, users } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_quote_posts",
      category: "data-bearing",
      scope: "always",
      description: "Get tweets that quote a specific tweet (by tweet ID).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Tweet ID" },
          max_results: { type: "integer", description: "Number of results, 10-100 (default 10)", minimum: 10, maximum: 100 },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetch(`/2/tweets/${params.id}/quote_tweets`, {
            max_results: params.max_results ?? 10,
            "tweet.fields": TWEET_FIELDS,
            "user.fields": USER_FIELDS,
            expansions: "author_id",
          });
          const tweets = (data.data ?? []).map((t) => formatTweet(t, data.includes));
          return { success: true, data: { result_count: data.meta?.result_count ?? tweets.length, tweets } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // Read — Trends
    {
      name: "twitter_trends",
      category: "data-bearing",
      scope: "always",
      description:
        "Get trending topics on X/Twitter by location. Use WOEID: 1 = worldwide, 23424977 = US, 23424975 = UK, 23424856 = Japan, 615702 = Paris, 2459115 = New York. Returns trend names and tweet volumes.",
      parameters: {
        type: "object",
        properties: {
          woeid: { type: "integer", description: "WOEID location code (default 1 = worldwide)", minimum: 1 },
        },
      },
      execute: async (params) => {
        try {
          const id = params.woeid ?? 1;
          const data = await xFetch(`/2/trends/by/woeid/${id}`);
          const trends = (data.data ?? []).map((t) => ({
            name: t.trend_name ?? t.name ?? null,
            tweet_count: t.tweet_count ?? null,
          }));
          return { success: true, data: { woeid: id, trends } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // Write (OAuth 1.0a)
    {
      name: "twitter_post_create",
      category: "action",
      scope: "admin-only",
      description: "Post a new tweet on X/Twitter. Requires OAuth credentials configured in webui. Can create replies and quote tweets.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Tweet text (max 280 chars)" },
          reply_to: { type: "string", description: "Tweet ID to reply to (optional)" },
          quote_tweet_id: { type: "string", description: "Tweet ID to quote (optional)" },
        },
        required: ["text"],
      },
      execute: async (params) => {
        try {
          if (params.text.length > 280) {
            return { success: false, error: `Tweet too long (${params.text.length}/280 chars).` };
          }
          const body = { text: params.text };
          if (params.reply_to) body.reply = { in_reply_to_tweet_id: params.reply_to };
          if (params.quote_tweet_id) body.quote_tweet_id = params.quote_tweet_id;
          const data = await xFetchOAuth("POST", "/2/tweets", body);
          return { success: true, data: { id: data.data?.id, text: data.data?.text } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_post_delete",
      category: "action",
      scope: "admin-only",
      description: "Delete a tweet you posted. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Tweet ID to delete" },
        },
        required: ["id"],
      },
      execute: async (params) => {
        try {
          const data = await xFetchOAuth("DELETE", `/2/tweets/${params.id}`);
          return { success: true, data: { deleted: data.data?.deleted ?? true } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_like",
      category: "action",
      scope: "admin-only",
      description: "Like a tweet. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          tweet_id: { type: "string", description: "Tweet ID to like" },
        },
        required: ["tweet_id"],
      },
      execute: async (params) => {
        try {
          const userId = await getAuthenticatedUserId();
          const data = await xFetchOAuth("POST", `/2/users/${userId}/likes`, { tweet_id: params.tweet_id });
          return { success: true, data: { liked: data.data?.liked ?? true } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_unlike",
      category: "action",
      scope: "admin-only",
      description: "Unlike a previously liked tweet. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          tweet_id: { type: "string", description: "Tweet ID to unlike" },
        },
        required: ["tweet_id"],
      },
      execute: async (params) => {
        try {
          const userId = await getAuthenticatedUserId();
          const data = await xFetchOAuth("DELETE", `/2/users/${userId}/likes/${params.tweet_id}`);
          return { success: true, data: { liked: data.data?.liked ?? false } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_retweet",
      category: "action",
      scope: "admin-only",
      description: "Retweet a tweet. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          tweet_id: { type: "string", description: "Tweet ID to retweet" },
        },
        required: ["tweet_id"],
      },
      execute: async (params) => {
        try {
          const userId = await getAuthenticatedUserId();
          const data = await xFetchOAuth("POST", `/2/users/${userId}/retweets`, { tweet_id: params.tweet_id });
          return { success: true, data: { retweeted: data.data?.retweeted ?? true } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_unretweet",
      category: "action",
      scope: "admin-only",
      description: "Undo a retweet. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          tweet_id: { type: "string", description: "Tweet ID to unretweet" },
        },
        required: ["tweet_id"],
      },
      execute: async (params) => {
        try {
          const userId = await getAuthenticatedUserId();
          const data = await xFetchOAuth("DELETE", `/2/users/${userId}/retweets/${params.tweet_id}`);
          return { success: true, data: { retweeted: data.data?.retweeted ?? false } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_follow",
      category: "action",
      scope: "admin-only",
      description: "Follow a user on X/Twitter. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          target_user_id: { type: "string", description: "User ID to follow" },
        },
        required: ["target_user_id"],
      },
      execute: async (params) => {
        try {
          const userId = await getAuthenticatedUserId();
          const data = await xFetchOAuth("POST", `/2/users/${userId}/following`, { target_user_id: params.target_user_id });
          return { success: true, data: { following: data.data?.following ?? true, pending: data.data?.pending_follow ?? false } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_unfollow",
      category: "action",
      scope: "admin-only",
      description: "Unfollow a user on X/Twitter. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          target_user_id: { type: "string", description: "User ID to unfollow" },
        },
        required: ["target_user_id"],
      },
      execute: async (params) => {
        try {
          const userId = await getAuthenticatedUserId();
          const data = await xFetchOAuth("DELETE", `/2/users/${userId}/following/${params.target_user_id}`);
          return { success: true, data: { following: data.data?.following ?? false } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_bookmark",
      category: "action",
      scope: "admin-only",
      description: "Bookmark a tweet for later. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          tweet_id: { type: "string", description: "Tweet ID to bookmark" },
        },
        required: ["tweet_id"],
      },
      execute: async (params) => {
        try {
          const userId = await getAuthenticatedUserId();
          const data = await xFetchOAuth("POST", `/2/users/${userId}/bookmarks`, { tweet_id: params.tweet_id });
          return { success: true, data: { bookmarked: data.data?.bookmarked ?? true } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "twitter_remove_bookmark",
      category: "action",
      scope: "admin-only",
      description: "Remove a bookmarked tweet. Requires OAuth.",
      parameters: {
        type: "object",
        properties: {
          tweet_id: { type: "string", description: "Tweet ID to remove from bookmarks" },
        },
        required: ["tweet_id"],
      },
      execute: async (params) => {
        try {
          const userId = await getAuthenticatedUserId();
          const data = await xFetchOAuth("DELETE", `/2/users/${userId}/bookmarks/${params.tweet_id}`);
          return { success: true, data: { bookmarked: data.data?.bookmarked ?? false } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
  ];
};
