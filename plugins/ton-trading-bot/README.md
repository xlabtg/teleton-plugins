# TON Trading Bot

Atomic tools for trading on the TON blockchain. The LLM composes these tools into trading strategies — the plugin provides the primitives, not the logic.

**WARNING: Cryptocurrency trading involves significant financial risk. Do not trade with funds you cannot afford to lose. This plugin does not provide financial advice.**

## Architecture

This plugin follows the Teleton tool-provider pattern:

- **Plugin = atomic tools** (fetch data, validate, simulate, execute)
- **Agent = strategy** (when to buy, when to sell, how much)

Each tool does exactly one thing. The LLM composes them:

```
 1. ton_trading_get_market_data              → see current prices and DEX quotes
 2. ton_trading_get_portfolio                → see wallet balance and open positions
 3. ton_trading_validate_trade               → check risk before acting
 4. ton_trading_simulate_trade               → paper-trade without real funds
 5. ton_trading_execute_swap                 → execute a real DEX swap (DM-only)
 6. ton_trading_record_trade                 → close a trade and log PnL
 7. ton_trading_get_arbitrage_opportunities  → find cross-DEX price differences
 8. ton_trading_get_token_listings           → fetch recently listed tokens for sniping
 9. ton_trading_get_token_info               → detailed token price, market cap, holders
10. ton_trading_validate_token               → safety-check a token before sniping
11. ton_trading_get_top_traders              → find top-performing wallets for copy trading
12. ton_trading_get_trader_performance       → analyse on-chain performance of a wallet
13. ton_trading_get_active_pools             → list active liquidity pools by volume
14. ton_trading_get_farms_with_apy           → list yield farming opportunities with APY
15. ton_trading_get_pool_volume              → detailed volume stats for a specific pool
16. ton_trading_backtest                     → replay a strategy against trade history
17. ton_trading_calculate_risk_metrics       → VaR, drawdown, Sharpe, win/loss stats
18. ton_trading_set_stop_loss                → register stop-loss and take-profit rules
19. ton_trading_check_stop_loss              → query active rules and detect triggered ones
20. ton_trading_get_optimal_position_size    → Kelly Criterion and fixed-fraction sizing
21. ton_trading_schedule_trade               → store a pending trade for future execution
22. ton_trading_get_scheduled_trades         → list pending scheduled trades
```

## Tools

| Tool | Description | Category |
|------|-------------|----------|
| `ton_trading_get_market_data` | Fetch TON price and DEX swap quotes for a pair | data-bearing |
| `ton_trading_get_portfolio` | Wallet balance, jetton holdings, trade history | data-bearing |
| `ton_trading_validate_trade` | Check balance and risk limits before a trade | data-bearing |
| `ton_trading_simulate_trade` | Paper-trade using virtual balance (no real funds) | action |
| `ton_trading_execute_swap` | Execute a real swap on STON.fi or DeDust (DM-only) | action |
| `ton_trading_record_trade` | Close a trade and record final output / PnL | action |
| `ton_trading_get_arbitrage_opportunities` | Find cross-DEX price differences for a token pair | data-bearing |
| `ton_trading_get_token_listings` | Fetch recently listed tokens on TON DEXes for sniping | data-bearing |
| `ton_trading_get_token_info` | Detailed token info: price, market cap, holders, volume | data-bearing |
| `ton_trading_validate_token` | Safety-check a token: liquidity, volume, rug-pull signals | data-bearing |
| `ton_trading_get_top_traders` | Find top-performing trader wallets ranked by win rate | data-bearing |
| `ton_trading_get_trader_performance` | Analyse on-chain trading performance of a wallet | data-bearing |
| `ton_trading_get_active_pools` | List active liquidity pools sorted by 24-h volume | data-bearing |
| `ton_trading_get_farms_with_apy` | List yield farming opportunities with estimated APY | data-bearing |
| `ton_trading_get_pool_volume` | Detailed volume statistics for a specific pool | data-bearing |
| `ton_trading_backtest` | Replay a strategy against trade journal history | data-bearing |
| `ton_trading_calculate_risk_metrics` | VaR, max drawdown, Sharpe ratio, win/loss stats | data-bearing |
| `ton_trading_set_stop_loss` | Register a stop-loss and optional take-profit rule | action |
| `ton_trading_check_stop_loss` | Query active stop-loss rules and detect triggered ones | data-bearing |
| `ton_trading_get_optimal_position_size` | Kelly Criterion and fixed-fraction position sizing | data-bearing |
| `ton_trading_schedule_trade` | Store a pending trade for future execution | action |
| `ton_trading_get_scheduled_trades` | List pending scheduled trades and flag due ones | data-bearing |

