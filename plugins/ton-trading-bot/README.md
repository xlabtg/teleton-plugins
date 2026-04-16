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
23. ton_trading_reset_simulation_balance     → reset virtual balance to starting amount
24. ton_trading_set_simulation_balance       → manually set the virtual balance
25. ton_trading_set_take_profit              → standalone take-profit with optional trailing stop
26. ton_trading_auto_execute                 → auto-execute trades when price triggers are met
27. ton_trading_get_portfolio_summary        → portfolio overview with unrealized P&L
28. ton_trading_rebalance_portfolio          → calculate rebalancing trades for target allocations
29. ton_trading_get_technical_indicators     → RSI, MACD, Bollinger Bands for a token
30. ton_trading_get_order_book_depth         → liquidity analysis and price impact
31. ton_trading_create_schedule              → create recurring DCA or grid trading schedule
32. ton_trading_cancel_schedule              → cancel one or more scheduled trades
33. ton_trading_get_performance_dashboard    → real-time P&L, win rate, daily breakdown
34. ton_trading_export_trades                → export trade history for external analysis
35. ton_trading_dynamic_stop_loss            → volatility-adjusted stop-loss using ATR
36. ton_trading_position_sizing              → optimal position size based on volatility
37. ton_trading_cross_dex_routing            → optimal split routing across multiple DEXes
38. ton_trading_get_best_price               → compare prices across STON.fi, DeDust, TONCO
39. ton_trading_get_open_positions           → list open real or simulation positions
40. ton_trading_close_position               → close one open position by trade ID
41. ton_trading_close_all_positions          → close all open positions for a mode
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
| `ton_trading_get_open_positions` | List open real or simulation positions | data-bearing |
| `ton_trading_close_position` | Close one open position by trade ID | action |
| `ton_trading_close_all_positions` | Close all open positions for a selected mode | action |
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
| `ton_trading_reset_simulation_balance` | Reset the simulation balance to a starting amount | action |
| `ton_trading_set_simulation_balance` | Manually set the simulation balance | action |
| `ton_trading_set_take_profit` | Register standalone take-profit rule with optional trailing stop | action |
| `ton_trading_auto_execute` | Auto-execute trades when price trigger conditions are met | action |
| `ton_trading_get_portfolio_summary` | Comprehensive portfolio overview with unrealized P&L | data-bearing |
| `ton_trading_rebalance_portfolio` | Calculate trades needed to hit target allocations | data-bearing |
| `ton_trading_get_technical_indicators` | RSI, MACD, Bollinger Bands for a TON token pair | data-bearing |
| `ton_trading_get_order_book_depth` | Order book depth, liquidity, and price impact analysis | data-bearing |
| `ton_trading_create_schedule` | Create recurring DCA or grid trading schedule | action |
| `ton_trading_cancel_schedule` | Cancel one or more scheduled (pending) trades | action |
| `ton_trading_get_performance_dashboard` | Real-time P&L, win rate, and daily trade breakdown | data-bearing |
| `ton_trading_export_trades` | Export trade history in structured format | data-bearing |
| `ton_trading_dynamic_stop_loss` | Volatility-adjusted stop-loss using Average True Range | action |
| `ton_trading_position_sizing` | Optimal position size based on volatility and conviction | data-bearing |
| `ton_trading_cross_dex_routing` | Optimal split-routing plan across multiple DEXes | data-bearing |
| `ton_trading_get_best_price` | Compare prices across STON.fi, DeDust, TONCO | data-bearing |

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
- "Show open simulation positions"
- "Close simulation position #7"
- "Close all open simulation positions"

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

### `ton_trading_get_open_positions`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | string | No | all | "real", "simulation", or "all" |
| `limit` | integer | No | 50 | Max open positions to return (1–100) |

### `ton_trading_close_position`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `trade_id` | integer | Yes | — | Open journal trade ID to close |
| `mode` | string | Yes | — | "real" or "simulation"; must match the trade |
| `amount` | number | No | trade amount_out | Override amount of acquired asset to sell |
| `slippage` | number | No | config default | Slippage for real reverse swap |
| `dex` | string | No | auto | "stonfi" or "dedust" |
| `exit_price_usd` | number | No | TON price when available | USD price of original from_asset at close |
| `note` | string | No | — | Optional close note |

### `ton_trading_close_all_positions`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | string | Yes | — | "real" or "simulation" |
| `slippage` | number | No | config default | Slippage for real reverse swaps |
| `dex` | string | No | auto | "stonfi" or "dedust" |
| `exit_price_usd` | number | No | TON price when available | USD price applied to all closed positions |
| `note` | string | No | — | Optional close note |

### `ton_trading_set_take_profit`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `trade_id` | integer | Yes | — | Journal trade ID to protect |
| `entry_price` | number | Yes | — | Price at which position was opened |
| `take_profit_percent` | number | Yes | — | Profit % that triggers exit (e.g. 10 = +10%) |
| `trailing_stop` | boolean | No | false | Enable trailing stop that locks in profits |
| `trailing_stop_percent` | number | No | tp/2 | Trailing offset below peak price in % |

