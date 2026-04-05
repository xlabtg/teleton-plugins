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
        quoteSTONfi: async () => ({ output: "10.5", price: "10.5" }),
        quoteDeDust: async () => ({ output: "10.3", price: "10.3" }),
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

    it("exports exactly 24 tools", () => {
      const sdk = makeSdk();
      const toolList = mod.tools(sdk);
      assert.equal(toolList.length, 24);
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
      // First exec: CREATE TABLE statements; subsequent execs: ALTER TABLE migrations
      assert.ok(executed.length >= 1);
      assert.ok(executed[0].includes("trade_journal"));
      assert.ok(executed[0].includes("sim_balance"));
      assert.ok(executed[0].includes("stop_loss_rules"));
      assert.ok(executed[0].includes("scheduled_trades"));
    });

    it("migrate adds entry_price_usd and exit_price_usd columns to trade_journal", () => {
      const executed = [];
      const mockDb = { exec: (sql) => executed.push(sql) };
      mod.migrate(mockDb);
      // The CREATE TABLE should include both P&L price columns
      assert.ok(executed[0].includes("entry_price_usd"), "CREATE TABLE should include entry_price_usd");
      assert.ok(executed[0].includes("exit_price_usd"), "CREATE TABLE should include exit_price_usd");
      // ALTER TABLE migrations should be present for backward compatibility
      const allSql = executed.join("\n");
      assert.ok(allSql.includes("ALTER TABLE trade_journal ADD COLUMN entry_price_usd"), "should include ALTER for entry_price_usd");
      assert.ok(allSql.includes("ALTER TABLE trade_journal ADD COLUMN exit_price_usd"), "should include ALTER for exit_price_usd");
    });

    it("migrate handles existing database that already has the columns", () => {
      // When columns already exist, ALTER TABLE throws — migrate should not propagate the error
      const mockDb = {
        exec: (sql) => {
          if (sql.includes("ALTER TABLE")) throw new Error("duplicate column name");
        },
      };
      assert.doesNotThrow(() => mod.migrate(mockDb));
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

    it("calculates P&L in USD when currencies differ (USDT→TON trade)", async () => {
      // Reproduces issue #80: 50 USDT → 37.6 TON at entry_price_usd=1 (USDT),
      // exit_price_usd=1.33 (TON price in USD). Real P&L should be ~$0, not -$12.40.
      const openTrade = {
        id: 10,
        mode: "simulation",
        from_asset: "USDT",
        to_asset: "TON",
        amount_in: 50,       // 50 USDT spent
        entry_price_usd: 1,  // 1 USDT = $1
        amount_out: null,
        status: "open",
      };
      const sdk = makeSdk({ dbRows: { trade: openTrade } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      // Closing: received 37.6 TON at $1.33/TON = $50.008 USD value
      const result = await tool.execute(
        { trade_id: 10, amount_out: 37.6, exit_price_usd: 1.33 },
        makeContext()
      );
      assert.equal(result.success, true);
      // USD value out = 37.6 * 1.33 = 50.008; USD value in = 50 * 1 = 50
      // pnl = 50.008 - 50 = 0.008 (small positive, not -12.40)
      assert.ok(result.data.pnl > 0, `pnl should be slightly positive (~0.008), got ${result.data.pnl}`);
      assert.ok(result.data.pnl < 1, `pnl should be near zero, got ${result.data.pnl}`);
      assert.equal(result.data.profit_or_loss, "profit");
    });

    it("calculates P&L correctly for TON→USDT trade using USD prices", async () => {
      // Buying USDT with TON: 37.6 TON at $1.33 → 50 USDT
      const openTrade = {
        id: 11,
        mode: "simulation",
        from_asset: "TON",
        to_asset: "USDT",
        amount_in: 37.6,     // 37.6 TON spent
        entry_price_usd: 1.33, // TON = $1.33
        amount_out: null,
        status: "open",
      };
      const sdk = makeSdk({ dbRows: { trade: openTrade } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      // Closing: received 50 USDT at $1/USDT
      const result = await tool.execute(
        { trade_id: 11, amount_out: 50, exit_price_usd: 1 },
        makeContext()
      );
      assert.equal(result.success, true);
      // USD value out = 50 * 1 = 50; USD value in = 37.6 * 1.33 = 50.008
      // pnl = 50 - 50.008 = -0.008 (tiny loss, not a huge number)
      assert.ok(result.data.pnl < 0, `pnl should be slightly negative, got ${result.data.pnl}`);
      assert.ok(result.data.pnl > -1, `pnl should be near zero, got ${result.data.pnl}`);
      assert.equal(result.data.profit_or_loss, "loss");
    });

    it("falls back to raw amount diff when no USD prices provided (backward compat)", async () => {
      const openTrade = {
        id: 12,
        mode: "simulation",
        from_asset: "TON",
        to_asset: "TON",
        amount_in: 10,
        amount_out: null,
        status: "open",
      };
      const sdk = makeSdk({ dbRows: { trade: openTrade } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute({ trade_id: 12, amount_out: 11 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.pnl, 1);
      assert.equal(result.data.profit_or_loss, "profit");
    });

    it("persists exit_price_usd to database when closing a trade", async () => {
      const openTrade = {
        id: 13,
        mode: "real",
        from_asset: "USDT",
        to_asset: "TON",
        amount_in: 50,
        entry_price_usd: 1,
        amount_out: null,
        status: "open",
      };
      let capturedSql = null;
      let capturedArgs = null;
      const sdk = {
        ...makeSdk({ dbRows: { trade: openTrade } }),
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => {
              if (sql.includes("trade_journal") && sql.includes("WHERE id")) return openTrade;
              return null;
            },
            all: () => [],
            run: (...args) => {
              if (sql.includes("UPDATE trade_journal")) {
                capturedSql = sql;
                capturedArgs = args;
              }
              return { lastInsertRowid: 1 };
            },
          }),
        },
      };
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute(
        { trade_id: 13, amount_out: 37.6, exit_price_usd: 1.33 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.ok(capturedSql?.includes("exit_price_usd"), "UPDATE SQL should include exit_price_usd column");
      assert.ok(capturedArgs !== null, "run() should have been called");
      // args order: amount_out, exit_price_usd, pnl, pnl_percent, note, trade_id
      assert.equal(capturedArgs[1], 1.33, "exit_price_usd should be persisted as 1.33");
    });

    it("ton_trading_simulate_trade accepts and stores entry_price_usd", async () => {
      const sdk = makeSdk({ dbRows: { simBalance: { balance: 1000 } } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_simulate_trade");
      const result = await tool.execute(
        { from_asset: "USDT", to_asset: "TON", amount_in: 50, expected_amount_out: 37.6, entry_price_usd: 1 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.entry_price_usd, 1);
    });
  });

  // ── ton_trading_get_arbitrage_opportunities ─────────────────────────────────
  describe("ton_trading_get_arbitrage_opportunities", () => {
    it("returns opportunities when DEX prices differ", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => ({ balance: "100.5", balanceNano: "100500000000" }),
          getPrice: async () => ({ usd: 3.5, source: "mock" }),
          getJettonBalances: async () => [],
          dex: {
            quoteSTONfi: async () => ({ output: "10.0", price: "10.0" }),
            quoteDeDust: async () => ({ output: "10.5", price: "10.5" }),
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_arbitrage_opportunities");
      const result = await tool.execute({ from_asset: "TON", to_asset: "EQCxE6test", amount: "1" }, {});
      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.data.opportunities));
    });

    it("returns empty opportunities when quotes are equal", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => ({ balance: "100.5", balanceNano: "100500000000" }),
          getPrice: async () => ({ usd: 3.5, source: "mock" }),
          getJettonBalances: async () => [],
          dex: {
            quoteSTONfi: async () => ({ output: "10.0", price: "10.0" }),
            quoteDeDust: async () => ({ output: "10.0", price: "10.0" }),
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_arbitrage_opportunities");
      const result = await tool.execute(
        { from_asset: "TON", to_asset: "EQCxE6test", amount: "1", min_profit_percent: 1 },
        {}
      );
      assert.equal(result.success, true);
      assert.equal(result.data.opportunities.length, 0);
    });

    it("returns failure when DEX quote fails", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => null,
          getPrice: async () => null,
          getJettonBalances: async () => [],
          dex: {
            quote: async () => { throw new Error("DEX down"); },
            quoteSTONfi: async () => { throw new Error("StonFi down"); },
            quoteDeDust: async () => { throw new Error("DeDust down"); },
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_arbitrage_opportunities");
      const result = await tool.execute({ from_asset: "TON", to_asset: "EQCxE6test", amount: "1" }, {});
      assert.equal(result.success, false);
    });

    it("error message includes the actual DEX error, not just a generic message", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => null,
          getPrice: async () => null,
          getJettonBalances: async () => [],
          dex: {
            quote: async () => { throw new Error("Router contract not found"); },
            quoteSTONfi: async () => { throw new Error("Router contract not found"); },
            quoteDeDust: async () => { throw new Error("Vault not initialized"); },
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_arbitrage_opportunities");
      const result = await tool.execute({ from_asset: "TON", to_asset: "EQCxE6test", amount: "1" }, {});
      assert.equal(result.success, false);
      // The error must contain actionable detail — not just the generic "Could not fetch DEX quotes"
      assert.notEqual(result.error, "Could not fetch DEX quotes", "error should include actual failure detail, not just the generic message");
      assert.ok(result.error, "error should be set");
    });

    it("succeeds with partial quotes when only one DEX fails", async () => {
      const sdk = makeSdk({
        ton: {
          getAddress: () => "EQTestWalletAddress",
          getBalance: async () => ({ balance: "100.5", balanceNano: "100500000000" }),
          getPrice: async () => ({ usd: 3.5, source: "mock" }),
          getJettonBalances: async () => [],
          dex: {
            quote: async () => { throw new Error("aggregated quote unavailable"); },
            quoteSTONfi: async () => ({ output: "10.0", price: "10.0" }),
            quoteDeDust: async () => { throw new Error("DeDust pool not found"); },
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_arbitrage_opportunities");
      const result = await tool.execute({ from_asset: "TON", to_asset: "EQCxE6test", amount: "1" }, {});
      // Only 1 DEX responded — not enough for arbitrage but should not hard-fail
      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.data.opportunities));
    });

    it("required parameters include from_asset, to_asset, amount", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_arbitrage_opportunities");
      assert.ok(tool.parameters?.required?.includes("from_asset"));
      assert.ok(tool.parameters?.required?.includes("to_asset"));
      assert.ok(tool.parameters?.required?.includes("amount"));
    });
  });

  // ── ton_trading_get_token_listings ──────────────────────────────────────────
  describe("ton_trading_get_token_listings", () => {
    it("has correct name and description", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_token_listings");
      assert.ok(tool);
      assert.ok(tool.description);
      assert.equal(tool.category, "data-bearing");
    });

    it("returns cached data when available", async () => {
      const cachedData = { listings: [{ name: "CachedToken" }], fetched_at: Date.now() };
      const sdk = makeSdk({ storage: { get: () => cachedData, set: () => {}, has: () => true } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_token_listings");
      const result = await tool.execute({}, {});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, cachedData);
    });
  });

  // ── ton_trading_get_token_info ──────────────────────────────────────────────
  describe("ton_trading_get_token_info", () => {
    it("required parameters include token_address", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_token_info");
      assert.ok(tool.parameters?.required?.includes("token_address"));
    });

    it("returns cached data when available", async () => {
      const cachedData = { token_address: "EQCxE6test", name: "TestToken", price_usd: 1.5 };
      const sdk = makeSdk({ storage: { get: () => cachedData, set: () => {}, has: () => true } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_token_info");
      const result = await tool.execute({ token_address: "EQCxE6test" }, {});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, cachedData);
    });
  });

  // ── ton_trading_validate_token ──────────────────────────────────────────────
  describe("ton_trading_validate_token", () => {
    it("required parameters include token_address", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_validate_token");
      assert.ok(tool.parameters?.required?.includes("token_address"));
    });

    it("has data-bearing category", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_validate_token");
      assert.equal(tool.category, "data-bearing");
    });
  });

  // ── ton_trading_get_top_traders ─────────────────────────────────────────────
  describe("ton_trading_get_top_traders", () => {
    it("has correct name and category", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_top_traders");
      assert.ok(tool);
      assert.equal(tool.category, "data-bearing");
    });

    it("returns cached data when available", async () => {
      const cachedData = { traders: [{ wallet: "EQTest", win_rate: 0.7 }], fetched_at: Date.now() };
      const sdk = makeSdk({ storage: { get: () => cachedData, set: () => {}, has: () => true } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_top_traders");
      const result = await tool.execute({}, {});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, cachedData);
    });
  });

  // ── ton_trading_get_trader_performance ─────────────────────────────────────
  describe("ton_trading_get_trader_performance", () => {
    it("required parameters include wallet_address", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_trader_performance");
      assert.ok(tool.parameters?.required?.includes("wallet_address"));
    });

    it("returns cached data when available", async () => {
      const cachedData = { wallet_address: "EQTest", total_swaps: 5, win_rate: 0.6 };
      const sdk = makeSdk({ storage: { get: () => cachedData, set: () => {}, has: () => true } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_trader_performance");
      const result = await tool.execute({ wallet_address: "EQTest" }, {});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, cachedData);
    });
  });

  // ── ton_trading_get_active_pools ────────────────────────────────────────────
  describe("ton_trading_get_active_pools", () => {
    it("has correct name and category", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_active_pools");
      assert.ok(tool);
      assert.equal(tool.category, "data-bearing");
    });

    it("returns cached data when available", async () => {
      const cachedData = { pools: [{ name: "TON/USDT", dex: "stonfi" }], fetched_at: Date.now() };
      const sdk = makeSdk({ storage: { get: () => cachedData, set: () => {}, has: () => true } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_active_pools");
      const result = await tool.execute({}, {});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, cachedData);
    });
  });

  // ── ton_trading_get_farms_with_apy ──────────────────────────────────────────
  describe("ton_trading_get_farms_with_apy", () => {
    it("has correct name and category", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_farms_with_apy");
      assert.ok(tool);
      assert.equal(tool.category, "data-bearing");
    });

    it("returns cached data when available", async () => {
      const cachedData = { farms: [{ name: "TON/USDT", estimated_apy_percent: 15 }], fetched_at: Date.now() };
      const sdk = makeSdk({ storage: { get: () => cachedData, set: () => {}, has: () => true } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_farms_with_apy");
      const result = await tool.execute({}, {});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, cachedData);
    });
  });

  // ── ton_trading_get_pool_volume ─────────────────────────────────────────────
  describe("ton_trading_get_pool_volume", () => {
    it("required parameters include pool_address", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_pool_volume");
      assert.ok(tool.parameters?.required?.includes("pool_address"));
    });

    it("returns cached data when available", async () => {
      const cachedData = { pool_address: "EQPool", volume_usd: { h24: 50000 } };
      const sdk = makeSdk({ storage: { get: () => cachedData, set: () => {}, has: () => true } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_pool_volume");
      const result = await tool.execute({ pool_address: "EQPool" }, {});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, cachedData);
    });
  });

  // ── ton_trading_backtest ────────────────────────────────────────────────────
  describe("ton_trading_backtest", () => {
    it("required parameters include strategy, from_asset, to_asset", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_backtest");
      assert.ok(tool.parameters?.required?.includes("strategy"));
      assert.ok(tool.parameters?.required?.includes("from_asset"));
      assert.ok(tool.parameters?.required?.includes("to_asset"));
    });

    it("returns note when not enough trades exist", async () => {
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => [], run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_backtest");
      const result = await tool.execute(
        { strategy: "momentum", from_asset: "TON", to_asset: "EQCxE6test" },
        {}
      );
      assert.equal(result.success, true);
      assert.ok(result.data.note);
    });

    it("backtests buy_and_hold strategy with trade data", async () => {
      const trades = [
        { id: 1, from_asset: "TON", to_asset: "EQCxE6test", pnl_percent: 5, status: "closed" },
        { id: 2, from_asset: "TON", to_asset: "EQCxE6test", pnl_percent: -3, status: "closed" },
        { id: 3, from_asset: "TON", to_asset: "EQCxE6test", pnl_percent: 8, status: "closed" },
      ];
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => trades, run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_backtest");
      const result = await tool.execute(
        { strategy: "buy_and_hold", from_asset: "TON", to_asset: "EQCxE6test" },
        {}
      );
      assert.equal(result.success, true);
      assert.ok(result.data.simulated_trades >= 0);
      assert.ok("win_rate" in result.data);
      assert.ok("total_pnl_percent" in result.data);
    });
  });

  // ── ton_trading_calculate_risk_metrics ──────────────────────────────────────
  describe("ton_trading_calculate_risk_metrics", () => {
    it("returns note when no trades found", async () => {
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => [], run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_calculate_risk_metrics");
      const result = await tool.execute({}, {});
      assert.equal(result.success, true);
      assert.ok(result.data.note);
    });

    it("computes win rate and sharpe from trade history", async () => {
      const trades = [
        { pnl_percent: 10 },
        { pnl_percent: -5 },
        { pnl_percent: 8 },
        { pnl_percent: -3 },
        { pnl_percent: 12 },
      ];
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => trades, run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_calculate_risk_metrics");
      const result = await tool.execute({ mode: "all" }, {});
      assert.equal(result.success, true);
      assert.ok("win_rate" in result.data);
      assert.ok("max_drawdown_percent" in result.data);
      assert.ok("value_at_risk_percent" in result.data);
      assert.ok("sharpe_ratio" in result.data);
    });
  });

  // ── ton_trading_set_stop_loss ───────────────────────────────────────────────
  describe("ton_trading_set_stop_loss", () => {
    it("required parameters include trade_id, entry_price, stop_loss_percent", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_set_stop_loss");
      assert.ok(tool.parameters?.required?.includes("trade_id"));
      assert.ok(tool.parameters?.required?.includes("entry_price"));
      assert.ok(tool.parameters?.required?.includes("stop_loss_percent"));
    });

    it("registers a stop-loss rule and returns trigger prices", async () => {
      const openTrade = { id: 1, status: "open" };
      const sdk = makeSdk({ dbRows: { trade: openTrade, lastInsertRowid: 5 } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_set_stop_loss");
      const result = await tool.execute(
        { trade_id: 1, entry_price: 100, stop_loss_percent: 10, take_profit_percent: 20 },
        {}
      );
      assert.equal(result.success, true);
      assert.ok("stop_loss_price" in result.data);
      assert.ok("take_profit_price" in result.data);
      assert.ok(result.data.stop_loss_price < 100, "stop loss price should be below entry");
      assert.ok(result.data.take_profit_price > 100, "take profit price should be above entry");
    });

    it("returns failure when trade not found", async () => {
      const sdk = makeSdk({ dbRows: { trade: null } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_set_stop_loss");
      const result = await tool.execute({ trade_id: 999, entry_price: 100, stop_loss_percent: 5 }, {});
      assert.equal(result.success, false);
      assert.ok(result.error.includes("not found"));
    });

    it("returns failure when trade is already closed", async () => {
      const closedTrade = { id: 2, status: "closed" };
      const sdk = makeSdk({ dbRows: { trade: closedTrade } });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_set_stop_loss");
      const result = await tool.execute({ trade_id: 2, entry_price: 100, stop_loss_percent: 5 }, {});
      assert.equal(result.success, false);
      assert.ok(result.error.includes("already closed"));
    });
  });

  // ── ton_trading_check_stop_loss ────────────────────────────────────────────
  describe("ton_trading_check_stop_loss", () => {
    it("required parameters include current_price", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_check_stop_loss");
      assert.ok(tool.parameters?.required?.includes("current_price"));
    });

    it("has data-bearing category", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_check_stop_loss");
      assert.equal(tool.category, "data-bearing");
    });

    it("returns no triggered rules when price is within limits", async () => {
      const activeRule = { id: 1, trade_id: 1, entry_price: 100, stop_loss_percent: 10, take_profit_percent: 20, status: "active" };
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => [activeRule], run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_check_stop_loss");
      const result = await tool.execute({ current_price: 100 }, {});
      assert.equal(result.success, true);
      assert.equal(result.data.triggered_rules.length, 0);
      assert.equal(result.data.safe_rules.length, 1);
      assert.ok(result.data.note.includes("No rules triggered"));
    });

    it("detects stop-loss trigger when price falls below threshold", async () => {
      const activeRule = { id: 2, trade_id: 3, entry_price: 100, stop_loss_percent: 10, take_profit_percent: null, status: "active" };
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => [activeRule], run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_check_stop_loss");
      const result = await tool.execute({ current_price: 89 }, {}); // below 90 (stop-loss price)
      assert.equal(result.success, true);
      assert.equal(result.data.triggered_rules.length, 1);
      assert.equal(result.data.triggered_rules[0].action, "stop_loss");
      assert.equal(result.data.triggered_rules[0].stop_loss_hit, true);
      assert.ok(result.data.note.includes("triggered"));
    });

    it("detects take-profit trigger when price rises above threshold", async () => {
      const activeRule = { id: 3, trade_id: 4, entry_price: 100, stop_loss_percent: 10, take_profit_percent: 20, status: "active" };
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => [activeRule], run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_check_stop_loss");
      const result = await tool.execute({ current_price: 121 }, {}); // above 120 (take-profit price)
      assert.equal(result.success, true);
      assert.equal(result.data.triggered_rules.length, 1);
      assert.equal(result.data.triggered_rules[0].action, "take_profit");
      assert.equal(result.data.triggered_rules[0].take_profit_hit, true);
    });

    it("filters rules by trade_id when provided", async () => {
      const rule1 = { id: 1, trade_id: 1, entry_price: 100, stop_loss_percent: 10, take_profit_percent: null, status: "active" };
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => null,
            all: (...args) => {
              // Only return rule if the trade_id matches what was queried
              return args[0] === 1 ? [rule1] : [];
            },
            run: () => ({ lastInsertRowid: 1 }),
          }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_check_stop_loss");
      const result = await tool.execute({ current_price: 100, trade_id: 1 }, {});
      assert.equal(result.success, true);
      assert.equal(result.data.active_rules, 1);
    });

    it("returns empty results when no active rules exist", async () => {
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => [], run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_check_stop_loss");
      const result = await tool.execute({ current_price: 50 }, {});
      assert.equal(result.success, true);
      assert.equal(result.data.active_rules, 0);
      assert.equal(result.data.triggered_rules.length, 0);
      assert.equal(result.data.safe_rules.length, 0);
    });
  });

  // ── ton_trading_get_optimal_position_size ──────────────────────────────────
  describe("ton_trading_get_optimal_position_size", () => {
    it("required parameters include stop_loss_percent", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_optimal_position_size");
      assert.ok(tool.parameters?.required?.includes("stop_loss_percent"));
    });

    it("returns position sizes for simulation mode with no history", async () => {
      const sdk = makeSdk({
        dbRows: { simBalance: { balance: 1000 } },
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => sql.includes("sim_balance") ? { balance: 1000 } : null,
            all: () => [],
            run: () => ({ lastInsertRowid: 1 }),
          }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_optimal_position_size");
      const result = await tool.execute({ mode: "simulation", stop_loss_percent: 5 }, {});
      assert.equal(result.success, true);
      assert.ok("kelly_position_size" in result.data);
      assert.ok("fixed_fraction_position_size" in result.data);
      assert.ok("recommendation" in result.data);
    });

    it("returns position sizes for real mode", async () => {
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({ get: () => null, all: () => [], run: () => ({ lastInsertRowid: 1 }) }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_optimal_position_size");
      const result = await tool.execute({ mode: "real", stop_loss_percent: 10, risk_percent: 2 }, {});
      assert.equal(result.success, true);
      assert.equal(result.data.mode, "real");
    });
  });

  // ── ton_trading_schedule_trade ──────────────────────────────────────────────
  describe("ton_trading_schedule_trade", () => {
    it("required parameters include mode, from_asset, to_asset, amount, execute_at_iso", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_schedule_trade");
      assert.ok(tool.parameters?.required?.includes("mode"));
      assert.ok(tool.parameters?.required?.includes("from_asset"));
      assert.ok(tool.parameters?.required?.includes("to_asset"));
      assert.ok(tool.parameters?.required?.includes("amount"));
      assert.ok(tool.parameters?.required?.includes("execute_at_iso"));
    });

    it("schedules a trade and returns scheduled_id", async () => {
      const sdk = makeSdk({ dbRows: { lastInsertRowid: 42 } });
      const futureDate = new Date(Date.now() + 3_600_000).toISOString(); // 1h from now
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_schedule_trade");
      const result = await tool.execute(
        { mode: "simulation", from_asset: "TON", to_asset: "EQCxE6test", amount: 5, execute_at_iso: futureDate },
        {}
      );
      assert.equal(result.success, true);
      assert.equal(result.data.scheduled_id, 42);
      assert.equal(result.data.status, "pending");
    });

    it("returns failure for invalid date", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_schedule_trade");
      const result = await tool.execute(
        { mode: "simulation", from_asset: "TON", to_asset: "EQCxE6test", amount: 5, execute_at_iso: "not-a-date" },
        {}
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("Invalid execute_at_iso"));
    });

    it("returns failure for past date", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_schedule_trade");
      const pastDate = new Date(Date.now() - 3_600_000).toISOString();
      const result = await tool.execute(
        { mode: "simulation", from_asset: "TON", to_asset: "EQCxE6test", amount: 5, execute_at_iso: pastDate },
        {}
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("future"));
    });
  });

  // ── ton_trading_get_scheduled_trades ───────────────────────────────────────
  describe("ton_trading_get_scheduled_trades", () => {
    it("has correct name and category", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_scheduled_trades");
      assert.ok(tool);
      assert.equal(tool.category, "data-bearing");
    });

    it("returns scheduled trades list with due flag", async () => {
      const now = Date.now();
      const dueTrade = { id: 1, execute_at: now - 1000, status: "pending", from_asset: "TON", to_asset: "EQCxE6test", amount: 5 };
      const pendingTrade = { id: 2, execute_at: now + 3_600_000, status: "pending", from_asset: "TON", to_asset: "EQCxE6test", amount: 3 };
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: () => ({
            get: () => null,
            all: () => [dueTrade, pendingTrade],
            run: () => ({ lastInsertRowid: 1 }),
          }),
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_scheduled_trades");
      const result = await tool.execute({ status: "pending" }, {});
      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.data.scheduled_trades));
      assert.equal(result.data.due_now, 1);
      assert.ok(result.data.scheduled_trades[0].is_due === true);
      assert.ok(result.data.scheduled_trades[1].is_due === false);
    });
  });

  // ── SQL injection tests ─────────────────────────────────────────────────────
  describe("SQL injection prevention", () => {
    it("ton_trading_calculate_risk_metrics: mode value is passed as parameter, not interpolated", async () => {
      const capturedSqls = [];
      const capturedParams = [];
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: (sql) => {
            capturedSqls.push(sql);
            return {
              get: () => null,
              all: (...params) => { capturedParams.push(params); return []; },
              run: () => ({ lastInsertRowid: 1 }),
            };
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_calculate_risk_metrics");
      await tool.execute({ mode: "real", lookback_days: 7, confidence_level: 0.95 }, {});
      const riskSql = capturedSqls.find((s) => s.includes("trade_journal"));
      assert.ok(riskSql, "trade_journal query should be captured");
      // SQL must not contain the literal mode value — it must use a placeholder
      assert.ok(!riskSql.includes("'real'"), "mode value must not be string-interpolated into SQL");
      assert.ok(riskSql.includes("?"), "SQL must use parameterized placeholder");
      // The mode value must be passed as a bound parameter
      const riskParams = capturedParams.find((p) => p.some((v) => v === "real"));
      assert.ok(riskParams, "mode value 'real' must be passed as a bound parameter");
    });

    it("ton_trading_calculate_risk_metrics: SQL injection payload is not interpolated", async () => {
      const capturedSqls = [];
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: (sql) => {
            capturedSqls.push(sql);
            return {
              get: () => null,
              all: () => [],
              run: () => ({ lastInsertRowid: 1 }),
            };
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_calculate_risk_metrics");
      const injectionPayload = "real' OR '1'='1";
      await tool.execute({ mode: injectionPayload, lookback_days: 7, confidence_level: 0.95 }, {});
      const riskSql = capturedSqls.find((s) => s.includes("trade_journal"));
      assert.ok(riskSql, "trade_journal query should be captured");
      assert.ok(!riskSql.includes(injectionPayload), "SQL injection payload must not appear in query string");
    });

    it("ton_trading_get_scheduled_trades: status value is passed as parameter, not interpolated", async () => {
      const capturedSqls = [];
      const capturedParams = [];
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: (sql) => {
            capturedSqls.push(sql);
            return {
              get: () => null,
              all: (...params) => { capturedParams.push(params); return []; },
              run: () => ({ lastInsertRowid: 1 }),
            };
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_scheduled_trades");
      await tool.execute({ status: "pending", limit: 10 }, {});
      const schedSql = capturedSqls.find((s) => s.includes("scheduled_trades"));
      assert.ok(schedSql, "scheduled_trades query should be captured");
      assert.ok(!schedSql.includes("'pending'"), "status value must not be string-interpolated into SQL");
      assert.ok(schedSql.includes("?"), "SQL must use parameterized placeholder");
      const schedParams = capturedParams.find((p) => p.some((v) => v === "pending"));
      assert.ok(schedParams, "status value 'pending' must be passed as a bound parameter");
    });

    it("ton_trading_get_scheduled_trades: SQL injection payload is not interpolated", async () => {
      const capturedSqls = [];
      const sdk = makeSdk({
        db: {
          exec: () => {},
          prepare: (sql) => {
            capturedSqls.push(sql);
            return {
              get: () => null,
              all: () => [],
              run: () => ({ lastInsertRowid: 1 }),
            };
          },
        },
      });
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_get_scheduled_trades");
      const injectionPayload = "pending' OR '1'='1";
      await tool.execute({ status: injectionPayload, limit: 10 }, {});
      const schedSql = capturedSqls.find((s) => s.includes("scheduled_trades"));
      assert.ok(schedSql, "scheduled_trades query should be captured");
      assert.ok(!schedSql.includes(injectionPayload), "SQL injection payload must not appear in query string");
    });
  });

  // ── ton_trading_record_trade: simulation balance bug fix ────────────────────
  describe("ton_trading_record_trade simulation balance credit-back (issue #96)", () => {
    it("credits principal + profit back when from_asset is TON and USD prices are provided", async () => {
      // Reproduces issue #96: 13 TON → USDT trade, exit_price_usd=1, entry_price_usd=1.33 (TON price)
      // pnl_usd = (amount_out * exit_price_usd) - (amount_in * entry_price_usd)
      //         = (17.39 * 1) - (13 * 1.33) = 17.39 - 17.29 = 0.10 USD
      // credit_ton = amount_in + pnl_usd / entry_price_usd = 13 + 0.10/1.33 ≈ 13.075
      const openTrade = {
        id: 100,
        mode: "simulation",
        from_asset: "TON",
        to_asset: "EQUsdtAddress",
        amount_in: 13,
        entry_price_usd: 1.33,
        amount_out: null,
        status: "open",
      };
      let savedBalance = null;
      const sdk = {
        ...makeSdk({ dbRows: { trade: openTrade, simBalance: { balance: 50 } } }),
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => {
              if (sql.includes("sim_balance")) return { balance: 50 };
              if (sql.includes("trade_journal") && sql.includes("WHERE id")) return openTrade;
              return null;
            },
            all: () => [],
            run: (...args) => {
              if (sql.includes("INSERT INTO sim_balance")) savedBalance = args[1];
              return { lastInsertRowid: 1 };
            },
          }),
        },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      };
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute(
        { trade_id: 100, amount_out: 17.39, exit_price_usd: 1 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.ok(savedBalance !== null, "simulation balance should be updated on close");
      // Expected: 50 (prev balance) + 13 (principal) + pnl_ton ≈ 50 + 13 + 0.075 ≈ 63.075
      assert.ok(savedBalance > 63, `balance should be restored to ~63+, got ${savedBalance}`);
      assert.ok(savedBalance < 64, `balance should be around 63, got ${savedBalance}`);
    });

    it("credits amount_out directly when no USD prices given (same-currency TON→TON trade)", async () => {
      // TON→TON trade: deducted 10, received 11 → credit back 11
      const openTrade = {
        id: 101,
        mode: "simulation",
        from_asset: "TON",
        to_asset: "TON",
        amount_in: 10,
        entry_price_usd: null,
        amount_out: null,
        status: "open",
      };
      let savedBalance = null;
      const sdk = {
        ...makeSdk({ dbRows: { trade: openTrade, simBalance: { balance: 90 } } }),
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => {
              if (sql.includes("sim_balance")) return { balance: 90 };
              if (sql.includes("trade_journal") && sql.includes("WHERE id")) return openTrade;
              return null;
            },
            all: () => [],
            run: (...args) => {
              if (sql.includes("INSERT INTO sim_balance")) savedBalance = args[1];
              return { lastInsertRowid: 1 };
            },
          }),
        },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      };
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute({ trade_id: 101, amount_out: 11 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(savedBalance, 90 + 11, "should credit amount_out (11) back to balance (90+11=101)");
    });

    it("does NOT credit balance when from_asset is not TON (e.g. USDT→TON trade)", async () => {
      // USDT→TON trade: no TON was deducted at open, so nothing to credit back
      const openTrade = {
        id: 102,
        mode: "simulation",
        from_asset: "EQUsdtAddress",
        to_asset: "TON",
        amount_in: 50,
        entry_price_usd: 1,
        amount_out: null,
        status: "open",
      };
      let savedBalance = null;
      const sdk = {
        ...makeSdk({ dbRows: { trade: openTrade } }),
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => {
              if (sql.includes("sim_balance")) return { balance: 100 };
              if (sql.includes("trade_journal") && sql.includes("WHERE id")) return openTrade;
              return null;
            },
            all: () => [],
            run: (...args) => {
              if (sql.includes("INSERT INTO sim_balance")) savedBalance = args[1];
              return { lastInsertRowid: 1 };
            },
          }),
        },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      };
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute(
        { trade_id: 102, amount_out: 37.6, exit_price_usd: 1.33 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(savedBalance, null, "should NOT update sim balance for non-TON from_asset trades");
    });

    it("credits back principal + loss when trade is a loss (TON→USDT losing trade)", async () => {
      // 10 TON → USDT at $2/TON (entry), exit at $1.5/TON equivalent → loss
      // amount_out = 15 USDT, exit_price_usd = 1 (USDT price)
      // usdOut = 15, usdIn = 10 * 2 = 20, pnl = -5 USD
      // credit_ton = 10 + (-5/2) = 10 - 2.5 = 7.5 TON
      const openTrade = {
        id: 103,
        mode: "simulation",
        from_asset: "TON",
        to_asset: "EQUsdtAddress",
        amount_in: 10,
        entry_price_usd: 2,
        amount_out: null,
        status: "open",
      };
      let savedBalance = null;
      const sdk = {
        ...makeSdk({ dbRows: { trade: openTrade } }),
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => {
              if (sql.includes("sim_balance")) return { balance: 90 };
              if (sql.includes("trade_journal") && sql.includes("WHERE id")) return openTrade;
              return null;
            },
            all: () => [],
            run: (...args) => {
              if (sql.includes("INSERT INTO sim_balance")) savedBalance = args[1];
              return { lastInsertRowid: 1 };
            },
          }),
        },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      };
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_record_trade");
      const result = await tool.execute(
        { trade_id: 103, amount_out: 15, exit_price_usd: 1 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.profit_or_loss, "loss");
      // credit_ton = 7.5, new balance = 90 + 7.5 = 97.5
      assert.ok(Math.abs(savedBalance - 97.5) < 0.0001, `expected 97.5, got ${savedBalance}`);
    });
  });

  // ── ton_trading_reset_simulation_balance ────────────────────────────────────
  describe("ton_trading_reset_simulation_balance", () => {
    it("resets balance to specified amount and returns previous balance", async () => {
      let savedBalance = null;
      const sdk = {
        ...makeSdk({ dbRows: { simBalance: { balance: 42 } } }),
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => (sql.includes("sim_balance") ? { balance: 42 } : null),
            all: () => [],
            run: (...args) => {
              if (sql.includes("INSERT INTO sim_balance")) savedBalance = args[1];
              return { lastInsertRowid: 1 };
            },
          }),
        },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      };
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_reset_simulation_balance");
      const result = await tool.execute({ amount: 1000 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.previous_balance, 42);
      assert.equal(result.data.new_balance, 1000);
      assert.equal(savedBalance, 1000);
    });

    it("uses plugin config simulationBalance as default when no amount given", async () => {
      let savedBalance = null;
      const sdk = {
        ...makeSdk({ pluginConfig: { simulationBalance: 500 }, dbRows: { simBalance: { balance: 10 } } }),
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => (sql.includes("sim_balance") ? { balance: 10 } : null),
            all: () => [],
            run: (...args) => {
              if (sql.includes("INSERT INTO sim_balance")) savedBalance = args[1];
              return { lastInsertRowid: 1 };
            },
          }),
        },
        pluginConfig: { simulationBalance: 500 },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      };
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_reset_simulation_balance");
      const result = await tool.execute({}, makeContext());
      assert.equal(result.success, true);
      assert.equal(savedBalance, 500, "should default to simulationBalance config value");
    });
  });

  // ── ton_trading_set_simulation_balance ──────────────────────────────────────
  describe("ton_trading_set_simulation_balance", () => {
    it("sets balance to specified amount and returns previous balance", async () => {
      let savedBalance = null;
      const sdk = {
        ...makeSdk({ dbRows: { simBalance: { balance: 200 } } }),
        db: {
          exec: () => {},
          prepare: (sql) => ({
            get: () => (sql.includes("sim_balance") ? { balance: 200 } : null),
            all: () => [],
            run: (...args) => {
              if (sql.includes("INSERT INTO sim_balance")) savedBalance = args[1];
              return { lastInsertRowid: 1 };
            },
          }),
        },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      };
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_set_simulation_balance");
      const result = await tool.execute({ amount: 350 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.previous_balance, 200);
      assert.equal(result.data.new_balance, 350);
      assert.equal(savedBalance, 350);
    });

    it("required parameters include amount", () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "ton_trading_set_simulation_balance");
      assert.ok(tool.parameters?.required?.includes("amount"));
    });
  });
});
