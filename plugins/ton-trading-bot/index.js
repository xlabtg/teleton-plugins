/**
 * TON Trading Bot Plugin
 *
 * Granular, atomic tools for the LLM to compose trading workflows on TON:
 *   - ton_trading_get_market_data          — fetch current prices and DEX quotes
 *   - ton_trading_get_portfolio            — wallet balance, jetton holdings, trade history
 *   - ton_trading_validate_trade           — check risk parameters before acting
 *   - ton_trading_simulate_trade           — paper-trade without real money
 *   - ton_trading_execute_swap             — execute real swap on TON DEX (DM-only)
 *   - ton_trading_record_trade             — record a closed trade and update PnL
 *
 * Algorithmic trading tools (P0 — highest priority):
 *   - ton_trading_get_arbitrage_opportunities — find cross-DEX price differences
 *   - ton_trading_get_token_listings          — monitor new token launches on DEXes
 *   - ton_trading_get_token_info              — get details for a specific token
 *   - ton_trading_validate_token              — safety-check a token before sniping
 *   - ton_trading_get_top_traders             — find wallets with strong track records
 *   - ton_trading_get_trader_performance      — analyse a specific trader's history
 *
 * Liquidity & farming tools (P1):
 *   - ton_trading_get_active_pools            — list active DEX liquidity pools
 *   - ton_trading_get_farms_with_apy          — list yield farms sorted by APY
 *   - ton_trading_get_pool_volume             — get 24-h volume for a pool
 *
 * Backtesting tools (P1):
 *   - ton_trading_backtest                    — replay a strategy against trade history
 *
 * Risk management tools (P2):
 *   - ton_trading_calculate_risk_metrics      — VaR, max drawdown, Sharpe ratio
 *   - ton_trading_set_stop_loss               — register a stop-loss rule in the journal
 *   - ton_trading_check_stop_loss             — query active rules and detect triggered stop-loss / take-profit
 *   - ton_trading_get_optimal_position_size   — Kelly / fixed-fraction sizing
 *
 * Automation tools (P2):
 *   - ton_trading_schedule_trade              — store a pending trade for future execution
 *   - ton_trading_get_scheduled_trades        — list pending scheduled trades
 *
 * Pattern B (SDK) — uses sdk.ton, sdk.ton.dex, sdk.db, sdk.storage, sdk.log
 *
 * Architecture: each tool is atomic. The LLM composes them into a strategy.
 * No internal signal generation, no embedded strategy loops.
 */

export const manifest = {
  name: "ton-trading-bot",
  version: "2.0.0",
  sdkVersion: ">=1.0.0",
  description: "Atomic TON trading tools: market data, portfolio, risk validation, simulation, DEX swap execution, cross-DEX arbitrage, sniper trading, copy trading, liquidity pools, farming, backtesting, risk management, and automation. The LLM composes these into trading strategies.",
  defaultConfig: {
    maxTradePercent: 10,       // max single trade as % of balance
    minBalanceTON: 1,          // minimum TON balance required to trade
    defaultSlippage: 0.05,     // 5% slippage tolerance
    simulationBalance: 1000,   // starting virtual balance for paper trading
  },
};

// ─── Database Migration ──────────────────────────────────────────────────────

