# xRocket Pay Plugin

Telegram crypto payments via the [xRocket Pay API](https://pay.xrocket.tg) — transfers, multi-cheques, invoices, and withdrawals.

## Setup

1. Open [@xRocket](https://t.me/xRocket) on Telegram
2. Go to **My Apps** → create an app → copy the API key
3. Set the secret: `XROCKET_API_KEY=<your-key>` (or configure via the dashboard)

## Tools (15)

### App / Wallet

| Tool | Type | Description |
|------|------|-------------|
| `xrocket_app_info` | read | App info — name, fee %, balances |
| `xrocket_transfer` | action | Transfer funds to a Telegram user |
| `xrocket_withdraw` | action | Withdraw to external wallet (multi-chain) |
| `xrocket_withdrawal_status` | read | Check withdrawal status |

### Reference

| Tool | Type | Description |
|------|------|-------------|
| `xrocket_withdrawal_fees` | read | Withdrawal fees by currency |
| `xrocket_currencies` | read | Available currencies + limits (cached 5min) |

### Multi-Cheques

| Tool | Type | Description |
|------|------|-------------|
| `xrocket_cheque_create` | action | Create a multi-cheque |
| `xrocket_cheque_list` | read | List cheques |
| `xrocket_cheque_info` | read | Cheque details + activations |
| `xrocket_cheque_delete` | action | Delete a cheque (refunds remaining) |

### Invoices

| Tool | Type | Description |
|------|------|-------------|
| `xrocket_invoice_create` | action | Create an invoice |
| `xrocket_invoice_list` | read | List invoices |
| `xrocket_invoice_info` | read | Invoice details + payments |
| `xrocket_invoice_delete` | action | Delete an invoice |
| `xrocket_invoice_address` | action | Generate on-chain payment address |

## Notes

- **Currency code for TON is `TONCOIN`**, not `TON`. Use `xrocket_currencies` to see all codes.
- All action tools are restricted to DMs (not available in groups).
- Transfer and withdrawal IDs are auto-generated (UUID) if not provided.
- `expired_in` on invoices is in **seconds** (max 86400 = 24h).
- Supported networks: TON, BSC, ETH, BTC, TRX, SOL.
