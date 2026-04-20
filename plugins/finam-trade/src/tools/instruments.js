import { accountIdProperty, createTool, emptyParameters, symbolProperty } from "./common.js";
import {
  compact,
  decimalString,
  encodePath,
  getCache,
  mapAsset,
  moneyValue,
  normalizeSymbol,
  setCache,
} from "../utils.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

export function instrumentTools({ client, sdk, cacheTtlMs = CACHE_TTL_MS }) {
  return [
    createTool(
      sdk,
      {
        name: "finam_get_instrument",
        description:
          "Get detailed Finam instrument information by symbol: ticker, MIC, type, name, currency, lot size, min step, and derivative details.",
        parameters: {
          type: "object",
          properties: {
            symbol: symbolProperty,
            account_id: {
              ...accountIdProperty,
              description: "Optional account ID for account-specific instrument information.",
            },
          },
          required: ["symbol"],
        },
      },
      async (params) => {
        const symbol = normalizeSymbol(params.symbol);
        const data = await client.get(`/v1/assets/${encodePath(symbol)}`, {
          query: compact({ account_id: params.account_id }),
        });
        return {
          ...mapAsset({ ...data, symbol: data.symbol ?? symbol }),
          expiration_date: data.expiration_date ?? null,
          future_details: data.future_details ?? null,
          option_details: data.option_details ?? null,
          bond_details: data.bond_details ?? null,
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_asset_params",
        description:
          "Get account-specific trading parameters for an instrument, including tradeability, long/short availability, risk rates, and margin values.",
        parameters: {
          type: "object",
          properties: {
            symbol: symbolProperty,
            account_id: accountIdProperty,
          },
          required: ["symbol"],
        },
      },
      async (params) => {
        const symbol = normalizeSymbol(params.symbol);
        const data = await client.get(`/v1/assets/${encodePath(symbol)}/params`, {
          query: compact({ account_id: params.account_id }),
        });
        return {
          symbol: data.symbol ?? symbol,
          account_id: data.account_id ?? params.account_id ?? null,
          tradeable: data.tradeable ?? data.is_tradable ?? null,
          longable: data.longable ?? null,
          shortable: data.shortable ?? null,
          long_risk_rate: decimalString(data.long_risk_rate),
          short_risk_rate: decimalString(data.short_risk_rate),
          long_collateral: moneyValue(data.long_collateral),
          short_collateral: moneyValue(data.short_collateral),
          long_initial_margin: moneyValue(data.long_initial_margin),
          short_initial_margin: moneyValue(data.short_initial_margin),
          price_type: data.price_type ?? null,
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_instruments_list",
        description:
          "Get Finam instruments with pagination. Supports cursor, active/archive filters, and optional client-side MIC filtering.",
        parameters: {
          type: "object",
          properties: {
            cursor: { type: "string", description: "Pagination cursor from next_cursor." },
            only_active: { type: "boolean", description: "Return only non-archived instruments." },
            only_disabled: { type: "boolean", description: "Return only archived instruments." },
            mic: { type: "string", description: "Optional client-side MIC filter, for example MISX." },
            use_cache: { type: "boolean", description: "Use sdk.db cache when available. Default: true." },
          },
        },
      },
      async (params) => {
        const query = compact({
          cursor: params.cursor,
          only_active: params.only_active,
          only_disabled: params.only_disabled,
        });
        const cacheKey = `assets:${JSON.stringify(query)}`;
        let data = params.use_cache === false ? null : getCache(sdk, cacheKey);
        if (!data) {
          data = await client.get("/v1/assets/all", { query });
          setCache(sdk, cacheKey, data, cacheTtlMs);
        }

        const mic = params.mic ? String(params.mic).toUpperCase() : null;
        const instruments = (data.assets ?? [])
          .filter((asset) => !mic || String(asset.mic).toUpperCase() === mic)
          .map(mapAsset);
        return { instruments, next_cursor: data.next_cursor ?? null };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_tradeable_instruments",
        description: "Get the Finam API list of currently available trading instruments.",
        parameters: emptyParameters,
      },
      async () => {
        const cacheKey = "assets:tradeable";
        let data = getCache(sdk, cacheKey);
        if (!data) {
          data = await client.get("/v1/assets");
          setCache(sdk, cacheKey, data, cacheTtlMs);
        }
        return { instruments: (data.assets ?? []).map(mapAsset) };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_exchanges",
        description: "Get Finam supported exchanges and MIC codes.",
        parameters: emptyParameters,
      },
      async () => {
        const cacheKey = "exchanges";
        let data = getCache(sdk, cacheKey);
        if (!data) {
          data = await client.get("/v1/exchanges");
          setCache(sdk, cacheKey, data, cacheTtlMs);
        }
        return { exchanges: data.exchanges ?? [] };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_schedule",
        description: "Get trading schedule sessions for a Finam instrument.",
        parameters: {
          type: "object",
          properties: {
            symbol: symbolProperty,
          },
          required: ["symbol"],
        },
      },
      async (params) => {
        const symbol = normalizeSymbol(params.symbol);
        const data = await client.get(`/v1/assets/${encodePath(symbol)}/schedule`);
        return {
          symbol: data.symbol ?? symbol,
          sessions: (data.sessions ?? []).map((session) => ({
            type: session.type ?? null,
            start: session.interval?.start_time ?? null,
            end: session.interval?.end_time ?? null,
          })),
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_clock",
        description: "Get current Finam API server time.",
        parameters: emptyParameters,
      },
      async () => client.get("/v1/assets/clock")
    ),

    createTool(
      sdk,
      {
        name: "finam_get_constituents",
        description: "Get index constituents for a Finam index symbol, with optional cursor pagination.",
        parameters: {
          type: "object",
          properties: {
            symbol: symbolProperty,
            cursor: { type: "string" },
          },
          required: ["symbol"],
        },
      },
      async (params) => {
        const symbol = normalizeSymbol(params.symbol);
        const data = await client.get(`/v1/assets/${encodePath(symbol)}/constituents`, {
          query: compact({ cursor: params.cursor }),
        });
        return {
          symbol,
          constituents: (data.assets ?? data.constituents ?? []).map(mapAsset),
          next_cursor: data.next_cursor ?? null,
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_options_chain",
        description:
          "Get an options chain for a Finam underlying symbol. Supports root and expiration date filters.",
        parameters: {
          type: "object",
          properties: {
            underlying_symbol: symbolProperty,
            root: { type: "string" },
            expiration_year: { type: "integer", minimum: 1, maximum: 9999 },
            expiration_month: { type: "integer", minimum: 1, maximum: 12 },
            expiration_day: { type: "integer", minimum: 1, maximum: 31 },
          },
          required: ["underlying_symbol"],
        },
      },
      async (params) => {
        const symbol = normalizeSymbol(params.underlying_symbol);
        const data = await client.get(`/v1/assets/${encodePath(symbol)}/options`, {
          query: compact({
            root: params.root,
            "expiration_date.year": params.expiration_year,
            "expiration_date.month": params.expiration_month,
            "expiration_date.day": params.expiration_day,
          }),
        });
        return data;
      }
    ),
  ];
}
