import { accountIdProperty, createTool } from "./common.js";
import {
  encodePath,
  mapCash,
  mapPosition,
  mapTrade,
  moneyValue,
  withIntervalQuery,
} from "../utils.js";

export function accountTools({ client, auth, sdk }) {
  return [
    createTool(
      sdk,
      {
        name: "finam_get_accounts",
        description:
          "List Finam trading accounts available to the configured FINAM_SECRET. Optionally expands each account with type and status.",
        parameters: {
          type: "object",
          properties: {
            include_details: {
              type: "boolean",
              description: "Fetch account details for every account ID. Default: true.",
            },
          },
        },
      },
      async (params) => {
        const details = await auth.getTokenDetails();
        const accountIds = details.account_ids ?? details.accounts ?? [];
        const includeDetails = params.include_details !== false;

        if (!includeDetails) {
          return {
            accounts: accountIds.map((accountId) => ({
              account_id: accountId,
              name: null,
              type: null,
              status: null,
            })),
            readonly: details.readonly ?? null,
            md_permissions: details.md_permissions ?? [],
          };
        }

        const accounts = [];
        for (const accountId of accountIds) {
          const account = await client.get(`/v1/accounts/${encodePath(accountId)}`);
          accounts.push({
            account_id: account.account_id ?? accountId,
            name: account.name ?? null,
            type: account.type ?? null,
            status: account.status ?? null,
            equity: moneyValue(account.equity),
            open_account_date: account.open_account_date ?? null,
          });
        }

        return {
          accounts,
          readonly: details.readonly ?? null,
          md_permissions: details.md_permissions ?? [],
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_account_info",
        description:
          "Get Finam account details: equity, unrealized PnL, margin fields, cash, positions, and account dates.",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
          },
          required: ["account_id"],
        },
      },
      async (params) => {
        const account = await client.get(`/v1/accounts/${encodePath(params.account_id)}`);
        return {
          account_id: account.account_id ?? params.account_id,
          type: account.type ?? null,
          status: account.status ?? null,
          equity: moneyValue(account.equity),
          pnl: moneyValue(account.unrealized_profit),
          margin: moneyValue(account.portfolio_mc?.maintenance_margin),
          buying_power: moneyValue(account.portfolio_mc?.available_cash),
          portfolio_mc: account.portfolio_mc ?? null,
          portfolio_mct: account.portfolio_mct ?? null,
          portfolio_forts: account.portfolio_forts ?? null,
          open_account_date: account.open_account_date ?? null,
          first_trade_date: account.first_trade_date ?? null,
          first_non_trade_date: account.first_non_trade_date ?? null,
          positions: (account.positions ?? []).map(mapPosition),
          cash: (account.cash ?? []).map(mapCash),
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_positions",
        description:
          "List open positions for a Finam account, optionally filtered by symbol. Returns quantities, average/current prices, and PnL.",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            symbol: {
              type: "string",
              description: "Optional symbol filter, for example SBER@MISX.",
            },
          },
          required: ["account_id"],
        },
      },
      async (params) => {
        const account = await client.get(`/v1/accounts/${encodePath(params.account_id)}`);
        const symbol = params.symbol ? String(params.symbol).toUpperCase() : null;
        const positions = (account.positions ?? [])
          .filter((position) => !symbol || String(position.symbol).toUpperCase() === symbol)
          .map(mapPosition);
        return { account_id: account.account_id ?? params.account_id, positions };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_cash",
        description: "Get available cash balances by currency for a Finam account.",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
          },
          required: ["account_id"],
        },
      },
      async (params) => {
        const account = await client.get(`/v1/accounts/${encodePath(params.account_id)}`);
        return {
          account_id: account.account_id ?? params.account_id,
          cash: (account.cash ?? []).map(mapCash),
        };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_trades",
        description:
          "Get executed trade history for a Finam account with optional limit, ISO start/end interval, and symbol filter.",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            limit: { type: "integer", minimum: 1, maximum: 1000 },
            start_time: { type: "string", description: "Inclusive ISO timestamp." },
            end_time: { type: "string", description: "Exclusive ISO timestamp." },
            symbol: { type: "string", description: "Optional symbol filter." },
          },
          required: ["account_id"],
        },
      },
      async (params) => {
        const data = await client.get(`/v1/accounts/${encodePath(params.account_id)}/trades`, {
          query: withIntervalQuery(params),
        });
        const symbol = params.symbol ? String(params.symbol).toUpperCase() : null;
        const trades = (data.trades ?? [])
          .filter((trade) => !symbol || String(trade.symbol).toUpperCase() === symbol)
          .map(mapTrade);
        return { account_id: params.account_id, trades };
      }
    ),

    createTool(
      sdk,
      {
        name: "finam_get_transactions",
        description:
          "Get account transaction history, including cash changes, trade-linked transactions, and transaction categories.",
        parameters: {
          type: "object",
          properties: {
            account_id: accountIdProperty,
            limit: { type: "integer", minimum: 1, maximum: 1000 },
            start_time: { type: "string", description: "Inclusive ISO timestamp." },
            end_time: { type: "string", description: "Exclusive ISO timestamp." },
          },
          required: ["account_id"],
        },
      },
      async (params) => {
        const data = await client.get(`/v1/accounts/${encodePath(params.account_id)}/transactions`, {
          query: withIntervalQuery(params),
        });
        return {
          account_id: params.account_id,
          transactions: (data.transactions ?? []).map((tx) => ({
            tx_id: tx.id ?? null,
            type: tx.transaction_category ?? tx.category ?? null,
            name: tx.transaction_name ?? null,
            symbol: tx.symbol ?? null,
            amount: moneyValue(tx.change),
            currency: tx.change?.currency_code ?? null,
            timestamp: tx.timestamp ?? null,
            quantity: tx.change_qty?.value ?? null,
            trade: tx.trade ?? null,
          })),
        };
      }
    ),
  ];
}
