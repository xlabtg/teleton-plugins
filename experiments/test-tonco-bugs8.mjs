/**
 * Test: pool pair query with 0:000 address for TON
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

// The TON address in TONCO indexer is the raw 0:000... address (native TON, not pTON)
const TON_ADDR = "0:0000000000000000000000000000000000000000000000000000000000000000";
// Let's try querying USDT/TON pool
// USDT address from tonco: 0:b113a994b5024a16719f6911f48e552b2f306d4f0e0ec52e61ebef5ec3870eb9

// Get all USDT pools from pool listing
console.log("Getting all pools, filtering for USDT/TON...");
const allPools = await gqlQuery(`{ pools(where: { isInitialized: true }) { address name version totalValueLockedUsd jetton0 { address symbol } jetton1 { address symbol } } }`);
allPools.pools.sort((a, b) => parseFloat(b.totalValueLockedUsd ?? 0) - parseFloat(a.totalValueLockedUsd ?? 0));

const usdtTon = allPools.pools.filter(p =>
  (p.jetton0?.address === TON_ADDR || p.jetton1?.address === TON_ADDR) &&
  (p.jetton0?.symbol?.toUpperCase().includes("USD") || p.jetton1?.symbol?.toUpperCase().includes("USD"))
);
console.log(`Found ${usdtTon.length} USDT/TON pools`);
for (const p of usdtTon.slice(0, 5)) {
  console.log(`  ${p.version}: ${p.name} TVL=${parseFloat(p.totalValueLockedUsd).toFixed(0)}`);
  console.log(`    j0: ${p.jetton0.symbol} ${p.jetton0.address}`);
  console.log(`    j1: ${p.jetton1.symbol} ${p.jetton1.address}`);
}

// Test the jetton pair query with TON_ADDR directly
console.log("\nTest pair query with TON 0:000... address...");
const usdtAddr = "0:b113a994b5024a16719f6911f48e552b2f306d4f0e0ec52e61ebef5ec3870eb9";

const r1 = await gqlQuery(`query { pools(where: { jetton0: "${TON_ADDR}", jetton1: "${usdtAddr}", isInitialized: true }) { address version jetton0 { symbol } jetton1 { symbol } } }`);
console.log(`TON/USDT: ${r1.pools.length} pools`);

const r2 = await gqlQuery(`query { pools(where: { jetton0: "${usdtAddr}", jetton1: "${TON_ADDR}", isInitialized: true }) { address version jetton0 { symbol } jetton1 { symbol } } }`);
console.log(`USDT/TON: ${r2.pools.length} pools`);
for (const p of [...r1.pools, ...r2.pools]) {
  console.log(`  ${p.version}: ${p.jetton0.symbol}/${p.jetton1.symbol}`);
}

// Now test what the plugin does with "TON" -> pTON address from code
const pTonAddr = "EQBnGWMCf3-FZZq1W4IWcNiZ0_ms1pwhIr0WNCioB99MkA=="; // from plugin code
const USDT_EQ = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

const r3 = await gqlQuery(`query { pools(where: { jetton0: "${pTonAddr}", jetton1: "${USDT_EQ}", isInitialized: true }) { address version jetton0 { symbol } jetton1 { symbol } } }`);
console.log(`\npTON_EQ/USDT_EQ: ${r3.pools.length} pools`);

const r4 = await gqlQuery(`query { pools(where: { jetton0: "${USDT_EQ}", jetton1: "${pTonAddr}", isInitialized: true }) { address version jetton0 { symbol } jetton1 { symbol } } }`);
console.log(`USDT_EQ/pTON_EQ: ${r4.pools.length} pools`);

// The fix: when user says "TON", use the raw 0:000 address in queries
console.log("\n--- CONCLUSION ---");
console.log("TON address in TONCO indexer:", TON_ADDR);
console.log("pTON address used in plugin:", pTonAddr, " -> BROKEN (returns 0 pools)");
console.log("Fix: use 0:000... for TON native, or resolve via jetton symbol search first");
