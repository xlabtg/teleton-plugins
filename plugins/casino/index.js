/**
 * Teleton Casino Plugin — Slot machine and dice games with TON payments
 *
 * Uses Plugin SDK exclusively:
 * - sdk.ton.getAddress(), getBalance(), verifyPayment(), sendTON()
 * - sdk.telegram.sendDice()
 * - sdk.db for player stats and journal
 */

// ─── Manifest ────────────────────────────────────────────────────────

export const manifest = {
  name: "casino",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Slot machine and dice games with TON payments and auto-payout",
  defaultConfig: {
    min_bet: 0.1,
    max_bet_percent: 5,
    min_bankroll: 10,
    max_payment_age_minutes: 10,
    tx_retention_days: 30,
  },
};

// ─── Database Migration ──────────────────────────────────────────────

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS casino_users (
      telegram_id TEXT PRIMARY KEY,
      wallet_address TEXT,
      total_bets INTEGER NOT NULL DEFAULT 0,
      total_wagered REAL NOT NULL DEFAULT 0,
      total_wins INTEGER NOT NULL DEFAULT 0,
      total_losses INTEGER NOT NULL DEFAULT 0,
      total_won REAL NOT NULL DEFAULT 0,
      last_bet_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS used_transactions (
      tx_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      game_type TEXT NOT NULL,
      used_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_used_tx_user ON used_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_used_tx_used_at ON used_transactions(used_at);

    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
      type TEXT NOT NULL CHECK(type IN ('trade', 'gift', 'middleman', 'kol')),
      action TEXT NOT NULL,
      asset_from TEXT,
      asset_to TEXT,
      amount_from REAL,
      amount_to REAL,
      price_ton REAL,
      counterparty TEXT,
      platform TEXT,
      reasoning TEXT,
      outcome TEXT CHECK(outcome IN ('pending', 'profit', 'loss', 'neutral', 'cancelled')),
      pnl_ton REAL,
      pnl_pct REAL,
      tx_hash TEXT,
      tool_used TEXT,
      chat_id TEXT,
      user_id INTEGER,
      closed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_journal_type ON journal(type);
    CREATE INDEX IF NOT EXISTS idx_journal_timestamp ON journal(timestamp DESC);
  `);
}

// ─── Constants ───────────────────────────────────────────────────────

const SLOT = {
  topWin:    { range: [64, 64], multiplier: 5   },
  bigWin:    { range: [60, 63], multiplier: 2.5 },
  mediumWin: { range: [55, 59], multiplier: 1.8 },
  smallWin:  { range: [43, 54], multiplier: 1.2 },
};

const DICE = {
  topWin:   { value: 6, multiplier: 2.5 },
  bigWin:   { value: 5, multiplier: 1.8 },
  smallWin: { value: 4, multiplier: 1.3 },
};

// ─── Configuration ───────────────────────────────────────────────────

function buildConfig(pluginConfig) {
  return {
    minBet:               pluginConfig.min_bet ?? 0.1,
    maxBetPercent:        pluginConfig.max_bet_percent ?? 5,
    minBankroll:          pluginConfig.min_bankroll ?? 10,
    maxPaymentAgeMinutes: pluginConfig.max_payment_age_minutes ?? 10,
    txRetentionDays:      pluginConfig.tx_retention_days ?? 30,
  };
}

// ─── Multiplier & Interpretation ─────────────────────────────────────

function getSlotMultiplier(value) {
  if (value >= SLOT.topWin.range[0]    && value <= SLOT.topWin.range[1])    return SLOT.topWin.multiplier;
  if (value >= SLOT.bigWin.range[0]    && value <= SLOT.bigWin.range[1])    return SLOT.bigWin.multiplier;
  if (value >= SLOT.mediumWin.range[0] && value <= SLOT.mediumWin.range[1]) return SLOT.mediumWin.multiplier;
  if (value >= SLOT.smallWin.range[0]  && value <= SLOT.smallWin.range[1])  return SLOT.smallWin.multiplier;
  return 0;
}

function getDiceMultiplier(value) {
  if (value === DICE.topWin.value)   return DICE.topWin.multiplier;
  if (value === DICE.bigWin.value)   return DICE.bigWin.multiplier;
  if (value === DICE.smallWin.value) return DICE.smallWin.multiplier;
  return 0;
}

function getSlotInterpretation(value) {
  if (value >= SLOT.topWin.range[0]    && value <= SLOT.topWin.range[1])    return "🎰 777! Top win!";
  if (value >= SLOT.bigWin.range[0]    && value <= SLOT.bigWin.range[1])    return "🎊 Big win!";
  if (value >= SLOT.mediumWin.range[0] && value <= SLOT.mediumWin.range[1]) return "✨ Nice win!";
  if (value >= SLOT.smallWin.range[0]  && value <= SLOT.smallWin.range[1])  return "🎯 Small win!";
  return `Spin result: ${value}/64`;
}

function getDiceInterpretation(value) {
  if (value === DICE.topWin.value)   return "🎲 6! Top win!";
  if (value === DICE.bigWin.value)   return "🎊 Big win (5)!";
  if (value === DICE.smallWin.value) return "✨ Nice win (4)!";
  return `Dice: ${value}`;
}

function getWinMessage(multiplier, amount) {
  if (multiplier >= 5)   return `🎰 777! You won ${amount.toFixed(2)} TON (${multiplier}x)`;
  if (multiplier >= 2.5) return `🎊 Big win! You won ${amount.toFixed(2)} TON (${multiplier}x)`;
  if (multiplier >= 1.8) return `✨ Nice win! You won ${amount.toFixed(2)} TON (${multiplier}x)`;
  if (multiplier >= 1.2) return `🎯 Small win! You won ${amount.toFixed(2)} TON (${multiplier}x)`;
  return `You won ${amount.toFixed(2)} TON (${multiplier}x)`;
}

// ─── Game Engine ─────────────────────────────────────────────────────

async function executeGame(gameConfig, params, sdk, config, context) {
  try {
    const { chat_id, bet_amount, player_username, reply_to } = params;
    const userId = String(context.senderId);
    const username = (player_username ?? "").replace(/^@/, "").toLowerCase().trim();

    // 1. Validate username
    if (!username) {
      return {
        success: false,
        error: "❌ You need a Telegram @username to play. Set up your username in Telegram settings and try again!",
      };
    }

    // 2. Casino wallet & balance
    const casinoWallet = sdk.ton.getAddress();
    if (!casinoWallet) {
      return { success: false, error: "Casino wallet not initialized." };
    }

    // 3. Balance check
    const balanceInfo = await sdk.ton.getBalance(casinoWallet);
    if (!balanceInfo) {
      return { success: false, error: "Failed to check casino balance." };
    }

    const balance = parseFloat(balanceInfo.balance);

    if (isNaN(balance)) {
      return { success: false, error: "Failed to parse casino balance." };
    }

    if (balance < config.minBankroll) {
      return { success: false, error: "🚨 Casino is temporarily closed (insufficient bankroll)." };
    }

    // 4. Max bet
    const maxBetByPercent = balance * (config.maxBetPercent / 100);
    const maxBetByCoverage = balance / gameConfig.maxMultiplier;
    const maxBet = Math.min(maxBetByPercent, maxBetByCoverage);

    if (bet_amount > maxBet) {
      return {
        success: false,
        error: `❌ Bet too high. Maximum: ${maxBet.toFixed(2)} TON (balance: ${balance.toFixed(2)} TON)`,
      };
    }

    if (bet_amount < config.minBet) {
      return { success: false, error: `❌ Minimum bet is ${config.minBet} TON` };
    }

    // 5. Verify payment (via SDK)
    const payment = await sdk.ton.verifyPayment({
      amount: bet_amount,
      memo: username,
      gameType: gameConfig.gameType,
      maxAgeMinutes: config.maxPaymentAgeMinutes,
    });

    if (!payment.verified || !payment.playerWallet) {
      return {
        success: false,
        error: payment.error ?? `❌ Payment not found. Send ${bet_amount} TON to ${casinoWallet} with memo: ${username}`,
      };
    }

    // 6. Dice animation
    const diceResult = await sdk.telegram.sendDice(chat_id, gameConfig.emoticon, reply_to);
    const gameValue = diceResult.value;
    const messageId = diceResult.messageId;

    // 7. Calculate outcome
    const multiplier = gameConfig.getMultiplier(gameValue);
    const won = multiplier > 0;
    const payoutAmount = won ? bet_amount * multiplier : 0;

    // 8. Record bet (atomic)
    const recordBet = sdk.db.transaction(() => {
      sdk.db
        .prepare(
          `INSERT INTO casino_users (telegram_id, wallet_address, total_bets, total_wagered, last_bet_at)
           VALUES (?, ?, 1, ?, unixepoch())
           ON CONFLICT(telegram_id) DO UPDATE SET
             wallet_address = excluded.wallet_address,
             total_bets = total_bets + 1,
             total_wagered = total_wagered + ?,
             last_bet_at = unixepoch()`
        )
        .run(userId, payment.playerWallet, bet_amount, bet_amount);

      const entry = sdk.db
        .prepare(
          `INSERT INTO journal (
             type, action, asset_from, asset_to, amount_from,
             platform, reasoning, outcome, tx_hash, tool_used,
             chat_id, user_id, timestamp
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
        )
        .run(
          "trade",
          gameConfig.toolName,
          "TON",
          gameConfig.assetLabel,
          bet_amount,
          "telegram_casino",
          `${gameConfig.gameType} result: ${gameValue}/${gameConfig.maxValue}`,
          "pending",
          payment.compositeKey,
          gameConfig.toolName,
          chat_id,
          userId
        );

      return Number(entry.lastInsertRowid);
    });

    const journalId = recordBet();

    // 9. Auto-payout
    let payoutSent = false;
    let payoutTxRef;

    if (won && payoutAmount > 0) {
      try {
        const winMsg = getWinMessage(multiplier, payoutAmount);
        const payoutResult = await sdk.ton.sendTON(payment.playerWallet, payoutAmount, winMsg);
        payoutSent = true;
        payoutTxRef = payoutResult.txRef;

        // Record win (atomic)
        sdk.db.transaction(() => {
          sdk.db
            .prepare(
              `UPDATE journal SET outcome = 'loss', amount_to = ?, pnl_ton = ?, closed_at = unixepoch() WHERE id = ?`
            )
            .run(payoutAmount, -(payoutAmount - bet_amount), journalId);

          sdk.db
            .prepare(
              `UPDATE casino_users SET total_wins = total_wins + 1, total_won = total_won + ? WHERE telegram_id = ?`
            )
            .run(payoutAmount, userId);
        })();
      } catch (err) {
        // Payout failed — journal stays 'pending' for admin review
        sdk.log.error("Payout failed:", err);
      }
    }

    if (!won) {
      // Record loss (atomic)
      sdk.db.transaction(() => {
        sdk.db
          .prepare(
            `UPDATE journal SET outcome = 'profit', amount_to = 0, pnl_ton = ?, closed_at = unixepoch() WHERE id = ?`
          )
          .run(bet_amount, journalId);

        sdk.db
          .prepare(`UPDATE casino_users SET total_losses = total_losses + 1 WHERE telegram_id = ?`)
          .run(userId);
      })();
    }

    return {
      success: true,
      data: {
        game_value: gameValue,
        won,
        multiplier,
        payout_amount: payoutAmount > 0 ? payoutAmount.toFixed(2) : "0",
        payout_sent: payoutSent,
        payout_tx_ref: payoutTxRef,
        bet_amount: bet_amount.toFixed(2),
        player_username: username,
        player_wallet: payment.playerWallet,
        payment_key: payment.compositeKey,
        journal_id: journalId,
        message_id: messageId,
        interpretation: gameConfig.getInterpretation(gameValue),
      },
    };
  } catch (err) {
    return { success: false, error: String(err.message ?? err).slice(0, 500) };
  }
}

