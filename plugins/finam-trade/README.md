# Finam Trade Pro

Finam Trade Pro exposes Finam Trade API account, trading, market-data, instrument, report, and usage tools to Teleton.

The plugin uses the REST API documented at `https://tradeapi.finam.ru/docs/rest/`, requests a short-lived JWT through `POST /v1/sessions`, and refreshes that JWT before expiry. It can also opt into Finam's gRPC `SubscribeJwtRenewal` stream for JWT renewal.

## Setup

1. Create a permanent Finam API secret in the Finam Trade API Tokens page.
2. Add the secret to Teleton as `FINAM_SECRET`.
3. Copy or install `plugins/finam-trade` into Teleton plugins and restart the agent.

Optional plugin config:

```json
{
  "api_base": "https://api.finam.ru",
  "grpc_base": "api.finam.ru:443",
  "enable_grpc_jwt_renewal": false,
  "rate_limit_rps": 3,
  "rate_limit_per_minute": 200,
  "timeout_ms": 30000,
  "cache_ttl_seconds": 3600
}
```

## Security

- Secrets are loaded only through `sdk.secrets.require("FINAM_SECRET")` with fallback to `sdk.secrets.get` for older runtimes.
- Tokens and secrets are never logged by the plugin.
- The client only accepts HTTPS API base URLs and rejects localhost/private-network targets.
- IPv4 and IPv6 localhost/private API targets are rejected before requests are created.
- Requests are limited to at most 200 per minute. The default config uses 3 requests per second, which is below that limit.
- `401` and `403` responses clear the cached JWT and retry once with a fresh session token.
- When `enable_grpc_jwt_renewal` is true, `grpc_base` is used only for Finam's authenticated JWT renewal stream.

## Tools

Account tools:

- `finam_get_accounts`
- `finam_get_account_info`
- `finam_get_positions`
- `finam_get_cash`
- `finam_get_trades`
- `finam_get_transactions`

Order tools:

- `finam_place_order`
- `finam_cancel_order`
- `finam_get_orders`
- `finam_get_order_status`
- `finam_place_sltp`

Market data tools:

- `finam_get_bars`
- `finam_get_latest_trades`
- `finam_get_orderbook`
- `finam_get_last_quote`

Instrument tools:

- `finam_get_instrument`
- `finam_get_asset_params`
- `finam_get_instruments_list`
- `finam_get_tradeable_instruments`
- `finam_get_exchanges`
- `finam_get_schedule`
- `finam_get_clock`
- `finam_get_constituents`
- `finam_get_options_chain`

Report and quota tools:

- `finam_generate_report`
- `finam_get_report_status`
- `finam_get_usage`

## Symbol Format

Finam instruments use `TICKER@MIC`, for example `SBER@MISX`. The plugin normalizes symbols to uppercase and returns a validation error if the MIC is missing.

## Examples

Get accounts:

```json
{}
```

Place a limit order:

```json
{
  "account_id": "ACCOUNT_ID",
  "symbol": "SBER@MISX",
  "quantity": "10",
  "side": "buy",
  "type": "limit",
  "limit_price": "150.50",
  "time_in_force": "day",
  "comment": "Teleton order"
}
```

The plugin maps order decimals to Finam REST `Decimal` objects, for example `"quantity": { "value": "10" }`, matching the current `PlaceOrder` and `PlaceSLTPOrder` REST docs.

Get daily bars:

```json
{
  "symbol": "SBER@MISX",
  "interval": "1d",
  "start_time": "2026-01-01T00:00:00Z",
  "end_time": "2026-01-31T00:00:00Z"
}
```

Generate an account report:

```json
{
  "account_id": "ACCOUNT_ID",
  "date_begin": "2026-01-01",
  "date_end": "2026-01-31",
  "report_form": "short"
}
```

## Error Handling

Every tool returns the Teleton standard shape:

```json
{ "success": true, "data": {} }
```

or:

```json
{ "success": false, "error": "Finam API 429: ..." }
```

Network failures, API errors, validation errors, and missing secrets are converted to `success: false` results for the LLM.

## Live Smoke And Readiness

The repo includes a credential-gated live smoke runner for final broker validation:

```bash
npm run finam:live-smoke -- --dry-run
FINAM_SECRET=... FINAM_LIVE_ACCOUNT_ID=... npm run finam:live-smoke
```

By default it runs only non-trading checks:

- `finam_get_accounts`
- `finam_get_account_info`
- `finam_generate_report`
- real JWT session creation and pre-expiry refresh
- real `401`/`403` recovery after an intentionally invalid cached JWT
- negative auth failure with an invalid secret

Trading smoke checks require explicit opt-in and explicit payloads so the script never invents live order terms:

```bash
FINAM_SECRET=... \
FINAM_LIVE_ENABLE_TRADING=1 \
FINAM_LIVE_PLACE_ORDER_JSON='{"account_id":"ACCOUNT_ID","symbol":"SBER@MISX","quantity":"1","side":"buy","type":"limit","limit_price":"1"}' \
FINAM_LIVE_SLTP_JSON='{"account_id":"ACCOUNT_ID","symbol":"SBER@MISX","side":"sell","quantity_sl":"1","sl_price":"1"}' \
npm run finam:live-smoke
```

Returned order IDs are cancelled by default. Set `FINAM_LIVE_CANCEL_CREATED_ORDERS=0` only when cleanup is handled outside the script. Use a non-production account or the safest broker-provided test environment.

## REST And gRPC Scope

The current Teleton tools expose Finam's REST request/response operations. The gRPC integration is implemented for `AuthService.SubscribeJwtRenewal`, which is the gRPC-specific token renewal stream recommended by the Finam docs. Market, account, order, and report streaming subscriptions are not exposed as Teleton tools yet.

Known production-readiness limits:

- Live broker smoke evidence depends on a real non-production `FINAM_SECRET` and test account; do not treat green unit/CI checks alone as proof that order/report flows work against a broker account.
- The smoke runner can verify that optional gRPC JWT renewal starts without breaking REST requests by setting `FINAM_LIVE_ENABLE_GRPC=1`.
- Broader Finam gRPC market/account/order/report streaming tools are intentionally out of scope for this PR.
