/**
 * TONAPI plugin -- TON blockchain explorer data from tonapi.io
 *
 * Provides account info, jetton balances, NFT data, token prices, transaction
 * lookups, execution traces, DNS resolution, staking pools, and validators.
 * Data from the public TONAPI (optional Bearer token for higher rate limits).
 * API key loaded via sdk.secrets (optional).
 */

const API_BASE = "https://tonapi.io";

// ---------------------------------------------------------------------------
// SDK export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "tonapi",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "TON blockchain data from TONAPI -- accounts, jettons, NFTs, prices, transactions, traces, DNS, staking",
};

export const tools = (sdk) => {
  const API_KEY = sdk.secrets.get("api_key") ?? null;
  const RATE_LIMIT_MS = API_KEY ? 1000 : 4000;

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  let lastRequestTime = 0;

  async function tonapiFetch(path, params = {}) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
    }
    lastRequestTime = Date.now();

    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers = { Accept: "application/json" };
    if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`TONAPI error: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  return [
    // Accounts
    {
      name: "tonapi_account",
      description:
        "Get TON account info by address or .ton domain. Returns balance (in TON), status, interfaces, last activity, name, and whether it is a wallet. Use to look up any wallet or contract on TON.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Wallet/contract address or .ton domain",
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/accounts/${params.account_id}`);
          return {
            success: true,
            data: {
              address: data.address ?? null,
              balance_ton: Number(data.balance ?? 0) / 1e9,
              status: data.status ?? null,
              last_activity: data.last_activity ?? null,
              interfaces: data.interfaces ?? [],
              name: data.name ?? null,
              is_wallet: data.is_wallet ?? null,
              icon: data.icon ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_account_jettons",
      description:
        "List jetton (token) balances for a TON wallet. Returns each token's name, symbol, address, human-readable amount, and USD value if available. Use to see what tokens an account holds.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Wallet/contract address or .ton domain",
          },
          currencies: {
            type: "string",
            description: "Comma-separated currency codes for price conversion (default: usd)",
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/accounts/${params.account_id}/jettons`, {
            currencies: params.currencies ?? "usd",
          });
          const balances = (data.balances ?? []).map((b) => {
            const j = b.jetton ?? {};
            const decimals = j.decimals ?? 9;
            const amount = Number(b.balance ?? 0) / Math.pow(10, decimals);
            const usdPrice = b.price?.prices?.USD ?? null;
            return {
              jetton_address: j.address ?? null,
              name: j.name ?? null,
              symbol: j.symbol ?? null,
              decimals,
              amount,
              usd_value: usdPrice != null ? amount * Number(usdPrice) : null,
              verification: j.verification ?? null,
              image: j.image ?? null,
            };
          });
          return { success: true, data: { balances } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_account_nfts",
      description:
        "List NFTs owned by a TON account. Returns each NFT's address, collection, name, description, image, and verification status. Use to browse an account's NFT holdings.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Wallet/contract address or .ton domain",
          },
          limit: {
            type: "integer",
            description: "Number of NFTs to return, 1-1000 (default: 100)",
            minimum: 1,
            maximum: 1000,
          },
          offset: {
            type: "integer",
            description: "Pagination offset (default: 0)",
            minimum: 0,
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/accounts/${params.account_id}/nfts`, {
            limit: params.limit ?? 100,
            offset: params.offset ?? 0,
          });
          const items = (data.nft_items ?? []).map((item) => {
            const meta = item.metadata ?? {};
            const coll = item.collection ?? {};
            return {
              address: item.address ?? null,
              index: item.index ?? null,
              collection_address: coll.address ?? null,
              collection_name: coll.name ?? null,
              name: meta.name ?? null,
              description: meta.description ?? null,
              image: meta.image ?? null,
              owner: item.owner?.address ?? null,
              verified: item.approved_by?.length > 0,
            };
          });
          return { success: true, data: { nft_items: items } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_account_events",
      description:
        "Get recent events (transactions) for a TON account. Returns event ID, timestamp, scam flag, and actions with type-specific details (TonTransfer, JettonTransfer, NftItemTransfer, SmartContractExec, etc.). Use to review an account's transaction history.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Wallet/contract address or .ton domain",
          },
          limit: {
            type: "integer",
            description: "Number of events to return, 1-100 (default: 20)",
            minimum: 1,
            maximum: 100,
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/accounts/${params.account_id}/events`, {
            limit: params.limit ?? 20,
          });
          const events = (data.events ?? []).map((ev) => {
            const actions = (ev.actions ?? []).map((a) => {
              const base = {
                type: a.type ?? null,
                status: a.status ?? null,
              };
              if (a.type === "TonTransfer" && a.TonTransfer) {
                base.sender = a.TonTransfer.sender?.address ?? null;
                base.recipient = a.TonTransfer.recipient?.address ?? null;
                base.amount_ton = Number(a.TonTransfer.amount ?? 0) / 1e9;
                base.comment = a.TonTransfer.comment ?? null;
              } else if (a.type === "JettonTransfer" && a.JettonTransfer) {
                const jt = a.JettonTransfer;
                base.sender = jt.sender?.address ?? null;
                base.recipient = jt.recipient?.address ?? null;
                base.amount = jt.amount ?? null;
                base.jetton_name = jt.jetton?.name ?? null;
                base.jetton_symbol = jt.jetton?.symbol ?? null;
                base.jetton_address = jt.jetton?.address ?? null;
              } else if (a.type === "NftItemTransfer" && a.NftItemTransfer) {
                const nt = a.NftItemTransfer;
                base.sender = nt.sender?.address ?? null;
                base.recipient = nt.recipient?.address ?? null;
                base.nft_address = nt.nft ?? null;
              } else if (a.type === "SmartContractExec" && a.SmartContractExec) {
                const sc = a.SmartContractExec;
                base.executor = sc.executor?.address ?? null;
                base.contract = sc.contract?.address ?? null;
                base.ton_attached = Number(sc.ton_attached ?? 0) / 1e9;
                base.operation = sc.operation ?? null;
              }
              return base;
            });
            return {
              event_id: ev.event_id ?? null,
              timestamp: ev.timestamp ?? null,
              is_scam: ev.is_scam ?? false,
              actions,
            };
          });
          return { success: true, data: { events } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_account_search",
      description:
        "Search TON accounts by domain name (.ton, .t.me, etc.). Returns matching addresses and their associated names. Use to resolve a domain to an on-chain address.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Domain name to search for",
          },
        },
        required: ["name"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch("/v2/accounts/search", {
            name: params.name,
          });
          const addresses = (data.addresses ?? []).map((a) => ({
            address: a.address ?? null,
            name: a.name ?? null,
          }));
          return { success: true, data: { addresses } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // Jettons & Rates
    {
      name: "tonapi_jetton_info",
      description:
        "Get jetton metadata and stats by master contract address from TONAPI. Returns name, symbol, decimals, image, description, total supply (human-readable), mintable flag, holders count, and verification status.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Jetton master contract address",
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/jettons/${params.account_id}`);
          const m = data.metadata ?? {};
          const decimals = Number(m.decimals ?? 9);
          const rawSupply = data.total_supply ?? "0";
          const humanSupply = Number(rawSupply) / Math.pow(10, decimals);
          return {
            success: true,
            data: {
              address: m.address ?? data.address ?? params.account_id,
              name: m.name ?? null,
              symbol: m.symbol ?? null,
              decimals,
              image: m.image ?? null,
              description: m.description ?? null,
              total_supply_raw: rawSupply,
              total_supply: humanSupply,
              mintable: data.mintable ?? null,
              holders_count: data.holders_count ?? null,
              verification: data.verification ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_jetton_holders",
      description:
        "List top holders of a jetton by master contract address from TONAPI. Returns each holder's owner address, name, is_wallet flag, and raw balance. Note: divide raw balance by 10^decimals (from tonapi_jetton_info) to get human-readable amounts.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Jetton master contract address",
          },
          limit: {
            type: "integer",
            description: "Number of holders to return, 1-1000 (default: 100)",
            minimum: 1,
            maximum: 1000,
          },
          offset: {
            type: "integer",
            description: "Pagination offset (default: 0)",
            minimum: 0,
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/jettons/${params.account_id}/holders`, {
            limit: params.limit ?? 100,
            offset: params.offset ?? 0,
          });
          const holders = (data.addresses ?? []).map((h) => ({
            owner_address: h.owner?.address ?? null,
            owner_name: h.owner?.name ?? null,
            is_wallet: h.owner?.is_wallet ?? null,
            balance_raw: h.balance ?? null,
          }));
          return {
            success: true,
            data: {
              total: data.total ?? holders.length,
              holders,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_rates",
      description:
        "Get current exchange rates for one or more TON tokens from TONAPI. Pass comma-separated addresses (use \"ton\" for native TON). Returns prices in the requested currencies (default: TON and USD).",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          tokens: {
            type: "string",
            description: "Comma-separated token addresses; use \"ton\" for native TON (e.g. \"ton,EQBynBO23ywH...\")",
          },
          currencies: {
            type: "string",
            description: "Comma-separated currency codes (default: \"ton,usd\")",
          },
        },
        required: ["tokens"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch("/v2/rates", {
            tokens: params.tokens,
            currencies: params.currencies ?? "ton,usd",
          });
          const rates = data.rates ?? {};
          const result = Object.entries(rates).map(([token, info]) => ({
            token,
            prices: info.prices ?? {},
          }));
          return { success: true, data: result };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_rates_chart",
      description:
        "Get historical price chart data for a token from TONAPI. Returns timestamp-value data points. Optionally specify a date range with unix timestamps.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token address or \"ton\" for native TON",
          },
          currency: {
            type: "string",
            description: "Price currency (default: \"usd\")",
          },
          start_date: {
            type: "integer",
            description: "Start of range as unix timestamp (optional)",
          },
          end_date: {
            type: "integer",
            description: "End of range as unix timestamp (optional)",
          },
        },
        required: ["token"],
      },
      execute: async (params) => {
        try {
          const query = {
            token: params.token,
            currency: params.currency ?? "usd",
          };
          if (params.start_date != null) query.start_date = params.start_date;
          if (params.end_date != null) query.end_date = params.end_date;
          const data = await tonapiFetch("/v2/rates/chart", query);
          return { success: true, data: { points: data.points ?? data } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // NFT
    {
      name: "tonapi_nft_collection",
      description:
        "Get NFT collection details by contract address from TONAPI. Returns collection name, description, image, owner, and item count. Use when the user wants to inspect a specific NFT collection on TON.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "NFT collection contract address",
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/nfts/collections/${params.account_id}`);
          const metadata = data.metadata ?? {};
          const previews = (data.previews ?? []).map((p) => ({
            resolution: p.resolution ?? null,
            url: p.url ?? null,
          }));
          return {
            success: true,
            data: {
              address: data.address ?? null,
              name: metadata.name ?? null,
              description: metadata.description ?? null,
              image: metadata.image ?? null,
              owner: data.owner
                ? { address: data.owner.address ?? null, name: data.owner.name ?? null }
                : null,
              item_count: data.next_item_index ?? null,
              previews,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_nft_items",
      description:
        "List NFT items in a collection from TONAPI. Returns a compact summary per item: address, index, owner, name, image, sale status, and verification. Use when the user wants to browse items in a TON NFT collection.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "NFT collection contract address",
          },
          limit: {
            type: "integer",
            description: "Number of items to return, 1-1000 (default: 50)",
            minimum: 1,
            maximum: 1000,
          },
          offset: {
            type: "integer",
            description: "Offset for pagination (default: 0)",
            minimum: 0,
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/nfts/collections/${params.account_id}/items`, {
            limit: params.limit ?? 50,
            offset: params.offset ?? 0,
          });
          const items = (data.nft_items ?? []).map((item) => {
            const meta = item.metadata ?? {};
            return {
              address: item.address ?? null,
              index: item.index ?? null,
              owner: item.owner
                ? { address: item.owner.address ?? null, name: item.owner.name ?? null }
                : null,
              name: meta.name ?? null,
              description: meta.description ?? null,
              image: meta.image ?? null,
              verified: item.verified ?? false,
              on_sale: item.sale != null,
            };
          });
          return { success: true, data: { items } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_nft_item",
      description:
        "Get detailed information about a single NFT item from TONAPI. Returns metadata (name, description, image, attributes), owner, collection, sale info (marketplace, price), previews, and verification status. Use when the user wants full details on a specific NFT.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "NFT item contract address",
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/nfts/${params.account_id}`);
          const metadata = data.metadata ?? {};
          const previews = (data.previews ?? []).map((p) => ({
            resolution: p.resolution ?? null,
            url: p.url ?? null,
          }));
          const sale = data.sale
            ? {
                marketplace: data.sale.market?.name ?? data.sale.marketplace ?? null,
                price: data.sale.price
                  ? {
                      value: data.sale.price.value ?? null,
                      token_name: data.sale.price.token_name ?? null,
                    }
                  : null,
              }
            : null;
          const attributes = (metadata.attributes ?? []).map((a) => ({
            trait: a.trait_type ?? null,
            value: a.value ?? null,
          }));
          return {
            success: true,
            data: {
              address: data.address ?? null,
              index: data.index ?? null,
              owner: data.owner
                ? { address: data.owner.address ?? null, name: data.owner.name ?? null }
                : null,
              collection: data.collection
                ? { address: data.collection.address ?? null, name: data.collection.name ?? null }
                : null,
              name: metadata.name ?? null,
              description: metadata.description ?? null,
              image: metadata.image ?? null,
              attributes,
              previews,
              sale,
              verified: data.verified ?? false,
              approved_by: data.approved_by ?? [],
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // Blockchain
    {
      name: "tonapi_transaction",
      description:
        "Look up a specific TON blockchain transaction by its hash. Returns key fields: hash, account address, success status, timestamp, total fees (in TON), in_msg summary (source, destination, value), out_msgs count, and transaction type.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          transaction_id: {
            type: "string",
            description: "Transaction hash to look up",
          },
        },
        required: ["transaction_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(
            `/v2/blockchain/transactions/${params.transaction_id}`
          );
          const feesNano = Number(data.total_fees ?? 0);
          const inMsg = data.in_msg ?? null;
          return {
            success: true,
            data: {
              hash: data.hash ?? null,
              lt: data.lt ?? null,
              account: data.account?.address ?? data.account ?? null,
              success: data.success ?? null,
              timestamp: data.utime ?? null,
              orig_status: data.orig_status ?? null,
              end_status: data.end_status ?? null,
              total_fees_ton: feesNano / 1e9,
              transaction_type: data.transaction_type ?? null,
              in_msg: inMsg
                ? {
                    source: inMsg.source?.address ?? inMsg.source ?? null,
                    destination:
                      inMsg.destination?.address ?? inMsg.destination ?? null,
                    value_ton: Number(inMsg.value ?? 0) / 1e9,
                  }
                : null,
              out_msgs_count: (data.out_msgs ?? []).length,
              description: data.description ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_trace",
      description:
        "Get the execution trace for a TON transaction. Shows the full chain of internal messages as a flattened list of steps with depth, hash, account, success status, and timestamp. Use to understand how a transaction propagated through contracts.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          trace_id: {
            type: "string",
            description: "Trace hash (same as the transaction hash)",
          },
        },
        required: ["trace_id"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/traces/${params.trace_id}`);

          const steps = [];
          function flatten(node, depth) {
            const tx = node.transaction ?? {};
            steps.push({
              depth,
              hash: tx.hash ?? null,
              account: tx.account?.address ?? tx.account ?? null,
              success: tx.success ?? null,
              timestamp: tx.utime ?? null,
            });
            for (const child of node.children ?? []) {
              flatten(child, depth + 1);
            }
          }
          flatten(data, 0);

          return { success: true, data: { steps } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_validators",
      description:
        "List current TON blockchain validators with their stake amounts. Returns an array of validators with address, stake in TON, and max_factor. Also includes election timing (elect_at, elect_close) if available.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async () => {
        try {
          const data = await tonapiFetch("/v2/blockchain/validators");
          const validators = (data.validators ?? []).map((v) => ({
            address: v.address ?? v.adnl_address ?? null,
            stake_ton: Number(v.stake ?? 0) / 1e9,
            max_factor: v.max_factor ?? null,
          }));
          return {
            success: true,
            data: {
              elect_at: data.elect_at ?? null,
              elect_close: data.elect_close ?? null,
              validators,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },

    // DNS & Staking
    {
      name: "tonapi_dns_resolve",
      description:
        "Resolve a .ton domain to its wallet and/or site address. Use when the user wants to look up which address a TON domain name points to. Returns wallet address, site address, and other DNS records if available.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          domain_name: {
            type: "string",
            description: 'TON domain name to resolve (e.g. "wallet.ton", "foundation.ton")',
          },
        },
        required: ["domain_name"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/dns/${encodeURIComponent(params.domain_name)}/resolve`);
          return {
            success: true,
            data: {
              wallet: data.wallet?.address ?? null,
              site: data.site ?? null,
              storage: data.storage ?? null,
              next_resolver: data.next_resolver ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_dns_info",
      description:
        "Get domain info for a .ton domain including owner, expiry date, and NFT item address. Use when the user wants ownership or registration details for a TON domain.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          domain_name: {
            type: "string",
            description: 'TON domain name (e.g. "wallet.ton", "foundation.ton")',
          },
        },
        required: ["domain_name"],
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch(`/v2/dns/${encodeURIComponent(params.domain_name)}`);
          return {
            success: true,
            data: {
              name: data.name ?? null,
              expiring_at: data.expiring_at
                ? new Date(data.expiring_at * 1000).toISOString()
                : null,
              owner: data.item?.owner?.address ?? null,
              nft_address: data.item?.address ?? null,
              metadata: data.item?.metadata ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_dns_auctions",
      description:
        "List active .ton domain auctions. Use when the user wants to see which TON domains are currently up for auction and their prices. Returns domain names, current bids in TON, bidders, and auction dates.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          tld: {
            type: "string",
            description: 'Top-level domain filter (default: "ton")',
          },
        },
      },
      execute: async (params) => {
        try {
          const data = await tonapiFetch("/v2/dns/auctions", {
            tld: params.tld ?? "ton",
          });
          const auctions = (data.data ?? []).map((a) => ({
            domain: a.domain ?? null,
            owner: a.owner ?? null,
            price_ton: a.price != null ? Number(a.price) / 1e9 : null,
            date: a.date != null ? new Date(a.date * 1000).toISOString() : null,
            bids: a.bids ?? null,
          }));
          return { success: true, data: { auctions } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_staking_pools",
      description:
        "List available staking pools on the TON blockchain. Returns pool addresses, names, APY, total staked amount, min stake, implementation type, nominator counts, and verification status. Optionally filter by an account address to check eligibility.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          available_for: {
            type: "string",
            description: "Account address to check staking eligibility for (optional)",
          },
        },
      },
      execute: async (params) => {
        try {
          const query = {};
          if (params.available_for) query.available_for = params.available_for;
          const data = await tonapiFetch("/v2/staking/pools", query);
          const pools = (data.pools ?? []).map((p) => ({
            address: p.address ?? null,
            name: p.name ?? null,
            implementation: p.implementation ?? null,
            apy: p.apy != null ? `${p.apy}%` : null,
            total_amount_ton: p.total_amount != null ? Number(p.total_amount) / 1e9 : null,
            min_stake_ton: p.min_stake != null ? Number(p.min_stake) / 1e9 : null,
            current_nominators: p.current_nominators ?? null,
            max_nominators: p.max_nominators ?? null,
            verified: p.verified ?? null,
            cycle_start: p.cycle_start != null ? new Date(p.cycle_start * 1000).toISOString() : null,
            cycle_end: p.cycle_end != null ? new Date(p.cycle_end * 1000).toISOString() : null,
          }));
          return { success: true, data: { pools } };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
    {
      name: "tonapi_staking_pool",
      description:
        "Get detailed info for a specific TON staking pool by its contract address. Returns pool name, APY, total staked amount, min stake, implementation type, nominator counts, cycle times, and verification status.",
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Staking pool contract address",
          },
        },
        required: ["account_id"],
      },
      execute: async (params) => {
        try {
          const p = await tonapiFetch(`/v2/staking/pool/${encodeURIComponent(params.account_id)}`);
          return {
            success: true,
            data: {
              address: p.address ?? null,
              name: p.name ?? null,
              implementation: p.implementation ?? null,
              apy: p.apy != null ? `${p.apy}%` : null,
              total_amount_ton: p.total_amount != null ? Number(p.total_amount) / 1e9 : null,
              min_stake_ton: p.min_stake != null ? Number(p.min_stake) / 1e9 : null,
              current_nominators: p.current_nominators ?? null,
              max_nominators: p.max_nominators ?? null,
              verified: p.verified ?? null,
              cycle_start: p.cycle_start != null ? new Date(p.cycle_start * 1000).toISOString() : null,
              cycle_end: p.cycle_end != null ? new Date(p.cycle_end * 1000).toISOString() : null,
              nominators_count: p.nominators_count ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message || err).slice(0, 500) };
        }
      },
    },
  ];
};
