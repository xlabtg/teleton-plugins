const BASE_URL = "https://min-api.cryptocompare.com/data";

const POPULAR = {
  btc: "BTC",
  bitcoin: "BTC",
  биткоин: "BTC",
  eth: "ETH",
  ethereum: "ETH",
  эфир: "ETH",
  эфириум: "ETH",
  ton: "TON",
  toncoin: "TON",
  тон: "TON",
  sol: "SOL",
  solana: "SOL",
  солана: "SOL",
  doge: "DOGE",
  dogecoin: "DOGE",
  дож: "DOGE",
  xrp: "XRP",
  ripple: "XRP",
  bnb: "BNB",
  ada: "ADA",
  cardano: "ADA",
  dot: "DOT",
  polkadot: "DOT",
  matic: "MATIC",
  polygon: "MATIC",
  avax: "AVAX",
  avalanche: "AVAX",
  link: "LINK",
  chainlink: "LINK",
  uni: "UNI",
  uniswap: "UNI",
  usdt: "USDT",
  tether: "USDT",
  usdc: "USDC",
};

function resolveSymbol(input) {
  const lower = input.toLowerCase().trim();
  return POPULAR[lower] ?? input.toUpperCase();
}

export const manifest = {
  name: "crypto-prices",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Live cryptocurrency prices and comparisons via CryptoCompare.",
};

export const tools = (sdk) => [
  {
    name: "crypto_price",
    description:
      "Get current cryptocurrency price in USD and RUB with 24h change. Supports BTC, ETH, TON, SOL, DOGE, XRP, BNB, ADA, and 5000+ other coins. Accepts names in Russian too (биткоин, эфир, тон).",
    category: "data-bearing",
    scope: "always",
    parameters: {
      type: "object",
      properties: {
        coin: {
          type: "string",
          description:
            'Coin name or symbol (e.g. "BTC", "bitcoin", "биткоин", "TON", "тон", "ETH")',
        },
      },
      required: ["coin"],
    },
    execute: async (params) => {
      try {
        const symbol = resolveSymbol(params.coin);
        const url = `${BASE_URL}/pricemultifull?fsyms=${symbol}&tsyms=USD,RUB`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

        if (!res.ok) {
          return { success: false, error: `API error: ${res.status}` };
        }

        const data = await res.json();
        const raw = data.RAW?.[symbol];

        if (!raw || !raw.USD) {
          return {
            success: false,
            error: `Coin "${params.coin}" (${symbol}) not found`,
          };
        }

        const usd = raw.USD;
        const rub = raw.RUB;

        return {
          success: true,
          data: {
            symbol,
            price_usd: `$${usd.PRICE.toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
            price_rub: rub
              ? `${rub.PRICE.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽`
              : "N/A",
            change_24h: `${usd.CHANGEPCT24HOUR.toFixed(2)}%`,
            change_1h: `${usd.CHANGEPCTHOUR.toFixed(2)}%`,
            high_24h: `$${usd.HIGH24HOUR.toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
            low_24h: `$${usd.LOW24HOUR.toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
            market_cap: `$${(usd.MKTCAP / 1e9).toFixed(2)}B`,
            volume_24h: `$${(usd.TOTALVOLUME24HTO / 1e9).toFixed(2)}B`,
          },
        };
      } catch (err) {
        sdk.log.error("crypto_price:", err.message);
        return {
          success: false,
          error: String(err.message || err).slice(0, 500),
        };
      }
    },
  },

  {
    name: "crypto_compare",
    description:
      "Compare prices of multiple cryptocurrencies side by side. Up to 5 coins at once.",
    category: "data-bearing",
    scope: "always",
    parameters: {
      type: "object",
      properties: {
        coins: {
          type: "string",
          description:
            'Comma-separated coin names or symbols (e.g. "BTC,ETH,TON" or "биткоин,эфир,тон")',
        },
      },
      required: ["coins"],
    },
    execute: async (params) => {
      try {
        const symbols = params.coins
          .split(",")
          .map((c) => resolveSymbol(c.trim()))
          .slice(0, 5);

        const url = `${BASE_URL}/pricemultifull?fsyms=${symbols.join(",")}&tsyms=USD`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

        if (!res.ok) {
          return { success: false, error: `API error: ${res.status}` };
        }

        const data = await res.json();
        const results = [];

        for (const symbol of symbols) {
          const usd = data.RAW?.[symbol]?.USD;
          if (usd) {
            results.push({
              symbol,
              price: `$${usd.PRICE.toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
              change_24h: `${usd.CHANGEPCT24HOUR.toFixed(2)}%`,
              market_cap: `$${(usd.MKTCAP / 1e9).toFixed(2)}B`,
            });
          } else {
            results.push({ symbol, error: "not found" });
          }
        }

        return { success: true, data: { coins: results } };
      } catch (err) {
        sdk.log.error("crypto_compare:", err.message);
        return {
          success: false,
          error: String(err.message || err).slice(0, 500),
        };
      }
    },
  },
];
