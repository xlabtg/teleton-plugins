/**
 * Test: fix swap quote logic with correct addresses
 */
const INDEXER_URL = "https://indexer.tonco.io/graphql";

async function gqlQuery(query, variables = {}) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL error: ${json.errors[0].message.slice(0, 300)}`);
  return json.data;
}

// The correct TON address in TONCO indexer (native TON = all zeros)
const TON_RAW = "0:0000000000000000000000000000000000000000000000000000000000000000";
// USDT on TON (bounceable)
const USDT_EQ = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const USDT_UQ = "UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_7ko";

// The core of the fix: we need to resolve the user's token address to raw format 
// and then query by single jetton + filter client side

// Test approach: fetch all pools for token_in and filter client-side for token_out
console.log("Test: fetch pools for TON and find USDT pool...");

// First, resolve USDT from the indexer via jetton lookup
const USDT_addr_bounceable = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const d1 = await gqlQuery(`query { jettons(where: { address: "${USDT_addr_bounceable}" }, filter: { first: 1 }) { address symbol decimals } }`);
console.log("USDT jetton lookup:", JSON.stringify(d1));

// Try with "USDT" symbol
const d2 = await gqlQuery(`query { jettons(where: {}, filter: { first: 50 }) { address symbol decimals totalValueLockedUsd } }`);
const usdt = (d2.jettons ?? []).filter(j => j.symbol?.toUpperCase().includes("USDT") || j.symbol?.includes("USD₮"));
console.log("USDT tokens:", usdt.map(j => `${j.symbol}: ${j.address?.slice(0,20)} TVL=${parseFloat(j.totalValueLockedUsd ?? 0).toFixed(0)}`));

// Test fetching pools for a single jetton (TON) with correct approach
const d3 = await gqlQuery(`
  query { 
    pools(where: { jetton0: "${TON_RAW}", isInitialized: true }) { 
      address version fee tick tickSpacing liquidity priceSqrt totalValueLockedUsd
      jetton0 { address symbol decimals }
      jetton1 { address symbol decimals }
      jetton0Price jetton1Price
    }
    pools2: pools(where: { jetton1: "${TON_RAW}", isInitialized: true }) { 
      address version fee tick tickSpacing liquidity priceSqrt totalValueLockedUsd
      jetton0 { address symbol decimals }
      jetton1 { address symbol decimals }
      jetton0Price jetton1Price
    }
  }
`);
const allTonPools = [...(d3.pools ?? []), ...(d3.pools2 ?? [])];
console.log(`\nTON pools total: ${allTonPools.length}`);

// Sort by TVL
allTonPools.sort((a, b) => parseFloat(b.totalValueLockedUsd ?? 0) - parseFloat(a.totalValueLockedUsd ?? 0));

// Show top ones
for (const p of allTonPools.slice(0, 5)) {
  console.log(`  ${p.version}: ${p.jetton0.symbol}/${p.jetton1.symbol} TVL=${parseFloat(p.totalValueLockedUsd ?? 0).toFixed(0)} j0Price=${p.jetton0Price} j1Price=${p.jetton1Price}`);
}