export function migrate(db) {
  db.exec(`
    -- Trade journal: every executed and simulated trade
    CREATE TABLE IF NOT EXISTS trade_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      mode TEXT NOT NULL,           -- 'real' | 'simulation'
      action TEXT NOT NULL,         -- 'buy' | 'sell'
      from_asset TEXT NOT NULL,
      to_asset TEXT NOT NULL,
      amount_in REAL NOT NULL,
      amount_out REAL,
      entry_price_usd REAL,         -- USD price of from_asset at entry (for cross-currency P&L)
      exit_price_usd REAL,          -- USD price of to_asset at exit (for cross-currency P&L)
      pnl REAL,
      pnl_percent REAL,
      status TEXT NOT NULL,         -- 'open' | 'closed' | 'failed'
      tx_hash TEXT,
      note TEXT
    );

    -- Simulation balance ledger
    CREATE TABLE IF NOT EXISTS sim_balance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      balance REAL NOT NULL
    );

    -- Stop-loss rules: registered per open trade
    CREATE TABLE IF NOT EXISTS stop_loss_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL,
      stop_loss_percent REAL NOT NULL,   -- e.g. 5 means close at -5%
      take_profit_percent REAL,          -- optional take-profit level
      entry_price REAL NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'triggered' | 'cancelled'
    );

    -- Scheduled trades: pending orders for future execution
    CREATE TABLE IF NOT EXISTS scheduled_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      execute_at INTEGER NOT NULL,       -- Unix ms timestamp
      mode TEXT NOT NULL,               -- 'real' | 'simulation'
      from_asset TEXT NOT NULL,
      to_asset TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'executed' | 'cancelled'
    );
  `);

  // Backward-compatible migrations for existing databases created before these columns were added.
  // SQLite does not support "ADD COLUMN IF NOT EXISTS", so we use a try/catch per column.
  const alterColumns = [
    "ALTER TABLE trade_journal ADD COLUMN entry_price_usd REAL",
    "ALTER TABLE trade_journal ADD COLUMN exit_price_usd REAL",
  ];
  for (const sql of alterColumns) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSimBalance(sdk) {
  const row = sdk.db
    .prepare("SELECT balance FROM sim_balance ORDER BY timestamp DESC LIMIT 1")
    .get();
  return row ? row.balance : (sdk.pluginConfig.simulationBalance ?? 1000);
}

function setSimBalance(sdk, balance) {
  sdk.db
    .prepare("INSERT INTO sim_balance (timestamp, balance) VALUES (?, ?)")
    .run(Date.now(), balance);
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export const tools = (sdk) => [

  // ── Tool 1: ton_trading_get_market_data ────────────────────────────────────
  {
    name: "ton_trading_get_market_data",
    description:
      "Fetch current TON price and DEX swap quotes for a token pair. Returns raw market data for the LLM to analyze and decide on a trading action.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        from_asset: {
          type: "string",
          description: 'Asset to swap from — "TON" for native TON, or a jetton master address (e.g. "EQCxE6...")',
        },
        to_asset: {
          type: "string",
          description: 'Asset to swap to — "TON" for native TON, or a jetton master address',
        },
        amount: {
          type: "string",
          description: 'Amount of from_asset to quote (human-readable, e.g. "1" for 1 TON)',
        },
      },
      required: ["from_asset", "to_asset", "amount"],
    },
    execute: async (params, _context) => {
      const { from_asset, to_asset, amount } = params;
      try {
        const [tonPrice, dexQuote] = await Promise.all([
          sdk.ton.getPrice(),
          sdk.ton.dex.quote({
            fromAsset: from_asset,
            toAsset: to_asset,
            amount: parseFloat(amount),
          }).catch((err) => {
            sdk.log.warn(`DEX quote failed: ${err.message}`);
            return null;
          }),
        ]);

        const walletAddress = sdk.ton.getAddress();

        const data = {
          ton_price_usd: tonPrice?.usd ?? null,
          ton_price_source: tonPrice?.source ?? null,
          wallet_address: walletAddress,
          quote: dexQuote
            ? {
                from_asset,
                to_asset,
                amount_in: amount,
                stonfi: dexQuote.stonfi ?? null,
                dedust: dexQuote.dedust ?? null,
                recommended: dexQuote.recommended ?? null,
                savings: dexQuote.savings ?? null,
              }
            : null,
        };

        // Cache for use by validate/simulate tools
        sdk.storage.set(`market:${from_asset}:${to_asset}`, data, { ttl: 60_000 });

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_market_data failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 2: ton_trading_get_portfolio ──────────────────────────────────────
  {
    name: "ton_trading_get_portfolio",
    description:
      "Get the agent's current portfolio: TON balance, jetton (token) holdings, and recent trade history from the journal.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        history_limit: {
          type: "integer",
          description: "Number of recent trades to include (1–50, default 10)",
          minimum: 1,
          maximum: 50,
        },
      },
    },
    execute: async (params, _context) => {
      const limit = params.history_limit ?? 10;
      try {
        const [tonBalance, jettonBalances] = await Promise.all([
          sdk.ton.getBalance(),
          sdk.ton.getJettonBalances().catch(() => []),
        ]);

        const recentTrades = sdk.db
          .prepare(
            "SELECT * FROM trade_journal ORDER BY timestamp DESC LIMIT ?"
          )
          .all(limit);

        const simBalance = getSimBalance(sdk);

        return {
          success: true,
          data: {
            wallet_address: sdk.ton.getAddress(),
            ton_balance: tonBalance?.balance ?? null,
            ton_balance_nano: tonBalance?.balanceNano ?? null,
            simulation_balance: simBalance,
            jetton_holdings: jettonBalances.map((j) => ({
              jetton_address: j.jettonAddress ?? null,
              name: j.name ?? null,
              symbol: j.symbol ?? null,
              balance: j.balanceFormatted ?? j.balance ?? null,
            })),
            recent_trades: recentTrades,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_get_portfolio failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 3: ton_trading_validate_trade ─────────────────────────────────────
  {
    name: "ton_trading_validate_trade",
    description:
      "Check whether a proposed trade meets risk parameters: balance sufficiency, maximum trade percentage cap, and minimum balance floor. Returns a pass/fail result with reasons. Call this before executing or simulating a trade.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Trading mode: "real" uses wallet balance, "simulation" uses the virtual balance',
          enum: ["real", "simulation"],
        },
        amount_ton: {
          type: "number",
          description: "Amount of TON being traded",
        },
      },
      required: ["mode", "amount_ton"],
    },
    execute: async (params, _context) => {
      const { mode, amount_ton } = params;
      try {
        const balance =
          mode === "simulation"
            ? getSimBalance(sdk)
            : parseFloat((await sdk.ton.getBalance())?.balance ?? "0");

        const maxTradePercent = sdk.pluginConfig.maxTradePercent ?? 10;
        const minBalance = sdk.pluginConfig.minBalanceTON ?? 1;
        const maxAllowed = balance * (maxTradePercent / 100);

        const issues = [];

        if (balance < minBalance) {
          issues.push({
            type: "insufficient_balance",
            message: `Balance (${balance} TON) is below minimum (${minBalance} TON)`,
          });
        }

        if (amount_ton > maxAllowed) {
          issues.push({
            type: "exceeds_max_trade_percent",
            message: `Amount ${amount_ton} TON exceeds ${maxTradePercent}% of balance (max ${maxAllowed.toFixed(4)} TON)`,
          });
        }

        if (amount_ton > balance) {
          issues.push({
            type: "exceeds_balance",
            message: `Amount ${amount_ton} TON exceeds available balance (${balance} TON)`,
          });
        }

        const passed = issues.length === 0;

        return {
          success: true,
          data: {
            passed,
            mode,
            current_balance: balance,
            requested_amount: amount_ton,
            max_allowed_amount: parseFloat(maxAllowed.toFixed(6)),
            issues,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_validate_trade failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 4: ton_trading_simulate_trade ─────────────────────────────────────
  {
    name: "ton_trading_simulate_trade",
    description:
      "Paper-trade (simulate) a swap using the virtual simulation balance. No real funds are spent. Records the simulated trade in the journal.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        from_asset: {
          type: "string",
          description: 'Asset being sold — "TON" or a jetton master address',
        },
        to_asset: {
          type: "string",
          description: 'Asset being bought — "TON" or a jetton master address',
        },
        amount_in: {
          type: "number",
          description: "Amount of from_asset to trade",
        },
        expected_amount_out: {
          type: "number",
          description: "Expected output amount from a prior market data fetch or DEX quote",
        },
        note: {
          type: "string",
          description: "Optional note describing the rationale for this trade",
        },
        entry_price_usd: {
          type: "number",
          description: "USD price of from_asset at trade entry. Required for accurate P&L when trading between non-USD pairs (e.g. TON/USDT). Obtain from ton_trading_get_market_data.",
        },
      },
      required: ["from_asset", "to_asset", "amount_in", "expected_amount_out"],
    },
    execute: async (params, _context) => {
      const { from_asset, to_asset, amount_in, expected_amount_out, note, entry_price_usd } = params;
      try {
        const simBalance = getSimBalance(sdk);
        const minBalance = sdk.pluginConfig.minBalanceTON ?? 1;

        if (from_asset === "TON" && simBalance < amount_in) {
          return {
            success: false,
            error: `Insufficient simulation balance: ${simBalance} TON (need ${amount_in} TON)`,
          };
        }

        if (from_asset === "TON" && simBalance - amount_in < minBalance) {
          return {
            success: false,
            error: `Trade would bring simulation balance below minimum (${minBalance} TON)`,
          };
        }

        // Update virtual balance: if selling TON, deduct it
        if (from_asset === "TON") {
          setSimBalance(sdk, simBalance - amount_in);
        }

        const tradeId = sdk.db
          .prepare(
            `INSERT INTO trade_journal
             (timestamp, mode, action, from_asset, to_asset, amount_in, amount_out, entry_price_usd, status, note)
             VALUES (?, 'simulation', 'buy', ?, ?, ?, ?, ?, 'open', ?)`
          )
          .run(Date.now(), from_asset, to_asset, amount_in, expected_amount_out, entry_price_usd ?? null, note ?? null)
          .lastInsertRowid;

        sdk.log.info(
          `Simulated trade #${tradeId}: ${amount_in} ${from_asset} → ${expected_amount_out} ${to_asset}`
        );

        return {
          success: true,
          data: {
            trade_id: tradeId,
            mode: "simulation",
            from_asset,
            to_asset,
            amount_in,
            expected_amount_out,
            entry_price_usd: entry_price_usd ?? null,
            new_simulation_balance: from_asset === "TON" ? simBalance - amount_in : simBalance,
            status: "open",
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_simulate_trade failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 5: ton_trading_execute_swap ───────────────────────────────────────
  {
    name: "ton_trading_execute_swap",
    description:
      "Execute a real token swap on TON DEX (STON.fi / DeDust) from the agent wallet. This spends real funds — call ton_trading_validate_trade first. Only available in direct messages for security.",
    category: "action",
    scope: "dm-only",
    parameters: {
      type: "object",
      properties: {
        from_asset: {
          type: "string",
          description: 'Asset to sell — "TON" or a jetton master address',
        },
        to_asset: {
          type: "string",
          description: 'Asset to buy — "TON" or a jetton master address',
        },
        amount: {
          type: "string",
          description: 'Amount to sell in human-readable units (e.g. "2.5" for 2.5 TON)',
        },
        slippage: {
          type: "number",
          description: "Slippage tolerance (e.g. 0.05 for 5%). Defaults to plugin config (default: 0.05)",
          minimum: 0.001,
          maximum: 0.5,
        },
        dex: {
          type: "string",
          description: 'Preferred DEX: "stonfi", "dedust", or omit to use the best available quote',
          enum: ["stonfi", "dedust"],
        },
        entry_price_usd: {
          type: "number",
          description: "USD price of from_asset at trade entry. Required for accurate P&L when trading between non-USD pairs (e.g. TON/USDT). Obtain from ton_trading_get_market_data.",
        },
      },
      required: ["from_asset", "to_asset", "amount"],
    },
    execute: async (params, context) => {
      const {
        from_asset,
        to_asset,
        amount,
        slippage = sdk.pluginConfig.defaultSlippage ?? 0.05,
        dex,
        entry_price_usd,
      } = params;

      try {
        const walletAddress = sdk.ton.getAddress();
        if (!walletAddress) {
          return { success: false, error: "Wallet not initialized" };
        }

        const result = await sdk.ton.dex.swap({
          fromAsset: from_asset,
          toAsset: to_asset,
          amount: parseFloat(amount),
          slippage,
          ...(dex ? { dex } : {}),
        });

        const tradeId = sdk.db
          .prepare(
            `INSERT INTO trade_journal
             (timestamp, mode, action, from_asset, to_asset, amount_in, amount_out, entry_price_usd, status)
             VALUES (?, 'real', 'buy', ?, ?, ?, ?, ?, 'open')`
          )
          .run(
            Date.now(),
            from_asset,
            to_asset,
            parseFloat(amount),
            result?.expectedOutput ? parseFloat(result.expectedOutput) : null,
            entry_price_usd ?? null
          )
          .lastInsertRowid;

        sdk.log.info(
          `Swap executed #${tradeId}: ${amount} ${from_asset} → ${to_asset} via ${result?.dex ?? dex ?? "best"}`
        );

        try {
          await sdk.telegram.sendMessage(
            context.chatId,
            `Swap submitted: ${amount} ${from_asset} → ${to_asset}\nExpected output: ${result?.expectedOutput ?? "unknown"}\nTrade ID: ${tradeId}\nAllow ~30 seconds for on-chain confirmation.`
          );
        } catch (msgErr) {
          if (msgErr.name === "PluginSDKError") {
            sdk.log.warn(`Could not send confirmation message: ${msgErr.code}: ${msgErr.message}`);
          } else {
            sdk.log.warn(`Could not send confirmation message: ${msgErr.message}`);
          }
        }

        return {
          success: true,
          data: {
            trade_id: tradeId,
            from_asset,
            to_asset,
            amount_in: amount,
            expected_output: result?.expectedOutput ?? null,
            min_output: result?.minOutput ?? null,
            slippage,
            dex: result?.dex ?? dex ?? "auto",
            status: "open",
            note: "Allow ~30 seconds for on-chain confirmation",
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_execute_swap failed: ${err.message}`);
        if (err.name === "PluginSDKError") {
          return { success: false, error: `${err.code}: ${String(err.message).slice(0, 500)}` };
        }
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 6: ton_trading_record_trade ───────────────────────────────────────
  {
    name: "ton_trading_record_trade",
    description:
      "Close an open trade in the journal and record the final output amount and PnL. Use this after selling a position to track performance.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        trade_id: {
          type: "integer",
          description: "Journal trade ID returned by ton_trading_execute_swap or ton_trading_simulate_trade",
        },
        amount_out: {
          type: "number",
          description: "Actual amount received when closing the trade",
        },
        exit_price_usd: {
          type: "number",
          description: "USD price of to_asset at trade exit. Required for accurate P&L when trading between non-USD pairs (e.g. TON/USDT). Obtain from ton_trading_get_market_data.",
        },
        note: {
          type: "string",
          description: "Optional note (e.g. exit reason)",
        },
      },
      required: ["trade_id", "amount_out"],
    },
    execute: async (params, _context) => {
      const { trade_id, amount_out, exit_price_usd, note } = params;
      try {
        const entry = sdk.db
          .prepare("SELECT * FROM trade_journal WHERE id = ?")
          .get(trade_id);

        if (!entry) {
          return { success: false, error: `Trade ${trade_id} not found` };
        }

        if (entry.status === "closed") {
          return { success: false, error: `Trade ${trade_id} is already closed` };
        }

        // Convert amounts to USD when prices are available to handle cross-currency P&L.
        // Example: 50 USDT → 37.6 TON. Without conversion, pnl = 37.6 - 50 = -12.4 (wrong).
        // With prices: usdOut = 37.6 * 1.33 = 50.008, usdIn = 50 * 1 = 50, pnl = 0.008 (correct).
        const entryPriceUsd = entry.entry_price_usd ?? exit_price_usd ?? null;
        const usdIn = entryPriceUsd != null ? entry.amount_in * entryPriceUsd : entry.amount_in;
        const usdOut = exit_price_usd != null ? amount_out * exit_price_usd : amount_out;

        const pnl = usdOut - usdIn;
        const pnlPercent =
          usdIn > 0 ? (pnl / usdIn) * 100 : 0;

        sdk.db
          .prepare(
            `UPDATE trade_journal
             SET amount_out = ?, exit_price_usd = ?, pnl = ?, pnl_percent = ?, status = 'closed', note = COALESCE(?, note)
             WHERE id = ?`
          )
          .run(amount_out, exit_price_usd ?? null, pnl, pnlPercent, note ?? null, trade_id);

        // If simulation, credit the proceeds back
        if (entry.mode === "simulation" && entry.to_asset === "TON") {
          const simBalance = getSimBalance(sdk);
          setSimBalance(sdk, simBalance + amount_out);
        }

        sdk.log.info(
          `Trade #${trade_id} closed: PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} (${pnlPercent.toFixed(2)}%)`
        );

        return {
          success: true,
          data: {
            trade_id,
            amount_in: entry.amount_in,
            amount_out,
            pnl: parseFloat(pnl.toFixed(6)),
            pnl_percent: parseFloat(pnlPercent.toFixed(2)),
            profit_or_loss: pnl >= 0 ? "profit" : "loss",
            mode: entry.mode,
            status: "closed",
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_record_trade failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── P0 Tools: Cross-DEX Arbitrage ─────────────────────────────────────────

  // ── Tool 7: ton_trading_get_arbitrage_opportunities ────────────────────────
  {
    name: "ton_trading_get_arbitrage_opportunities",
    description:
      "Find cross-DEX price differences for a token pair across StonFi, DeDust, TONCO, and swap.coffee. Returns opportunities sorted by net profit after fees. Call this before deciding to execute an arbitrage trade.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        from_asset: {
          type: "string",
          description: 'Asset to quote from — "TON" or a jetton master address',
        },
        to_asset: {
          type: "string",
          description: 'Asset to quote to — "TON" or a jetton master address',
        },
        amount: {
          type: "string",
          description: 'Amount to quote in from_asset units (e.g. "1")',
        },
        min_profit_percent: {
          type: "number",
          description: "Minimum net profit percentage to include in results (default 0.5)",
          minimum: 0,
        },
      },
      required: ["from_asset", "to_asset", "amount"],
    },
    execute: async (params, _context) => {
      const { from_asset, to_asset, amount, min_profit_percent = 0.5 } = params;
      try {
        const dexFees = { stonfi: 0.003, dedust: 0.003, tonco: 0.003, swapcoffee: 0.002 };

        const quote = await sdk.ton.dex.quote({
          fromAsset: from_asset,
          toAsset: to_asset,
          amount: parseFloat(amount),
        }).catch((err) => {
          sdk.log.warn(`DEX quote failed: ${err.message}`);
          return null;
        });

        if (!quote) {
          return { success: false, error: "Could not fetch DEX quotes" };
        }

        // Collect per-DEX outputs
        const dexOutputs = [];
        for (const [dex, fee] of Object.entries(dexFees)) {
          const raw = quote[dex];
          if (!raw) continue;
          const outputRaw = parseFloat(raw.output ?? raw.price ?? 0);
          if (outputRaw <= 0) continue;
          const outputAfterFee = outputRaw * (1 - fee);
          dexOutputs.push({ dex, output: outputRaw, outputAfterFee, fee });
        }

        if (dexOutputs.length < 2) {
          return {
            success: true,
            data: { opportunities: [], note: "Not enough DEX quotes to compute arbitrage" },
          };
        }

        // Find all buy-low / sell-high pairs
        const opportunities = [];
        for (let i = 0; i < dexOutputs.length; i++) {
          for (let j = 0; j < dexOutputs.length; j++) {
            if (i === j) continue;
            const buy = dexOutputs[i];
            const sell = dexOutputs[j];
            if (buy.outputAfterFee >= sell.outputAfterFee) continue;
            const profitPercent =
              ((sell.outputAfterFee - buy.outputAfterFee) / buy.outputAfterFee) * 100;
            if (profitPercent < min_profit_percent) continue;
            opportunities.push({
              buy_on: buy.dex,
              sell_on: sell.dex,
              buy_output: parseFloat(buy.outputAfterFee.toFixed(6)),
              sell_output: parseFloat(sell.outputAfterFee.toFixed(6)),
              net_profit_percent: parseFloat(profitPercent.toFixed(4)),
              combined_fees_percent: parseFloat(((buy.fee + sell.fee) * 100).toFixed(3)),
            });
          }
        }

        opportunities.sort((a, b) => b.net_profit_percent - a.net_profit_percent);

        sdk.storage.set(`arb:${from_asset}:${to_asset}`, { opportunities, ts: Date.now() }, { ttl: 30_000 });

        return {
          success: true,
          data: {
            from_asset,
            to_asset,
            amount,
            opportunities,
            dex_quotes: dexOutputs.map((d) => ({ dex: d.dex, output: d.output })),
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_get_arbitrage_opportunities failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── P0 Tools: Sniper Trading ───────────────────────────────────────────────

  // ── Tool 8: ton_trading_get_token_listings ─────────────────────────────────
  {
    name: "ton_trading_get_token_listings",
    description:
      "Fetch recently listed tokens on TON DEXes (StonFi, DeDust, GasPump). Returns new tokens sorted by listing time, with initial liquidity and volume data. Use for sniper trading strategies.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum number of listings to return (1–50, default 20)",
          minimum: 1,
          maximum: 50,
        },
        min_liquidity_ton: {
          type: "number",
          description: "Minimum pool liquidity in TON to filter out micro-pools (default 100)",
          minimum: 0,
        },
      },
    },
    execute: async (params, _context) => {
      const limit = params.limit ?? 20;
      const minLiquidity = params.min_liquidity_ton ?? 100;
      try {
        const cacheKey = `listings:${limit}:${minLiquidity}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/new_pools?page=1`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          return { success: false, error: `GeckoTerminal API returned ${res.status}` };
        }

        const [json, tonPrice] = await Promise.all([
          res.json(),
          sdk.ton.getPrice(),
        ]);
        const tonPriceUsd = tonPrice?.usd ?? 3;
        const pools = (json?.data ?? [])
          .map((p) => {
            const attr = p.attributes ?? {};
            return {
              pool_address: p.id?.replace("ton_", "") ?? null,
              name: attr.name ?? null,
              dex: attr.dex_id ?? null,
              base_token_address: attr.base_token_price_usd != null
                ? (p.relationships?.base_token?.data?.id?.replace("ton_", "") ?? null)
                : null,
              quote_token_address: p.relationships?.quote_token?.data?.id?.replace("ton_", "") ?? null,
              created_at: attr.pool_created_at ?? null,
              reserve_in_usd: parseFloat(attr.reserve_in_usd ?? 0),
              volume_usd_24h: parseFloat(attr.volume_usd?.h24 ?? 0),
            };
          })
          .filter((p) => {
            const reserveTon = p.reserve_in_usd / tonPriceUsd;
            return reserveTon >= minLiquidity;
          })
          .slice(0, limit);

        const data = { listings: pools, fetched_at: Date.now() };
        sdk.storage.set(cacheKey, data, { ttl: 60_000 });

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_token_listings failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 9: ton_trading_get_token_info ─────────────────────────────────────
  {
    name: "ton_trading_get_token_info",
    description:
      "Get detailed information about a specific token by its jetton master address: price, market cap, holders, 24-h volume, and top pools. Use before deciding to snipe a new token.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        token_address: {
          type: "string",
          description: "Jetton master address of the token (e.g. \"EQCxE6...\")",
        },
      },
      required: ["token_address"],
    },
    execute: async (params, _context) => {
      const { token_address } = params;
      try {
        const cacheKey = `tokeninfo:${token_address}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${encodeURIComponent(token_address)}`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          return { success: false, error: `GeckoTerminal API returned ${res.status}` };
        }

        const json = await res.json();
        const attr = json?.data?.attributes ?? {};

        const data = {
          token_address,
          name: attr.name ?? null,
          symbol: attr.symbol ?? null,
          price_usd: parseFloat(attr.price_usd ?? 0) || null,
          market_cap_usd: parseFloat(attr.market_cap_usd ?? 0) || null,
          fdv_usd: parseFloat(attr.fdv_usd ?? 0) || null,
          volume_usd_24h: parseFloat(attr.volume_usd?.h24 ?? 0) || null,
          price_change_24h_percent: parseFloat(attr.price_change_percentage?.h24 ?? 0) || null,
          total_supply: attr.total_supply ?? null,
          coingecko_coin_id: attr.coingecko_coin_id ?? null,
        };

        sdk.storage.set(cacheKey, data, { ttl: 120_000 });

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_token_info failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 10: ton_trading_validate_token ────────────────────────────────────
  {
    name: "ton_trading_validate_token",
    description:
      "Safety-check a token before sniping: checks liquidity, volume, age, and basic rug-pull signals. Returns a risk score and list of warnings. Always call this before executing a sniper trade.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        token_address: {
          type: "string",
          description: "Jetton master address to validate",
        },
        min_liquidity_ton: {
          type: "number",
          description: "Minimum liquidity in TON to consider safe (default 100)",
          minimum: 0,
        },
        min_volume_usd_24h: {
          type: "number",
          description: "Minimum 24-h volume in USD (default 500)",
          minimum: 0,
        },
      },
      required: ["token_address"],
    },
    execute: async (params, _context) => {
      const { token_address, min_liquidity_ton = 100, min_volume_usd_24h = 500 } = params;
      try {
        // Reuse token info (cached or fresh)
        const infoRes = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${encodeURIComponent(token_address)}`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        const warnings = [];
        let riskScore = 0; // 0 (safe) → 100 (very risky)

        if (!infoRes.ok) {
          warnings.push({ type: "token_not_found", message: "Token not found on GeckoTerminal — treat as very high risk" });
          riskScore = 90;
          return { success: true, data: { token_address, safe: false, risk_score: riskScore, warnings } };
        }

        const json = await infoRes.json();
        const attr = json?.data?.attributes ?? {};

        const priceUsd = parseFloat(attr.price_usd ?? 0);
        const marketCapUsd = parseFloat(attr.market_cap_usd ?? 0);
        const volumeUsd24h = parseFloat(attr.volume_usd?.h24 ?? 0);
        const reserveUsd = parseFloat(attr.reserve_in_usd ?? 0);
        const tonPrice = await sdk.ton.getPrice();
        const reserveTon = reserveUsd / (tonPrice?.usd ?? 3);

        if (reserveTon < min_liquidity_ton) {
          warnings.push({ type: "low_liquidity", message: `Liquidity (~${reserveTon.toFixed(0)} TON) is below minimum (${min_liquidity_ton} TON)` });
          riskScore += 30;
        }

        if (volumeUsd24h < min_volume_usd_24h) {
          warnings.push({ type: "low_volume", message: `24h volume ($${volumeUsd24h.toFixed(0)}) is below minimum ($${min_volume_usd_24h})` });
          riskScore += 20;
        }

        if (priceUsd <= 0) {
          warnings.push({ type: "no_price", message: "Token has no price data — possibly not tradeable" });
          riskScore += 25;
        }

        if (marketCapUsd > 0 && volumeUsd24h > marketCapUsd * 5) {
          warnings.push({ type: "suspicious_volume", message: "Volume is >5× market cap — possible wash trading" });
          riskScore += 25;
        }

        riskScore = Math.min(riskScore, 100);
        const safe = riskScore < 40 && warnings.length === 0;

        return {
          success: true,
          data: {
            token_address,
            name: attr.name ?? null,
            symbol: attr.symbol ?? null,
            safe,
            risk_score: riskScore,
            warnings,
            liquidity_ton: parseFloat(reserveTon.toFixed(2)),
            volume_usd_24h: volumeUsd24h,
            price_usd: priceUsd || null,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_validate_token failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── P0 Tools: Copy Trading ─────────────────────────────────────────────────

  // ── Tool 11: ton_trading_get_top_traders ───────────────────────────────────
  {
    name: "ton_trading_get_top_traders",
    description:
      "Find top-performing trader wallets on TON by analysing on-chain DEX activity. Returns wallets ranked by win rate and profit over the specified period. Use to find wallets worth copying.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Number of top traders to return (1–20, default 10)",
          minimum: 1,
          maximum: 20,
        },
        min_trades: {
          type: "integer",
          description: "Minimum number of trades to qualify (default 10)",
          minimum: 1,
        },
        min_win_rate: {
          type: "number",
          description: "Minimum win rate (0–1, e.g. 0.6 = 60%, default 0.55)",
          minimum: 0,
          maximum: 1,
        },
      },
    },
    execute: async (params, _context) => {
      const limit = params.limit ?? 10;
      const minTrades = params.min_trades ?? 10;
      const minWinRate = params.min_win_rate ?? 0.55;
      try {
        const cacheKey = `toptraders:${limit}:${minTrades}:${minWinRate}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        // Fetch trending pools to find active traders
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/trending_pools?page=1`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          return { success: false, error: `GeckoTerminal API returned ${res.status}` };
        }

        const json = await res.json();
        const pools = (json?.data ?? []).slice(0, 5);

        // For each trending pool, fetch recent trades to identify active wallets
        const walletStats = new Map();

        await Promise.all(
          pools.map(async (pool) => {
            const poolAddress = pool.id?.replace("ton_", "");
            if (!poolAddress) return;

            const tradesRes = await fetch(
              `https://api.geckoterminal.com/api/v2/networks/ton/pools/${encodeURIComponent(poolAddress)}/trades?trade_volume_in_usd_greater_than=10`,
              { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
            ).catch(() => null);

            if (!tradesRes?.ok) return;
            const tradesJson = await tradesRes.json().catch(() => null);
            if (!tradesJson) return;

            for (const trade of (tradesJson?.data ?? [])) {
              const attr = trade.attributes ?? {};
              const wallet = attr.tx_from_address ?? null;
              if (!wallet) continue;

              const priceChange = parseFloat(attr.price_to_in_currency_token ?? 0) -
                parseFloat(attr.price_from_in_currency_token ?? 0);
              const isWin = priceChange > 0;

              if (!walletStats.has(wallet)) {
                walletStats.set(wallet, { wallet, trades: 0, wins: 0, total_volume_usd: 0 });
              }
              const stats = walletStats.get(wallet);
              stats.trades += 1;
              if (isWin) stats.wins += 1;
              stats.total_volume_usd += parseFloat(attr.volume_in_usd ?? 0);
            }
          })
        );

        const traders = Array.from(walletStats.values())
          .filter((w) => w.trades >= minTrades)
          .map((w) => ({
            ...w,
            win_rate: parseFloat((w.wins / w.trades).toFixed(4)),
          }))
          .filter((w) => w.win_rate >= minWinRate)
          .sort((a, b) => b.win_rate - a.win_rate)
          .slice(0, limit);

        const data = { traders, fetched_at: Date.now() };
        sdk.storage.set(cacheKey, data, { ttl: 300_000 });

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_top_traders failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 12: ton_trading_get_trader_performance ────────────────────────────
  {
    name: "ton_trading_get_trader_performance",
    description:
      "Analyse the recent on-chain trading performance of a specific wallet: win rate, total PnL estimate, most-traded tokens, and active pools. Use before deciding to copy a trader.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        wallet_address: {
          type: "string",
          description: "TON wallet address to analyse",
        },
        limit: {
          type: "integer",
          description: "Number of recent transactions to analyse (1–50, default 20)",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["wallet_address"],
    },
    execute: async (params, _context) => {
      const { wallet_address, limit = 20 } = params;
      try {
        const cacheKey = `traderperf:${wallet_address}:${limit}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        const res = await fetch(
          `https://tonapi.io/v2/accounts/${encodeURIComponent(wallet_address)}/events?limit=${limit}&subject_only=true`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          return { success: false, error: `TON API returned ${res.status}` };
        }

        const json = await res.json();
        const events = json?.events ?? [];

        let swaps = 0;
        let wins = 0;
        const tokenFrequency = new Map();

        for (const event of events) {
          for (const action of (event.actions ?? [])) {
            if (action.type !== "JettonSwap") continue;
            swaps += 1;
            const jetton = action.JettonSwap?.jetton_master_in?.address ?? null;
            if (jetton) tokenFrequency.set(jetton, (tokenFrequency.get(jetton) ?? 0) + 1);
            // Heuristic win: received more value out than paid in (by token amounts)
            const amtIn = parseFloat(action.JettonSwap?.amount_in ?? 0);
            const amtOut = parseFloat(action.JettonSwap?.amount_out ?? 0);
            if (amtOut > amtIn) wins += 1;
          }
        }

        const winRate = swaps > 0 ? parseFloat((wins / swaps).toFixed(4)) : null;
        const topTokens = Array.from(tokenFrequency.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([address, count]) => ({ address, swap_count: count }));

        const data = {
          wallet_address,
          analysed_events: events.length,
          total_swaps: swaps,
          wins,
          win_rate: winRate,
          top_tokens: topTokens,
          fetched_at: Date.now(),
        };

        sdk.storage.set(cacheKey, data, { ttl: 180_000 });

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_trader_performance failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── P1 Tools: Liquidity & Farming ─────────────────────────────────────────

  // ── Tool 13: ton_trading_get_active_pools ──────────────────────────────────
  {
    name: "ton_trading_get_active_pools",
    description:
      "List active liquidity pools on TON DEXes (StonFi, DeDust, TONCO) sorted by 24-h volume. Returns pool address, token pair, liquidity, and volume. Use to find pools for LP or farming strategies.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Number of pools to return (1–50, default 20)",
          minimum: 1,
          maximum: 50,
        },
        dex: {
          type: "string",
          description: 'Filter by DEX: "stonfi", "dedust", "tonco", or omit for all',
          enum: ["stonfi", "dedust", "tonco"],
        },
        min_volume_usd_24h: {
          type: "number",
          description: "Minimum 24-h volume in USD (default 1000)",
          minimum: 0,
        },
      },
    },
    execute: async (params, _context) => {
      const limit = params.limit ?? 20;
      const dexFilter = params.dex ?? null;
      const minVolume = params.min_volume_usd_24h ?? 1000;
      try {
        const cacheKey = `pools:${dexFilter ?? "all"}:${minVolume}:${limit}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/pools?page=1&sort=h24_volume_usd_liquidity_desc`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          return { success: false, error: `GeckoTerminal API returned ${res.status}` };
        }

        const json = await res.json();
        let pools = (json?.data ?? []).map((p) => {
          const attr = p.attributes ?? {};
          return {
            pool_address: p.id?.replace("ton_", "") ?? null,
            name: attr.name ?? null,
            dex: attr.dex_id ?? null,
            volume_usd_24h: parseFloat(attr.volume_usd?.h24 ?? 0),
            reserve_in_usd: parseFloat(attr.reserve_in_usd ?? 0),
            fee_tier: attr.pool_fee ?? null,
            created_at: attr.pool_created_at ?? null,
          };
        });

        if (dexFilter) {
          pools = pools.filter((p) => p.dex?.toLowerCase().includes(dexFilter));
        }

        pools = pools
          .filter((p) => p.volume_usd_24h >= minVolume)
          .slice(0, limit);

        const data = { pools, fetched_at: Date.now() };
        sdk.storage.set(cacheKey, data, { ttl: 120_000 });

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_active_pools failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 14: ton_trading_get_farms_with_apy ────────────────────────────────
  {
    name: "ton_trading_get_farms_with_apy",
    description:
      "List yield farming opportunities on TON DEXes with estimated APY. Returns farms sorted by APY descending. Use to find the best farming strategies.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Number of farms to return (1–50, default 20)",
          minimum: 1,
          maximum: 50,
        },
        min_apy: {
          type: "number",
          description: "Minimum APY percentage to include (default 5)",
          minimum: 0,
        },
        min_tvl_usd: {
          type: "number",
          description: "Minimum total value locked in USD (default 10000)",
          minimum: 0,
        },
      },
    },
    execute: async (params, _context) => {
      const limit = params.limit ?? 20;
      const minApy = params.min_apy ?? 5;
      const minTvl = params.min_tvl_usd ?? 10_000;
      try {
        const cacheKey = `farms:${minApy}:${minTvl}:${limit}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        // Use GeckoTerminal pools as a proxy — estimate APY from fee yield
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/pools?page=1&sort=h24_volume_usd_liquidity_desc`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          return { success: false, error: `GeckoTerminal API returned ${res.status}` };
        }

        const json = await res.json();
        const farms = (json?.data ?? [])
          .map((p) => {
            const attr = p.attributes ?? {};
            const volume24h = parseFloat(attr.volume_usd?.h24 ?? 0);
            const reserve = parseFloat(attr.reserve_in_usd ?? 0);
            const feeTier = parseFloat(attr.pool_fee ?? 0.003);
            // Estimated APY: daily fee yield × 365
            const dailyFeeYield = reserve > 0 ? (volume24h * feeTier) / reserve : 0;
            const estimatedApy = dailyFeeYield * 365 * 100;
            return {
              pool_address: p.id?.replace("ton_", "") ?? null,
              name: attr.name ?? null,
              dex: attr.dex_id ?? null,
              tvl_usd: reserve,
              volume_usd_24h: volume24h,
              fee_tier: feeTier,
              estimated_apy_percent: parseFloat(estimatedApy.toFixed(2)),
            };
          })
          .filter((f) => f.tvl_usd >= minTvl && f.estimated_apy_percent >= minApy)
          .sort((a, b) => b.estimated_apy_percent - a.estimated_apy_percent)
          .slice(0, limit);

        const data = { farms, fetched_at: Date.now(), note: "APY is estimated from 24h fee yield × 365 — actual rewards may differ" };
        sdk.storage.set(cacheKey, data, { ttl: 300_000 });

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_farms_with_apy failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 15: ton_trading_get_pool_volume ───────────────────────────────────
  {
    name: "ton_trading_get_pool_volume",
    description:
      "Get detailed volume statistics for a specific liquidity pool: 1h, 6h, 24h volumes and price change percentages. Use to monitor pool activity before adding liquidity.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        pool_address: {
          type: "string",
          description: "Pool contract address on TON",
        },
      },
      required: ["pool_address"],
    },
    execute: async (params, _context) => {
      const { pool_address } = params;
      try {
        const cacheKey = `poolvol:${pool_address}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/pools/${encodeURIComponent(pool_address)}`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          return { success: false, error: `GeckoTerminal API returned ${res.status}` };
        }

        const json = await res.json();
        const attr = json?.data?.attributes ?? {};

        const data = {
          pool_address,
          name: attr.name ?? null,
          dex: attr.dex_id ?? null,
          reserve_in_usd: parseFloat(attr.reserve_in_usd ?? 0),
          volume_usd: {
            h1: parseFloat(attr.volume_usd?.h1 ?? 0),
            h6: parseFloat(attr.volume_usd?.h6 ?? 0),
            h24: parseFloat(attr.volume_usd?.h24 ?? 0),
          },
          price_change_percent: {
            h1: parseFloat(attr.price_change_percentage?.h1 ?? 0),
            h6: parseFloat(attr.price_change_percentage?.h6 ?? 0),
            h24: parseFloat(attr.price_change_percentage?.h24 ?? 0),
          },
          transactions_24h: {
            buys: attr.transactions?.h24?.buys ?? null,
            sells: attr.transactions?.h24?.sells ?? null,
          },
          fetched_at: Date.now(),
        };

        sdk.storage.set(cacheKey, data, { ttl: 60_000 });

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_pool_volume failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── P1 Tools: Backtesting ──────────────────────────────────────────────────

  // ── Tool 16: ton_trading_backtest ──────────────────────────────────────────
  {
    name: "ton_trading_backtest",
    description:
      "Replay a simple threshold-based strategy against historical trades in the journal. Returns win rate, total PnL, max drawdown, and Sharpe ratio. Use to evaluate a strategy before running it live.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          description: 'Strategy type: "buy_and_hold", "mean_reversion", or "momentum"',
          enum: ["buy_and_hold", "mean_reversion", "momentum"],
        },
        from_asset: {
          type: "string",
          description: 'Asset pair — from asset (e.g. "TON")',
        },
        to_asset: {
          type: "string",
          description: "Asset pair — to asset (jetton address)",
        },
        entry_threshold_percent: {
          type: "number",
          description: "For mean_reversion/momentum: price change % that triggers a buy (default 2)",
          minimum: 0,
        },
        exit_threshold_percent: {
          type: "number",
          description: "Profit % at which the strategy exits (default 5)",
          minimum: 0,
        },
        stop_loss_percent: {
          type: "number",
          description: "Loss % that triggers a stop-loss exit (default 5)",
          minimum: 0,
        },
        lookback_days: {
          type: "integer",
          description: "Number of days of journal history to use (default 30, max 365)",
          minimum: 1,
          maximum: 365,
        },
      },
      required: ["strategy", "from_asset", "to_asset"],
    },
    execute: async (params, _context) => {
      const {
        strategy,
        from_asset,
        to_asset,
        entry_threshold_percent = 2,
        exit_threshold_percent = 5,
        stop_loss_percent = 5,
        lookback_days = 30,
      } = params;
      try {
        const since = Date.now() - lookback_days * 24 * 60 * 60 * 1000;

        const trades = sdk.db
          .prepare(
            `SELECT * FROM trade_journal
             WHERE from_asset = ? AND to_asset = ? AND timestamp >= ? AND status = 'closed'
             ORDER BY timestamp ASC`
          )
          .all(from_asset, to_asset, since);

        if (trades.length < 2) {
          return {
            success: true,
            data: {
              strategy,
              from_asset,
              to_asset,
              note: `Not enough closed trades (${trades.length}) to backtest. Need at least 2.`,
              simulated_trades: 0,
            },
          };
        }

        let capital = 1000; // virtual starting capital
        const initialCapital = capital;
        let wins = 0;
        let losses = 0;
        let maxCapital = capital;
        let minCapital = capital;
        const returns = [];

        for (let i = 1; i < trades.length; i++) {
          const prev = trades[i - 1];
          const curr = trades[i];

          const prevPnlPct = prev.pnl_percent ?? 0;
          let shouldBuy = false;

          if (strategy === "buy_and_hold") {
            shouldBuy = true;
          } else if (strategy === "mean_reversion") {
            shouldBuy = prevPnlPct <= -entry_threshold_percent;
          } else if (strategy === "momentum") {
            shouldBuy = prevPnlPct >= entry_threshold_percent;
          }

          if (!shouldBuy) continue;

          const tradeReturn = curr.pnl_percent ?? 0;
          const exitedAtProfit = tradeReturn >= exit_threshold_percent;
          const exitedAtStop = tradeReturn <= -stop_loss_percent;
          const effectiveReturn = exitedAtStop ? -stop_loss_percent : (exitedAtProfit ? exit_threshold_percent : tradeReturn);

          const prevCapital = capital;
          capital = capital * (1 + effectiveReturn / 100);
          const ret = (capital - prevCapital) / prevCapital;
          returns.push(ret);

          if (capital > maxCapital) maxCapital = capital;
          if (capital < minCapital) minCapital = capital;

          if (effectiveReturn > 0) wins += 1;
          else losses += 1;
        }

        const totalTrades = wins + losses;
        const totalPnl = capital - initialCapital;
        const totalPnlPercent = (totalPnl / initialCapital) * 100;
        const winRate = totalTrades > 0 ? wins / totalTrades : 0;
        const maxDrawdown = maxCapital > 0 ? ((maxCapital - minCapital) / maxCapital) * 100 : 0;

        // Sharpe ratio (simplified, assuming risk-free rate = 0)
        let sharpe = null;
        if (returns.length > 1) {
          const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
          const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
          const stddev = Math.sqrt(variance);
          sharpe = stddev > 0 ? parseFloat((mean / stddev).toFixed(4)) : null;
        }

        return {
          success: true,
          data: {
            strategy,
            from_asset,
            to_asset,
            lookback_days,
            journal_trades_analysed: trades.length,
            simulated_trades: totalTrades,
            wins,
            losses,
            win_rate: parseFloat(winRate.toFixed(4)),
            total_pnl: parseFloat(totalPnl.toFixed(4)),
            total_pnl_percent: parseFloat(totalPnlPercent.toFixed(2)),
            max_drawdown_percent: parseFloat(maxDrawdown.toFixed(2)),
            sharpe_ratio: sharpe,
            final_capital: parseFloat(capital.toFixed(4)),
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_backtest failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── P2 Tools: Risk Management ──────────────────────────────────────────────

  // ── Tool 17: ton_trading_calculate_risk_metrics ────────────────────────────
  {
    name: "ton_trading_calculate_risk_metrics",
    description:
      "Calculate risk metrics from the trade journal: Value at Risk (VaR), maximum drawdown, Sharpe ratio, and win/loss statistics. Returns a risk summary to guide position sizing.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Analyse "real" trades, "simulation" trades, or "all" (default "all")',
          enum: ["real", "simulation", "all"],
        },
        lookback_days: {
          type: "integer",
          description: "Number of days of history to include (default 30)",
          minimum: 1,
          maximum: 365,
        },
        confidence_level: {
          type: "number",
          description: "VaR confidence level (0.9–0.99, default 0.95)",
          minimum: 0.9,
          maximum: 0.99,
        },
      },
    },
    execute: async (params, _context) => {
      const { mode = "all", lookback_days = 30, confidence_level = 0.95 } = params;
      try {
        const since = Date.now() - lookback_days * 24 * 60 * 60 * 1000;

        const [modeClause, modeParams] = mode === "all"
          ? ["", []]
          : ["AND mode = ?", [mode]];
        const trades = sdk.db
          .prepare(
            `SELECT pnl_percent FROM trade_journal
             WHERE status = 'closed' AND timestamp >= ? ${modeClause}
             ORDER BY timestamp ASC`
          )
          .all(since, ...modeParams);

        if (trades.length === 0) {
          return {
            success: true,
            data: { mode, lookback_days, note: "No closed trades found in this period", trades_analysed: 0 },
          };
        }

        const returns = trades.map((t) => (t.pnl_percent ?? 0) / 100);

        const sorted = [...returns].sort((a, b) => a - b);
        const varIndex = Math.floor((1 - confidence_level) * sorted.length);
        const var95 = sorted[varIndex] ?? sorted[0];

        const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
        const stddev = Math.sqrt(variance);
        const sharpe = stddev > 0 ? parseFloat((mean / stddev).toFixed(4)) : null;

        // Max drawdown
        let peak = 1;
        let trough = 1;
        let capital = 1;
        let maxDrawdown = 0;
        for (const r of returns) {
          capital *= 1 + r;
          if (capital > peak) { peak = capital; trough = capital; }
          if (capital < trough) {
            trough = capital;
            const dd = (peak - trough) / peak;
            if (dd > maxDrawdown) maxDrawdown = dd;
          }
        }

        const wins = returns.filter((r) => r > 0).length;
        const losses = returns.filter((r) => r < 0).length;
        const avgWin = wins > 0 ? returns.filter((r) => r > 0).reduce((s, r) => s + r, 0) / wins : 0;
        const avgLoss = losses > 0 ? Math.abs(returns.filter((r) => r < 0).reduce((s, r) => s + r, 0) / losses) : 0;
        const profitFactor = avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(4)) : null;

        return {
          success: true,
          data: {
            mode,
            lookback_days,
            trades_analysed: trades.length,
            win_rate: parseFloat((wins / trades.length).toFixed(4)),
            avg_win_percent: parseFloat((avgWin * 100).toFixed(2)),
            avg_loss_percent: parseFloat((avgLoss * 100).toFixed(2)),
            profit_factor: profitFactor,
            sharpe_ratio: sharpe,
            max_drawdown_percent: parseFloat((maxDrawdown * 100).toFixed(2)),
            value_at_risk_percent: parseFloat((Math.abs(var95) * 100).toFixed(2)),
            confidence_level,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_calculate_risk_metrics failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 18: ton_trading_set_stop_loss ─────────────────────────────────────
  {
    name: "ton_trading_set_stop_loss",
    description:
      "Register a stop-loss (and optional take-profit) rule for an open trade in the journal. The LLM should check this rule on each market data update and close the trade if triggered.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        trade_id: {
          type: "integer",
          description: "Journal trade ID to protect",
        },
        entry_price: {
          type: "number",
          description: "Price at which the position was opened (in quote asset units)",
        },
        stop_loss_percent: {
          type: "number",
          description: "Percentage loss that triggers the stop-loss (e.g. 5 = close at -5%)",
          minimum: 0.1,
          maximum: 99,
        },
        take_profit_percent: {
          type: "number",
          description: "Optional profit percentage that triggers the take-profit exit",
          minimum: 0.1,
        },
      },
      required: ["trade_id", "entry_price", "stop_loss_percent"],
    },
    execute: async (params, _context) => {
      const { trade_id, entry_price, stop_loss_percent, take_profit_percent } = params;
      try {
        const entry = sdk.db
          .prepare("SELECT id, status FROM trade_journal WHERE id = ?")
          .get(trade_id);

        if (!entry) {
          return { success: false, error: `Trade ${trade_id} not found` };
        }
        if (entry.status === "closed") {
          return { success: false, error: `Trade ${trade_id} is already closed` };
        }

        const ruleId = sdk.db
          .prepare(
            `INSERT INTO stop_loss_rules (trade_id, stop_loss_percent, take_profit_percent, entry_price, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(trade_id, stop_loss_percent, take_profit_percent ?? null, entry_price, Date.now())
          .lastInsertRowid;

        const stopLossPrice = entry_price * (1 - stop_loss_percent / 100);
        const takeProfitPrice = take_profit_percent != null
          ? entry_price * (1 + take_profit_percent / 100)
          : null;

        sdk.log.info(`Stop-loss rule #${ruleId} set for trade #${trade_id}: SL=${stopLossPrice.toFixed(4)}`);

        return {
          success: true,
          data: {
            rule_id: ruleId,
            trade_id,
            entry_price,
            stop_loss_price: parseFloat(stopLossPrice.toFixed(6)),
            take_profit_price: takeProfitPrice != null ? parseFloat(takeProfitPrice.toFixed(6)) : null,
            stop_loss_percent,
            take_profit_percent: take_profit_percent ?? null,
            status: "active",
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_set_stop_loss failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 19: ton_trading_check_stop_loss ───────────────────────────────────
  {
    name: "ton_trading_check_stop_loss",
    description:
      "Query active stop-loss and take-profit rules for open trades and check whether the current market price has triggered any of them. Returns triggered rules with a recommended action. Call this after every ton_trading_get_market_data to enforce risk limits.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        current_price: {
          type: "number",
          description: "Current market price of the asset (in quote asset units)",
        },
        trade_id: {
          type: "integer",
          description: "Optional: check rules only for this specific trade ID. If omitted, all active rules are checked.",
        },
      },
      required: ["current_price"],
    },
    execute: async (params, _context) => {
      const { current_price, trade_id } = params;
      try {
        const query = trade_id != null
          ? "SELECT * FROM stop_loss_rules WHERE status = 'active' AND trade_id = ?"
          : "SELECT * FROM stop_loss_rules WHERE status = 'active'";
        const args = trade_id != null ? [trade_id] : [];

        const activeRules = sdk.db.prepare(query).all(...args);

        const triggered = [];
        const safe = [];

        for (const rule of activeRules) {
          const stopLossPrice = rule.entry_price * (1 - rule.stop_loss_percent / 100);
          const takeProfitPrice = rule.take_profit_percent != null
            ? rule.entry_price * (1 + rule.take_profit_percent / 100)
            : null;

          const stopLossHit = current_price <= stopLossPrice;
          const takeProfitHit = takeProfitPrice != null && current_price >= takeProfitPrice;

          const annotated = {
            rule_id: rule.id,
            trade_id: rule.trade_id,
            entry_price: rule.entry_price,
            current_price,
            stop_loss_price: parseFloat(stopLossPrice.toFixed(6)),
            take_profit_price: takeProfitPrice != null ? parseFloat(takeProfitPrice.toFixed(6)) : null,
            stop_loss_percent: rule.stop_loss_percent,
            take_profit_percent: rule.take_profit_percent ?? null,
            stop_loss_hit: stopLossHit,
            take_profit_hit: takeProfitHit,
          };

          if (stopLossHit || takeProfitHit) {
            annotated.action = stopLossHit ? "stop_loss" : "take_profit";
            triggered.push(annotated);
          } else {
            safe.push(annotated);
          }
        }

        if (triggered.length > 0) {
          sdk.log.info(`ton_trading_check_stop_loss: ${triggered.length} rule(s) triggered at price ${current_price}`);
        }

        return {
          success: true,
          data: {
            current_price,
            active_rules: activeRules.length,
            triggered_rules: triggered,
            safe_rules: safe,
            note: triggered.length > 0
              ? `${triggered.length} rule(s) triggered — close affected trades using ton_trading_record_trade, then update rule status to 'triggered'`
              : "No rules triggered — all positions within limits",
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_check_stop_loss failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 21: ton_trading_get_optimal_position_size ─────────────────────────
  {
    name: "ton_trading_get_optimal_position_size",
    description:
      "Calculate the optimal position size for a trade using the Kelly Criterion and fixed-fraction methods, based on historical win rate and risk/reward ratio from the trade journal.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Use "real" or "simulation" trade history (default "simulation")',
          enum: ["real", "simulation"],
        },
        risk_percent: {
          type: "number",
          description: "Maximum percentage of balance to risk per trade for fixed-fraction method (default 2)",
          minimum: 0.1,
          maximum: 50,
        },
        stop_loss_percent: {
          type: "number",
          description: "Stop-loss percentage for this trade (used for fixed-fraction sizing)",
          minimum: 0.1,
          maximum: 99,
        },
        lookback_days: {
          type: "integer",
          description: "Days of history to use for win rate calculation (default 30)",
          minimum: 1,
          maximum: 365,
        },
      },
      required: ["stop_loss_percent"],
    },
    execute: async (params, _context) => {
      const { mode = "simulation", risk_percent = 2, stop_loss_percent, lookback_days = 30 } = params;
      try {
        const since = Date.now() - lookback_days * 24 * 60 * 60 * 1000;
        const trades = sdk.db
          .prepare(
            `SELECT pnl_percent FROM trade_journal
             WHERE status = 'closed' AND mode = ? AND timestamp >= ?`
          )
          .all(mode, since);

        const balance =
          mode === "simulation"
            ? getSimBalance(sdk)
            : parseFloat((await sdk.ton.getBalance())?.balance ?? "0");

        let winRate = 0.5; // default if no history
        let avgWinPct = 5;
        let avgLossPct = 5;

        if (trades.length >= 5) {
          const wins = trades.filter((t) => (t.pnl_percent ?? 0) > 0);
          const lossesArr = trades.filter((t) => (t.pnl_percent ?? 0) < 0);
          winRate = wins.length / trades.length;
          avgWinPct = wins.length > 0
            ? wins.reduce((s, t) => s + (t.pnl_percent ?? 0), 0) / wins.length
            : 5;
          avgLossPct = lossesArr.length > 0
            ? Math.abs(lossesArr.reduce((s, t) => s + (t.pnl_percent ?? 0), 0) / lossesArr.length)
            : 5;
        }

        // Kelly Criterion: f* = W/L - (1-W)/W  where W=win_rate, L=loss_rate, b=avg_win/avg_loss
        const b = avgLossPct > 0 ? avgWinPct / avgLossPct : 1;
        const kellyFraction = winRate - (1 - winRate) / b;
        const halfKellyFraction = Math.max(0, kellyFraction / 2); // half-Kelly for safety

        // Fixed-fraction: risk a fixed % of capital, sized so stop-loss = that % of capital
        const fixedFractionSize = balance * (risk_percent / 100) / (stop_loss_percent / 100);

        return {
          success: true,
          data: {
            mode,
            balance,
            trades_analysed: trades.length,
            win_rate: parseFloat(winRate.toFixed(4)),
            avg_win_percent: parseFloat(avgWinPct.toFixed(2)),
            avg_loss_percent: parseFloat(avgLossPct.toFixed(2)),
            kelly_fraction: parseFloat(kellyFraction.toFixed(4)),
            half_kelly_fraction: parseFloat(halfKellyFraction.toFixed(4)),
            kelly_position_size: parseFloat((balance * halfKellyFraction).toFixed(4)),
            fixed_fraction_position_size: parseFloat(fixedFractionSize.toFixed(4)),
            risk_percent,
            stop_loss_percent,
            recommendation: kellyFraction <= 0
              ? "Kelly suggests no position — unfavorable win/loss ratio based on history"
              : `Suggested position: ${Math.min(balance * halfKellyFraction, fixedFractionSize).toFixed(2)} TON (lower of Kelly and fixed-fraction)`,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_get_optimal_position_size failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── P2 Tools: Automation ───────────────────────────────────────────────────

  // ── Tool 22: ton_trading_schedule_trade ────────────────────────────────────
  {
    name: "ton_trading_schedule_trade",
    description:
      "Store a pending trade to be executed at a future time. The LLM should check scheduled trades on each run and execute any that are due. Returns the scheduled trade ID.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Trading mode: "real" or "simulation"',
          enum: ["real", "simulation"],
        },
        from_asset: {
          type: "string",
          description: 'Asset to sell — "TON" or a jetton master address',
        },
        to_asset: {
          type: "string",
          description: 'Asset to buy — "TON" or a jetton master address',
        },
        amount: {
          type: "number",
          description: "Amount of from_asset to trade",
        },
        execute_at_iso: {
          type: "string",
          description: 'ISO 8601 datetime when to execute the trade (e.g. "2025-01-01T12:00:00Z")',
        },
        note: {
          type: "string",
          description: "Optional note describing the reason for scheduling",
        },
      },
      required: ["mode", "from_asset", "to_asset", "amount", "execute_at_iso"],
    },
    execute: async (params, _context) => {
      const { mode, from_asset, to_asset, amount, execute_at_iso, note } = params;
      try {
        const executeAt = new Date(execute_at_iso).getTime();
        if (isNaN(executeAt)) {
          return { success: false, error: `Invalid execute_at_iso: "${execute_at_iso}"` };
        }
        if (executeAt <= Date.now()) {
          return { success: false, error: "execute_at_iso must be in the future" };
        }

        const schedId = sdk.db
          .prepare(
            `INSERT INTO scheduled_trades (created_at, execute_at, mode, from_asset, to_asset, amount, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(Date.now(), executeAt, mode, from_asset, to_asset, amount, note ?? null)
          .lastInsertRowid;

        sdk.log.info(`Scheduled trade #${schedId}: ${amount} ${from_asset} → ${to_asset} at ${execute_at_iso}`);

        return {
          success: true,
          data: {
            scheduled_id: schedId,
            mode,
            from_asset,
            to_asset,
            amount,
            execute_at: execute_at_iso,
            status: "pending",
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_schedule_trade failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 23: ton_trading_get_scheduled_trades ──────────────────────────────
  {
    name: "ton_trading_get_scheduled_trades",
    description:
      "List pending scheduled trades. Returns all pending trades, highlighting those that are due now (execute_at <= current time). The LLM should execute due trades using ton_trading_execute_swap or ton_trading_simulate_trade.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: 'Filter by status: "pending", "executed", "cancelled", or "all" (default "pending")',
          enum: ["pending", "executed", "cancelled", "all"],
        },
        limit: {
          type: "integer",
          description: "Maximum number of records to return (1–50, default 20)",
          minimum: 1,
          maximum: 50,
        },
      },
    },
    execute: async (params, _context) => {
      const status = params.status ?? "pending";
      const limit = params.limit ?? 20;
      try {
        const [statusClause, statusParams] = status === "all"
          ? ["", []]
          : ["WHERE status = ?", [status]];

        const scheduled = sdk.db
          .prepare(`SELECT * FROM scheduled_trades ${statusClause} ORDER BY execute_at ASC LIMIT ?`)
          .all(...statusParams, limit);

        const now = Date.now();
        const annotated = scheduled.map((s) => ({
          ...s,
          is_due: s.execute_at <= now,
          due_in_ms: Math.max(0, s.execute_at - now),
        }));

        const dueTrades = annotated.filter((s) => s.is_due && s.status === "pending");

        return {
          success: true,
          data: {
            scheduled_trades: annotated,
            due_now: dueTrades.length,
            note: dueTrades.length > 0
              ? `${dueTrades.length} trade(s) are due — execute them using ton_trading_execute_swap or ton_trading_simulate_trade`
              : null,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_get_scheduled_trades failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },
];
