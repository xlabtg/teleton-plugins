/**
 * Fragment plugin -- Telegram username, number, and gift marketplace
 *
 * Provides search, item details, history, NFT metadata, collections,
 * and TON/USD rate from fragment.com. Read-only, no auth required.
 * Uses session cookie + hash extracted from the Fragment homepage.
 */

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

let _session = null;
let _sessionTime = 0;
const SESSION_TTL = 30 * 60 * 1000;

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function initSession() {
  const res = await fetch("https://fragment.com/", {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  const cookies = res.headers.get("set-cookie") ?? "";
  const ssid = cookies.match(/stel_ssid=([^;]+)/)?.[1];
  const html = await res.text();
  const hash = html.match(/apiUrl":"[^"]*hash=([a-f0-9]+)/)?.[1];
  const tonRate = html.match(/tonRate":([\d.]+)/)?.[1];
  if (!ssid || !hash) throw new Error("Failed to init Fragment session");
  return { ssid, hash, tonRate: tonRate ? parseFloat(tonRate) : null };
}

async function getSession() {
  if (_session && Date.now() - _sessionTime < SESSION_TTL) return _session;
  _session = await initSession();
  _sessionTime = Date.now();
  return _session;
}

function invalidateSession() {
  _session = null;
  _sessionTime = 0;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fragmentApi(method, params = {}) {
  const session = await getSession();
  const body = new URLSearchParams({ method, ...params });
  const res = await fetch(`https://fragment.com/api?hash=${session.hash}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": `stel_ssid=${session.ssid}`,
      "User-Agent": UA,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) {
    invalidateSession();
    throw new Error(data.error ?? "Fragment API error");
  }
  return data;
}

async function fragmentPage(path) {
  const session = await getSession();
  const res = await fetch(`https://fragment.com${path}`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": `stel_ssid=${session.ssid}`,
      "User-Agent": UA,
    },
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

function stripCommas(s) {
  return s ? s.replace(/,/g, "") : s;
}

function parsePrice(s) {
  if (!s) return null;
  const n = parseFloat(stripCommas(s));
  return isNaN(n) ? null : n;
}

/**
 * Parse search result rows for usernames/numbers.
 * Hrefs may include query params: /username/crypto?sort=price_desc
 */
function parseSearchRows(html) {
  if (!html) return [];
  const rows = [];
  const trParts = html.split(/<tr[\s>]/);
  for (const tr of trParts) {
    // Match href up to ? or "
    const href = tr.match(/href="\/(username|number)\/([^"?]+)/);
    if (!href) continue;

    const name = tr.match(/table-cell-value tm-value">([^<]+)/)?.[1]?.trim();
    const priceStr = tr.match(/icon-before icon-ton">([^<]+)/)?.[1]?.trim();
    const status = tr.match(/tm-status-(avail|unavail)[^"]*">([^<]+)/);
    const endTime = tr.match(/datetime="([^"]+)"/)?.[1];

    rows.push({
      name: name ?? null,
      url: `https://fragment.com/${href[1]}/${href[2]}`,
      price_ton: parsePrice(priceStr),
      status: status ? status[2].trim() : null,
      end_time: endTime ?? null,
    });
  }
  return rows;
}

/**
 * Parse gift search rows (view=list mode).
 * Hrefs include query params: /gift/durovscap-10?sort=price_asc&view=list
 */
function parseGiftRows(html) {
  if (!html) return [];
  const rows = [];
  const trParts = html.split(/<tr[\s>]/);
  for (const tr of trParts) {
    // Match href up to ? or "
    const href = tr.match(/href="\/gift\/([^"?]+)/);
    if (!href) continue;

    const name = tr.match(/table-cell-value tm-value">([^<]+)/)?.[1]?.trim();
    const attrs = tr.match(/table-cell-desc tm-nowrap">([^<]+)/)?.[1]?.trim();
    const priceStr = tr.match(/icon-before icon-ton">([^<]+)/)?.[1]?.trim();
    const endTime = tr.match(/datetime="([^"]+)"/)?.[1];

    rows.push({
      name: name ?? null,
      url: `https://fragment.com/gift/${href[1]}`,
      attributes: attrs ?? null,
      price_ton: parsePrice(priceStr),
      end_time: endTime ?? null,
    });
  }
  return rows;
}

/**
 * Parse history rows from item detail page tables.
 * Tables 2+ have: price, date, wallet columns.
 */
function parseHistoryRows(html, tableIndex) {
  if (!html) return [];
  const tables = html.split(/<table class="table tm-table tm-table-fixed">/);
  // tableIndex: 1 = current owner, 2 = sales history, 3 = bids/offers
  if (tableIndex >= tables.length) return [];
  const table = tables[tableIndex];
  const endIdx = table.indexOf("</table>");
  const content = endIdx > -1 ? table.slice(0, endIdx) : table;

  const rows = [];
  const trParts = content.split(/<tr[\s>]/);
  for (const tr of trParts) {
    if (!tr.includes("table-cell")) continue;
    // Skip header rows (contain <th>)
    if (tr.includes("<th")) continue;

    const priceStr = tr.match(/icon-before icon-ton">([^<]+)/)?.[1]?.trim();
    const transferred = tr.includes("Transferred");
    const date = tr.match(/datetime="([^"]+)"/)?.[1];
    const wallet = tr.match(/tonviewer\.com\/([^"]+)"/)?.[1] ?? null;
    const walletLabel = tr.match(/tm-wallet[^>]*>(?:<[^>]*>)*([^<]+)/)?.[1]?.trim();

    if (!date && !priceStr && !transferred) continue;

    rows.push({
      price_ton: transferred ? null : parsePrice(priceStr),
      action: transferred ? "transfer" : "sale",
      date: date ?? null,
      wallet: wallet ?? null,
      wallet_label: walletLabel ?? null,
    });
  }
  return rows;
}

/**
 * Parse an item detail page (h HTML + s state).
 */
function parseItemDetail(h, s) {
  const result = {
    type: s?.type ?? null,
    name: s?.username ?? s?.itemTitle ?? null,
    ton_rate: s?.tonRate ?? null,
  };

  if (!h) return result;

  // Status
  const statusMatch = h.match(/tm-status-(avail|unavail)[^"]*">([^<]+)/);
  result.status = statusMatch ? statusMatch[2].trim() : null;

  // Price (first occurrence in main section, before history tables)
  const priceStr = h.match(/icon-before icon-ton">([^<]+)/)?.[1]?.trim();
  result.price_ton = parsePrice(priceStr);

  // Owner wallet — from tonviewer link
  result.wallet = h.match(/tonviewer\.com\/([^"]+)"/)?.[1] ?? null;
  result.wallet_label = h.match(/tm-wallet[^>]*>(?:<[^>]*>)*([^<]+)/)?.[1]?.trim() ?? null;

  // End time
  result.end_time = h.match(/datetime="([^"]+)"/)?.[1] ?? null;

  // Attributes (for gifts)
  const attrMatch = h.match(/table-cell-desc tm-nowrap">([^<]+)/)?.[1]?.trim();
  if (attrMatch) result.attributes = attrMatch;

  return result;
}

/**
 * Parse collections list from gifts page HTML.
 * Each collection item: data-value="slug", tm-main-filters-name, tm-main-filters-count
 */
function parseCollections(html) {
  if (!html) return [];
  const collections = [];
  // Split on collection items
  const items = html.split(/js-choose-collection-item/);
  for (const item of items) {
    const slug = item.match(/data-value="([^"]+)"/)?.[1];
    if (!slug) continue;
    const name = item.match(/tm-main-filters-name">([^<]+)/)?.[1]?.trim();
    const countStr = item.match(/tm-main-filters-count">([^<]+)/)?.[1]?.trim();
    const count = countStr ? parseInt(stripCommas(countStr), 10) : null;
    collections.push({
      slug,
      name: name ?? slug,
      item_count: count,
    });
  }
  return collections;
}

// ---------------------------------------------------------------------------
// Export -- SDK wrapper
// ---------------------------------------------------------------------------

export const manifest = {
  name: "fragment",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Search and browse Telegram's NFT marketplace — usernames, numbers, collectible gifts, auction history",
};

export const tools = (sdk) => {

// ---------------------------------------------------------------------------
// Tool 1: fragment_search
// ---------------------------------------------------------------------------

const fragmentSearch = {
  name: "fragment_search",
  description:
    "Search usernames, phone numbers, or gifts on the Fragment.com marketplace. Returns a list of items with prices, status, and listing info.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["usernames", "numbers", "gifts"],
        description: "Type of items to search",
      },
      query: {
        type: "string",
        description: "Search query",
      },
      sort: {
        type: "string",
        enum: ["price_desc", "price_asc", "listed", "ending"],
        description: "Sort order (default: price_desc)",
      },
      filter: {
        type: "string",
        enum: ["sale", "auction", "sold", "available"],
        description: "Filter by status. 'available' returns all available items",
      },
      collection: {
        type: "string",
        description: "Gift collection slug (gifts only)",
      },
      limit: {
        type: "integer",
        description: "Max results to return (default: 20)",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["type"],
  },

  execute: async (params) => {
    try {
      const type = params.type;
      const apiParams = {
        type,
        query: params.query ?? "",
        sort: params.sort ?? "price_desc",
      };

      // Filter: "available" maps to empty string in the API
      if (params.filter) {
        apiParams.filter = params.filter === "available" ? "" : params.filter;
      }

      if (type === "gifts") {
        apiParams.view = "list";
        if (params.collection) apiParams.collection = params.collection;
      }

      const data = await fragmentApi("searchAuctions", apiParams);
      const html = data.html ?? "";

      let items;
      if (type === "gifts") {
        items = parseGiftRows(html);
      } else {
        items = parseSearchRows(html);
      }

      const limit = params.limit ?? 20;
      items = items.slice(0, limit);

      const nextOffset = html.match(/data-next-offset="(\d+)"/)?.[1];

      return {
        success: true,
        data: {
          type,
          count: items.length,
          items,
          has_more: !!nextOffset,
          next_offset: nextOffset ? parseInt(nextOffset, 10) : null,
        },
      };
    } catch (err) {
      sdk.log.error("fragment_search:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: fragment_item
// ---------------------------------------------------------------------------

const fragmentItem = {
  name: "fragment_item",
  description:
    "Get detailed info for a specific Fragment item (username, phone number, or gift). Returns status, price, owner wallet, and attributes.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["username", "number", "gift"],
        description: "Item type",
      },
      id: {
        type: "string",
        description: "Item identifier (e.g. 'crypto', '88800869800', 'durovscap-9')",
      },
    },
    required: ["type", "id"],
  },

  execute: async (params) => {
    try {
      const path = `/${params.type}/${params.id}`;
      const data = await fragmentPage(path);
      // Fragment redirects to search for non-existent items
      if (data.r || (!data.h && !data.s)) {
        return { success: false, error: `Item not found: ${params.type}/${params.id}` };
      }
      const detail = parseItemDetail(data.h ?? "", data.s ?? {});
      return { success: true, data: detail };
    } catch (err) {
      sdk.log.error("fragment_item:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: fragment_history
// ---------------------------------------------------------------------------

const fragmentHistory = {
  name: "fragment_history",
  description:
    "Get ownership or bid/sale history for a Fragment item. Shows price, date, action type, and wallet address for each historical event.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["username", "number", "gift"],
        description: "Item type",
      },
      id: {
        type: "string",
        description: "Item identifier",
      },
      history_type: {
        type: "string",
        enum: ["sales", "bids"],
        description: "History type: sales (ownership changes) or bids (offers). Default: sales",
      },
      limit: {
        type: "integer",
        description: "Max results (default: 20)",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["type", "id"],
  },

  execute: async (params) => {
    try {
      const historyType = params.history_type ?? "sales";
      const path = `/${params.type}/${params.id}`;
      const data = await fragmentPage(path);
      if (data.r || (!data.h && !data.s)) {
        return { success: false, error: `Item not found: ${params.type}/${params.id}` };
      }
      const html = data.h ?? "";

      // Table indices: 1 = current owner, 2 = sales history, 3 = bids/offers
      const tableIndex = historyType === "bids" ? 3 : 2;
      let rows = parseHistoryRows(html, tableIndex);

      const limit = params.limit ?? 20;
      rows = rows.slice(0, limit);

      return {
        success: true,
        data: {
          type: params.type,
          id: params.id,
          history_type: historyType,
          count: rows.length,
          entries: rows,
        },
      };
    } catch (err) {
      sdk.log.error("fragment_history:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: fragment_nft
// ---------------------------------------------------------------------------

const fragmentNft = {
  name: "fragment_nft",
  description:
    "Get NFT metadata for a Fragment item from nft.fragment.com. Returns name, description, image URL, and attributes. No session needed.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["username", "number", "gift"],
        description: "Item type",
      },
      id: {
        type: "string",
        description: "Item identifier (e.g. 'crypto', '88800869800', 'durovscap-9')",
      },
    },
    required: ["type", "id"],
  },

  execute: async (params) => {
    try {
      const url = `https://nft.fragment.com/${params.type}/${params.id}.json`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        throw new Error(`NFT API error: ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      return { success: true, data };
    } catch (err) {
      sdk.log.error("fragment_nft:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: fragment_collections
// ---------------------------------------------------------------------------

const fragmentCollections = {
  name: "fragment_collections",
  description:
    "List available gift collections on Fragment marketplace. Returns collection slugs, names, and item counts.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async () => {
    try {
      const data = await fragmentPage("/gifts");
      const html = data.h ?? "";
      const collections = parseCollections(html);

      return {
        success: true,
        data: {
          count: collections.length,
          collections,
        },
      };
    } catch (err) {
      sdk.log.error("fragment_collections:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: fragment_rate
// ---------------------------------------------------------------------------

const fragmentRate = {
  name: "fragment_rate",
  description:
    "Get the current TON/USD exchange rate from Fragment.com.",
  category: "data-bearing",
  scope: "always",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async () => {
    try {
      const session = await getSession();
      if (!session.tonRate) {
        throw new Error("TON rate not available from Fragment");
      }
      return { success: true, data: { ton_usd: session.tonRate } };
    } catch (err) {
      sdk.log.error("fragment_rate:", err.message);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Return tools array
// ---------------------------------------------------------------------------

return [
  fragmentSearch,
  fragmentItem,
  fragmentHistory,
  fragmentNft,
  fragmentCollections,
  fragmentRate,
];

}; // end tools(sdk)
