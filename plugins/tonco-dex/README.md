# tonco-dex

Trade tokens and manage concentrated liquidity positions on [TONCO DEX](https://tonco.io) — an advanced AMM with concentrated liquidity on TON.

Read tools query the TONCO GraphQL indexer. Swap execution uses the `@toncodex/sdk` to build transactions, signed from the agent wallet.

## Tools

| Tool | Description |
|------|-------------|
| `tonco_list_pools` | Discover and list TONCO liquidity pools, optionally filtered by token, sorted by TVL, volume, or APR |
| `tonco_get_pool_stats` | Get detailed statistics for a specific TONCO pool including reserves, price, volume, fees, and APR |
| `tonco_get_token_info` | Get token metadata and price information from the TONCO indexer |
| `tonco_swap_quote` | Get a swap quote from TONCO with expected output, price impact, and minimum received after slippage |
| `tonco_execute_swap` | Execute a token swap on TONCO DEX — simulates first, then sends on-chain transaction |
| `tonco_get_positions` | List liquidity positions on TONCO for a given owner address |
| `tonco_get_position_fees` | Get uncollected fees for a specific TONCO liquidity position |

## Install

```bash
mkdir -p ~/.teleton/plugins
cp -r plugins/tonco-dex ~/.teleton/plugins/
```

Most tools work immediately without any additional setup. To enable swap execution (`tonco_execute_swap`) and on-chain fee queries (`tonco_get_position_fees`), install the optional SDK:

```bash
cd ~/.teleton/plugins/tonco-dex && npm install
```

## Usage

Ask the AI:

- "List the top TONCO pools by TVL"
- "Show me TONCO pools that include USDT"
- "Get stats for this TONCO pool: EQC..."
- "What is the price of jUSDT on TONCO?"
- "Get a quote for swapping 10 TON to USDT on TONCO"
- "Swap 5 TON to USDT on TONCO"
- "Show my liquidity positions on TONCO for address EQ..."
- "How much fees have I earned on TONCO position NFT EQ...?"

## Trading flow

1. List available pools with `tonco_list_pools` to find token pairs
2. Look up token info with `tonco_get_token_info` to find contract addresses
3. Get a quote with `tonco_swap_quote` to preview expected output and price impact
4. Execute with `tonco_execute_swap` to send the swap transaction
5. Confirmation typically takes ~30 seconds on TON

## Concentrated Liquidity

TONCO uses a concentrated liquidity model (similar to Uniswap v3). Positions are defined by a tick range — liquidity is only active (earning fees) when the current price is within the position's range.

- **in-range**: position is earning fees
- **out-of-range**: price has moved outside the position's tick range; not earning fees
- **closed**: position has zero liquidity (fully withdrawn)

## Dependencies

Requires at runtime (provided by teleton):
- `@ton/core` — Address parsing
- `@ton/ton` — TonClient for on-chain queries

Optional dependencies (enable full functionality when installed):
- `@toncodex/sdk` — TONCO SDK for precise swap simulation, swap execution, and on-chain fee queries
- `@orbs-network/ton-access` — Decentralized TON HTTP API access (falls back to toncenter.com)
- `jsbi` — BigInt support for SDK internals

To install optional dependencies:

```bash
cd ~/.teleton/plugins/tonco-dex && npm install
```

Agent wallet at `~/.teleton/wallet.json` is used for signing all on-chain transactions.

## Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `tonco_api_key` | No | Optional API key for premium TONCO endpoints |

## Schemas

### tonco_list_pools

Discover and list TONCO liquidity pools. Optionally filter by token symbol or address. Sort by TVL, volume, APR, or fees.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token` | string | No | — | Filter by token symbol (e.g. "TON", "USDT") or contract address |
| `sort_by` | string | No | "tvl" | Sort by: tvl, volume, apr, or fees |
| `limit` | integer | No | 10 | Number of pools to return (1-50) |
| `version` | string | No | "v1_5" | Pool version: v1, v1_5, or all |

### tonco_get_pool_stats

Get detailed statistics for a specific TONCO pool by address.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `pool_address` | string | Yes | Pool contract address (e.g. EQC_R1hCuGK8Q8FfHJFbimp0-EHznTuyJsdJjDl7swWYnrF0) |

### tonco_get_token_info

Get token metadata and price from the TONCO indexer. Search by symbol or contract address.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token` | string | Yes | — | Token symbol (e.g. "TON", "USDT", "jUSDT") or contract address |
| `limit` | integer | No | 5 | Max results when searching by symbol (1-20) |

### tonco_swap_quote

Get a swap quote on TONCO DEX. Use 'TON' for native TON.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token_in` | string | Yes | — | Input token address or 'TON' for native TON |
| `token_out` | string | Yes | — | Output token address or 'TON' for native TON |
| `amount_in` | string | Yes | — | Amount to swap in human-readable units (e.g. "10" for 10 TON) |
| `slippage_percent` | number | No | 1.0 | Slippage tolerance in percent (0.01-50) |

### tonco_execute_swap

Execute a token swap on TONCO DEX from the agent wallet. DM-only for security. Use `tonco_swap_quote` first to preview.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token_in` | string | Yes | — | Input token address or 'TON' for native TON |
| `token_out` | string | Yes | — | Output token address or 'TON' for native TON |
| `amount_in` | string | Yes | — | Amount to swap in human-readable units (e.g. "10" for 10 TON) |
| `slippage_percent` | number | No | 1.0 | Slippage tolerance in percent (0.01-50) |

### tonco_get_positions

List liquidity positions on TONCO DEX for a given owner address.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `owner_address` | string | Yes | — | Owner wallet address (TON address) |
| `pool_address` | string | No | — | Filter positions by pool address |
| `include_closed` | boolean | No | false | Include closed (zero-liquidity) positions |
| `limit` | integer | No | 20 | Max positions to return (1-50) |

### tonco_get_position_fees

Get uncollected (pending) fees for a specific TONCO liquidity position by NFT address. Uses on-chain pool state for accurate fee calculation.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `nft_address` | string | Yes | Position NFT contract address |
| `pool_address` | string | No | Pool address (provide to avoid an extra on-chain lookup) |
