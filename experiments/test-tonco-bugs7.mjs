/**
 * Test: confirm orderBy works without orderDirection and pool pair querying
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

// Test 1: orderBy without orderDirection
console.log("Test 1: orderBy without orderDirection...");
const d1 = await gqlQuery(`
  query ListPools($where: PoolWhere, $filter: Filter) {
    pools(where: $where, filter: $filter) {
      address name version totalValueLockedUsd
      jetton0 { address symbol }
      jetton1 { address symbol }
    }
  }
`, {
  where: { isInitialized: true },
  filter: { first: 10, orderBy: "totalValueLockedUsd" }
});
console.log(`SUCCESS: ${d1.pools.length} pools`);
for (const p of d1.pools.slice(0, 3)) {
  console.log(`  ${p.name}: TVL=${parseFloat(p.totalValueLockedUsd).toFixed(2)}`);
}

// Test 2: Find pTON address used in the indexer
console.log("\nTest 2: Find TON pools to get pTON address...");
// Get all pools without filter
const d2 = await gqlQuery(`{
  pools(where: { isInitialized: true }) {
    address name version totalValueLockedUsd
    jetton0 { address symbol }
    jetton1 { address symbol }
  }
}`);
// Sort client-side by TVL desc
d2.pools.sort((a, b) => parseFloat(b.totalValueLockedUsd ?? 0) - parseFloat(a.totalValueLockedUsd ?? 0));
// Find pools where one of the tokens is TON/pTON/wTON
const tonPools = d2.pools.filter(p => 
  (p.jetton0?.symbol?.toLowerCase()?.includes("ton") || p.jetton1?.symbol?.toLowerCase()?.includes("ton"))
);
console.log(`Found ${tonPools.length} TON-related pools`);

// Collect unique TON addresses
const tonAddrs = new Set();
for (const p of tonPools.slice(0, 10)) {
  const j0sym = p.jetton0?.symbol?.toLowerCase() ?? "";
  const j1sym = p.jetton1?.symbol?.toLowerCase() ?? "";
  if (j0sym.includes("ton")) tonAddrs.add(`${p.jetton0.symbol}:${p.jetton0.address}`);
  if (j1sym.includes("ton")) tonAddrs.add(`${p.jetton1.symbol}:${p.jetton1.address}`);
}
console.log("TON addresses:", [...tonAddrs]);

// Test 3: find TON/USDT pool
const USDT_ADDR = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
// Get USDT raw address (0:xxx format)
const usdtPool = d2.pools.find(p => 
  p.jetton0?.address?.includes("b113") || p.jetton1?.address?.includes("b113")
);
if (usdtPool) {
  const usdtAddr = p.jetton0?.address?.includes("b113") ? usdtPool.jetton0.address : usdtPool.jetton1.address;
  console.log(`\nUSDT raw address: ${usdtAddr}`);
}

// Check if pool query works by pair
console.log("\nTest 3: Query pool by jetton pair...");
// Use the raw addresses (0:hex format)
const ptonAddr = "0:0000000000000000000000000000000000000000000000000000000000000000";
const usdtRaw = "0:b113a994b5024a16719f6911f48e552b2f306d4f0e0ec52e61ebef5ec3870eb9";

const d3 = await gqlQuery(`
  query GetPools($where: PoolWhere) {
    pools(where: $where) {
      address version
      jetton0 { address symbol }
      jetton1 { address symbol }
    }
  }
`, { where: { jetton0: ptonAddr, jetton1: usdtRaw, isInitialized: true } });
console.log(`pTON/USDT (0:000...): ${d3.pools.length} pools`);

const d4 = await gqlQuery(`
  query GetPools($where: PoolWhere) {
    pools(where: $where) {
      address version
      jetton0 { address symbol }
      jetton1 { address symbol }
    }
  }
`, { where: { jetton0: usdtRaw, jetton1: ptonAddr, isInitialized: true } });
console.log(`USDT/pTON (0:000...): ${d4.pools.length} pools`);

// Check what USDT/pTON pool looks like in pool listing
const usdtTonPools = d2.pools.filter(p => 
  (p.jetton0?.symbol?.includes("USD") || p.jetton1?.symbol?.includes("USD")) &&
  (p.jetton0?.symbol?.includes("TON") || p.jetton1?.symbol?.includes("TON"))
);
console.log("\nUSDT/TON pools in index:");
for (const p of usdtTonPools.slice(0, 5)) {
  console.log(`  ${p.name}: j0=${p.jetton0?.symbol}(${p.jetton0?.address?.slice(0,15)}) j1=${p.jetton1?.symbol}(${p.jetton1?.address?.slice(0,15)})`);
}
