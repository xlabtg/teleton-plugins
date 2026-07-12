/**
 * Position-management tool tests for ton-trading-bot (issue #188).
 *
 * The three position tools (ton_trading_get_open_positions,
 * ton_trading_close_position, ton_trading_close_all_positions) are exported and
 * already exercised in index.test.js. This file is the dedicated, focused suite
 * requested by issue #188: it pins the public API surface against the README /
 * manifest schema and covers the acceptance-criteria scenarios end-to-end,
 * including the two edge cases that were not previously asserted explicitly —
 * a graceful failure when closing an already-closed trade, and the
 * compare-and-swap guard that prevents close_all_positions from double-closing.
 *
 * All TON and DB calls are mocked — no real network or disk access.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

const PLUGIN_DIR = resolve("plugins/ton-trading-bot");
const PLUGIN_URL = pathToFileURL(join(PLUGIN_DIR, "index.js")).href;

// ─── Minimal mock SDK ─────────────────────────────────────────────────────────

function makeSdk(overrides = {}) {
  return {
    pluginConfig: {
      maxTradePercent: 10,
      minBalanceTON: 1,
      defaultSlippage: 0.05,
      simulationBalance: 1000,
      ...overrides.pluginConfig,
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ton: {
      getAddress: () => "EQTestWalletAddress",
      getBalance: async () => ({ balance: "100.5", balanceNano: "100500000000" }),
      getPrice: async () => ({ usd: 3.5, source: "mock", timestamp: 1 }),
      getJettonBalances: async () => [],
      dex: {
        quote: async (params) => ({
          stonfi: { output: String(params.amount + 1), price: String(params.amount + 1) },
          recommended: "stonfi",
        }),
        swap: async (params) => ({ expectedOutput: "11", minOutput: "10.5", dex: params.dex ?? "stonfi" }),
      },
      ...overrides.ton,
    },
    telegram: { sendMessage: async () => 42, ...overrides.telegram },
    db: overrides.db,
    storage: { set: () => {}, get: () => undefined, has: () => false, delete: () => false, clear: () => {} },
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return { chatId: 123456789, senderId: 987654321, ...overrides };
}

// ─── Stateful in-memory trade journal ─────────────────────────────────────────
// Persists INSERTs and applies the open→closing→closed transitions so a full
// close cycle (and a racing double-close) can be exercised against real changes.
function makeStatefulDb(seedTrades = []) {
  const trades = seedTrades.map((t) => ({ ...t }));
  const simBalanceRows = [{ timestamp: 0, balance: 1000 }];

  return {
    _trades: trades,
    exec: () => {},
    prepare: (sql) => ({
      get: (...args) => {
        if (sql.includes("FROM sim_balance")) return simBalanceRows[simBalanceRows.length - 1] ?? null;
        if (sql.includes("FROM trade_journal") && sql.includes("WHERE id")) {
          return trades.find((t) => t.id === args[0]) ?? null;
        }
        return null;
      },
      all: (...args) => {
        if (!sql.includes("FROM trade_journal")) return [];
        let rows = trades.filter((t) => t.status === "open");
        // Mirror the tool's "WHERE status = 'open' [AND mode = ?]" filter so the
        // mode filter and limit can be asserted against real rows.
        if (sql.includes("AND mode = ?")) {
          const mode = args[0];
          rows = rows.filter((t) => t.mode === mode);
        }
        rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        const limit = args[args.length - 1];
        return typeof limit === "number" ? rows.slice(0, limit) : rows;
      },
      run: (...args) => {
        if (sql.includes("INSERT INTO sim_balance")) {
          simBalanceRows.push({ timestamp: args[0], balance: args[1] });
          return { lastInsertRowid: simBalanceRows.length, changes: 1 };
        }
        if (sql.includes("UPDATE trade_journal")) {
          // Full close: SET amount_out=?, ..., status='closed' WHERE id=? AND status!='closed'
          if (sql.includes("SET amount_out")) {
            const id = args[5];
            const row = trades.find((t) => t.id === id);
            if (!row || row.status === "closed") return { lastInsertRowid: id, changes: 0 };
            row.amount_out = args[0];
            row.exit_price_usd = args[1];
            row.pnl = args[2];
            row.pnl_percent = args[3];
            if (args[4] != null) row.note = args[4];
            row.status = "closed";
            return { lastInsertRowid: id, changes: 1 };
          }
          // Status compare-and-swap: claim / release / terminal.
          let target = null;
          if (sql.includes("SET status = 'closing'")) target = "closing";
          else if (sql.includes("SET status = 'open'")) target = "open";
          else if (sql.includes("SET status = 'close_failed'")) target = "close_failed";
          let guard = null;
          if (sql.includes("AND status = 'open'")) guard = "open";
          else if (sql.includes("AND status = 'closing'")) guard = "closing";
          const id = args[args.length - 1];
          const row = trades.find((t) => t.id === id);
          if (!row) return { lastInsertRowid: id, changes: 0 };
          if (guard && row.status !== guard) return { lastInsertRowid: id, changes: 0 };
          if (target === "close_failed" && args[0] != null) row.note = args[0];
          if (target) row.status = target;
          return { lastInsertRowid: id, changes: 1 };
        }
        return { lastInsertRowid: 1, changes: 1 };
      },
    }),
  };
}

function openTrade(overrides = {}) {
  return {
    id: 1,
    timestamp: 1710000000000,
    mode: "simulation",
    action: "buy",
    from_asset: "TON",
    to_asset: "EQToken",
    amount_in: 10,
    amount_out: 25,
    entry_price_usd: 2,
    exit_price_usd: null,
    pnl: null,
    pnl_percent: null,
    status: "open",
    note: null,
    ...overrides,
  };
}

// ─── Load plugin once ─────────────────────────────────────────────────────────

let mod;
before(async () => {
  mod = await import(PLUGIN_URL);
});

const findTool = (sdk, name) => mod.tools(sdk).find((t) => t.name === name);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ton-trading-bot position-management API (issue #188)", () => {
  it("exports all three position tools so calls no longer fail with 'tool not found'", () => {
    const names = mod.tools(makeSdk({ db: makeStatefulDb() })).map((t) => t.name);
    assert.ok(names.includes("ton_trading_get_open_positions"));
    assert.ok(names.includes("ton_trading_close_position"));
    assert.ok(names.includes("ton_trading_close_all_positions"));
  });

  describe("ton_trading_get_open_positions", () => {
    it("returns only status = 'open' trades", async () => {
      const db = makeStatefulDb([
        openTrade({ id: 1, status: "open" }),
        openTrade({ id: 2, status: "closed" }),
        openTrade({ id: 3, status: "closing" }),
        openTrade({ id: 4, status: "open" }),
      ]);
      const tool = findTool(makeSdk({ db }), "ton_trading_get_open_positions");
      const result = await tool.execute({ mode: "all" }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.count, 2);
      const ids = result.data.positions.map((p) => p.trade_id).sort((a, b) => a - b);
      assert.deepEqual(ids, [1, 4]);
    });

    it("respects the mode filter for real, simulation, and all", async () => {
      const db = makeStatefulDb([
        openTrade({ id: 1, mode: "simulation" }),
        openTrade({ id: 2, mode: "real" }),
        openTrade({ id: 3, mode: "simulation" }),
      ]);
      const tool = findTool(makeSdk({ db }), "ton_trading_get_open_positions");

      const sim = await tool.execute({ mode: "simulation" }, makeContext());
      assert.equal(sim.success, true);
      assert.deepEqual(sim.data.positions.map((p) => p.trade_id).sort(), [1, 3]);
      assert.ok(sim.data.positions.every((p) => p.mode === "simulation"));

      const real = await tool.execute({ mode: "real" }, makeContext());
      assert.equal(real.success, true);
      assert.deepEqual(real.data.positions.map((p) => p.trade_id), [2]);

      const all = await tool.execute({ mode: "all" }, makeContext());
      assert.equal(all.success, true);
      assert.equal(all.data.count, 3);
    });

    it("clamps the limit into the documented 1-100 range", async () => {
      let capturedArgs = null;
      const db = makeStatefulDb([openTrade()]);
      const basePrepare = db.prepare;
      db.prepare = (sql) => {
        const stmt = basePrepare(sql);
        if (sql.includes("FROM trade_journal") && sql.includes("status = 'open'")) {
          const baseAll = stmt.all;
          stmt.all = (...args) => {
            capturedArgs = args;
            return baseAll(...args);
          };
        }
        return stmt;
      };
      const tool = findTool(makeSdk({ db }), "ton_trading_get_open_positions");
      await tool.execute({ mode: "all", limit: 9999 }, makeContext());
      assert.equal(capturedArgs[capturedArgs.length - 1], 100);
    });
  });

  describe("ton_trading_close_position", () => {
    it("scores a TON→USDT accumulation close by TON received, not by TON/USD movement (issue #204)", async () => {
      const db = makeStatefulDb([
        openTrade({
          id: 188,
          mode: "simulation",
          from_asset: "TON",
          to_asset: "USDT",
          amount_in: 10,
          amount_out: 17.95,
          entry_price_usd: 1.795,
        }),
      ]);
      const sdk = makeSdk({
        db,
        ton: {
          ...makeSdk().ton,
          getPrice: async () => ({ usd: 1.6412, source: "mock", timestamp: 1 }),
          dex: {
            quote: async () => ({ stonfi: { output: "10.93" }, recommended: "stonfi" }),
            swap: async () => null,
          },
        },
      });
      const tool = findTool(sdk, "ton_trading_close_position");
      const result = await tool.execute({ trade_id: 188, mode: "simulation" }, makeContext());

      assert.equal(result.success, true);
      assert.equal(result.data.pnl, 0.93);
      assert.equal(result.data.pnl_percent, 9.3);
      assert.equal(result.data.pnl_asset, "TON");
      assert.equal(result.data.profit_or_loss, "profit");
    });

    it("transitions a simulation position from 'open' to 'closed'", async () => {
      const db = makeStatefulDb([openTrade({ id: 7, mode: "simulation" })]);
      const tool = findTool(makeSdk({ db }), "ton_trading_close_position");
      const result = await tool.execute({ trade_id: 7, mode: "simulation" }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.trade_id, 7);
      assert.equal(result.data.status, "closed");
      assert.equal(db._trades.find((t) => t.id === 7).status, "closed");
    });

    it("fails gracefully when the trade is already closed", async () => {
      const db = makeStatefulDb([openTrade({ id: 8, mode: "simulation", status: "closed" })]);
      const tool = findTool(makeSdk({ db }), "ton_trading_close_position");
      const result = await tool.execute({ trade_id: 8, mode: "simulation" }, makeContext());
      assert.equal(result.success, false);
      assert.match(result.error, /already closed/i);
      // The closed row must stay closed — no resurrection to 'closing'/'open'.
      assert.equal(db._trades.find((t) => t.id === 8).status, "closed");
    });

    it("fails gracefully when the trade does not exist", async () => {
      const db = makeStatefulDb([]);
      const tool = findTool(makeSdk({ db }), "ton_trading_close_position");
      const result = await tool.execute({ trade_id: 999, mode: "simulation" }, makeContext());
      assert.equal(result.success, false);
      assert.match(result.error, /not found/i);
    });

    it("returns a simulation position to open when the reverse quote fails", async () => {
      const db = makeStatefulDb([openTrade({ id: 9, mode: "simulation" })]);
      const sdk = makeSdk({
        db,
        ton: {
          ...makeSdk().ton,
          dex: {
            quote: async () => { throw new Error("quote unavailable"); },
            swap: async () => null,
          },
        },
      });
      const tool = findTool(sdk, "ton_trading_close_position");
      const result = await tool.execute({ trade_id: 9, mode: "simulation" }, makeContext());

      assert.equal(result.success, false);
      assert.match(result.error, /quote unavailable/);
      assert.equal(db._trades.find((t) => t.id === 9).status, "open");
    });

    it("marks a real position close_failed when reverse-swap state is unknown", async () => {
      const db = makeStatefulDb([openTrade({ id: 13, mode: "real" })]);
      const sdk = makeSdk({
        db,
        ton: {
          ...makeSdk().ton,
          dex: {
            quote: async () => null,
            swap: async () => { throw new Error("network lost after submit"); },
          },
        },
      });
      const tool = findTool(sdk, "ton_trading_close_position");
      const result = await tool.execute({ trade_id: 13, mode: "real" }, makeContext());

      assert.equal(result.success, false);
      assert.match(result.error, /network lost after submit/);
      assert.equal(db._trades.find((t) => t.id === 13).status, "close_failed");
    });
  });

  describe("ton_trading_close_all_positions", () => {
    it("closes all open positions for the selected mode", async () => {
      const db = makeStatefulDb([
        openTrade({ id: 10, mode: "simulation", to_asset: "EQA" }),
        openTrade({ id: 11, mode: "simulation", to_asset: "EQB" }),
        openTrade({ id: 12, mode: "real", to_asset: "EQC" }),
      ]);
      const tool = findTool(makeSdk({ db }), "ton_trading_close_all_positions");
      const result = await tool.execute({ mode: "simulation" }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.closed_count, 2);
      assert.equal(result.data.failed_count, 0);
      // Only the simulation positions were touched; the real one stays open.
      assert.equal(db._trades.find((t) => t.id === 10).status, "closed");
      assert.equal(db._trades.find((t) => t.id === 11).status, "closed");
      assert.equal(db._trades.find((t) => t.id === 12).status, "open");
    });

    it("never double-closes when two close_all runs race (compare-and-swap)", async () => {
      const db = makeStatefulDb([
        openTrade({ id: 20, mode: "real", to_asset: "EQA" }),
        openTrade({ id: 21, mode: "real", to_asset: "EQB" }),
      ]);
      const swapCalls = [];
      const sdk = makeSdk({
        db,
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => ({ balance: "100.5", balanceNano: "100500000000" }),
          getPrice: async () => ({ usd: 2.2, source: "mock", timestamp: 1 }),
          getJettonBalances: async () => [],
          dex: {
            quote: async () => ({ stonfi: { output: "11", price: "11" }, recommended: "stonfi" }),
            swap: async (params) => {
              swapCalls.push(params.fromAsset);
              return { expectedOutput: "11", minOutput: "10.5", dex: "stonfi" };
            },
          },
        },
      });
      const tool = findTool(sdk, "ton_trading_close_all_positions");
      // Two concurrent sweeps over the same two open positions. Without the
      // compare-and-swap claim each reverse swap could fire twice, spending the
      // same funds twice (issue #182 / #188).
      const [r1, r2] = await Promise.all([
        tool.execute({ mode: "real", dex: "stonfi" }, makeContext()),
        tool.execute({ mode: "real", dex: "stonfi" }, makeContext()),
      ]);
      // Each position's reverse swap fires exactly once across both sweeps.
      assert.equal(swapCalls.length, 2, `reverse swap must fire once per position, got ${swapCalls.length}`);
      assert.equal(db._trades.find((t) => t.id === 20).status, "closed");
      assert.equal(db._trades.find((t) => t.id === 21).status, "closed");
      // Combined, both sweeps account for exactly the two real positions.
      const totalClosed = (r1.data?.closed_count ?? 0) + (r2.data?.closed_count ?? 0);
      assert.equal(totalClosed, 2, "exactly two closes should succeed across both racing sweeps");
    });
  });
});
