# Polymarket

Trade [Polymarket](https://polymarket.com) prediction markets straight from your
TON wallet. The plugin bridges **TON ↔ USDC (Polygon)** through
[ChangeNOW](https://changenow.io) and trades on the Polymarket **CLOB** with a
dedicated EVM key, exposing 10 LLM tools.

> **Zero dependencies.** All Ethereum signing crypto (Keccak‑256, secp256k1
> ECDSA with RFC‑6979 + low‑S, EIP‑712 typed‑data, RLP, EIP‑1559 transactions)
> is implemented in pure JavaScript under `lib/crypto/`, so the plugin installs
> with no `npm install` step and passes the repository's lockfile/audit checks.

## Tools

| Tool | Description |
| --- | --- |
| `polymarket_list_markets` | List active markets ordered by volume, optional tag filter |
| `polymarket_get_market` | Get one market by slug (outcomes, prices, token ids) |
| `polymarket_get_orderbook` | Live CLOB order book for an outcome token |
| `polymarket_place_order` | Place a limit order (BUY/SELL, price 0–1, size in shares) |
| `polymarket_cancel_order` | Cancel an open order by id |
| `polymarket_get_positions` | Current positions held by the EVM wallet |
| `polymarket_get_balance` | USDC (Polygon) + linked TON wallet balances |
| `polymarket_deposit` | Bridge TON → USDC (Polygon) to fund trading |
| `polymarket_withdraw` | Bridge USDC (Polygon) → TON |
| `polymarket_swap_status` | Check a bridge swap status by id |

Every tool returns the standard plugin contract:

```jsonc
{ "success": true,  "data":  { /* ... */ } }
{ "success": false, "error": "human-readable, secret-free message" }
```

## Secrets

Configured via Teleton secrets (never logged, never returned):

| Secret | Required | Purpose |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | ✅ | Dedicated Polygon key (`0x` + 64 hex) that signs orders and USDC transfers |
| `POLY_API_KEY` | ✅ | Polymarket CLOB API key |
| `POLY_API_SECRET` | ✅ | Polymarket CLOB API secret (base64url HMAC key) |
| `POLY_API_PASSPHRASE` | ✅ | Polymarket CLOB API passphrase |
| `CHANGENOW_API_KEY` | ✅ | ChangeNOW API key for the bridge |

Detailed setup: [SECRETS.md](SECRETS.md).

> Use a **fresh, dedicated** EVM key holding only your trading USDC. The withdraw
> flow broadcasts an on-chain ERC‑20 transfer, so the EVM wallet also needs a
> little **MATIC** for gas.

## Configuration

`defaultConfig` (override per install via `pluginConfig`):

| Key | Default | Meaning |
| --- | --- | --- |
| `network` | `mainnet` | `mainnet` (Polygon 137) or `testnet` (Amoy 80002) |
| `max_swap_ton` | `100` | Hard cap on a single deposit (TON) |
| `max_order_usdc` | `500` | Hard cap on a single order notional (USDC) |
| `require_confirmation_above_usdc` | `50` | Above this, money‑moving tools need `confirm=true` |
| `default_slippage_bps` | `100` | Reserved for slippage-aware flows |
| `changenow_from_network` | `ton` | ChangeNOW network code for TON |
| `changenow_to_network` | `matic` | ChangeNOW network code for Polygon |

## Safety model

- **Hard limits** — orders above `max_order_usdc` and deposits above
  `max_swap_ton` are rejected outright.
- **Two-step confirmation** — any order/deposit/withdraw whose value exceeds
  `require_confirmation_above_usdc` first returns a `confirmation_required`
  preview; nothing is sent until the tool is re-run with `confirm: true`.
- **Non-retried writes** — order placement and bridge creation are never
  retried, avoiding duplicate orders/swaps.
- **Error sanitisation** — every error reaching the LLM passes through
  `sanitizeError()`, which strips anything resembling a private key, API key, or
  token and truncates to 500 chars.

## Typical flow

1. `polymarket_deposit { amount_ton: 10 }` → preview, then
   `{ amount_ton: 10, confirm: true }` → bridges TON to USDC on Polygon.
2. `polymarket_swap_status { swap_id }` until finished.
3. `polymarket_list_markets` / `polymarket_get_market` → pick a market + token.
4. `polymarket_place_order { slug, outcome: "Yes", side: "BUY", price: 0.4, size: 10 }`.
5. `polymarket_get_positions` / `polymarket_get_balance` to track.
6. `polymarket_withdraw { amount_usdc: 25, confirm: true }` to cash back to TON.

## Architecture

```
index.js              manifest + migrate + tools(sdk)
lib/runtime.js        lazy wiring of clients from sdk.secrets
lib/tools.js          the 10 tools (limits, confirmation, contract)
lib/config.js         network endpoints + default config
lib/markets.js        Gamma API (markets)
lib/clob-client.js    CLOB v2 (orderbook, price, order signing, place/cancel)
lib/bridge.js         ChangeNOW v2 (estimate, min, exchange, status)
lib/evm-rpc.js        Polygon JSON-RPC (USDC balance, nonce, gas, broadcast)
lib/evm-wallet.js     key mgmt, EIP-712 order signing, EIP-1559 tx, L2 HMAC
lib/state.js          sqlite tracking of swaps + orders
lib/http.js           fetch wrapper (timeout, retry/backoff)
lib/util.js           contract helpers + error sanitisation
lib/crypto/*          Keccak-256, secp256k1, EIP-712, RLP, hex (pure JS)
```

## Tests

```bash
node --test plugins/polymarket/tests
```

Coverage includes Keccak/secp256k1/RLP known-answer vectors, an EIP‑712 order
sign→`ecrecover` round-trip, CLOB amount math, market normalisation, and the
tool limit/confirmation/sanitisation logic against mock clients.
```
