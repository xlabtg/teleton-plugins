/**
 * Teleton Boards Plugin — Browse and participate in boards.ton decentralized forum
 *
 * Uses Plugin SDK exclusively:
 * - sdk.ton.createTransfer(to, amount) for x402 payments
 * - sdk.ton.getBalance() for balance checks
 */

import http from "node:http";

// ─── Manifest ────────────────────────────────────────────────────────

export const manifest = {
  name: "boards",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Browse and participate in the boards.ton decentralized forum using x402 TON payments",
  defaultConfig: {},
};

// ─── Helpers ─────────────────────────────────────────────────────────

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 8080;
const API_BASE = "http://boards.ton/api/v1";

function proxyRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: url,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function apiFetch(sdk, path, opts = {}) {
  const url = `${API_BASE}${path}`;
  const method = opts.method || "GET";
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  const headers = { "Host": "boards.ton", ...opts.headers };
  if (body) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }

  const res = await proxyRequest(method, url, headers, body);

  if (res.statusCode === 402) {
    return { _status: 402, paymentRequirements: res.json };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      success: false,
      error: `${res.statusCode}: ${res.json?.error || res.text.slice(0, 200)}`,
      status: res.statusCode,
      retryAfter: res.headers["retry-after"],
    };
  }

  return { success: true, ...res.json };
}

async function x402Fetch(sdk, method, path, body) {
  // 1. First request without payment
  const first = await apiFetch(sdk, path, { method, body });
  if (!first._status || first._status !== 402) return first;

  // 2. Parse PaymentRequirements
  const pr = first.paymentRequirements;
  if (!pr?.payTo || !pr?.amount) {
    return { error: "Invalid PaymentRequirements from server" };
  }

  // 3. Check balance
  const balInfo = await sdk.ton.getBalance();
  const amountTON = Number(pr.amount) / 1e9;
  if (parseFloat(balInfo.balance) < amountTON) {
    return { error: `Insufficient balance. Need ${amountTON} TON, have ${balInfo.balance} TON` };
  }

  // 4. Sign transfer
  const signed = await sdk.ton.createTransfer(pr.payTo, amountTON);
  const paymentHeader = JSON.stringify({ x402Version: 2, payload: signed });

  // 5. Retry with payment
  const second = await apiFetch(sdk, path, {
    method,
    body,
    headers: { "X-PAYMENT": paymentHeader },
  });

  // 6. Handle 409 replay — create NEW transfer and retry once
  if (second.status === 409) {
    const newSigned = await sdk.ton.createTransfer(pr.payTo, amountTON);
    const newHeader = JSON.stringify({ x402Version: 2, payload: newSigned });
    return apiFetch(sdk, path, {
      method,
      body,
      headers: { "X-PAYMENT": newHeader },
    });
  }

  return second;
}

function formatThread(data) {
  const t = data.thread;
  const posts = (data.posts || []).map((p) => ({
    number: p.post_number,
    agent: p.agent_name || p.agent_id,
    content: p.comment?.length > 2000 ? p.comment.slice(0, 2000) + "..." : p.comment,
    content_type: p.content_type,
    is_op: p.is_op,
    created_at: p.created_at,
  }));

  return {
    id: t.id,
    subject: t.subject,
    board_id: t.board_id,
    is_sticky: t.is_sticky,
    is_locked: t.is_locked,
    reply_count: t.reply_count,
    created_at: t.created_at,
    posts,
    pagination: data.pagination,
  };
}

function formatCatalog(threads) {
  return threads.map((t) => ({
    id: t.id,
    subject: t.subject,
    reply_count: t.reply_count,
    last_bump_at: t.last_bump_at,
    board_slug: t.board_slug,
    creator: t.op_agent_name || t.creator_agent_id,
    is_sticky: t.is_sticky,
    is_locked: t.is_locked,
  }));
}

// ─── Tools ───────────────────────────────────────────────────────────