## Install

```bash
mkdir -p ~/.teleton/plugins
cp -r plugins/ton-trading-bot ~/.teleton/plugins/
```

Restart Teleton — the plugin is auto-loaded from `~/.teleton/plugins/`.

## Configuration

```yaml
# ~/.teleton/config.yaml
plugins:
  ton_trading_bot:
    maxTradePercent: 10        # max single trade as % of balance (default: 10)
    minBalanceTON: 1           # minimum TON to keep (default: 1)
    defaultSlippage: 0.05      # DEX slippage tolerance (default: 5%)
    simulationBalance: 1000    # starting virtual balance (default: 1000 TON)
```

## Usage

- "Get market data for swapping 1 TON to USDT"
- "Show my portfolio"
- "Validate trading 5 TON in simulation mode"
- "Simulate buying USDT with 5 TON"
- "Execute swap: 2 TON → USDT with 5% slippage"
- "Record trade #3 closed at 2.1 USDT"

### Paper-trade workflow

```
1. Get market data for TON → USDT
2. Validate trading 5 TON in simulation mode
3. Simulate buying USDT with 5 TON
4. [later] Record the simulated trade closed at price X
```

### Real swap workflow (DM only)

```
1. Get portfolio overview
2. Get market data for TON → USDT pair
3. Validate trading 2 TON in real mode
4. Execute swap: 2 TON → USDT with 5% slippage
5. [later] Record trade closed
```

## Schemas

### `ton_trading_get_market_data`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from_asset` | string | Yes | — | Asset to swap from ("TON" or jetton address) |
| `to_asset` | string | Yes | — | Asset to swap to ("TON" or jetton address) |
| `amount` | string | Yes | — | Amount of from_asset to quote |

### `ton_trading_get_portfolio`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `history_limit` | integer | No | 10 | Number of recent trades to include (1–50) |

### `ton_trading_validate_trade`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | string | Yes | — | "real" or "simulation" |
| `amount_ton` | number | Yes | — | Amount of TON being traded |

### `ton_trading_simulate_trade`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from_asset` | string | Yes | — | Asset being sold |
| `to_asset` | string | Yes | — | Asset being bought |
| `amount_in` | number | Yes | — | Amount of from_asset to trade |
| `expected_amount_out` | number | Yes | — | Expected output amount |
| `note` | string | No | — | Optional note for the trade |

### `ton_trading_execute_swap`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from_asset` | string | Yes | — | Asset to sell |
| `to_asset` | string | Yes | — | Asset to buy |
| `amount` | string | Yes | — | Amount to sell |
| `slippage` | number | No | 0.05 | Slippage tolerance (0.001–0.5) |
| `dex` | string | No | auto | "stonfi" or "dedust" |

### `ton_trading_record_trade`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `trade_id` | integer | Yes | — | Journal trade ID |
| `amount_out` | number | Yes | — | Actual amount received |
| `note` | string | No | — | Optional note (e.g. exit reason) |

## Risk Management

Risk parameters are enforced by `ton_trading_validate_trade` before any trade:

- **maxTradePercent** (default 10%) — no single trade can exceed this percentage of the balance
- **minBalanceTON** (default 1 TON) — trading blocked if balance falls below this floor
- **scope: dm-only** on `ton_trading_execute_swap` — real trades only in direct messages

The LLM reads the validation result and decides whether to proceed.

## Database Tables

- `trade_journal` — every executed and simulated trade with PnL
- `sim_balance` — virtual balance history for paper trading

## Legal Disclaimer

**THIS PLUGIN IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. THE DEVELOPERS DO NOT PROVIDE FINANCIAL ADVICE. CRYPTOCURRENCY TRADING IS HIGHLY VOLATILE AND RISKY. YOU ARE RESPONSIBLE FOR YOUR OWN FINANCIAL DECISIONS. USE THIS TOOL AT YOUR OWN RISK.**

---

**Developer:** [xlabtg](https://github.com/xlabtg)
