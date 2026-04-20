# Finam Trade Pro

Finam Trade Pro exposes Finam Trade API account, trading, market-data, instrument, report, and usage tools to Teleton.

The plugin uses the REST API documented at `https://tradeapi.finam.ru/docs/rest/`, requests a short-lived JWT through `POST /v1/sessions`, and refreshes that JWT before expiry. It uses native Node `fetch`, so no runtime packages are required.

## Setup

1. Create a permanent Finam API secret in the Finam Trade API Tokens page.
2. Add the secret to Teleton as `FINAM_SECRET`.
3. Copy or install `plugins/finam-trade` into Teleton plugins and restart the agent.

Optional plugin config:

```json
{
  "api_base": "https://api.finam.ru",
  "grpc_base": "api.finam.ru:443",
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
- Requests are limited to at most 200 per minute. The default config uses 3 requests per second, which is below that limit.
- `401` and `403` responses clear the cached JWT and retry once with a fresh session token.

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

## Notes

The current implementation exposes Finam's REST operations as Teleton tools. `grpc_base` is retained in configuration for compatibility with the requested plugin shape and future streaming extensions.