// ─── Tools ───────────────────────────────────────────────────────────

export const tools = (sdk) => {
  if (!sdk.db) {
    sdk.log.error("No database available — casino plugin requires migrate()");
    return [];
  }

  const config = buildConfig(sdk.pluginConfig);

  return [
    // ── casino_balance ─────────────────────────────────────────────
    {
      name: "casino_balance",
      description: `Check casino bankroll status and betting limits.

Returns: wallet address, balance, max bet (${config.maxBetPercent}% of bankroll), status, min bet (${config.minBet} TON).

IMPORTANT: When a player wants to bet, tell them to send TON to the casino address with their username as memo.
Example: "Send 2 TON to EQxxx with memo: john_doe"`,
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        try {
          const address = sdk.ton.getAddress();
          if (!address) {
            return { success: false, error: "Casino wallet not initialized." };
          }

          const balanceInfo = await sdk.ton.getBalance(address);
          if (!balanceInfo) {
            return { success: false, error: "Failed to fetch balance." };
          }

          const balance = parseFloat(balanceInfo.balance);

          if (isNaN(balance)) {
            return { success: false, error: "Failed to parse casino balance." };
          }

          let status, message, canAcceptBets;
          if (balance < config.minBankroll * 0.5) {
            status = "critical";
            message = `🚨 CRITICAL: Bankroll critically low (${balance.toFixed(2)} TON). Casino should be suspended.`;
            canAcceptBets = false;
          } else if (balance < config.minBankroll) {
            status = "warning";
            message = `⚠️ WARNING: Bankroll below minimum (${balance.toFixed(2)} TON). Refill recommended.`;
            canAcceptBets = false;
          } else {
            status = "ok";
            message = `✅ Casino bankroll is healthy (${balance.toFixed(2)} TON)`;
            canAcceptBets = true;
          }

          const maxMultiplier = SLOT.topWin.multiplier;
          const maxBetByPercent = balance * (config.maxBetPercent / 100);
          const maxBetByCoverage = balance / maxMultiplier;
          const maxBet = Math.min(maxBetByPercent, maxBetByCoverage);

          return {
            success: true,
            data: {
              address,
              balance: balance.toFixed(2),
              balanceNano: balanceInfo.balanceNano,
              status,
              canAcceptBets,
              minBet: String(config.minBet),
              maxBet: maxBet.toFixed(2),
              minBankroll: config.minBankroll,
              maxBetPercent: config.maxBetPercent,
              maxMultiplier,
              memoFormat: "{username}",
              message,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message ?? err).slice(0, 500) };
        }
      },
    },

    // ── casino_spin ────────────────────────────────────────────────
    {
      name: "casino_spin",
      description: `Execute a slot machine spin with full security checks.

Slot payout table:
- 🎰 64 (777) = 5x bet
- 🎰 60-63 = Big win (2.5x bet)
- 🎰 55-59 = Medium win (1.8x bet)
- 🎰 43-54 = Small win (1.2x bet)
- 🎰 1-42 = No win

Process: validates bet → verifies TON payment with username as memo → sends 🎰 animation → AUTO-PAYOUT if win.

Tell the user: "Send X TON to [casino_address] with memo: your_username"`,
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          chat_id:         { type: "string",  description: "Telegram chat ID where to send the spin" },
          bet_amount:      { type: "number",  description: "Bet amount in TON", minimum: 0.1 },
          player_username: { type: "string",  description: "Player's Telegram username (without @)" },
          reply_to:        { type: "integer", description: "Message ID to reply to" },
        },
        required: ["chat_id", "bet_amount", "player_username"],
      },
      execute: async (params, context) => {
        return executeGame(
          {
            emoticon: "🎰",
            gameType: "slot",
            toolName: "casino_spin",
            assetLabel: "SPIN",
            maxMultiplier: SLOT.topWin.multiplier,
            getMultiplier: getSlotMultiplier,
            getInterpretation: getSlotInterpretation,
            maxValue: 64,
          },
          params,
          sdk,
          config,
          context
        );
      },
    },

    // ── casino_dice ────────────────────────────────────────────────
    {
      name: "casino_dice",
      description: `Execute a dice roll with full security checks.

Dice payout table:
- 🎲 6 = Best roll (2.5x bet)
- 🎲 5 = Big win (1.8x bet)
- 🎲 4 = Small win (1.3x bet)
- 🎲 1-3 = No win

Same security as slots: validates bet → verifies TON payment → 🎲 animation → AUTO-PAYOUT.

Tell the user: "Send X TON to [casino_address] with memo: your_username"`,
      category: "action",
      scope: "admin-only",
      parameters: {
        type: "object",
        properties: {
          chat_id:         { type: "string",  description: "Telegram chat ID where to send the dice" },
          bet_amount:      { type: "number",  description: "Bet amount in TON", minimum: 0.1 },
          player_username: { type: "string",  description: "Player's Telegram username (without @)" },
          reply_to:        { type: "integer", description: "Message ID to reply to" },
        },
        required: ["chat_id", "bet_amount", "player_username"],
      },
      execute: async (params, context) => {
        return executeGame(
          {
            emoticon: "🎲",
            gameType: "dice",
            toolName: "casino_dice",
            assetLabel: "DICE",
            maxMultiplier: DICE.topWin.multiplier,
            getMultiplier: getDiceMultiplier,
            getInterpretation: getDiceInterpretation,
            maxValue: 6,
          },
          params,
          sdk,
          config,
          context
        );
      },
    },

    // ── casino_my_stats ────────────────────────────────────────────
    {
      name: "casino_my_stats",
      description: `Show the current player's personal casino statistics.

Returns: total bets, wins/losses, total wagered, total won, net P&L, win rate, last bet date.`,
      category: "data-bearing",
      scope: "always",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        try {
          const userId = String(context.senderId);

          const stats = sdk.db
            .prepare(
              `SELECT telegram_id, wallet_address, total_bets, total_wins, total_losses,
                      total_wagered, total_won, last_bet_at
               FROM casino_users WHERE telegram_id = ?`
            )
            .get(userId);

          if (!stats) {
            return {
              success: true,
              data: {
                has_played: false,
                message: "🎰 You haven't played at Teleton Casino yet! Make your first spin to get started.",
              },
            };
          }

          const netPnL = stats.total_won - stats.total_wagered;
          const winRate =
            stats.total_bets > 0
              ? ((stats.total_wins / stats.total_bets) * 100).toFixed(1)
              : "0";
          const lastPlay = stats.last_bet_at
            ? new Date(stats.last_bet_at * 1000).toLocaleDateString()
            : "Never";

          let emoji = "🎮";
          if (netPnL > 10)       emoji = "🤑";
          else if (netPnL > 0)   emoji = "😊";
          else if (netPnL < -10) emoji = "😢";
          else if (netPnL < 0)   emoji = "😐";

          return {
            success: true,
            data: {
              has_played: true,
              telegram_id: stats.telegram_id,
              wallet_address: stats.wallet_address,
              total_bets: stats.total_bets,
              total_wins: stats.total_wins,
              total_losses: stats.total_losses,
              total_wagered: stats.total_wagered.toFixed(2),
              total_won: stats.total_won.toFixed(2),
              net_pnl: netPnL.toFixed(2),
              net_pnl_positive: netPnL >= 0,
              win_rate: winRate,
              last_play: lastPlay,
              status_emoji: emoji,
              message: `${emoji} Teleton Casino Stats:
🎲 Total bets: ${stats.total_bets}
✅ Wins: ${stats.total_wins} | ❌ Losses: ${stats.total_losses}
📊 Win rate: ${winRate}%
💰 Wagered: ${stats.total_wagered.toFixed(2)} TON
🏆 Won: ${stats.total_won.toFixed(2)} TON
${netPnL >= 0 ? "📈" : "📉"} Net P&L: ${netPnL >= 0 ? "+" : ""}${netPnL.toFixed(2)} TON`,
            },
          };
        } catch (err) {
          return { success: false, error: String(err.message ?? err).slice(0, 500) };
        }
      },
    },
  ];
};
