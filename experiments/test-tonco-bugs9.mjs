/**
 * Test: pair query with raw addresses (0:hex), 
 * and fix the orderBy query issue with larger fetch + client sorting
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

// Raw address
const TON_RAW = "0:0000000000000000000000000000000000000000000000000000000000000000";
const USDT_RAW = "0:b113a994b5024a16719f6911f48e552b2f306d4f0e0ec52e61ebef5ec3870eb9";

// Explore: what does the pair query with raw addr return? 
// Note above found: USDT is 0:b113a994b5024a16719f6911... but the pair query returned 0 pools.
// Let's try different address formats
const USDT_RAW_FROM_LIST = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe"; // from listing

console.log("Test pair query with addresses from pool listing...");
const r1 = await gqlQuery(`query { pools(where: { jetton0: "${TON_RAW}", jetton1: "${USDT_RAW_FROM_LIST}", isInitialized: true }) { address version jetton0 { symbol } jetton1 { symbol } } }`);
console.log(`TON/USD₮ (raw from list): ${r1.pools.length} pools`);
for (const p of r1.pools) console.log(`  ${p.version}: ${p.jetton0.symbol}/${p.jetton1.symbol}`);

const r2 = await gqlQuery(`query { pools(where: { jetton0: "${USDT_RAW_FROM_LIST}", jetton1: "${TON_RAW}", isInitialized: true }) { address version jetton0 { symbol } jetton1 { symbol } } }`);
console.log(`USD₮/TON (raw from list): ${r2.pools.length} pools`);
for (const p of r2.pools) console.log(`  ${p.version}: ${p.jetton0.symbol}/${p.jetton1.symbol}`);

// Test: the pair query doesn't seem to work at all with the where clause filtering by jetton0+jetton1
// Maybe we need to fetch all and filter client-side?
// The key issue is: the indexer doesn't support filtering by pair - we must use single token and filter client-side

console.log("\nTest: single jetton filter...");
const r3 = await gqlQuery(`query { pools(where: { jetton0: "${TON_RAW}", isInitialized: true }) { address version jetton0 { symbol } jetton1 { address symbol } totalValueLockedUsd } }`);
console.log(`Pools with TON as jetton0: ${r3.pools.length}`);
for (const p of r3.pools.slice(0, 5)) {
  console.log(`  ${p.version}: TON/${p.jetton1.symbol} TVL=${parseFloat(p.totalValueLockedUsd ?? 0).toFixed(0)}`);
}

const r4 = await gqlQuery(`query { pools(where: { jetton1: "${TON_RAW}", isInitialized: true }) { address version jetton0 { address symbol } jetton1 { symbol } totalValueLockedUsd } }`);
console.log(`Pools with TON as jetton1: ${r4.pools.length}`);
for (const p of r4.pools.slice(0, 5)) {
  console.log(`  ${p.version}: ${p.jetton0.symbol}/TON TVL=${parseFloat(p.totalValueLockedUsd ?? 0).toFixed(0)}`);
}

// Alternative: use token info query for address resolution
console.log("\nTest: jetton info query to resolve TON address...");
const r5 = await gqlQuery(`query { jettons(where: {}, filter: { first: 10, orderBy: "totalValueLockedUsd" }) { address symbol totalValueLockedUsd } }`);
console.log(`Top jettons: ${r5.jettons?.length}`);
for (const j of (r5.jettons ?? []).slice(0, 5)) {
  console.log(`  ${j.symbol}: ${j.address?.slice(0,20)} TVL=${parseFloat(j.totalValueLockedUsd ?? 0).toFixed(0)}`);
}
