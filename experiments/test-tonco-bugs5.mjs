/**
 * Test: correct GraphQL schema field names for ordering
 */
const INDEXER_URL = "https://indexer.tonco.io/graphql";

async function gqlRaw(query, variables = {}) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

// Try different orderBy field names (camelCase vs snake_case)
const orderByFields = [
  "totalValueLockedUsd",
  "total_value_locked_usd",
  "tvl",
  "TVL",
];

for (const field of orderByFields) {
  const r = await gqlRaw(`
    query { pools(where: { isInitialized: true }, filter: { first: 1, orderBy: "${field}", orderDirection: "desc" }) { address } }
  `);
  if (r.errors) {
    console.log(`orderBy "${field}": ERROR - ${r.errors[0].message.slice(0, 100)}`);
  } else {
    console.log(`orderBy "${field}": OK - found ${r.data?.pools?.length} pools`);
  }
}

// Test: without filter at all (working case from before)
console.log("\nTest without filter:");
const r0 = await gqlRaw(`{ pools(where: { isInitialized: true }) { address name jetton0 { address symbol } jetton1 { address symbol } totalValueLockedUsd } }`);
if (r0.errors) {
  console.log("Error:", r0.errors[0].message.slice(0, 200));
} else {
  console.log(`Got ${r0.data?.pools?.length} pools`);
  const pools = r0.data?.pools ?? [];
  
  // Sort client-side to find top TVL pools
  pools.sort((a, b) => parseFloat(b.totalValueLockedUsd ?? 0) - parseFloat(a.totalValueLockedUsd ?? 0));
  
  console.log("Top 5 by TVL:");
  for (const p of pools.slice(0, 5)) {
    console.log(`  ${p.name || p.jetton0?.symbol+"/"+p.jetton1?.symbol}: TVL=${p.totalValueLockedUsd}, j0=${p.jetton0?.address?.slice(0,20)}, j1=${p.jetton1?.address?.slice(0,20)}`);
  }
  
  // Find pTON
  const tonPools = pools.filter(p => p.jetton0?.symbol?.includes("TON") || p.jetton1?.symbol?.includes("TON"));
  console.log("\nTON pools (first 5):");
  for (const p of tonPools.slice(0, 5)) {
    console.log(`  ${p.name}: j0.addr=${p.jetton0?.address?.slice(0,25)}, j1.addr=${p.jetton1?.address?.slice(0,25)}`);
  }
}
