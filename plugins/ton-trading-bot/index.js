/**
 * TON Trading Bot Plugin
 *
 * Granular, atomic tools for the LLM to compose trading workflows on TON:
 *   - ton_trading_get_market_data    — fetch current prices and DEX quotes
 *   - ton_trading_get_portfolio      — wallet balance, jetton holdings, trade history
 *   - ton_trading_validate_trade     — check risk parameters before acting
 *   - ton_trading_simulate_trade     — paper-trade without real money
 *   - ton_trading_execute_swap       — execute real swap on TON DEX (DM-only)
 *   - ton_trading_record_trade       — record a closed trade and update PnL
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
  description: "Atomic TON trading tools: market data, portfolio, risk validation, simulation, and DEX swap execution. The LLM composes these into trading strategies.",
  author: {
    name: "Tony (AI Agent)",
    role: "AI Developer",
    supervisor: "Anton Poroshin",
    link: "https://github.com/xlabtg",
  },
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
  `);
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
    execute: async (params, context) => {
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
    execute: async (params, context) => {
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
    execute: async (params, context) => {
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
      },
      required: ["from_asset", "to_asset", "amount_in", "expected_amount_out"],
    },
    execute: async (params, context) => {
      const { from_asset, to_asset, amount_in, expected_amount_out, note } = params;
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
             (timestamp, mode, action, from_asset, to_asset, amount_in, amount_out, status, note)
             VALUES (?, 'simulation', 'buy', ?, ?, ?, ?, 'open', ?)`
          )
          .run(Date.now(), from_asset, to_asset, amount_in, expected_amount_out, note ?? null)
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
             (timestamp, mode, action, from_asset, to_asset, amount_in, amount_out, status)
             VALUES (?, 'real', 'buy', ?, ?, ?, ?, 'open')`
          )
          .run(
            Date.now(),
            from_asset,
            to_asset,
            parseFloat(amount),
            result?.expectedOutput ? parseFloat(result.expectedOutput) : null
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
        note: {
          type: "string",
          description: "Optional note (e.g. exit reason)",
        },
      },
      required: ["trade_id", "amount_out"],
    },
    execute: async (params, context) => {
      const { trade_id, amount_out, note } = params;
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

        const pnl = amount_out - entry.amount_in;
        const pnlPercent =
          entry.amount_in > 0 ? (pnl / entry.amount_in) * 100 : 0;

        sdk.db
          .prepare(
            `UPDATE trade_journal
             SET amount_out = ?, pnl = ?, pnl_percent = ?, status = 'closed', note = COALESCE(?, note)
             WHERE id = ?`
          )
          .run(amount_out, pnl, pnlPercent, note ?? null, trade_id);

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
];
