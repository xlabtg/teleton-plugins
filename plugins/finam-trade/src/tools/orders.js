import { accountIdProperty, createTool, symbolProperty } from "./common.js";
import {
  compact,
  decimalValue,
  encodePath,
  mapOrder,
  normalizeOrderSide,
  normalizeOrderType,
  normalizeStopCondition,
  normalizeSymbol,
  normalizeTimeInForce,
  normalizeTpSpreadMeasure,
  normalizeValidBefore,
} from "../utils.js";

export function orderTools({ client, sdk }) {
  return [
    createTool(
      sdk,
      {
        name: "finam_place_order",
        description:
          "Place a Finam exchange order. Supports market, limit, stop market, stop limit, time-in-force, client order ID, comment, and multi-leg payloads.",
        category: "action",
        scope: "dm-only",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            symbol: symbolProperty,
            quantity: { type: "string", description: "Order quantity as a decimal string." },
            side: { type: "string", enum: ["buy", "sell", "SIDE_BUY", "SIDE_SELL"] },
            type: {
              type: "string",
              description: "market, limit, stop, stop_limit, multi_leg, or Finam ORDER_TYPE_*.",
            },
            limit_price: { type: "string", description: "Limit price for limit and stop-limit orders." },
            stop_price: { type: "string", description: "Stop activation price for stop orders." },
            stop_condition: { type: "string", description: "last_up, last_down, or STOP_CONDITION_*." },
            time_in_force: { type: "string", description: "day, gtc, ioc, fok, or TIME_IN_FORCE_*." },
            client_order_id: { type: "string" },
            valid_before: { type: "string", description: "day, till_cancelled, specified, or VALID_BEFORE_*." },
            comment: { type: "string" },
            legs: { type: "array", description: "Optional multi-leg order legs in Finam API shape." },
          },
          required: ["account_id", "symbol", "quantity", "side", "type"],
        },
      },
      async (params) => {
        const body = compact({
          symbol: normalizeSymbol(params.symbol),
          quantity: decimalValue(params.quantity, "quantity"),
          side: normalizeOrderSide(params.side),
          type: normalizeOrderType(params.type),
          time_in_force: normalizeTimeInForce(params.time_in_force ?? "day"),
          limit_price: decimalValue(params.limit_price, "limit_price"),
          stop_price: decimalValue(params.stop_price, "stop_price"),
          stop_condition: normalizeStopCondition(params.stop_condition),
          client_order_id: params.client_order_id,
          valid_before: normalizeValidBefore(params.valid_before),
          comment: params.comment,
          legs: normalizeLegs(params.legs),
        });
        const data = await client.post(`/v1/accounts/${encodePath(params.account_id)}/orders`, body);
        return {
          order_id: data.order_id ?? data.order?.order_id ?? null,
          raw: data,
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_cancel_order",
        description: "Cancel an active Finam order by account ID and order ID.",
        category: "action",
        scope: "dm-only",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            order_id: { type: "string", description: "Finam order ID." },
          },
          required: ["account_id", "order_id"],
        },
      },
      async (params) => {
        const data = await client.delete(
          `/v1/accounts/${encodePath(params.account_id)}/orders/${encodePath(params.order_id)}`
        );
        return { order_id: params.order_id, cancelled: true, raw: data };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_orders",
        description: "Get active and recent orders for a Finam account, optionally filtered by symbol.",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            symbol: { type: "string", description: "Optional symbol filter." },
          },
          required: ["account_id"],
        },
      },
      async (params) => {
        const data = await client.get(`/v1/accounts/${encodePath(params.account_id)}/orders`);
        const symbol = params.symbol ? String(params.symbol).toUpperCase() : null;
        const orders = (data.orders ?? [])
          .filter((order) => !symbol || String(order.symbol).toUpperCase() === symbol)
          .map(mapOrder);
        return { account_id: params.account_id, orders };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_order_status",
        description: "Get detailed status for a specific Finam order, including filled quantity and reject reason when present.",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            order_id: { type: "string", description: "Finam order ID." },
          },
          required: ["account_id", "order_id"],
        },
      },
      async (params) => {
        const data = await client.get(
          `/v1/accounts/${encodePath(params.account_id)}/orders/${encodePath(params.order_id)}`
        );
        const order = data.order ?? data;
        return { ...mapOrder(order), raw: data };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_place_sltp",
        description:
          "Place Finam stop-loss and/or take-profit orders for an existing position. Supports SL price, TP price, quantities, guard spread, and client order ID.",
        category: "action",
        scope: "dm-only",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            symbol: symbolProperty,
            side: { type: "string", enum: ["buy", "sell", "SIDE_BUY", "SIDE_SELL"] },
            quantity_sl: { type: "string", description: "Stop-loss quantity." },
            sl_price: { type: "string", description: "Stop-loss trigger price." },
            limit_price: { type: "string", description: "Optional limit price." },
            quantity_tp: { type: "string", description: "Take-profit quantity." },
            tp_price: { type: "string", description: "Take-profit price." },
            tp_guard_spread: { type: "string", description: "Take-profit guard spread." },
            tp_spread_measure: { type: "string", description: "percent, points, or TP_SPREAD_MEASURE_*." },
            client_order_id: { type: "string" },
            valid_before: { type: "string" },
            valid_expiry_time: { type: "string", description: "Expiry timestamp for VALID_BEFORE_SPECIFIED." },
            comment: { type: "string" },
          },
          required: ["account_id", "symbol", "side"],
        },
      },
      async (params) => {
        const body = compact({
          symbol: normalizeSymbol(params.symbol),
          side: normalizeOrderSide(params.side),
          quantity_sl: decimalValue(params.quantity_sl, "quantity_sl"),
          sl_price: decimalValue(params.sl_price, "sl_price"),
          limit_price: decimalValue(params.limit_price, "limit_price"),
          quantity_tp: decimalValue(params.quantity_tp, "quantity_tp"),
          tp_price: decimalValue(params.tp_price, "tp_price"),
          tp_guard_spread: decimalValue(params.tp_guard_spread, "tp_guard_spread"),
          tp_spread_measure: normalizeTpSpreadMeasure(params.tp_spread_measure),
          client_order_id: params.client_order_id,
          valid_before: normalizeValidBefore(params.valid_before),
          valid_expiry_time: params.valid_expiry_time,
          comment: params.comment,
        });
        const data = await client.post(`/v1/accounts/${encodePath(params.account_id)}/sltp-orders`, body);
        return {
          sl_order_id: data.sl_order_id ?? null,
          tp_order_id: data.tp_order_id ?? null,
          raw: data,
        };
      }
    ),
  ];
}

function normalizeLegs(legs) {
  if (!Array.isArray(legs)) return undefined;
  return legs.map((leg) => compact({
    symbol: leg.symbol ? normalizeSymbol(leg.symbol) : undefined,
    quantity: decimalValue(leg.quantity, "legs.quantity"),
    side: normalizeOrderSide(leg.side),
  }));
}
