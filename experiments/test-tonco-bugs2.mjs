/**
 * Test bug #2: orderDirection case, pool query, pTON address
 */

// Test fixing orderDirection: "DESC" -> "desc"
const INDEXER_URL = "https://indexer.tonco.io/graphql";

async function gqlQuery(query, variables = {}) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

// Test 1: Fix orderDirection to lowercase
console.log("Test 1: orderDirection lowercase...");
try {
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
    filter: { first: 3, orderBy: "totalValueLockedUsd", orderDirection: "desc" }
  });
  console.log(`SUCCESS: found ${data.pools.length} pools`);
  for (const p of data.pools) {
    console.log(`  ${p.name}: ${p.jetton0.address.slice(0,8)}... / ${p.jetton1.address.slice(0,8)}...`);
  }
} catch (err) {
  console.error("FAILED:", err.message);
}

// Test 2: Check pTON address to find TON pools
console.log("\nTest 2: Search for TON/USDT pool using pTON address...");
// Common pTON addresses
const pTonAddresses = [
  "EQBnGWMCf3-FZZq1W4IWcNiZ0_ms1pwhIr0WNCioB99MkA==",  // pTON v1_5 (used in code)
  "EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsBc_DhVfRRtOEffLez",  // pTON v1
];

for (const pTon of pTonAddresses) {
  try {
    const data = await gqlQuery(`
      query GetPools($where: PoolWhere) {
        pools(where: $where) {
          address version totalValueLockedUsd
          jetton0 { address symbol }
          jetton1 { address symbol }
        }
      }
    `, {
      where: { jetton0: pTon, isInitialized: true }
    });
    console.log(`  pTON ${pTon.slice(0,10)}... -> ${data.pools.length} pools as jetton0`);
    for (const p of data.pools.slice(0, 2)) {
      console.log(`    ${p.version}: ${p.jetton0.symbol}/${p.jetton1.symbol} tvl: ${p.totalValueLockedUsd}`);
    }
  } catch (err) {
    console.error(`  pTON ${pTon.slice(0,10)}... error:`, err.message);
  }
}

// Test 3: Check what pTON address is actually used in the indexer
console.log("\nTest 3: List top pools and check what address TON uses...");
try {
  const data = await gqlQuery(`
    query {
      pools(where: { isInitialized: true }, filter: { first: 5, orderBy: "totalValueLockedUsd", orderDirection: "desc" }) {
        address version totalValueLockedUsd
        jetton0 { address symbol }
        jetton1 { address symbol }
      }
    }
  `);
  for (const p of data.pools) {
    if (p.jetton0.symbol === "pTON" || p.jetton1.symbol === "pTON" || 
        p.jetton0.symbol === "TON" || p.jetton1.symbol === "TON") {
      console.log(`  ${p.version}: ${p.jetton0.symbol}(${p.jetton0.address.slice(0,20)}...) / ${p.jetton1.symbol}(${p.jetton1.address.slice(0,20)}...)`);
    }
  }
} catch (err) {
  console.error("FAILED:", err.message);
}

// Test 4: Try querying for a pool with TON using the token symbol approach
console.log("\nTest 4: Query pool by jetton0 symbol (not address)...");
try {
  const data = await gqlQuery(`
    query {
      pools(where: { isInitialized: true }, filter: { first: 10, orderBy: "totalValueLockedUsd", orderDirection: "desc" }) {
        address version totalValueLockedUsd
        jetton0 { address symbol }
        jetton1 { address symbol }
      }
    }
  `);
  for (const p of data.pools) {
    const j0 = p.jetton0.symbol?.toLowerCase();
    const j1 = p.jetton1.symbol?.toLowerCase();
    if (j0?.includes("ton") || j1?.includes("ton") || j0?.includes("usdt") || j1?.includes("usdt")) {
      console.log(`  ${p.version}: ${p.jetton0.symbol}/${p.jetton1.symbol} tvl: ${parseFloat(p.totalValueLockedUsd).toFixed(0)} pTON_j0_addr: ${p.jetton0.address.slice(0,30)}`);
    }
  }
} catch (err) {
  console.error("FAILED:", err.message);
}
