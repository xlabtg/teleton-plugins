/**
 * Test different address formats for the pool query
 */

const INDEXER_URL = "https://indexer.tonco.io/graphql";

// Pool from issue: EQCUUQ4JkETDPTRLlNaMBx5vGFhMn0OC1184AfdnBKKaGK2M (bounceable)
// This is the address we need to find in raw format.
// Let's first try to list pools and find this one.

async function gqlQuery(query, variables = {}) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  return json;
}

// First, find the pool by listing pools and check its address format in the response
console.log("=== Test: List pools to see what address format indexer uses ===");
const listQuery = `
  query ListPools($where: PoolWhere, $filter: Filter) {
    pools(where: $where, filter: $filter) {
      address
      name
    }
  }
`;
const listResult = await gqlQuery(listQuery, { where: { isInitialized: true }, filter: { first: 3 } });
console.log("Pool list result:", JSON.stringify(listResult.data?.pools, null, 2));

// The pool from the issue is EQCUUQ4JkETDPTRLlNaMBx5vGFhMn0OC1184AfdnBKKaGK2M
// Let's try the address in raw format: figure out if it's EQ (bounceable) or raw
// EQ... is bounceable Base64url encoded. The raw format would be 0:...

// Try with the actual address from the issue - EQ format
console.log("\n=== Test: Query with bounceable EQ address format ===");
const eq1 = await gqlQuery(`
  query GetPool($where: PoolWhere) {
    pools(where: $where) { address name }
  }
`, { where: { address: "EQCUUQ4JkETDPTRLlNaMBx5vGFhMn0OC1184AfdnBKKaGK2M" } });
console.log("Result (EQ format):", JSON.stringify(eq1, null, 2).slice(0, 600));

// Try from the list result - use a known valid address
if (listResult.data?.pools?.[0]?.address) {
  const knownAddr = listResult.data.pools[0].address;
  console.log(`\n=== Test: Query with known address from list: ${knownAddr} ===`);
  const knownResult = await gqlQuery(`
    query GetPool($where: PoolWhere) {
      pools(where: $where) { address name }
    }
  `, { where: { address: knownAddr } });
  console.log("Result:", JSON.stringify(knownResult, null, 2).slice(0, 600));
}
