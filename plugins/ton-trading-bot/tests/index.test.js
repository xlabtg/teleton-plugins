/**
 * Unit tests for ton-trading-bot plugin
 *
 * Tests manifest exports, tool definitions, and tool execute behavior
 * using Node's built-in test runner (node:test).
 *
 * All TON and DB calls are mocked — no real network or disk access.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

const PLUGIN_DIR = resolve("plugins/ton-trading-bot");
const PLUGIN_URL = pathToFileURL(join(PLUGIN_DIR, "index.js")).href;

// ─── Mock DB ──────────────────────────────────────────────────────────────────

function makeMockDb(rows = {}) {
  return {
    exec: () => {},
    prepare: (sql) => {
      // Return different mock data based on the SQL query
      return {
        get: () => {
          if (sql.includes("sim_balance")) return rows.simBalance ?? null;
          if (sql.includes("trade_journal") && sql.includes("WHERE id")) return rows.trade ?? null;
          return null;
        },
        all: () => rows.trades ?? [],
        run: () => ({ lastInsertRowid: rows.lastInsertRowid ?? 1 }),
      };
    },
  };
}

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
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    ton: {
      getAddress: () => "EQTestWalletAddress",
      getBalance: async () => ({ balance: "100.5", balanceNano: "100500000000" }),
      getPrice: async () => ({ usd: 3.5, source: "mock", timestamp: Date.now() }),
      getJettonBalances: async () => [],
      dex: {
        quote: async () => ({
          stonfi: { output: "10.5", price: "10.5" },
          dedust: { output: "10.3", price: "10.3" },
          recommended: "stonfi",
          savings: "0.2",
        }),
        swap: async (params) => ({
          expectedOutput: "10.5",
          minOutput: "9.975",
          dex: params.dex ?? "stonfi",
        }),
      },
      ...overrides.ton,
    },
    telegram: {
      sendMessage: async () => 42,
      ...overrides.telegram,
    },
    db: makeMockDb(overrides.dbRows ?? {}),
    storage: {
      set: () => {},
      get: () => undefined,
      has: () => false,
      delete: () => false,
      clear: () => {},
      ...overrides.storage,
    },
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    chatId: 123456789,
    senderId: 987654321,
    ...overrides,
  };
}

// ─── Load plugin once ─────────────────────────────────────────────────────────

let mod;

before(async () => {
  mod = await import(PLUGIN_URL);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ton-trading-bot plugin", () => {
  // ── Manifest tests ──────────────────────────────────────────────────────────
  describe("manifest", () => {
    it("exports manifest object", () => {
      assert.ok(mod.manifest, "manifest should be exported");
      assert.equal(typeof mod.manifest, "object");
    });

    it("manifest name matches plugin id", () => {
      assert.equal(mod.manifest.name, "ton-trading-bot");
    });

    it("manifest has version", () => {
      assert.ok(mod.manifest.version, "manifest.version should exist");
    });

    it("manifest has sdkVersion", () => {
      assert.ok(mod.manifest.sdkVersion, "manifest.sdkVersion should exist");
    });

    it("manifest has defaultConfig with required keys", () => {
      assert.ok(mod.manifest.defaultConfig, "defaultConfig should exist");
      assert.ok("maxTradePercent" in mod.manifest.defaultConfig);
      assert.ok("minBalanceTON" in mod.manifest.defaultConfig);
      assert.ok("defaultSlippage" in mod.manifest.defaultConfig);
      assert.ok("simulationBalance" in mod.manifest.defaultConfig);
    });
  });

  // ── tools export ────────────────────────────────────────────────────────────
  describe("tools export", () => {
    it("exports tools as a function (SDK pattern)", () => {
      assert.equal(typeof mod.tools, "function");
    });

    it("tools(sdk) returns an array", () => {
      const sdk = makeSdk();
      const toolList = mod.tools(sdk);
      assert.ok(Array.isArray(toolList));
    });

    it("exports exactly 6 tools", () => {
      const sdk = makeSdk();
      const toolList = mod.tools(sdk);
      assert.equal(toolList.length, 6);
    });

    it("all tools have name, description, and execute", () => {
      const sdk = makeSdk();
      const toolList = mod.tools(sdk);
      for (const tool of toolList) {
        assert.ok(tool.name, `tool should have name`);
        assert.ok(tool.description, `tool "${tool.name}" should have description`);
        assert.equal(typeof tool.execute, "function", `tool "${tool.name}" should have execute function`);
      }
    });

    it("exports migrate function for database setup", () => {
      assert.equal(typeof mod.migrate, "function");
    });

    it("migrate creates required tables without error", () => {
      const executed = [];
      const mockDb = { exec: (sql) => executed.push(sql) };
      assert.doesNotThrow(() => mod.migrate(mockDb));
      assert.equal(executed.length, 1);
      assert.ok(executed[0].includes("trade_journal"));
      assert.ok(executed[0].includes("sim_balance"));
    });
  });

  // ── ton_trading_get_market_data ─────────────────────────────────────────────
  describe("ton_trading_get_market_data", () => {
    it("returns success with price and DEX quote", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_market_data");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount: "1" },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.ok(result.data.ton_price_usd !== undefined);
      assert.ok(result.data.wallet_address);
      assert.ok(result.data.quote);
      assert.equal(result.data.quote.from_asset, "TON");
    });

    it("caches result in sdk.storage", async () => {
      let storedKey = null;
      const sdk = makeSdk({
        storage: {
          set: (key) => { storedKey = key; },
          get: () => undefined,
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_market_data");
      await tool.execute({ from_asset: "TON", to_asset: "EQCxE6test", amount: "1" }, makeContext());
      assert.ok(storedKey, "should set a storage key");
      assert.ok(storedKey.includes("TON"), "storage key should contain from_asset");
    });

    it("returns success even when DEX quote fails", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => ({ balance: "100.5", balanceNano: "100500000000" }),
          getPrice: async () => ({ usd: 3.5, source: "mock", timestamp: Date.now() }),
          getJettonBalances: async () => [],
          dex: {
            quote: async () => { throw new Error("DEX unavailable"); },
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_market_data");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount: "1" },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.quote, null);
    });

    it("returns failure when getPrice throws", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => null,
          getPrice: async () => { throw new Error("price fetch failed"); },
          getJettonBalances: async () => [],
          dex: {
            quote: async () => null,
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_market_data");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount: "1" },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("required parameters include from_asset, to_asset, amount", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_market_data");
      assert.ok(tool.parameters?.required?.includes("from_asset"));
      assert.ok(tool.parameters?.required?.includes("to_asset"));
      assert.ok(tool.parameters?.required?.includes("amount"));
    });
  });

  // ── ton_trading_get_portfolio ───────────────────────────────────────────────
  describe("ton_trading_get_portfolio", () => {
    it("returns wallet address, balances, and trade history", async () => {
      const sdk = makeSdk({
        dbRows: { simBalance: { balance: 950 }, trades: [] },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_portfolio");
      const result = await tool.execute({}, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.wallet_address);
      assert.ok(result.data.ton_balance !== undefined);
      assert.equal(result.data.simulation_balance, 950);
      assert.ok(Array.isArray(result.data.jetton_holdings));
      assert.ok(Array.isArray(result.data.recent_trades));
    });

    it("uses default simulation balance when no sim_balance row exists", async () => {
      const sdk = makeSdk({
        dbRows: { simBalance: null },
        pluginConfig: { simulationBalance: 500 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_portfolio");
      const result = await tool.execute({}, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.simulation_balance, 500);
    });

    it("handles getJettonBalances failure gracefully", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => ({ balance: "100.5", balanceNano: "100500000000" }),
          getPrice: async () => null,
          getJettonBalances: async () => { throw new Error("jetton error"); },
          dex: { quote: async () => null },
        },
        dbRows: { simBalance: null, trades: [] },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_portfolio");
      const result = await tool.execute({ history_limit: 5 }, makeContext());
      assert.equal(result.success, true);
      assert.deepEqual(result.data.jetton_holdings, []);
    });
  });

  // ── ton_trading_validate_trade ──────────────────────────────────────────────
  describe("ton_trading_validate_trade", () => {
    it("passes validation for a valid real trade within limits", async () => {
      const sdk = makeSdk({
        pluginConfig: { maxTradePercent: 10, minBalanceTON: 1 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_validate_trade");
      // balance = 100.5, 10% = 10.05, trading 5 TON
      const result = await tool.execute({ mode: "real", amount_ton: 5 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.passed, true);
      assert.equal(result.data.issues.length, 0);
    });

    it("fails when trade exceeds max trade percent", async () => {
      const sdk = makeSdk({
        pluginConfig: { maxTradePercent: 10, minBalanceTON: 1 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_validate_trade");
      // balance = 100.5, 10% = 10.05, trading 20 TON (exceeds limit)
      const result = await tool.execute({ mode: "real", amount_ton: 20 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.passed, false);
      assert.ok(result.data.issues.some((i) => i.type === "exceeds_max_trade_percent"));
    });

    it("fails when trade exceeds available balance", async () => {
      const sdk = makeSdk({
        pluginConfig: { maxTradePercent: 100, minBalanceTON: 1 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_validate_trade");
      // balance = 100.5, trading 200 TON (exceeds balance)
      const result = await tool.execute({ mode: "real", amount_ton: 200 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.passed, false);
      assert.ok(result.data.issues.some((i) => i.type === "exceeds_balance"));
    });

    it("fails when balance is below minimum", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => ({ balance: "0.5", balanceNano: "500000000" }),
          getPrice: async () => null,
          getJettonBalances: async () => [],
          dex: { quote: async () => null, swap: async () => null },
        },
        pluginConfig: { maxTradePercent: 10, minBalanceTON: 1 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_validate_trade");
      const result = await tool.execute({ mode: "real", amount_ton: 0.1 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.passed, false);
      assert.ok(result.data.issues.some((i) => i.type === "insufficient_balance"));
    });

    it("uses simulation balance for simulation mode", async () => {
      const sdk = makeSdk({
        dbRows: { simBalance: { balance: 1000 } },
        pluginConfig: { maxTradePercent: 10, minBalanceTON: 1 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_validate_trade");
      const result = await tool.execute({ mode: "simulation", amount_ton: 50 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.mode, "simulation");
      assert.equal(result.data.current_balance, 1000);
    });

    it("required parameters include mode and amount_ton", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_validate_trade");
      assert.ok(tool.parameters?.required?.includes("mode"));
      assert.ok(tool.parameters?.required?.includes("amount_ton"));
    });
  });

  // ── ton_trading_simulate_trade ──────────────────────────────────────────────
  describe("ton_trading_simulate_trade", () => {
    it("records a simulation trade and returns trade_id", async () => {
      const sdk = makeSdk({
        dbRows: { simBalance: { balance: 1000 }, lastInsertRowid: 7 },
        pluginConfig: { minBalanceTON: 1 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_simulate_trade");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount_in: 10, expected_amount_out: 100 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.mode, "simulation");
      assert.equal(result.data.trade_id, 7);
      assert.equal(result.data.status, "open");
    });

    it("returns failure when simulation balance is insufficient", async () => {
      const sdk = makeSdk({
        dbRows: { simBalance: { balance: 5 } },
        pluginConfig: { minBalanceTON: 1 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_simulate_trade");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount_in: 50, expected_amount_out: 500 },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("Insufficient simulation balance"));
    });

    it("returns failure when trade would drop balance below minimum", async () => {
      const sdk = makeSdk({
        dbRows: { simBalance: { balance: 2 } },
        pluginConfig: { minBalanceTON: 1 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_simulate_trade");
      // balance=2, min=1, trading 1.5 → leaves 0.5 which is below min
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount_in: 1.5, expected_amount_out: 15 },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("minimum"));
    });

    it("deducts amount from simulation balance when from_asset is TON", async () => {
      let savedBalance = null;
      const sdk = makeSdk({
        dbRows: { simBalance: { balance: 100 }, lastInsertRowid: 1 },
        pluginConfig: { minBalanceTON: 1 },
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => ({ balance: 100 }),
            all: () => [],
            run: (...args) => {
              if (sql.includes("INSERT INTO sim_balance")) savedBalance = args[1];
              return { lastInsertRowid: 1 };
            },
          }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_simulate_trade");
      await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount_in: 10, expected_amount_out: 100 },
        makeContext()
      );
      assert.equal(savedBalance, 90, "simulation balance should be deducted by amount_in");
    });

    it("required parameters include from_asset, to_asset, amount_in, expected_amount_out", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_simulate_trade");
      assert.ok(tool.parameters?.required?.includes("from_asset"));
      assert.ok(tool.parameters?.required?.includes("to_asset"));
      assert.ok(tool.parameters?.required?.includes("amount_in"));
      assert.ok(tool.parameters?.required?.includes("expected_amount_out"));
    });
  });

  // ── ton_trading_execute_swap ────────────────────────────────────────────────
  describe("ton_trading_execute_swap", () => {
    it("executes a DEX swap and returns trade_id", async () => {
      const sdk = makeSdk({
        dbRows: { lastInsertRowid: 3 },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_execute_swap");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount: "2" },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.trade_id, 3);
      assert.equal(result.data.status, "open");
      assert.equal(result.data.from_asset, "TON");
    });

    it("returns failure when wallet is not initialized", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => null,
          getBalance: async () => null,
          getPrice: async () => null,
          getJettonBalances: async () => [],
          dex: { quote: async () => null, swap: async () => null },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_execute_swap");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount: "2" },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.equal(result.error, "Wallet not initialized");
    });

    it("returns failure when DEX swap throws", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => null,
          getPrice: async () => null,
          getJettonBalances: async () => [],
          dex: {
            quote: async () => null,
            swap: async () => { throw new Error("insufficient liquidity"); },
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_execute_swap");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount: "2" },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("insufficient liquidity"));
    });

    it("is dm-only scope", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_execute_swap");
      assert.equal(tool.scope, "dm-only");
    });

    it("required parameters include from_asset, to_asset, amount", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_execute_swap");
      assert.ok(tool.parameters?.required?.includes("from_asset"));
      assert.ok(tool.parameters?.required?.includes("to_asset"));
      assert.ok(tool.parameters?.required?.includes("amount"));
    });
  });

  // ── ton_trading_record_trade ────────────────────────────────────────────────
  describe("ton_trading_record_trade", () => {
    it("closes an open trade and records PnL", async () => {
      const openTrade = {
        id: 1,
        mode: "simulation",
        from_asset: "TON",
        to_asset: "EQCxE6test",
        amount_in: 10,
        amount_out: null,
        status: "open",
      };
      const sdk = makeSdk({
        dbRows: { trade: openTrade },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute({ trade_id: 1, amount_out: 12 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.amount_in, 10);
      assert.equal(result.data.amount_out, 12);
      assert.equal(result.data.pnl, 2);
      assert.equal(result.data.status, "closed");
      assert.equal(result.data.profit_or_loss, "profit");
    });

    it("calculates loss correctly", async () => {
      const openTrade = { id: 2, mode: "real", amount_in: 10, status: "open", to_asset: "EQCxE6test" };
      const sdk = makeSdk({ dbRows: { trade: openTrade } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute({ trade_id: 2, amount_out: 8 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.pnl, -2);
      assert.equal(result.data.profit_or_loss, "loss");
    });

    it("returns failure when trade is not found", async () => {
      const sdk = makeSdk({ dbRows: { trade: null } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute({ trade_id: 999, amount_out: 10 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("not found"));
    });

    it("returns failure when trade is already closed", async () => {
      const closedTrade = { id: 3, mode: "real", amount_in: 10, status: "closed" };
      const sdk = makeSdk({ dbRows: { trade: closedTrade } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute({ trade_id: 3, amount_out: 10 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("already closed"));
    });

    it("required parameters include trade_id and amount_out", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      assert.ok(tool.parameters?.required?.includes("trade_id"));
      assert.ok(tool.parameters?.required?.includes("amount_out"));
    });
  });
});