### `ton_trading_auto_execute`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from_asset` | string | Yes | — | Asset to sell |
| `to_asset` | string | Yes | — | Asset to buy |
| `amount` | number | Yes | — | Amount to trade when conditions are met |
| `mode` | string | No | simulation | "real" or "simulation" |
| `trigger_price_below` | number | No | — | Execute when price falls below this value |
| `trigger_price_above` | number | No | — | Execute when price rises above this value |
| `auto_close_at_profit_percent` | number | No | — | Auto-register take-profit rule after execution |
| `auto_stop_loss_percent` | number | No | — | Auto-register stop-loss rule after execution |

### `ton_trading_get_portfolio_summary`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | string | No | all | "real", "simulation", or "all" |

### `ton_trading_rebalance_portfolio`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `target_allocations` | array | Yes | — | Array of `{asset, percent}` objects summing to 100 |
| `mode` | string | No | real | "real" or "simulation" |

### `ton_trading_get_technical_indicators`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token_address` | string | Yes | — | Token address or "TON" |
| `timeframe` | string | No | 1h | "1h", "4h", or "1d" |
| `periods` | integer | No | 14 | Candles for RSI calculation (5–100) |

### `ton_trading_get_order_book_depth`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from_asset` | string | Yes | — | Asset to sell |
| `to_asset` | string | Yes | — | Asset to buy |
| `trade_amount` | number | No | — | Trade size to estimate price impact for |

### `ton_trading_create_schedule`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `strategy` | string | Yes | — | "dca" or "grid" |
| `from_asset` | string | Yes | — | Asset to sell |
| `to_asset` | string | Yes | — | Asset to buy |
| `amount_per_trade` | number | Yes | — | Amount per individual order |
| `mode` | string | No | simulation | "real" or "simulation" |
| `interval_hours` | number | No | 24 | Hours between DCA orders |
| `num_orders` | integer | No | 5 | Number of orders to schedule |

### `ton_trading_cancel_schedule`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `schedule_id` | integer | No | — | Specific schedule ID to cancel |
| `from_asset` | string | No | — | Cancel all pending trades for this from_asset |
| `to_asset` | string | No | — | Cancel all pending trades for this to_asset |

### `ton_trading_get_performance_dashboard`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | string | No | all | "real", "simulation", or "all" |
| `days` | integer | No | 30 | Days to include in the report (1–365) |

### `ton_trading_export_trades`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | string | No | all | "real", "simulation", or "all" |
| `status` | string | No | all | "open", "closed", or "all" |
| `days` | integer | No | — | Limit to last N days |
| `limit` | integer | No | 200 | Max records (1–1000) |

### `ton_trading_dynamic_stop_loss`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `trade_id` | integer | Yes | — | Journal trade ID to protect |
| `token_address` | string | Yes | — | Token address for volatility data |
| `entry_price` | number | Yes | — | Price at which position was opened |
| `atr_multiplier` | number | No | 2.0 | Multiplier applied to ATR for stop distance |
| `max_stop_loss_percent` | number | No | 15 | Maximum stop-loss regardless of volatility |
| `take_profit_atr_multiplier` | number | No | — | Optional take-profit at N× ATR above entry |

### `ton_trading_position_sizing`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token_address` | string | Yes | — | Token address for volatility data |
| `stop_loss_percent` | number | Yes | — | Planned stop-loss for this trade |
| `mode` | string | No | simulation | "real" or "simulation" |
| `risk_per_trade_percent` | number | No | 2 | Max portfolio % to risk per trade |
| `conviction_level` | string | No | medium | "low" (0.5×), "medium" (1×), or "high" (1.5×) |

### `ton_trading_cross_dex_routing`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from_asset` | string | Yes | — | Asset to sell |
| `to_asset` | string | Yes | — | Asset to buy |
| `amount` | number | Yes | — | Total amount to swap |
| `max_splits` | integer | No | 2 | Maximum DEXes to split across (1–3) |

### `ton_trading_get_best_price`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from_asset` | string | Yes | — | Asset to sell |
| `to_asset` | string | Yes | — | Asset to buy |
| `amount` | string | Yes | — | Amount to quote |

## Risk Management

Risk parameters are enforced by `ton_trading_validate_trade` before any trade:

- **maxTradePercent** (default 10%) — no single trade can exceed this percentage of the balance
- **minBalanceTON** (default 1 TON) — trading blocked if balance falls below this floor
- **scope: dm-only** on `ton_trading_execute_swap`, `ton_trading_auto_execute`, `ton_trading_close_position`, and `ton_trading_close_all_positions` — real trades and closes only in direct messages

The LLM reads the validation result and decides whether to proceed.

## Database Tables

- `trade_journal` — every executed and simulated trade with PnL
- `sim_balance` — virtual balance history for paper trading
- `stop_loss_rules` — active stop-loss and take-profit rules per trade
- `scheduled_trades` — pending trades for future or scheduled execution

## Legal Disclaimer

**THIS PLUGIN IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. THE DEVELOPERS DO NOT PROVIDE FINANCIAL ADVICE. CRYPTOCURRENCY TRADING IS HIGHLY VOLATILE AND RISKY. YOU ARE RESPONSIBLE FOR YOUR OWN FINANCIAL DECISIONS. USE THIS TOOL AT YOUR OWN RISK.**

---

**Developer:** [xlabtg](https://github.com/xlabtg)
