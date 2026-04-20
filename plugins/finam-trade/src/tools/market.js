import { createTool, symbolProperty } from "./common.js";
import {
  decimalNumber,
  decimalString,
  encodePath,
  mapTrade,
  normalizeSymbol,
  normalizeTimeframe,
  withIntervalQuery,
} from "../utils.js";

export function marketTools({ client, sdk }) {
  return [
    createTool(
      sdk,
      {
        name: "finam_get_bars",
        description:
          "Get historical candle bars for a Finam instrument. Supports M1, M5, M15, M30, H1, H2, H4, H8, D, W, MN, and QR timeframes.",
        parameters: {
          type: "object",
          properties: {
            symbol: symbolProperty,
            interval: {
              type: "string",
              description: "Friendly timeframe alias such as 1m, 5m, 1h, 1d, or Finam TIME_FRAME_*.",
            },
            timeframe: {
              type: "string",
              description: "Alias for interval. Used when already passing Finam TIME_FRAME_*.",
            },
            start_time: { type: "string", description: "Inclusive ISO timestamp." },
            end_time: { type: "string", description: "Exclusive ISO timestamp." },
          },
          required: ["symbol"],
        },
      },
      async (params) => {
        const symbol = normalizeSymbol(params.symbol);
        const data = await client.get(`/v1/instruments/${encodePath(symbol)}/bars`, {
          query: {
            ...withIntervalQuery(params),
            timeframe: normalizeTimeframe(params.timeframe ?? params.interval ?? "D"),
          },
        });
        return {
          symbol: data.symbol ?? symbol,
          bars: (data.bars ?? []).map((bar) => ({
            timestamp: bar.timestamp ?? null,
            open: decimalNumber(bar.open),
            high: decimalNumber(bar.high),
            low: decimalNumber(bar.low),
            close: decimalNumber(bar.close),
            volume: decimalNumber(bar.volume),
            raw_open: decimalString(bar.open),
            raw_high: decimalString(bar.high),
            raw_low: decimalString(bar.low),
            raw_close: decimalString(bar.close),
            raw_volume: decimalString(bar.volume),
          })),
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_latest_trades",
        description: "Get latest public trades for a Finam instrument, including price, size, side, and timestamp.",
        parameters: {
          type: "object",
          properties: {
            symbol: symbolProperty,
            limit: { type: "integer", minimum: 1, description: "Optional client-side maximum result count." },
          },
          required: ["symbol"],
        },
      },
      async (params) => {
        const symbol = normalizeSymbol(params.symbol);
        const data = await client.get(`/v1/instruments/${encodePath(symbol)}/trades/latest`);
        const trades = (data.trades ?? []).slice(0, params.limit ?? undefined).map(mapTrade);
        return { symbol: data.symbol ?? symbol, trades };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_orderbook",
        description:
          "Get the current Finam order book for an instrument. Returns normalized bid/ask rows and the raw rows from the API.",
        parameters: {
          type: "object",
          properties: {
            symbol: symbolProperty,
            depth: { type: "integer", minimum: 1, description: "Optional client-side number of price levels to return." },
          },
          required: ["symbol"],
        },
      },
      async (params) => {
        const symbol = normalizeSymbol(params.symbol);
        const data = await client.get(`/v1/instruments/${encodePath(symbol)}/orderbook`);
        const rows = data.orderbook?.rows ?? [];
        const bids = [];
        const asks = [];
        for (const row of rows) {
          const price = decimalNumber(row.price);
          const buySize = decimalNumber(row.buy_size);
          const sellSize = decimalNumber(row.sell_size);
          if (buySize) bids.push([price, buySize]);
          if (sellSize) asks.push([price, sellSize]);
        }
        return {
          symbol: data.symbol ?? symbol,
          bids: bids.slice(0, params.depth ?? undefined),
          asks: asks.slice(0, params.depth ?? undefined),
          rows: rows.slice(0, params.depth ?? undefined).map((row) => ({
            price: decimalNumber(row.price),
            buy_size: decimalNumber(row.buy_size),
            sell_size: decimalNumber(row.sell_size),
            action: row.action ?? null,
            mpid: row.mpid ?? null,
            timestamp: row.timestamp ?? null,
          })),
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_last_quote",
        description: "Get the latest quote snapshot for a Finam instrument.",
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
        const data = await client.get(`/v1/instruments/${encodePath(symbol)}/quotes/latest`);
        return { symbol: data.symbol ?? symbol, quote: data.quote ?? data };
      }
    ),
  ];
}
