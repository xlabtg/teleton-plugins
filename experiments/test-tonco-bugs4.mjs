/**
 * Test: correct filter and pTON address
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

// Test with lowercase orderDirection 
console.log("Test correct filter with lowercase orderDirection...");
const data = await gqlQuery(`
  query ListPools($where: PoolWhere, $filter: Filter) {
    pools(where: $where, filter: $filter) {
      address name version totalValueLockedUsd
      jetton0 { address symbol }
      jetton1 { address symbol }
    }
  }
`, {
  where: { isInitialized: true },
  filter: { first: 5, orderBy: "totalValueLockedUsd", orderDirection: "desc" }
});
console.log(`SUCCESS: ${data.pools.length} pools`);
for (const p of data.pools) {
  console.log(`  ${p.name}: j0=${p.jetton0.address.slice(0,30)} j1=${p.jetton1.address.slice(0,30)}`);
}

// Find the pTON address used in actual pools
console.log("\nLooking for pTON in top pools...");
const USDT_ADDR = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
for (const p of data.pools) {
  const j0s = p.jetton0.symbol?.toUpperCase();
  const j1s = p.jetton1.symbol?.toUpperCase();
  if (j0s?.includes("TON") || j1s?.includes("TON")) {
    console.log(`  ${p.name}: j0=${p.jetton0.address} j1=${p.jetton1.address}`);
  }
}

// Test jetton0 filter with pTON address from pools
console.log("\nTest jetton pair filter...");
const tonPool = data.pools.find(p => p.jetton0.symbol?.includes("TON") || p.jetton1.symbol?.includes("TON"));
if (tonPool) {
  const tonAddr = tonPool.jetton0.symbol?.includes("TON") ? tonPool.jetton0.address : tonPool.jetton1.address;
  const otherAddr = tonPool.jetton0.symbol?.includes("TON") ? tonPool.jetton1.address : tonPool.jetton0.address;
  console.log(`  TON pool found: pTON=${tonAddr}, other=${otherAddr}`);
  
  // Try querying with these addresses
  try {
    const d2 = await gqlQuery(`
      query GetPools($where: PoolWhere) {
        pools(where: $where) {
          address version
          jetton0 { address symbol }
          jetton1 { address symbol }
        }
      }
    `, { where: { jetton0: tonAddr, jetton1: otherAddr, isInitialized: true } });
    console.log(`  Direct pair query: ${d2.pools.length} pools`);
  } catch (err) {
    console.error("  FAILED:", err.message);
  }
  
  // Try reverse
  try {
    const d3 = await gqlQuery(`
      query GetPools($where: PoolWhere) {
        pools(where: $where) {
          address version
          jetton0 { address symbol }
          jetton1 { address symbol }
        }
      }
    `, { where: { jetton0: otherAddr, jetton1: tonAddr, isInitialized: true } });
    console.log(`  Reverse pair query: ${d3.pools.length} pools`);
  } catch (err) {
    console.error("  FAILED:", err.message);
  }
}

// Test: what pTON address should be used?
// From the indexer, "tgUSD/TON" means jetton1 is TON - let's see its address
const tgUsdTon = data.pools.find(p => p.name === "tgUSD/TON");
if (tgUsdTon) {
  console.log(`\ntgUSD/TON pool jetton1 address: ${tgUsdTon.jetton1.address}`);
}
