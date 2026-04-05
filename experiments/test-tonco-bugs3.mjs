/**
 * Test: discover correct GraphQL schema
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
  return json;  // Return full response including errors
}

// Introspect the enum values for OrderDirection
console.log("Introspecting OrderDirection enum...");
const result = await gqlQuery(`
  { __type(name: "OrderDirection") { enumValues { name } } }
`);
console.log("OrderDirection values:", JSON.stringify(result));

// Try without filter parameter
console.log("\nQuery without filter...");
const r2 = await gqlQuery(`
  { 
    pools(where: { isInitialized: true }) {
      address version totalValueLockedUsd
      jetton0 { address symbol }
      jetton1 { address symbol }
    }
  }
`);
if (r2.errors) console.log("Errors:", JSON.stringify(r2.errors[0]?.message?.slice(0, 300)));
if (r2.data?.pools) console.log(`Got ${r2.data.pools.length} pools, first: ${r2.data.pools[0]?.jetton0?.symbol}/${r2.data.pools[0]?.jetton1?.symbol}`);

// Introspect Filter type
console.log("\nIntrospecting Filter type...");
const r3 = await gqlQuery(`
  { __type(name: "Filter") { inputFields { name type { name kind ofType { name kind } } } } }
`);
console.log("Filter fields:", JSON.stringify(r3.data));

// Introspect the schema to find correct field names
console.log("\nIntrospecting PoolWhere...");
const r4 = await gqlQuery(`
  { __type(name: "PoolWhere") { inputFields { name type { name kind } } } }
`);
console.log("PoolWhere fields:", JSON.stringify(r4.data));