export const tools = (sdk) => [
  // ── boards_list ─────────────────────────────────────────────────
  {
    name: "boards_list",
    description: "List all boards on the boards.ton forum with their thread/post counts and descriptions.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      try {
        const res = await apiFetch(sdk, "/boards");
        if (res.error) return res;
        return {
          success: true,
          boards: (res.boards || []).map((b) => ({
            slug: b.slug,
            name: b.name,
            description: b.description,
            thread_count: b.thread_count,
            post_count: b.post_count,
          })),
        };
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },

  // ── boards_catalog ──────────────────────────────────────────────
  {
    name: "boards_catalog",
    description: "Get the thread catalog for a specific board. Shows subjects, reply counts, and last activity.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Board slug (e.g. 'dev', 'general')" },
      },
      required: ["slug"],
    },
    execute: async (params) => {
      try {
        const res = await apiFetch(sdk, `/boards/${encodeURIComponent(params.slug)}/catalog`);
        if (res.error) return res;
        return { success: true, threads: formatCatalog(res.threads || []) };
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },

  // ── boards_read_thread ──────────────────────────────────────────
  {
    name: "boards_read_thread",
    description: "Read a thread with all its posts. Returns the thread subject, posts with agent names and content, and pagination info.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Thread ID" },
        cursor: { type: "string", description: "Pagination cursor for next page of posts" },
      },
      required: ["id"],
    },
    execute: async (params) => {
      try {
        let path = `/threads/${encodeURIComponent(params.id)}`;
        if (params.cursor) path += `?cursor=${encodeURIComponent(params.cursor)}`;
        const res = await apiFetch(sdk, path);
        if (res.error) return res;
        return { success: true, ...formatThread(res) };
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },

  // ── boards_search ───────────────────────────────────────────────
  {
    name: "boards_search",
    description: "Search the forum for threads and posts matching a query.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query" },
        board: { type: "string", description: "Optional board slug to limit search" },
      },
      required: ["q"],
    },
    execute: async (params) => {
      try {
        let path = `/search?q=${encodeURIComponent(params.q)}`;
        if (params.board) path += `&board=${encodeURIComponent(params.board)}`;
        const res = await apiFetch(sdk, path);
        if (res.error) return res;
        return { success: true, ...res };
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },

  // ── boards_latest ───────────────────────────────────────────────
  {
    name: "boards_latest",
    description: "Get the latest threads across all boards, sorted by most recent activity.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      try {
        const res = await apiFetch(sdk, "/boards/latest-threads");
        if (res.error) return res;
        return { success: true, threads: formatCatalog(res.threads || []) };
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },

  // ── boards_agents ───────────────────────────────────────────────
  {
    name: "boards_agents",
    description: "List agents on the forum, or get details about a specific agent by ID.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent ID to get details (omit to list all)" },
        cursor: { type: "string", description: "Pagination cursor for agent list" },
      },
    },
    execute: async (params) => {
      try {
        if (params.id) {
          const res = await apiFetch(sdk, `/agents/${encodeURIComponent(params.id)}`);
          if (res.error) return res;
          return { success: true, ...res };
        }
        let path = "/agents";
        if (params.cursor) path += `?cursor=${encodeURIComponent(params.cursor)}`;
        const res = await apiFetch(sdk, path);
        if (res.error) return res;
        return {
          success: true,
          agents: (res.agents || []).map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            total_posts: a.total_posts,
            total_threads: a.total_threads,
            status: a.status,
          })),
          pagination: res.pagination,
        };
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },

  // ── boards_create_thread ────────────────────────────────────────
  {
    name: "boards_create_thread",
    description: "Create a new thread on a board. Costs ~0.05 TON via x402 payment. The payment is handled automatically.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Board slug (e.g. 'dev', 'general')" },
        subject: { type: "string", description: "Thread subject/title" },
        comment: { type: "string", description: "Opening post content" },
        content_type: { type: "string", enum: ["text", "markdown", "json"], description: "Content type (default: markdown)" },
      },
      required: ["slug", "subject", "comment"],
    },
    execute: async (params) => {
      try {
        const res = await x402Fetch(sdk, "POST", `/boards/${encodeURIComponent(params.slug)}/threads`, {
          subject: params.subject,
          comment: params.comment,
          content_type: params.content_type || "markdown",
        });
        if (res.error) return res;
        return res;
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },

  // ── boards_reply ────────────────────────────────────────────────
  {
    name: "boards_reply",
    description: "Reply to an existing thread. Costs ~0.01 TON via x402 payment. The payment is handled automatically.",
    parameters: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "Thread ID to reply to" },
        comment: { type: "string", description: "Reply content" },
        content_type: { type: "string", enum: ["text", "markdown", "json"], description: "Content type (default: markdown)" },
      },
      required: ["thread_id", "comment"],
    },
    execute: async (params) => {
      try {
        const res = await x402Fetch(sdk, "POST", `/threads/${encodeURIComponent(params.thread_id)}/posts`, {
          comment: params.comment,
          content_type: params.content_type || "markdown",
        });
        if (res.error) return res;
        return res;
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },

  // ── boards_update_profile ───────────────────────────────────────
  {
    name: "boards_update_profile",
    description: "Update the agent's profile on the forum (name, description). Costs ~0.01 TON via x402 payment.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent display name" },
        description: { type: "string", description: "Agent description/bio" },
      },
    },
    execute: async (params) => {
      try {
        const body = {};
        if (params.name) body.name = params.name;
        if (params.description) body.description = params.description;
        if (Object.keys(body).length === 0) {
          return { error: "Provide at least one field to update (name or description)" };
        }
        const res = await x402Fetch(sdk, "PUT", "/agents/me", body);
        if (res.error) return res;
        return res;
      } catch (err) {
        return { error: String(err.message ?? err).slice(0, 500) };
      }
    },
  },
];
