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
 *   - ton_trading_get_open_positions       — list open real or simulation positions
 *   - ton_trading_close_position           — close one open position by trade ID
 *   - ton_trading_close_all_positions      — close all open positions for a mode
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
 * Simulation management tools:
 *   - ton_trading_reset_simulation_balance    — reset virtual balance to starting amount
 *   - ton_trading_set_simulation_balance      — manually set the virtual balance
 *
 * Take-profit automation (issue #135):
 *   - ton_trading_set_take_profit             — register standalone take-profit with optional trailing stop
 *   - ton_trading_auto_execute                — conditionally execute trades when price triggers are met
 *
 * Portfolio-level management (issue #135):
 *   - ton_trading_get_portfolio_summary       — comprehensive portfolio overview with unrealized P&L
 *   - ton_trading_rebalance_portfolio         — calculate rebalancing trades for target allocations
 *
 * Advanced market data (issue #135):
 *   - ton_trading_get_technical_indicators    — RSI, MACD, Bollinger Bands for TON/jettons
 *   - ton_trading_get_order_book_depth        — liquidity analysis and price impact assessment
 *
 * Scheduled trading features (issue #135):
 *   - ton_trading_create_schedule             — create recurring DCA or grid trading schedules
 *   - ton_trading_cancel_schedule             — cancel pending scheduled trades
 *
 * Performance analytics (issue #135):
 *   - ton_trading_get_performance_dashboard   — real-time P&L, win rate, trade breakdown
 *   - ton_trading_export_trades               — export trade history for external analysis
 *
 * Risk management enhancement (issue #135):
 *   - ton_trading_dynamic_stop_loss           — volatility-adjusted stop-loss using ATR
 *   - ton_trading_position_sizing             — optimal position size based on volatility and conviction
 *
 * Multi-DEX coordination (issue #135):
 *   - ton_trading_cross_dex_routing           — optimal split routing across multiple DEXes
 *   - ton_trading_get_best_price              — compare prices across STON.fi, DeDust, TONCO
 *
 * Pattern B (SDK) — uses sdk.ton, sdk.ton.dex, sdk.db, sdk.storage, sdk.log
 *
 * Architecture: each tool is atomic. The LLM composes them into a strategy.
 * No internal signal generation, no embedded strategy loops.
 */

export const manifest = {
  name: "ton-trading-bot",
  version: "2.2.0",
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
      status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'triggered' | 'cancelled'
      trailing_stop INTEGER NOT NULL DEFAULT 0,        -- 1 if trailing stop is active
      trailing_stop_percent REAL,                      -- trailing offset below peak price
      peak_price REAL                                  -- highest price seen (for trailing stop)
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
    "ALTER TABLE stop_loss_rules ADD COLUMN trailing_stop INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE stop_loss_rules ADD COLUMN trailing_stop_percent REAL",
    "ALTER TABLE stop_loss_rules ADD COLUMN peak_price REAL",
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

function toFiniteNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function getDexOutput(result, preferredDex) {
  if (!result || typeof result !== "object") return null;

  const direct = toFiniteNumber(
    result.expectedOutput ??
    result.output ??
    result.amountOut ??
    result.amount_out ??
    result.receivedAmount ??
    result.received_amount
  );
  if (direct != null) return direct;

  const candidates = [];
  if (preferredDex && result[preferredDex]) candidates.push(result[preferredDex]);
  if (typeof result.recommended === "string" && result[result.recommended]) {
    candidates.push(result[result.recommended]);
  } else if (result.recommended && typeof result.recommended === "object") {
    candidates.push(result.recommended);
  }
  candidates.push(result.stonfi, result.dedust, result.tonco, result.swapcoffee);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const output = toFiniteNumber(
      candidate.expectedOutput ??
      candidate.output ??
      candidate.amountOut ??
      candidate.amount_out ??
      candidate.receivedAmount ??
      candidate.received_amount ??
      candidate.price
    );
    if (output != null) return output;
  }

  return null;
}

function getDexName(result, preferredDex) {
  if (result?.dex) return result.dex;
  if (preferredDex) return preferredDex;
  if (typeof result?.recommended === "string") return result.recommended;
  return "auto";
}

function formatOpenPosition(trade) {
  return {
    trade_id: trade.id,
    mode: trade.mode,
    from_asset: trade.from_asset,
    to_asset: trade.to_asset,
    amount_in: trade.amount_in,
    expected_amount_out: trade.amount_out ?? null,
    entry_price_usd: trade.entry_price_usd ?? null,
    opened_at: trade.timestamp,
    note: trade.note ?? null,
  };
}

async function inferExitPriceUsd(sdk, fromAsset, explicitExitPriceUsd) {
  const explicit = toFiniteNumber(explicitExitPriceUsd);
  if (explicit != null) return explicit;

  if (fromAsset !== "TON") return null;
  const tonPrice = await sdk.ton.getPrice().catch(() => null);
  return toFiniteNumber(tonPrice?.usd);
}

function closeTradeJournalEntry(sdk, entry, amountOut, exitPriceUsd, note) {
  const amountIn = toFiniteNumber(entry.amount_in) ?? 0;
  const amountOutNumber = toFiniteNumber(amountOut);
  const entryPriceUsd = toFiniteNumber(entry.entry_price_usd);
  const exitPrice = toFiniteNumber(exitPriceUsd);

  if (amountOutNumber == null) {
    return { success: false, error: "Closing amount_out is required to record P&L" };
  }

  const usdIn = entryPriceUsd != null ? amountIn * entryPriceUsd : amountIn;
  const usdOut = exitPrice != null ? amountIn * exitPrice : amountOutNumber;

  const pnl = usdOut - usdIn;
  const pnlPercent = usdIn > 0 ? (pnl / usdIn) * 100 : 0;

  sdk.db
    .prepare(
      `UPDATE trade_journal
       SET amount_out = ?, exit_price_usd = ?, pnl = ?, pnl_percent = ?, status = 'closed', note = COALESCE(?, note)
       WHERE id = ?`
    )
    .run(amountOutNumber, exitPrice ?? null, pnl, pnlPercent, note ?? null, entry.id);

  if (entry.mode === "simulation" && entry.from_asset === "TON") {
    const simBalance = getSimBalance(sdk);
    const exitTonPriceUsd = exitPrice ?? entryPriceUsd ?? null;
    const creditTon =
      exitTonPriceUsd != null
        ? amountIn + pnl / exitTonPriceUsd
        : amountOutNumber;
    setSimBalance(sdk, simBalance + creditTon);
  }

  try {
    sdk.db
      .prepare("UPDATE stop_loss_rules SET status = 'cancelled' WHERE trade_id = ? AND status = 'active'")
      .run(entry.id);
  } catch {
    // Older or minimal test databases may not include stop-loss rules.
  }

  return {
    success: true,
    data: {
      trade_id: entry.id,
      amount_in: amountIn,
      amount_out: amountOutNumber,
      pnl: parseFloat(pnl.toFixed(6)),
      pnl_percent: parseFloat(pnlPercent.toFixed(2)),
      profit_or_loss: pnl >= 0 ? "profit" : "loss",
      mode: entry.mode,
      status: "closed",
    },
  };
}

async function closeOpenPosition(sdk, entry, params, context) {
  const { slippage = sdk.pluginConfig.defaultSlippage ?? 0.05, dex, note } = params;
  const closeAmount = toFiniteNumber(params.amount ?? entry.amount_out);

  if (entry.status === "closed") {
    return { success: false, error: `Trade ${entry.id} is already closed` };
  }

  if (closeAmount == null || closeAmount <= 0) {
    return {
      success: false,
      error: `Trade ${entry.id} has no recorded output amount to close; provide amount explicitly`,
    };
  }

  const closeSwapParams = {
    fromAsset: entry.to_asset,
    toAsset: entry.from_asset,
    amount: closeAmount,
    ...(slippage != null ? { slippage } : {}),
    ...(dex ? { dex } : {}),
  };
  const shouldUseExitPrice = params.exit_price_usd != null || entry.entry_price_usd != null;
  const exitPriceUsd = shouldUseExitPrice
    ? await inferExitPriceUsd(sdk, entry.from_asset, params.exit_price_usd)
    : null;

  let closeAmountOut = null;
  let closeDex = dex ?? null;
  let minOutput = null;

  if (entry.mode === "simulation") {
    if (entry.to_asset === entry.from_asset) {
      closeAmountOut = closeAmount;
      closeDex = "none";
    } else {
      const quote = await sdk.ton.dex.quote({
        fromAsset: entry.to_asset,
        toAsset: entry.from_asset,
        amount: closeAmount,
      });
      closeAmountOut = getDexOutput(quote, dex);
      closeDex = getDexName(quote, dex);
    }
  } else {
    const walletAddress = sdk.ton.getAddress();
    if (!walletAddress) {
      return { success: false, error: "Wallet not initialized" };
    }

    const quote = await sdk.ton.dex.quote({
      fromAsset: entry.to_asset,
      toAsset: entry.from_asset,
      amount: closeAmount,
    }).catch((err) => {
      sdk.log.warn(`Reverse close quote failed for trade #${entry.id}: ${err.message}`);
      return null;
    });

    const swapResult = await sdk.ton.dex.swap(closeSwapParams);
    minOutput = toFiniteNumber(swapResult?.minOutput);
    closeAmountOut = getDexOutput(swapResult, dex) ?? getDexOutput(quote, dex) ?? minOutput;
    closeDex = getDexName(swapResult, dex);

    try {
      await sdk.telegram.sendMessage(
        context.chatId,
        `Close submitted for trade #${entry.id}: ${closeAmount} ${entry.to_asset} → ${entry.from_asset}\nExpected output: ${closeAmountOut ?? "unknown"}\nAllow ~30 seconds for on-chain confirmation.`
      );
    } catch (msgErr) {
      if (msgErr.name === "PluginSDKError") {
        sdk.log.warn(`Could not send close confirmation message: ${msgErr.code}: ${msgErr.message}`);
      } else {
        sdk.log.warn(`Could not send close confirmation message: ${msgErr.message}`);
      }
    }
  }

  if (closeAmountOut == null) {
    return { success: false, error: `Could not determine close output for trade ${entry.id}` };
  }

  const closeResult = closeTradeJournalEntry(
    sdk,
    entry,
    closeAmountOut,
    exitPriceUsd,
    note ?? "closed by ton_trading_close_position"
  );

  if (!closeResult.success) return closeResult;

  sdk.log.info(
    `Position #${entry.id} closed: ${closeAmount} ${entry.to_asset} → ${closeAmountOut} ${entry.from_asset}`
  );

  return {
    success: true,
    data: {
      ...closeResult.data,
      original_position: formatOpenPosition(entry),
      close: {
        from_asset: entry.to_asset,
        to_asset: entry.from_asset,
        amount_in: closeAmount,
        amount_out: closeAmountOut,
        exit_price_usd: exitPriceUsd,
        slippage: entry.mode === "real" ? slippage : null,
        dex: closeDex,
        min_output: minOutput,
      },
    },
  };
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
          description: "USD price of from_asset at trade exit. Must match the same asset as entry_price_usd (e.g. if you sold TON, provide TON's USD price at the time of closing). Obtain from ton_trading_get_market_data.",
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

        const closeResult = closeTradeJournalEntry(sdk, entry, amount_out, exit_price_usd, note);
        if (!closeResult.success) return closeResult;

        sdk.log.info(
          `Trade #${trade_id} closed: PnL ${closeResult.data.pnl >= 0 ? "+" : ""}${closeResult.data.pnl.toFixed(4)} (${closeResult.data.pnl_percent.toFixed(2)}%)`
        );

        return closeResult;
      } catch (err) {
        sdk.log.error(`ton_trading_record_trade failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Position Management: ton_trading_get_open_positions ───────────────────
  {
    name: "ton_trading_get_open_positions",
    description:
      "Get open trading positions from the journal, filtered by real or simulation mode. Use this before deciding which positions to close.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Include "real", "simulation", or "all" open positions (default "all")',
          enum: ["real", "simulation", "all"],
        },
        limit: {
          type: "integer",
          description: "Maximum number of open positions to return (1-100, default 50)",
          minimum: 1,
          maximum: 100,
        },
      },
    },
    execute: async (params, _context) => {
      const { mode = "all" } = params;
      const requestedLimit = Number.parseInt(params.limit ?? 50, 10);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 100);

      try {
        const modeClause = mode === "all" ? "" : "AND mode = ?";
        const args = mode === "all" ? [limit] : [mode, limit];
        const openTrades = sdk.db
          .prepare(`SELECT * FROM trade_journal WHERE status = 'open' ${modeClause} ORDER BY timestamp DESC LIMIT ?`)
          .all(...args);

        return {
          success: true,
          data: {
            mode,
            count: openTrades.length,
            positions: openTrades.map(formatOpenPosition),
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_get_open_positions failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Position Management: ton_trading_close_position ────────────────────────
  {
    name: "ton_trading_close_position",
    description:
      "Close a specific open position by trade ID. Simulation mode uses a reverse DEX quote; real mode submits a reverse DEX swap and then closes the journal entry.",
    category: "action",
    scope: "dm-only",
    parameters: {
      type: "object",
      properties: {
        trade_id: {
          type: "integer",
          description: "Open journal trade ID to close",
        },
        mode: {
          type: "string",
          description: 'Expected mode for the trade: "real" or "simulation". Required to prevent accidental real closes.',
          enum: ["real", "simulation"],
        },
        amount: {
          type: "number",
          description: "Optional override for the amount of the acquired asset to sell when closing. Defaults to the trade's recorded amount_out.",
        },
        slippage: {
          type: "number",
          description: "Slippage tolerance for real close swaps (default: plugin config, typically 0.05)",
          minimum: 0.001,
          maximum: 0.5,
        },
        dex: {
          type: "string",
          description: 'Preferred DEX for real close swaps: "stonfi" or "dedust"',
          enum: ["stonfi", "dedust"],
        },
        exit_price_usd: {
          type: "number",
          description: "USD price of the original from_asset at close. If omitted for TON positions, the current TON/USD price is used when available.",
        },
        note: {
          type: "string",
          description: "Optional close note or reason",
        },
      },
      required: ["trade_id", "mode"],
    },
    execute: async (params, context) => {
      const { trade_id, mode } = params;
      try {
        const entry = sdk.db
          .prepare("SELECT * FROM trade_journal WHERE id = ?")
          .get(trade_id);

        if (!entry) {
          return { success: false, error: `Trade ${trade_id} not found` };
        }

        if (entry.mode !== mode) {
          return {
            success: false,
            error: `Trade ${trade_id} mode is "${entry.mode}", but close_position was called with mode "${mode}"`,
          };
        }

        return await closeOpenPosition(sdk, entry, params, context);
      } catch (err) {
        sdk.log.error(`ton_trading_close_position failed: ${err.message}`);
        if (err.name === "PluginSDKError") {
          return { success: false, error: `${err.code}: ${String(err.message).slice(0, 500)}` };
        }
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Position Management: ton_trading_close_all_positions ───────────────────
  {
    name: "ton_trading_close_all_positions",
    description:
      "Close all open positions for the selected mode. Returns a per-position result so failed closes are visible and can be retried.",
    category: "action",
    scope: "dm-only",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Close positions in "real" or "simulation" mode. Required to prevent accidental real closes.',
          enum: ["real", "simulation"],
        },
        slippage: {
          type: "number",
          description: "Slippage tolerance for real close swaps (default: plugin config, typically 0.05)",
          minimum: 0.001,
          maximum: 0.5,
        },
        dex: {
          type: "string",
          description: 'Preferred DEX for real close swaps: "stonfi" or "dedust"',
          enum: ["stonfi", "dedust"],
        },
        exit_price_usd: {
          type: "number",
          description: "USD price of the original from_asset at close. Applies to all matching positions when provided.",
        },
        note: {
          type: "string",
          description: "Optional close note or reason applied to every closed position",
        },
      },
      required: ["mode"],
    },
    execute: async (params, context) => {
      const { mode } = params;
      try {
        const openTrades = sdk.db
          .prepare("SELECT * FROM trade_journal WHERE status = 'open' AND mode = ? ORDER BY timestamp DESC")
          .all(mode);

        const closed = [];
        const failures = [];

        for (const entry of openTrades) {
          const result = await closeOpenPosition(sdk, entry, params, context);
          if (result.success) {
            closed.push(result.data);
          } else {
            failures.push({
              trade_id: entry.id,
              error: result.error,
            });
          }
        }

        const data = {
          mode,
          requested_count: openTrades.length,
          closed_count: closed.length,
          failed_count: failures.length,
          closed_positions: closed,
          failures,
        };

        if (failures.length > 0) {
          return {
            success: false,
            error: `Failed to close ${failures.length} of ${openTrades.length} open position(s)`,
            data,
          };
        }

        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_close_all_positions failed: ${err.message}`);
        if (err.name === "PluginSDKError") {
          return { success: false, error: `${err.code}: ${String(err.message).slice(0, 500)}` };
        }
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
        const dexFees = { stonfi: 0.003, dedust: 0.003 };
        const quoteParams = { fromAsset: from_asset, toAsset: to_asset, amount: parseFloat(amount) };

        // Query each DEX individually so a single failure doesn't hide the others
        const dexErrors = {};
        const [stonfiResult, dedustResult] = await Promise.all([
          sdk.ton.dex.quoteSTONfi(quoteParams).catch((err) => {
            sdk.log.warn(`StonFi quote failed for ${from_asset}→${to_asset}: ${err.message}`);
            dexErrors.stonfi = err.message;
            return null;
          }),
          sdk.ton.dex.quoteDeDust(quoteParams).catch((err) => {
            sdk.log.warn(`DeDust quote failed for ${from_asset}→${to_asset}: ${err.message}`);
            dexErrors.dedust = err.message;
            return null;
          }),
        ]);

        const rawQuotes = { stonfi: stonfiResult, dedust: dedustResult };
        const anySucceeded = Object.values(rawQuotes).some((q) => q !== null);

        if (!anySucceeded) {
          const errorDetail = Object.entries(dexErrors)
            .map(([dex, msg]) => `${dex}: ${msg}`)
            .join("; ");
          sdk.log.error(`All DEX quotes failed for ${from_asset}→${to_asset}: ${errorDetail}`);
          return { success: false, error: `Could not fetch DEX quotes — ${errorDetail}`.slice(0, 500) };
        }

        // Collect per-DEX outputs
        const dexOutputs = [];
        for (const [dex, fee] of Object.entries(dexFees)) {
          const raw = rawQuotes[dex];
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
          // For trailing stops: update peak_price if price moved higher, then compute stop from peak
          let effectivePeak = rule.peak_price ?? rule.entry_price;
          let trailingStopPrice = null;
          if (rule.trailing_stop && rule.trailing_stop_percent != null) {
            if (current_price > effectivePeak) {
              effectivePeak = current_price;
              sdk.db
                .prepare("UPDATE stop_loss_rules SET peak_price = ? WHERE id = ?")
                .run(effectivePeak, rule.id);
            }
            trailingStopPrice = effectivePeak * (1 - rule.trailing_stop_percent / 100);
          }

          // The plain stop-loss level is always based on entry price, regardless of trailing.
          const plainStopLossPrice = rule.entry_price * (1 - rule.stop_loss_percent / 100);
          const takeProfitPrice = rule.take_profit_percent != null
            ? rule.entry_price * (1 + rule.take_profit_percent / 100)
            : null;

          // When trailing stop is active the effective stop price is the trailing floor
          // (used for the annotated stop_loss_price field), but the exit is classified as
          // "take_profit" because the trade is being closed to lock in profits, not a loss.
          const stopLossPrice = trailingStopPrice ?? plainStopLossPrice;

          // Plain stop-loss fires only when price drops below the entry-based floor.
          const stopLossHit = current_price <= plainStopLossPrice;
          // For trailing stops: take_profit fires when price pulls back below the trailing floor.
          // For plain rules:    take_profit fires when price reaches the static target.
          const takeProfitHit = rule.trailing_stop
            ? trailingStopPrice != null && current_price <= trailingStopPrice && !stopLossHit
            : takeProfitPrice != null && current_price >= takeProfitPrice;

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
            trailing_stop: rule.trailing_stop === 1,
            trailing_stop_percent: rule.trailing_stop_percent ?? null,
            peak_price: rule.trailing_stop === 1 ? parseFloat(effectivePeak.toFixed(6)) : null,
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

  // ── Tool 23: ton_trading_reset_simulation_balance ──────────────────────────
  {
    name: "ton_trading_reset_simulation_balance",
    description:
      "Reset the simulation (paper-trading) balance to a specified starting amount. Use this to start a fresh simulation session or undo accumulated errors in the virtual balance.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        amount: {
          type: "number",
          description: "New starting balance in TON (default: plugin config simulationBalance, typically 1000)",
          minimum: 0,
        },
      },
    },
    execute: async (params, _context) => {
      try {
        const amount = params.amount ?? sdk.pluginConfig.simulationBalance ?? 1000;
        const previousBalance = getSimBalance(sdk);
        setSimBalance(sdk, amount);
        sdk.log.info(`Simulation balance reset from ${previousBalance} to ${amount} TON`);
        return {
          success: true,
          data: {
            previous_balance: previousBalance,
            new_balance: amount,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_reset_simulation_balance failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 24: ton_trading_set_simulation_balance ────────────────────────────
  {
    name: "ton_trading_set_simulation_balance",
    description:
      "Manually set the simulation (paper-trading) balance to a specific amount. Use this to align the virtual balance with a real portfolio value or to inject/withdraw virtual funds.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        amount: {
          type: "number",
          description: "New simulation balance in TON",
          minimum: 0,
        },
      },
      required: ["amount"],
    },
    execute: async (params, _context) => {
      const { amount } = params;
      try {
        const previousBalance = getSimBalance(sdk);
        setSimBalance(sdk, amount);
        sdk.log.info(`Simulation balance manually set from ${previousBalance} to ${amount} TON`);
        return {
          success: true,
          data: {
            previous_balance: previousBalance,
            new_balance: amount,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_set_simulation_balance failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Take-Profit Automation ─────────────────────────────────────────────────

  // ── Tool 25: ton_trading_set_take_profit ───────────────────────────────────
  {
    name: "ton_trading_set_take_profit",
    description:
      "Register a standalone take-profit rule for an open trade. When the market price reaches the take-profit level, the LLM should close the position using ton_trading_record_trade. Supports optional trailing stop that locks in profits as price rises.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        trade_id: {
          type: "integer",
          description: "Journal trade ID to protect with a take-profit rule",
        },
        entry_price: {
          type: "number",
          description: "Price at which the position was opened (in quote asset units)",
        },
        take_profit_percent: {
          type: "number",
          description: "Profit percentage that triggers the take-profit exit (e.g. 10 = close at +10%)",
          minimum: 0.1,
        },
        trailing_stop: {
          type: "boolean",
          description: "Enable trailing stop — the take-profit level adjusts upward as price rises, locking in profits. Defaults to false.",
        },
        trailing_stop_percent: {
          type: "number",
          description: "Trailing stop offset below the peak price in percent. Only used when trailing_stop is true. Defaults to take_profit_percent / 2.",
          minimum: 0.1,
        },
      },
      required: ["trade_id", "entry_price", "take_profit_percent"],
    },
    execute: async (params, _context) => {
      const { trade_id, entry_price, take_profit_percent, trailing_stop = false, trailing_stop_percent } = params;
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

        // Use a very large stop-loss (99%) to create a take-profit-only rule via the existing table
        const trailingOffset = trailing_stop_percent ?? take_profit_percent / 2;
        const ruleId = sdk.db
          .prepare(
            `INSERT INTO stop_loss_rules
               (trade_id, stop_loss_percent, take_profit_percent, entry_price, created_at,
                trailing_stop, trailing_stop_percent, peak_price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            trade_id, 99, take_profit_percent, entry_price, Date.now(),
            trailing_stop ? 1 : 0,
            trailing_stop ? trailingOffset : null,
            trailing_stop ? entry_price : null
          )
          .lastInsertRowid;

        const takeProfitPrice = entry_price * (1 + take_profit_percent / 100);

        sdk.log.info(
          `Take-profit rule #${ruleId} set for trade #${trade_id}: TP=${takeProfitPrice.toFixed(4)}` +
          (trailing_stop ? ` (trailing stop: ${trailingOffset}%)` : "")
        );

        return {
          success: true,
          data: {
            rule_id: ruleId,
            trade_id,
            entry_price,
            take_profit_price: parseFloat(takeProfitPrice.toFixed(6)),
            take_profit_percent,
            trailing_stop,
            trailing_stop_percent: trailing_stop ? trailingOffset : null,
            status: "active",
            note: trailing_stop
              ? `Trailing stop active — take-profit will adjust upward as price rises, closing ${trailingOffset}% below peak`
              : `Take-profit will trigger when price reaches ${takeProfitPrice.toFixed(4)}. Monitor with ton_trading_check_stop_loss.`,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_set_take_profit failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Automated Trade Execution ──────────────────────────────────────────────

  // ── Tool 26: ton_trading_auto_execute ──────────────────────────────────────
  {
    name: "ton_trading_auto_execute",
    description:
      "Evaluate a set of trigger conditions against current market data and automatically execute a trade if all conditions are met. Supports price target, technical threshold, and schedule-based triggers. Returns what was evaluated and whether a trade was submitted.",
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
          type: "number",
          description: "Amount of from_asset to trade when conditions are met",
        },
        mode: {
          type: "string",
          description: 'Trading mode: "real" or "simulation" (default "simulation")',
          enum: ["real", "simulation"],
        },
        trigger_price_below: {
          type: "number",
          description: "Execute when current price falls below this value (buy-the-dip trigger)",
        },
        trigger_price_above: {
          type: "number",
          description: "Execute when current price rises above this value (breakout trigger)",
        },
        auto_close_at_profit_percent: {
          type: "number",
          description: "Automatically register a take-profit rule after execution at this profit %",
          minimum: 0.1,
        },
        auto_stop_loss_percent: {
          type: "number",
          description: "Automatically register a stop-loss rule after execution at this loss %",
          minimum: 0.1,
        },
        slippage: {
          type: "number",
          description: "Slippage tolerance for execution (default: plugin config, typically 0.05)",
          minimum: 0.001,
          maximum: 0.5,
        },
      },
      required: ["from_asset", "to_asset", "amount"],
    },
    execute: async (params, _context) => {
      const {
        from_asset, to_asset, amount, mode = "simulation",
        trigger_price_below, trigger_price_above,
        auto_close_at_profit_percent, auto_stop_loss_percent,
        slippage = sdk.pluginConfig.defaultSlippage ?? 0.05,
      } = params;
      try {
        // Fetch current market price for evaluation
        const [tonPrice, dexQuote] = await Promise.all([
          sdk.ton.getPrice(),
          sdk.ton.dex.quote({
            fromAsset: from_asset,
            toAsset: to_asset,
            amount,
          }).catch(() => null),
        ]);

        const currentPrice = dexQuote?.recommended
          ? parseFloat(dexQuote[dexQuote.recommended]?.output ?? dexQuote[dexQuote.recommended]?.price ?? 0) / amount
          : (tonPrice?.usd ?? null);

        const conditions = [];
        let allMet = true;

        if (trigger_price_below != null) {
          const met = currentPrice != null && currentPrice < trigger_price_below;
          conditions.push({ type: "price_below", threshold: trigger_price_below, current: currentPrice, met });
          if (!met) allMet = false;
        }

        if (trigger_price_above != null) {
          const met = currentPrice != null && currentPrice > trigger_price_above;
          conditions.push({ type: "price_above", threshold: trigger_price_above, current: currentPrice, met });
          if (!met) allMet = false;
        }

        if (conditions.length === 0) {
          // No conditions — execute immediately
          allMet = true;
        }

        if (!allMet) {
          return {
            success: true,
            data: {
              executed: false,
              reason: "Trigger conditions not met",
              conditions,
              current_price: currentPrice,
            },
          };
        }

        // ── Risk validation (same rules as ton_trading_validate_trade) ──────────
        const maxTradePercent = sdk.pluginConfig.maxTradePercent ?? 10;
        const minBalanceTON = sdk.pluginConfig.minBalanceTON ?? 1;

        if (mode === "simulation" && from_asset === "TON") {
          const simBalance = getSimBalance(sdk);
          const maxAllowed = simBalance * (maxTradePercent / 100);
          if (simBalance < minBalanceTON) {
            return {
              success: false,
              error: `Simulation balance (${simBalance} TON) is below minimum (${minBalanceTON} TON)`,
            };
          }
          if (amount > maxAllowed) {
            return {
              success: false,
              error: `Amount ${amount} TON exceeds ${maxTradePercent}% of simulation balance (max ${maxAllowed.toFixed(4)} TON)`,
            };
          }
          if (simBalance - amount < minBalanceTON) {
            return {
              success: false,
              error: `Trade would bring simulation balance below minimum (${minBalanceTON} TON)`,
            };
          }
        } else if (mode === "real" && from_asset === "TON") {
          const realBalance = parseFloat((await sdk.ton.getBalance())?.balance ?? "0");
          const maxAllowed = realBalance * (maxTradePercent / 100);
          if (realBalance < minBalanceTON) {
            return {
              success: false,
              error: `Wallet balance (${realBalance} TON) is below minimum (${minBalanceTON} TON)`,
            };
          }
          if (amount > maxAllowed) {
            return {
              success: false,
              error: `Amount ${amount} TON exceeds ${maxTradePercent}% of balance (max ${maxAllowed.toFixed(4)} TON)`,
            };
          }
        }

        // Execute the trade
        let tradeResult;
        if (mode === "simulation") {
          const expectedOut = dexQuote?.recommended
            ? parseFloat(dexQuote[dexQuote.recommended]?.output ?? dexQuote[dexQuote.recommended]?.price ?? 0)
            : amount;

          const tradeId = sdk.db
            .prepare(
              `INSERT INTO trade_journal
               (timestamp, mode, action, from_asset, to_asset, amount_in, amount_out, entry_price_usd, status, note)
               VALUES (?, 'simulation', 'buy', ?, ?, ?, ?, ?, 'open', 'auto_execute')`
            )
            .run(Date.now(), from_asset, to_asset, amount, expectedOut, tonPrice?.usd ?? null, null)
            .lastInsertRowid;

          if (from_asset === "TON") {
            const simBalance = getSimBalance(sdk);
            setSimBalance(sdk, simBalance - amount);
          }

          tradeResult = { trade_id: tradeId, mode: "simulation", from_asset, to_asset, amount_in: amount };
        } else {
          const swapResult = await sdk.ton.dex.swap({
            fromAsset: from_asset,
            toAsset: to_asset,
            amount,
            slippage,
          });

          const tradeId = sdk.db
            .prepare(
              `INSERT INTO trade_journal
               (timestamp, mode, action, from_asset, to_asset, amount_in, amount_out, entry_price_usd, status)
               VALUES (?, 'real', 'buy', ?, ?, ?, ?, ?, 'open')`
            )
            .run(
              Date.now(), from_asset, to_asset, amount,
              swapResult?.expectedOutput ? parseFloat(swapResult.expectedOutput) : null,
              tonPrice?.usd ?? null
            )
            .lastInsertRowid;

          tradeResult = { trade_id: tradeId, mode: "real", from_asset, to_asset, amount_in: amount, dex: swapResult?.dex };
        }

        // Register automatic risk management rules if requested
        const rules = [];
        if (auto_close_at_profit_percent != null || auto_stop_loss_percent != null) {
          const stopLossPct = auto_stop_loss_percent ?? 99;
          const tpPct = auto_close_at_profit_percent ?? null;
          const ruleId = sdk.db
            .prepare(
              `INSERT INTO stop_loss_rules (trade_id, stop_loss_percent, take_profit_percent, entry_price, created_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(tradeResult.trade_id, stopLossPct, tpPct, currentPrice ?? amount, Date.now())
            .lastInsertRowid;
          rules.push({ rule_id: ruleId, stop_loss_percent: stopLossPct, take_profit_percent: tpPct });
        }

        sdk.log.info(`Auto-executed trade #${tradeResult.trade_id}: ${amount} ${from_asset} → ${to_asset}`);

        return {
          success: true,
          data: {
            executed: true,
            trade: tradeResult,
            conditions,
            current_price: currentPrice,
            risk_rules: rules,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_auto_execute failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Portfolio-Level Management ─────────────────────────────────────────────

  // ── Tool 27: ton_trading_get_portfolio_summary ─────────────────────────────
  {
    name: "ton_trading_get_portfolio_summary",
    description:
      "Get a comprehensive portfolio overview with unrealized P&L for all open positions, total exposure, and performance metrics. Use this for a full snapshot of the portfolio before making allocation decisions.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Include "real", "simulation", or "all" trades in the summary (default "all")',
          enum: ["real", "simulation", "all"],
        },
      },
    },
    execute: async (params, _context) => {
      const { mode = "all" } = params;
      try {
        const modeClause = mode === "all" ? "" : "AND mode = ?";
        const modeArgs = mode === "all" ? [] : [mode];

        const openTrades = sdk.db
          .prepare(`SELECT * FROM trade_journal WHERE status = 'open' ${modeClause} ORDER BY timestamp DESC`)
          .all(...modeArgs);

        const closedTrades = sdk.db
          .prepare(`SELECT pnl, pnl_percent, mode FROM trade_journal WHERE status = 'closed' ${modeClause}`)
          .all(...modeArgs);

        // Fetch current TON price for unrealized P&L estimation
        const tonPrice = await sdk.ton.getPrice().catch(() => null);
        const tonPriceUsd = tonPrice?.usd ?? null;

        // Calculate portfolio metrics
        const totalOpenPositions = openTrades.length;
        const totalExposureTon = openTrades.reduce((sum, t) => sum + (t.from_asset === "TON" ? (t.amount_in ?? 0) : 0), 0);

        const realizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
        const winCount = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
        const lossCount = closedTrades.filter((t) => (t.pnl ?? 0) < 0).length;
        const winRate = closedTrades.length > 0 ? winCount / closedTrades.length : null;

        const simBalance = getSimBalance(sdk);
        const realBalance = await sdk.ton.getBalance().catch(() => null);

        return {
          success: true,
          data: {
            mode,
            real_balance_ton: realBalance?.balance ?? null,
            simulation_balance_ton: simBalance,
            ton_price_usd: tonPriceUsd,
            open_positions: totalOpenPositions,
            total_exposure_ton: parseFloat(totalExposureTon.toFixed(4)),
            realized_pnl_usd: parseFloat(realizedPnl.toFixed(4)),
            total_closed_trades: closedTrades.length,
            win_count: winCount,
            loss_count: lossCount,
            win_rate: winRate != null ? parseFloat(winRate.toFixed(4)) : null,
            open_trades: openTrades.map((t) => ({
              trade_id: t.id,
              mode: t.mode,
              from_asset: t.from_asset,
              to_asset: t.to_asset,
              amount_in: t.amount_in,
              entry_price_usd: t.entry_price_usd,
              opened_at: t.timestamp,
            })),
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_get_portfolio_summary failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 28: ton_trading_rebalance_portfolio ───────────────────────────────
  {
    name: "ton_trading_rebalance_portfolio",
    description:
      "Calculate the trades needed to rebalance the portfolio to target allocations. Returns a rebalancing plan with suggested buy/sell actions. Does not execute trades — use ton_trading_execute_swap to act on the plan.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        target_allocations: {
          type: "array",
          description: "Target portfolio allocations as an array of {asset, percent} objects. Percents must sum to 100.",
          items: {
            type: "object",
            properties: {
              asset: { type: "string", description: 'Asset address or "TON"' },
              percent: { type: "number", description: "Target allocation percent (0–100)" },
            },
            required: ["asset", "percent"],
          },
          minItems: 1,
        },
        mode: {
          type: "string",
          description: 'Use "real" wallet balance or "simulation" balance (default "real")',
          enum: ["real", "simulation"],
        },
      },
      required: ["target_allocations"],
    },
    execute: async (params, _context) => {
      const { target_allocations, mode = "real" } = params;
      try {
        const totalPercent = target_allocations.reduce((s, a) => s + a.percent, 0);
        if (Math.abs(totalPercent - 100) > 0.01) {
          return { success: false, error: `Target allocations must sum to 100% (got ${totalPercent.toFixed(2)}%)` };
        }

        const totalBalance =
          mode === "simulation"
            ? getSimBalance(sdk)
            : parseFloat((await sdk.ton.getBalance())?.balance ?? "0");

        const tonPrice = await sdk.ton.getPrice().catch(() => null);
        const tonPriceUsd = tonPrice?.usd ?? 1;

        const tonBalanceUsd = totalBalance * tonPriceUsd;

        // Fetch current jetton holdings for real mode
        let jettonHoldings = [];
        if (mode === "real") {
          jettonHoldings = await sdk.ton.getJettonBalances().catch(() => []);
        }

        // For each unique jetton in target_allocations, fetch a DEX quote to convert
        // token balance → USD value. Raw token units are NOT USD for non-stable assets.
        const jettonPricesUsd = {};
        for (const target of target_allocations) {
          if (target.asset !== "TON") {
            const holding = jettonHoldings.find((j) => j.jettonAddress === target.asset);
            if (holding && parseFloat(holding.balanceFormatted ?? holding.balance ?? "0") > 0) {
              const tokenBalance = parseFloat(holding.balanceFormatted ?? holding.balance ?? "0");
              // Quote 1 unit of the jetton to TON to get the price
              const priceQuote = await sdk.ton.dex.quote({
                fromAsset: target.asset,
                toAsset: "TON",
                amount: 1,
              }).catch(() => null);
              if (priceQuote) {
                const tonPerToken = parseFloat(
                  priceQuote[priceQuote.recommended]?.output ??
                  priceQuote[priceQuote.recommended]?.price ??
                  0
                );
                jettonPricesUsd[target.asset] = {
                  tokenBalance,
                  valueUsd: tokenBalance * tonPerToken * tonPriceUsd,
                };
              }
            }
          }
        }

        // Total portfolio USD = TON holdings + all priced jetton holdings
        const jettonTotalUsd = Object.values(jettonPricesUsd).reduce(
          (sum, j) => sum + j.valueUsd,
          0
        );
        const totalValueUsd = tonBalanceUsd + jettonTotalUsd;

        const rebalancingPlan = target_allocations.map((target) => {
          const targetValueUsd = totalValueUsd * (target.percent / 100);
          let currentValueUsd = 0;

          if (target.asset === "TON") {
            currentValueUsd = totalBalance * tonPriceUsd;
          } else if (jettonPricesUsd[target.asset]) {
            // Use market-price-based USD value for jetton holdings
            currentValueUsd = jettonPricesUsd[target.asset].valueUsd;
          } else {
            // No holding or no price available — assume zero current value
            currentValueUsd = 0;
          }

          const diffUsd = targetValueUsd - currentValueUsd;
          const diffTon = diffUsd / tonPriceUsd;

          return {
            asset: target.asset,
            target_percent: target.percent,
            target_value_usd: parseFloat(targetValueUsd.toFixed(2)),
            current_value_usd: parseFloat(currentValueUsd.toFixed(2)),
            diff_usd: parseFloat(diffUsd.toFixed(2)),
            diff_ton: parseFloat(diffTon.toFixed(4)),
            action: diffUsd > 1 ? "buy" : diffUsd < -1 ? "sell" : "hold",
          };
        });

        const actions = rebalancingPlan.filter((p) => p.action !== "hold");

        return {
          success: true,
          data: {
            mode,
            total_portfolio_value_usd: parseFloat(totalValueUsd.toFixed(2)),
            ton_balance: parseFloat(totalBalance.toFixed(4)),
            ton_balance_usd: parseFloat(tonBalanceUsd.toFixed(2)),
            jetton_holdings_usd: parseFloat(jettonTotalUsd.toFixed(2)),
            ton_price_usd: tonPriceUsd,
            rebalancing_plan: rebalancingPlan,
            actions_required: actions.length,
            note: actions.length > 0
              ? `${actions.length} asset(s) need rebalancing. Execute using ton_trading_execute_swap.`
              : "Portfolio is already balanced — no trades needed.",
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_rebalance_portfolio failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Advanced Market Data ───────────────────────────────────────────────────

  // ── Tool 29: ton_trading_get_technical_indicators ──────────────────────────
  {
    name: "ton_trading_get_technical_indicators",
    description:
      "Calculate RSI, MACD, and Bollinger Bands for a TON token pair using recent price data. Returns indicator values and trading signals (overbought/oversold). Use to inform entry and exit decisions.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        token_address: {
          type: "string",
          description: 'Token address to analyse — "TON" for native TON or a jetton master address',
        },
        timeframe: {
          type: "string",
          description: 'Candle timeframe: "1h", "4h", "1d" (default "1h")',
          enum: ["1h", "4h", "1d"],
        },
        periods: {
          type: "integer",
          description: "Number of candles to use for calculations (default 14 for RSI, 26 for MACD)",
          minimum: 5,
          maximum: 100,
        },
      },
      required: ["token_address"],
    },
    execute: async (params, _context) => {
      const { token_address, timeframe = "1h", periods = 14 } = params;
      try {
        const cacheKey = `indicators:${token_address}:${timeframe}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        // Fetch OHLCV data from GeckoTerminal
        const resolution = timeframe === "1h" ? "hour" : timeframe === "4h" ? "4h" : "day";
        const limit = Math.max(periods + 10, 50);

        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${encodeURIComponent(token_address)}/ohlcv/${resolution}?limit=${limit}&currency=usd`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          return { success: false, error: `GeckoTerminal OHLCV API returned ${res.status}` };
        }

        const json = await res.json();
        const ohlcv = (json?.data?.attributes?.ohlcv_list ?? []).map(([ts, o, h, l, c, v]) => ({
          timestamp: ts * 1000,
          open: parseFloat(o),
          high: parseFloat(h),
          low: parseFloat(l),
          close: parseFloat(c),
          volume: parseFloat(v),
        }));

        if (ohlcv.length < periods) {
          return { success: false, error: `Not enough price data: need ${periods} candles, got ${ohlcv.length}` };
        }

        const closes = ohlcv.map((c) => c.close);
        const currentPrice = closes[closes.length - 1];

        // ── RSI (Relative Strength Index) ──────────────────────────────────
        const rsiPeriod = periods;
        const gains = [], losses = [];
        for (let i = 1; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          gains.push(diff > 0 ? diff : 0);
          losses.push(diff < 0 ? Math.abs(diff) : 0);
        }
        const avgGain = gains.slice(-rsiPeriod).reduce((s, g) => s + g, 0) / rsiPeriod;
        const avgLoss = losses.slice(-rsiPeriod).reduce((s, l) => s + l, 0) / rsiPeriod;
        const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
        const rsi = parseFloat((100 - 100 / (1 + rs)).toFixed(2));

        // ── MACD (Moving Average Convergence Divergence) ───────────────────
        function ema(data, n) {
          const k = 2 / (n + 1);
          let emaVal = data[0];
          for (let i = 1; i < data.length; i++) {
            emaVal = data[i] * k + emaVal * (1 - k);
          }
          return emaVal;
        }
        const ema12 = ema(closes, 12);
        const ema26 = ema(closes, 26);
        const macdLine = parseFloat((ema12 - ema26).toFixed(6));
        const signalLine = parseFloat(ema(closes.slice(-9), 9).toFixed(6));
        const macdHistogram = parseFloat((macdLine - signalLine).toFixed(6));

        // ── Bollinger Bands ────────────────────────────────────────────────
        const bbPeriod = 20;
        const recentCloses = closes.slice(-bbPeriod);
        const bbMean = recentCloses.reduce((s, c) => s + c, 0) / bbPeriod;
        const bbStdDev = Math.sqrt(recentCloses.reduce((s, c) => s + (c - bbMean) ** 2, 0) / bbPeriod);
        const bbUpper = parseFloat((bbMean + 2 * bbStdDev).toFixed(6));
        const bbLower = parseFloat((bbMean - 2 * bbStdDev).toFixed(6));
        const bbMiddle = parseFloat(bbMean.toFixed(6));

        // ── Signals ────────────────────────────────────────────────────────
        const signals = [];
        if (rsi < 30) signals.push({ indicator: "RSI", signal: "oversold", strength: "strong", note: `RSI ${rsi} < 30 — potential buy signal` });
        else if (rsi > 70) signals.push({ indicator: "RSI", signal: "overbought", strength: "strong", note: `RSI ${rsi} > 70 — potential sell signal` });
        if (macdHistogram > 0 && macdLine > 0) signals.push({ indicator: "MACD", signal: "bullish", strength: "moderate", note: "MACD above signal line" });
        else if (macdHistogram < 0 && macdLine < 0) signals.push({ indicator: "MACD", signal: "bearish", strength: "moderate", note: "MACD below signal line" });
        if (currentPrice <= bbLower) signals.push({ indicator: "Bollinger", signal: "oversold", strength: "moderate", note: "Price at lower band" });
        else if (currentPrice >= bbUpper) signals.push({ indicator: "Bollinger", signal: "overbought", strength: "moderate", note: "Price at upper band" });

        const data = {
          token_address,
          timeframe,
          current_price: currentPrice,
          candles_analysed: ohlcv.length,
          rsi: { value: rsi, signal: rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral" },
          macd: { macd_line: macdLine, signal_line: signalLine, histogram: macdHistogram, signal: macdHistogram > 0 ? "bullish" : "bearish" },
          bollinger_bands: { upper: bbUpper, middle: bbMiddle, lower: bbLower, bandwidth: parseFloat((bbUpper - bbLower).toFixed(6)) },
          signals,
          calculated_at: Date.now(),
        };

        sdk.storage.set(cacheKey, data, { ttl: 300_000 });
        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_technical_indicators failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 30: ton_trading_get_order_book_depth ──────────────────────────────
  {
    name: "ton_trading_get_order_book_depth",
    description:
      "Analyse order book depth and liquidity for a token pair. Returns bid/ask spread, depth at various price levels, and estimated price impact for a given trade size. Use before large trades to assess slippage risk.",
    category: "data-bearing",
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
        trade_amount: {
          type: "number",
          description: "Trade size to estimate price impact for (in from_asset units)",
        },
      },
      required: ["from_asset", "to_asset"],
    },
    execute: async (params, _context) => {
      const { from_asset, to_asset, trade_amount } = params;
      try {
        const cacheKey = `orderbook:${from_asset}:${to_asset}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached && !trade_amount) return { success: true, data: cached };

        // Fetch quotes at different sizes to construct a synthetic order book
        const testAmounts = [0.1, 1, 5, 10, 50, 100];
        const quotePromises = testAmounts.map((amt) =>
          sdk.ton.dex.quote({ fromAsset: from_asset, toAsset: to_asset, amount: amt })
            .catch(() => null)
        );

        const quotes = await Promise.all(quotePromises);

        const depthLevels = testAmounts.map((amt, i) => {
          const q = quotes[i];
          if (!q) return null;
          const output = parseFloat(q.recommended ? q[q.recommended]?.output ?? q[q.recommended]?.price ?? 0 : 0);
          const effectivePrice = output > 0 ? output / amt : null;
          return { amount_in: amt, amount_out: output, effective_price: effectivePrice };
        }).filter(Boolean);

        // Calculate spread and price impact
        let bidAskSpread = null;
        let priceImpactPercent = null;

        if (depthLevels.length >= 2) {
          const basePrice = depthLevels[0]?.effective_price;
          const largePrice = depthLevels[depthLevels.length - 1]?.effective_price;
          if (basePrice && largePrice) {
            bidAskSpread = parseFloat(Math.abs(basePrice - largePrice).toFixed(6));
            priceImpactPercent = parseFloat(((Math.abs(basePrice - largePrice) / basePrice) * 100).toFixed(4));
          }
        }

        let customTradeImpact = null;
        if (trade_amount != null) {
          const customQuote = await sdk.ton.dex.quote({
            fromAsset: from_asset,
            toAsset: to_asset,
            amount: trade_amount,
          }).catch(() => null);

          if (customQuote) {
            const output = parseFloat(customQuote.recommended ? customQuote[customQuote.recommended]?.output ?? customQuote[customQuote.recommended]?.price ?? 0 : 0);
            const basePrice = depthLevels[0]?.effective_price;
            const effectivePrice = output > 0 ? output / trade_amount : null;
            customTradeImpact = {
              trade_amount,
              expected_output: output,
              effective_price: effectivePrice,
              price_impact_percent: basePrice && effectivePrice
                ? parseFloat((Math.abs(effectivePrice - basePrice) / basePrice * 100).toFixed(4))
                : null,
            };
          }
        }

        const data = {
          from_asset,
          to_asset,
          depth_levels: depthLevels,
          bid_ask_spread: bidAskSpread,
          price_impact_percent_large: priceImpactPercent,
          custom_trade_impact: customTradeImpact,
          liquidity_rating: priceImpactPercent == null ? null :
            priceImpactPercent < 0.5 ? "high" : priceImpactPercent < 2 ? "medium" : "low",
          fetched_at: Date.now(),
        };

        sdk.storage.set(cacheKey, data, { ttl: 30_000 });
        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_order_book_depth failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Scheduled Trading Features ─────────────────────────────────────────────

  // ── Tool 31: ton_trading_create_schedule ───────────────────────────────────
  {
    name: "ton_trading_create_schedule",
    description:
      "Create a recurring trading schedule for strategies like dollar-cost averaging (DCA) or grid trading. Stores multiple pending trades at calculated intervals. Use ton_trading_get_scheduled_trades to check and execute due trades.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          description: 'Schedule strategy: "dca" (dollar-cost averaging at regular intervals) or "grid" (trades at price levels)',
          enum: ["dca", "grid"],
        },
        from_asset: {
          type: "string",
          description: 'Asset to sell — "TON" or a jetton master address',
        },
        to_asset: {
          type: "string",
          description: 'Asset to buy — "TON" or a jetton master address',
        },
        amount_per_trade: {
          type: "number",
          description: "Amount per individual trade execution",
          minimum: 0.001,
        },
        mode: {
          type: "string",
          description: 'Trading mode: "real" or "simulation" (default "simulation")',
          enum: ["real", "simulation"],
        },
        interval_hours: {
          type: "number",
          description: 'For DCA strategy: hours between each trade (e.g. 24 for daily). Required for "dca" strategy.',
          minimum: 1,
        },
        num_orders: {
          type: "integer",
          description: "Number of orders to schedule (default 5)",
          minimum: 1,
          maximum: 100,
        },
        note: {
          type: "string",
          description: "Optional label for this schedule (e.g. 'Daily DCA into TON')",
        },
      },
      required: ["strategy", "from_asset", "to_asset", "amount_per_trade"],
    },
    execute: async (params, _context) => {
      const {
        strategy, from_asset, to_asset, amount_per_trade,
        mode = "simulation", interval_hours = 24, num_orders = 5, note,
      } = params;
      try {
        if (strategy === "dca" && !interval_hours) {
          return { success: false, error: 'interval_hours is required for "dca" strategy' };
        }

        const scheduledIds = [];
        const now = Date.now();

        for (let i = 0; i < num_orders; i++) {
          const executeAt = strategy === "dca"
            ? now + (i + 1) * interval_hours * 60 * 60 * 1000
            : now + (i + 1) * 3600 * 1000; // grid: 1h intervals by default

          const id = sdk.db
            .prepare(
              `INSERT INTO scheduled_trades (created_at, execute_at, mode, from_asset, to_asset, amount, note)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(now, executeAt, mode, from_asset, to_asset, amount_per_trade,
              note ? `[${strategy}] ${note}` : `[${strategy}] order ${i + 1}/${num_orders}`)
            .lastInsertRowid;

          scheduledIds.push({ order: i + 1, schedule_id: id, execute_at: executeAt });
        }

        sdk.log.info(`Scheduled ${num_orders} ${strategy} orders: ${from_asset} → ${to_asset}`);

        return {
          success: true,
          data: {
            strategy,
            mode,
            from_asset,
            to_asset,
            amount_per_trade,
            num_orders_created: scheduledIds.length,
            total_amount: parseFloat((amount_per_trade * num_orders).toFixed(4)),
            schedule: scheduledIds,
            note: `${num_orders} orders scheduled. Check and execute due ones with ton_trading_get_scheduled_trades.`,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_create_schedule failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 32: ton_trading_cancel_schedule ───────────────────────────────────
  {
    name: "ton_trading_cancel_schedule",
    description:
      "Cancel one or more scheduled (pending) trades. Can cancel a single trade by ID, or all pending trades for a given asset pair. Returns the number of trades cancelled.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        schedule_id: {
          type: "integer",
          description: "Specific scheduled trade ID to cancel. If omitted, cancel all matching pending trades.",
        },
        from_asset: {
          type: "string",
          description: "Cancel all pending trades selling this asset (used when schedule_id is omitted)",
        },
        to_asset: {
          type: "string",
          description: "Cancel all pending trades buying this asset (used when schedule_id is omitted)",
        },
      },
    },
    execute: async (params, _context) => {
      const { schedule_id, from_asset, to_asset } = params;
      try {
        let cancelledCount = 0;

        if (schedule_id != null) {
          const row = sdk.db.prepare("SELECT id, status FROM scheduled_trades WHERE id = ?").get(schedule_id);
          if (!row) return { success: false, error: `Scheduled trade ${schedule_id} not found` };
          if (row.status !== "pending") return { success: false, error: `Scheduled trade ${schedule_id} is not pending (status: ${row.status})` };

          sdk.db.prepare("UPDATE scheduled_trades SET status = 'cancelled' WHERE id = ?").run(schedule_id);
          cancelledCount = 1;
        } else if (from_asset || to_asset) {
          const conditions = ["status = 'pending'"];
          const args = [];
          if (from_asset) { conditions.push("from_asset = ?"); args.push(from_asset); }
          if (to_asset) { conditions.push("to_asset = ?"); args.push(to_asset); }

          const result = sdk.db
            .prepare(`UPDATE scheduled_trades SET status = 'cancelled' WHERE ${conditions.join(" AND ")}`)
            .run(...args);
          cancelledCount = result.changes;
        } else {
          return { success: false, error: "Provide either schedule_id or from_asset/to_asset to cancel" };
        }

        sdk.log.info(`Cancelled ${cancelledCount} scheduled trade(s)`);

        return {
          success: true,
          data: {
            cancelled_count: cancelledCount,
            schedule_id: schedule_id ?? null,
            from_asset: from_asset ?? null,
            to_asset: to_asset ?? null,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_cancel_schedule failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Performance Analytics ──────────────────────────────────────────────────

  // ── Tool 33: ton_trading_get_performance_dashboard ─────────────────────────
  {
    name: "ton_trading_get_performance_dashboard",
    description:
      "Get a real-time performance dashboard with key trading metrics: total P&L, win rate, best/worst trades, average holding time, and daily/weekly breakdown. Use for strategy optimization and monitoring.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Analyse "real", "simulation", or "all" trades (default "all")',
          enum: ["real", "simulation", "all"],
        },
        days: {
          type: "integer",
          description: "Number of days to include in the report (default 30)",
          minimum: 1,
          maximum: 365,
        },
      },
    },
    execute: async (params, _context) => {
      const { mode = "all", days = 30 } = params;
      try {
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        const modeClause = mode === "all" ? "" : "AND mode = ?";
        const modeArgs = mode === "all" ? [] : [mode];

        const trades = sdk.db
          .prepare(
            `SELECT * FROM trade_journal WHERE status = 'closed' AND timestamp >= ? ${modeClause} ORDER BY timestamp ASC`
          )
          .all(since, ...modeArgs);

        const openTrades = sdk.db
          .prepare(`SELECT COUNT(*) as count FROM trade_journal WHERE status = 'open' ${modeClause}`)
          .get(...modeArgs);

        if (trades.length === 0) {
          return {
            success: true,
            data: {
              mode, days,
              total_trades: 0,
              open_positions: openTrades?.count ?? 0,
              note: "No closed trades in the selected period",
            },
          };
        }

        const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
        const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
        const losses = trades.filter((t) => (t.pnl ?? 0) < 0);
        const winRate = trades.length > 0 ? wins.length / trades.length : 0;

        const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length : 0;

        const bestTrade = trades.reduce((best, t) => (t.pnl ?? 0) > (best.pnl ?? 0) ? t : best, trades[0]);
        const worstTrade = trades.reduce((worst, t) => (t.pnl ?? 0) < (worst.pnl ?? 0) ? t : worst, trades[0]);

        const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;

        // Daily P&L breakdown
        const dailyPnl = {};
        for (const t of trades) {
          const day = new Date(t.timestamp).toISOString().slice(0, 10);
          dailyPnl[day] = (dailyPnl[day] ?? 0) + (t.pnl ?? 0);
        }

        return {
          success: true,
          data: {
            mode,
            period_days: days,
            total_trades: trades.length,
            open_positions: openTrades?.count ?? 0,
            win_count: wins.length,
            loss_count: losses.length,
            win_rate: parseFloat(winRate.toFixed(4)),
            total_pnl_usd: parseFloat(totalPnl.toFixed(4)),
            avg_win_usd: parseFloat(avgWin.toFixed(4)),
            avg_loss_usd: parseFloat(avgLoss.toFixed(4)),
            profit_factor: profitFactor != null ? parseFloat(profitFactor.toFixed(2)) : null,
            best_trade: { trade_id: bestTrade.id, pnl: bestTrade.pnl, pnl_percent: bestTrade.pnl_percent },
            worst_trade: { trade_id: worstTrade.id, pnl: worstTrade.pnl, pnl_percent: worstTrade.pnl_percent },
            daily_pnl: Object.entries(dailyPnl).map(([date, pnl]) => ({ date, pnl: parseFloat(pnl.toFixed(4)) })),
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_get_performance_dashboard failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 34: ton_trading_export_trades ─────────────────────────────────────
  {
    name: "ton_trading_export_trades",
    description:
      "Export trade history from the journal in a structured format suitable for external analysis. Returns all trade records with full P&L data for the specified period and mode.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Export "real", "simulation", or "all" trades (default "all")',
          enum: ["real", "simulation", "all"],
        },
        status: {
          type: "string",
          description: 'Export "open", "closed", or "all" trades (default "all")',
          enum: ["open", "closed", "all"],
        },
        days: {
          type: "integer",
          description: "Limit to trades from the last N days. Omit for all history.",
          minimum: 1,
        },
        limit: {
          type: "integer",
          description: "Maximum number of records to return (default 200, max 1000)",
          minimum: 1,
          maximum: 1000,
        },
      },
    },
    execute: async (params, _context) => {
      const { mode = "all", status = "all", days, limit = 200 } = params;
      try {
        const conditions = [];
        const args = [];

        if (mode !== "all") { conditions.push("mode = ?"); args.push(mode); }
        if (status !== "all") { conditions.push("status = ?"); args.push(status); }
        if (days != null) {
          const since = Date.now() - days * 24 * 60 * 60 * 1000;
          conditions.push("timestamp >= ?");
          args.push(since);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const trades = sdk.db
          .prepare(`SELECT * FROM trade_journal ${where} ORDER BY timestamp DESC LIMIT ?`)
          .all(...args, limit);

        const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
        const closedTrades = trades.filter((t) => t.status === "closed");

        return {
          success: true,
          data: {
            filters: { mode, status, days: days ?? "all" },
            total_records: trades.length,
            total_pnl_usd: parseFloat(totalPnl.toFixed(4)),
            closed_count: closedTrades.length,
            open_count: trades.length - closedTrades.length,
            trades,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_export_trades failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Risk Management Enhancement ────────────────────────────────────────────

  // ── Tool 35: ton_trading_dynamic_stop_loss ─────────────────────────────────
  {
    name: "ton_trading_dynamic_stop_loss",
    description:
      "Calculate and register a volatility-adjusted stop-loss level for a trade. Uses Average True Range (ATR) to size the stop-loss proportional to recent market volatility, preventing premature stop-outs on volatile assets.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        trade_id: {
          type: "integer",
          description: "Journal trade ID to protect",
        },
        token_address: {
          type: "string",
          description: "Token address to fetch volatility data for",
        },
        entry_price: {
          type: "number",
          description: "Price at which the position was opened",
        },
        atr_multiplier: {
          type: "number",
          description: "Multiplier applied to ATR to set stop distance (default 2.0 — 2× ATR below entry)",
          minimum: 0.5,
          maximum: 10,
        },
        max_stop_loss_percent: {
          type: "number",
          description: "Maximum allowed stop-loss in percent, regardless of volatility (default 15)",
          minimum: 1,
          maximum: 99,
        },
        take_profit_atr_multiplier: {
          type: "number",
          description: "Optional: set take-profit at this many ATRs above entry (e.g. 3.0 for 3× ATR)",
          minimum: 0.5,
        },
      },
      required: ["trade_id", "token_address", "entry_price"],
    },
    execute: async (params, _context) => {
      const {
        trade_id, token_address, entry_price,
        atr_multiplier = 2.0, max_stop_loss_percent = 15,
        take_profit_atr_multiplier,
      } = params;
      try {
        const entry = sdk.db.prepare("SELECT id, status FROM trade_journal WHERE id = ?").get(trade_id);
        if (!entry) return { success: false, error: `Trade ${trade_id} not found` };
        if (entry.status === "closed") return { success: false, error: `Trade ${trade_id} is already closed` };

        // Fetch recent OHLCV data to calculate ATR
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${encodeURIComponent(token_address)}/ohlcv/hour?limit=20&currency=usd`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } }
        );

        let atr = entry_price * 0.03; // fallback: 3% of price
        let atrPercent = 3;

        if (res.ok) {
          const json = await res.json();
          const ohlcv = (json?.data?.attributes?.ohlcv_list ?? []).map(([, , h, l, c]) => ({
            high: parseFloat(h), low: parseFloat(l), close: parseFloat(c),
          }));

          if (ohlcv.length >= 2) {
            const trueRanges = ohlcv.slice(1).map((candle, i) => {
              const prevClose = ohlcv[i].close;
              return Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - prevClose),
                Math.abs(candle.low - prevClose)
              );
            });
            atr = trueRanges.reduce((s, r) => s + r, 0) / trueRanges.length;
            atrPercent = (atr / entry_price) * 100;
          }
        }

        // Clamp stop-loss to max_stop_loss_percent
        const dynamicStopPercent = Math.min(atrPercent * atr_multiplier, max_stop_loss_percent);
        const takeProfitPercent = take_profit_atr_multiplier != null
          ? atrPercent * take_profit_atr_multiplier
          : null;

        // Register the rule
        const ruleId = sdk.db
          .prepare(
            `INSERT INTO stop_loss_rules (trade_id, stop_loss_percent, take_profit_percent, entry_price, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(trade_id, dynamicStopPercent, takeProfitPercent ?? null, entry_price, Date.now())
          .lastInsertRowid;

        const stopLossPrice = entry_price * (1 - dynamicStopPercent / 100);
        const takeProfitPrice = takeProfitPercent != null ? entry_price * (1 + takeProfitPercent / 100) : null;

        sdk.log.info(`Dynamic stop-loss #${ruleId} set for trade #${trade_id}: ATR=${atr.toFixed(6)}, SL=${dynamicStopPercent.toFixed(2)}%`);

        return {
          success: true,
          data: {
            rule_id: ruleId,
            trade_id,
            entry_price,
            atr,
            atr_percent: parseFloat(atrPercent.toFixed(4)),
            atr_multiplier,
            dynamic_stop_loss_percent: parseFloat(dynamicStopPercent.toFixed(4)),
            stop_loss_price: parseFloat(stopLossPrice.toFixed(6)),
            take_profit_price: takeProfitPrice != null ? parseFloat(takeProfitPrice.toFixed(6)) : null,
            take_profit_percent: takeProfitPercent != null ? parseFloat(takeProfitPercent.toFixed(4)) : null,
            was_clamped: atrPercent * atr_multiplier > max_stop_loss_percent,
            status: "active",
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_dynamic_stop_loss failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 36: ton_trading_position_sizing ───────────────────────────────────
  {
    name: "ton_trading_position_sizing",
    description:
      "Calculate the optimal position size for a trade based on current portfolio volatility. Combines Kelly Criterion with volatility-scaled risk limits to recommend a position size that preserves capital under adverse conditions.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: 'Use "real" or "simulation" balance (default "simulation")',
          enum: ["real", "simulation"],
        },
        token_address: {
          type: "string",
          description: "Token address to fetch volatility data for position sizing",
        },
        risk_per_trade_percent: {
          type: "number",
          description: "Maximum portfolio percentage to risk on this single trade (default 2%)",
          minimum: 0.1,
          maximum: 20,
        },
        stop_loss_percent: {
          type: "number",
          description: "Planned stop-loss percentage for this trade (used for position sizing)",
          minimum: 0.1,
          maximum: 99,
        },
        conviction_level: {
          type: "string",
          description: 'Trade conviction: "low" (0.5× sizing), "medium" (1×), "high" (1.5×). Default "medium".',
          enum: ["low", "medium", "high"],
        },
      },
      required: ["token_address", "stop_loss_percent"],
    },
    execute: async (params, _context) => {
      const {
        mode = "simulation", token_address, risk_per_trade_percent = 2,
        stop_loss_percent, conviction_level = "medium",
      } = params;
      try {
        const balance = mode === "simulation"
          ? getSimBalance(sdk)
          : parseFloat((await sdk.ton.getBalance())?.balance ?? "0");

        // Fetch recent volatility data
        let volatilityPercent = stop_loss_percent; // fallback: use stop-loss as proxy
        try {
          const res = await fetch(
            `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${encodeURIComponent(token_address)}/ohlcv/hour?limit=24&currency=usd`,
            { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } }
          );
          if (res.ok) {
            const json = await res.json();
            const closes = (json?.data?.attributes?.ohlcv_list ?? []).map(([, , , , c]) => parseFloat(c));
            if (closes.length >= 5) {
              const returns = closes.slice(1).map((c, i) => Math.abs(c - closes[i]) / closes[i] * 100);
              volatilityPercent = returns.reduce((s, r) => s + r, 0) / returns.length;
            }
          }
        } catch {
          // use fallback
        }

        // Base position size: risk% of balance / stop-loss%
        const convictionMultiplier = { low: 0.5, medium: 1.0, high: 1.5 }[conviction_level] ?? 1.0;
        const baseSize = balance * (risk_per_trade_percent / 100) / (stop_loss_percent / 100);
        const volatilityAdjustedSize = baseSize * Math.min(1, stop_loss_percent / (volatilityPercent * 2 || stop_loss_percent));
        const finalSize = parseFloat((volatilityAdjustedSize * convictionMultiplier).toFixed(4));
        const maxSize = balance * 0.25; // hard cap at 25% of balance

        // Historical trade win rate
        const historicalTrades = sdk.db
          .prepare("SELECT pnl_percent FROM trade_journal WHERE status = 'closed' AND mode = ? LIMIT 50")
          .all(mode);
        const winRate = historicalTrades.length > 0
          ? historicalTrades.filter((t) => (t.pnl_percent ?? 0) > 0).length / historicalTrades.length
          : 0.5;

        return {
          success: true,
          data: {
            mode,
            balance_ton: parseFloat(balance.toFixed(4)),
            token_address,
            risk_per_trade_percent,
            stop_loss_percent,
            volatility_percent_24h: parseFloat(volatilityPercent.toFixed(4)),
            conviction_level,
            conviction_multiplier: convictionMultiplier,
            historical_win_rate: parseFloat(winRate.toFixed(4)),
            base_position_size_ton: parseFloat(baseSize.toFixed(4)),
            volatility_adjusted_size_ton: parseFloat(volatilityAdjustedSize.toFixed(4)),
            recommended_position_size_ton: Math.min(finalSize, maxSize),
            hard_cap_ton: parseFloat(maxSize.toFixed(4)),
            recommendation: finalSize > maxSize
              ? `Position capped at ${maxSize.toFixed(2)} TON (25% balance limit). Consider reducing conviction or risk%.`
              : `Recommended position: ${finalSize.toFixed(2)} TON (${(finalSize / balance * 100).toFixed(1)}% of balance)`,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_position_sizing failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Multi-DEX Coordination ─────────────────────────────────────────────────

  // ── Tool 37: ton_trading_cross_dex_routing ─────────────────────────────────
  {
    name: "ton_trading_cross_dex_routing",
    description:
      "Find the optimal execution path across multiple DEXes for a token swap. Analyses split routing (partial fill on multiple DEXes) to minimise price impact and maximise output. Returns a routing plan for the LLM to execute.",
    category: "data-bearing",
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
          type: "number",
          description: "Total amount to swap in from_asset units",
        },
        max_splits: {
          type: "integer",
          description: "Maximum number of DEXes to split the trade across (default 2)",
          minimum: 1,
          maximum: 3,
        },
      },
      required: ["from_asset", "to_asset", "amount"],
    },
    execute: async (params, _context) => {
      const { from_asset, to_asset, amount, max_splits = 2 } = params;
      try {
        const dexList = ["stonfi", "dedust"];
        const quoteParams = { fromAsset: from_asset, toAsset: to_asset, amount };

        const [stonfiQuote, dedustQuote] = await Promise.all([
          sdk.ton.dex.quoteSTONfi(quoteParams).catch(() => null),
          sdk.ton.dex.quoteDeDust(quoteParams).catch(() => null),
        ]);

        const dexQuotes = [];
        if (stonfiQuote) dexQuotes.push({ dex: "stonfi", output: parseFloat(stonfiQuote.output ?? stonfiQuote.price ?? 0), fee: 0.003 });
        if (dedustQuote) dexQuotes.push({ dex: "dedust", output: parseFloat(dedustQuote.output ?? dedustQuote.price ?? 0), fee: 0.003 });

        if (dexQuotes.length === 0) {
          return { success: false, error: "No DEX quotes available for routing" };
        }

        // Sort by output descending to find best single-DEX route
        dexQuotes.sort((a, b) => b.output - a.output);
        const bestSingleDex = dexQuotes[0];

        // Try 50/50 split if multiple DEXes available
        let bestRoute = {
          type: "single",
          dex: bestSingleDex.dex,
          total_output: bestSingleDex.output,
          splits: [{ dex: bestSingleDex.dex, amount_in: amount, expected_output: bestSingleDex.output, percent: 100 }],
        };

        if (dexQuotes.length >= 2 && max_splits >= 2) {
          // Calculate split quotes at half the amount
          const halfAmount = amount / 2;
          const [stonfiHalf, dedustHalf] = await Promise.all([
            sdk.ton.dex.quoteSTONfi({ ...quoteParams, amount: halfAmount }).catch(() => null),
            sdk.ton.dex.quoteDeDust({ ...quoteParams, amount: halfAmount }).catch(() => null),
          ]);

          if (stonfiHalf && dedustHalf) {
            const splitOutput = parseFloat(stonfiHalf.output ?? stonfiHalf.price ?? 0) +
              parseFloat(dedustHalf.output ?? dedustHalf.price ?? 0);

            if (splitOutput > bestSingleDex.output * 1.001) { // only split if >0.1% better
              bestRoute = {
                type: "split",
                total_output: splitOutput,
                improvement_percent: parseFloat(((splitOutput - bestSingleDex.output) / bestSingleDex.output * 100).toFixed(4)),
                splits: [
                  { dex: "stonfi", amount_in: halfAmount, expected_output: parseFloat(stonfiHalf.output ?? stonfiHalf.price ?? 0), percent: 50 },
                  { dex: "dedust", amount_in: halfAmount, expected_output: parseFloat(dedustHalf.output ?? dedustHalf.price ?? 0), percent: 50 },
                ],
              };
            }
          }
        }

        const savings = bestRoute.total_output - dexQuotes[dexQuotes.length - 1]?.output;

        return {
          success: true,
          data: {
            from_asset,
            to_asset,
            amount_in: amount,
            best_route: bestRoute,
            all_dex_quotes: dexQuotes,
            savings_vs_worst: parseFloat(savings.toFixed(6)),
            execution_note: bestRoute.type === "split"
              ? `Split route: execute ${bestRoute.splits.map((s) => `${s.amount_in} on ${s.dex}`).join(" and ")} for best output`
              : `Single-DEX route on ${bestRoute.dex} is optimal`,
          },
        };
      } catch (err) {
        sdk.log.error(`ton_trading_cross_dex_routing failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 38: ton_trading_get_best_price ────────────────────────────────────
  {
    name: "ton_trading_get_best_price",
    description:
      "Compare prices across STON.fi, DeDust, and TONCO to find the best execution price for a swap. Returns ranked results with estimated output, slippage, and fees for each DEX. Use before any trade to ensure best execution.",
    category: "data-bearing",
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
          description: 'Amount to quote in from_asset units (e.g. "1" for 1 TON)',
        },
      },
      required: ["from_asset", "to_asset", "amount"],
    },
    execute: async (params, _context) => {
      const { from_asset, to_asset, amount } = params;
      try {
        const cacheKey = `bestprice:${from_asset}:${to_asset}:${amount}`;
        const cached = sdk.storage.get(cacheKey);
        if (cached) return { success: true, data: cached };

        const amountNum = parseFloat(amount);
        const quoteParams = { fromAsset: from_asset, toAsset: to_asset, amount: amountNum };

        const dexFees = { stonfi: 0.003, dedust: 0.003, tonco: 0.003 };

        const [stonfiQuote, dedustQuote, toncoQuote] = await Promise.all([
          sdk.ton.dex.quoteSTONfi(quoteParams).catch((err) => {
            sdk.log.warn(`StonFi quote failed: ${err.message}`);
            return null;
          }),
          sdk.ton.dex.quoteDeDust(quoteParams).catch((err) => {
            sdk.log.warn(`DeDust quote failed: ${err.message}`);
            return null;
          }),
          sdk.ton.dex.quoteTONCO
            ? sdk.ton.dex.quoteTONCO(quoteParams).catch((err) => {
                sdk.log.warn(`TONCO quote failed: ${err.message}`);
                return null;
              })
            : Promise.resolve(null),
        ]);

        const results = [];

        if (stonfiQuote) {
          const output = parseFloat(stonfiQuote.output ?? stonfiQuote.price ?? 0);
          const fee = amountNum * dexFees.stonfi;
          results.push({
            dex: "stonfi",
            output_amount: output,
            effective_price: output > 0 ? output / amountNum : null,
            fee_amount: fee,
            output_after_fee: output * (1 - dexFees.stonfi),
          });
        }

        if (dedustQuote) {
          const output = parseFloat(dedustQuote.output ?? dedustQuote.price ?? 0);
          const fee = amountNum * dexFees.dedust;
          results.push({
            dex: "dedust",
            output_amount: output,
            effective_price: output > 0 ? output / amountNum : null,
            fee_amount: fee,
            output_after_fee: output * (1 - dexFees.dedust),
          });
        }

        if (toncoQuote) {
          const output = parseFloat(toncoQuote.output ?? toncoQuote.price ?? 0);
          const fee = amountNum * dexFees.tonco;
          results.push({
            dex: "tonco",
            output_amount: output,
            effective_price: output > 0 ? output / amountNum : null,
            fee_amount: fee,
            output_after_fee: output * (1 - dexFees.tonco),
          });
        }

        if (results.length === 0) {
          return { success: false, error: "No DEX prices available" };
        }

        results.sort((a, b) => (b.output_after_fee ?? 0) - (a.output_after_fee ?? 0));
        const best = results[0];
        const worst = results[results.length - 1];
        const savingsPercent = worst.output_after_fee > 0
          ? ((best.output_after_fee - worst.output_after_fee) / worst.output_after_fee) * 100
          : 0;

        const data = {
          from_asset,
          to_asset,
          amount_in: amount,
          best_dex: best.dex,
          best_output: parseFloat((best.output_after_fee ?? 0).toFixed(6)),
          savings_vs_worst_percent: parseFloat(savingsPercent.toFixed(4)),
          dex_comparison: results.map((r) => ({
            dex: r.dex,
            output_amount: parseFloat((r.output_amount ?? 0).toFixed(6)),
            output_after_fee: parseFloat((r.output_after_fee ?? 0).toFixed(6)),
            effective_price: r.effective_price != null ? parseFloat(r.effective_price.toFixed(6)) : null,
            fee_amount: parseFloat(r.fee_amount.toFixed(6)),
          })),
          fetched_at: Date.now(),
        };

        sdk.storage.set(cacheKey, data, { ttl: 30_000 });
        return { success: true, data };
      } catch (err) {
        sdk.log.error(`ton_trading_get_best_price failed: ${err.message}`);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },
];
