# Polymarket Secrets Setup

This plugin needs five Teleton secrets:

| Secret | Source | Used for |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | A fresh Polygon-compatible EVM wallet | EIP-712 order signing and USDC transfers on Polygon |
| `POLY_API_KEY` | Polymarket CLOB L2 credentials | Authenticated CLOB requests |
| `POLY_API_SECRET` | Polymarket CLOB L2 credentials | HMAC signing for authenticated CLOB requests |
| `POLY_API_PASSPHRASE` | Polymarket CLOB L2 credentials | Authenticated CLOB requests |
| `CHANGENOW_API_KEY` | ChangeNOW Partner account | TON <-> USDC bridge quotes and swaps |

Keep these values out of git, logs, screenshots, and ordinary chat history. Use a
dedicated wallet that holds only the funds you are prepared to trade with this
plugin.

## Compatibility Note

The current plugin signs Polymarket orders as a direct EOA wallet
(`signatureType = 0`). Polymarket also documents proxy, Safe, and deposit wallet
flows with a separate funder address. Do not use credentials created for those
flows with this plugin unless the plugin is extended to support `signatureType`
and `funderAddress`.

Use the same EOA private key for `EVM_PRIVATE_KEY` and for deriving the
`POLY_*` credentials below. The EOA address is the address that will hold Polygon
USDC and the native Polygon gas token, POL/MATIC.

## 1. Create The EVM Wallet

You can generate a fresh EVM key with the helper already included in this
plugin:

```bash
node --input-type=module -e 'import { generateKeypair } from "./plugins/polymarket/lib/evm-wallet.js"; console.log(JSON.stringify(generateKeypair(), null, 2));'
```

Example shape:

```json
{
  "address": "0x...",
  "privateKey": "0x..."
}
```

Save the `privateKey` value as `EVM_PRIVATE_KEY`. Save the `address` value for
funding and checks. Never reuse a personal wallet or the Teleton TON wallet
mnemonic here; this must be a Polygon/EVM key.

Fund the EVM address with:

- Polygon USDC for Polymarket orders.
- A small amount of the native Polygon gas token, shown as POL or MATIC by
  different wallets, for withdrawals and ERC-20 transfers.

## 2. Derive The Polymarket CLOB Credentials

Polymarket CLOB authentication has two levels:

- L1: the EVM private key signs an ownership message.
- L2: the resulting API key, secret, and passphrase sign authenticated CLOB
  requests.

Use the official Polymarket CLOB SDK in a temporary directory. This keeps the
plugin dependency-free while still using Polymarket's signing flow.

```bash
mkdir -p /tmp/polymarket-clob-auth
cd /tmp/polymarket-clob-auth
npm init -y
npm install @polymarket/clob-client-v2 viem
PRIVATE_KEY=0xYOUR_DEDICATED_EVM_PRIVATE_KEY node --input-type=module <<'EOF'
import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const host = "https://clob.polymarket.com";
const chain = 137;
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const signer = createWalletClient({
  account,
  transport: http("https://polygon-rpc.com"),
});

const client = new ClobClient({ host, chain, signer });
const credentials = await client.createOrDeriveApiKey();
console.log(JSON.stringify(credentials, null, 2));
EOF
```

Map the output into Teleton secrets:

| SDK output field | Teleton secret |
| --- | --- |
| `key` or `apiKey` | `POLY_API_KEY` |
| `secret` | `POLY_API_SECRET` |
| `passphrase` | `POLY_API_PASSPHRASE` |

If Polymarket returns `L2 AUTH NOT AVAILABLE`, `INVALID_SIGNATURE`, or
`Invalid Funder Address`, re-check that the private key is the same EOA key you
will store as `EVM_PRIVATE_KEY` and that you are not deriving credentials for a
proxy, Safe, or deposit wallet flow.

## 3. Get The ChangeNOW API Key

Create or open a ChangeNOW Partner account:

1. Go to <https://changenow.io/for-partners> or <https://changenow.io/api>.
2. Register or sign in.
3. Open `Dashboard > Profile settings > Account details`.
4. Copy the API key and store it as `CHANGENOW_API_KEY`.

ChangeNOW normally creates one API key per partner account. If the key is
rotated in ChangeNOW, update the Teleton secret before using deposit or withdraw
tools again.

## 4. Store The Secrets In Teleton

Use your Teleton deployment's secrets UI, or set them from an admin chat/console
with:

```text
/secret set polymarket EVM_PRIVATE_KEY "0x..."
/secret set polymarket POLY_API_KEY "..."
/secret set polymarket POLY_API_SECRET "..."
/secret set polymarket POLY_API_PASSPHRASE "..."
/secret set polymarket CHANGENOW_API_KEY "..."
```

For container and CI-style deployments, Teleton also resolves plugin secrets
from environment variables derived from the plugin id and key:

```bash
POLYMARKET_EVM_PRIVATE_KEY=0x...
POLYMARKET_POLY_API_KEY=...
POLYMARKET_POLY_API_SECRET=...
POLYMARKET_POLY_API_PASSPHRASE=...
POLYMARKET_CHANGENOW_API_KEY=...
```

Restart or reload the Teleton agent after changing secrets if your deployment
does not hot-reload plugin secrets.

## 5. Verify The Setup

Start with read-only checks:

1. Run `polymarket_list_markets` to verify public Polymarket access.
2. Run `polymarket_get_balance` to verify that `EVM_PRIVATE_KEY` is readable and
   the EVM address is derived correctly.
3. Run `polymarket_deposit` without `confirm=true` to verify the ChangeNOW key
   and receive a preview only.

Only after these checks pass, place a very small order or run a small bridge
operation. Keep `max_order_usdc`, `max_swap_ton`, and
`require_confirmation_above_usdc` conservative until the full flow is proven.

## External References

- Polymarket authentication:
  <https://docs.polymarket.com/api-reference/authentication>
- Polymarket trading quickstart:
  <https://docs.polymarket.com/trading/quickstart>
- ChangeNOW API:
  <https://changenow.io/api>
- ChangeNOW Partner account:
  <https://changenow.io/for-partners>
