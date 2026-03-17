# xRocket Trade Plugin

Spot trading on the [xRocket Exchange](https://trade.xrocket.tg) — orders, market data, candlesticks, and account management.

## Setup

1. Open [@xRocket](https://t.me/xRocket) on Telegram
2. Go to **My Apps** → create an app → copy the **Exchange** API key
3. Set the secret: `XROCKETTRADE_EXCHANGE_KEY=<your-key>` (or configure via the dashboard)

> **Note**: This is a different key than xRocket Pay. The Exchange and Pay wallets are separate.

## Tools (16)

### Account (5)

| Tool | Type | Description |
|------|------|-------------|
| `xtrade_balances` | read | All exchange balances (non-zero) |
| `xtrade_balance` | read | Balance for a specific coin |
| `xtrade_fees` | read | Your maker/taker fee rates |
| `xtrade_withdrawal_fees` | read | Withdrawal fees and minimums |
| `xtrade_withdraw` | action | Withdraw to external wallet |

### Market Data (6)

| Tool | Type | Description |
|------|------|-------------|
| `xtrade_pairs` | read | All trading pairs with prices and volumes |
| `xtrade_pair` | read | Details for one pair |
| `xtrade_order_book` | read | Full order book (buy/sell walls) |
| `xtrade_last_trades` | read | Recent executed trades |
| `xtrade_time_series` | read | OHLCV candlestick data |
| `xtrade_rate` | read | Crypto-to-crypto exchange rate |

### Orders (5)

| Tool | Type | Description |
|------|------|-------------|
| `xtrade_order_create` | action | Place a buy/sell order (limit or market) |
| `xtrade_order_list` | read | List your orders (active or history) |
| `xtrade_order_info` | read | Order details by ID |
| `xtrade_order_cancel` | action | Cancel an active order |
| `xtrade_order_estimate` | read | Simulate order execution (preview fees) |

## Notes

- **Deposits** are done through the @xRocket Telegram bot, not via the API.
- The Exchange wallet is **separate** from the Pay wallet — different balances.
- Pair names use format `BASE-QUOTE` (e.g. `TONCOIN-USDT`, `BTC-USDT`).
- TON currency code is `TONCOIN`, not `TON`.
- Order types: `BUY` / `SELL`. Execute types: `LIMIT` / `MARKET`.
- For LIMIT orders, `rate` parameter is required.
- Supported withdrawal networks: TON, BSC, ETH, BTC, TRX, SOL.
