/**
 * Test: Understand the actual GraphQL filter structure
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

// The "Filter" type has: skip, first, orderBy (String), orderDirection (OrderDirection enum)
// But the error was about "totalValueLockedUsd" as an unknown arg inside findMany
// This suggests the filter.orderBy value needs to be a field name that Prisma knows about

// The API shows pools have camelCase fields. Let's try orderBy with snake_case
const tests = [
  { orderBy: "totalValueLockedUsd", orderDirection: "desc" },
  { orderBy: "total_value_locked_usd", orderDirection: "desc" },
];

for (const filter of tests) {
  const r = await gqlRaw(
    `query ListPools($where: PoolWhere, $filter: Filter) {
      pools(where: $where, filter: $filter) { address }
    }`,
    { where: { isInitialized: true, showV1_5: true }, filter: { first: 3, ...filter } }
  );
  if (r.errors) {
    console.log(`orderBy="${filter.orderBy}": ERROR: ${r.errors[0].message.slice(0, 120)}`);
  } else {
    console.log(`orderBy="${filter.orderBy}": OK got ${r.data?.pools?.length} pools`);
  }
}

// Test ordering by different fields - maybe the issue is the field name is wrong
const fieldCandidates = ["volume24HUsd", "fees24HUsd", "apr", "txCount", "liquidity", "creationUnix"];
for (const f of fieldCandidates) {
  const r = await gqlRaw(
    `query ListPools($filter: Filter) {
      pools(where: { isInitialized: true }, filter: $filter) { address }
    }`,
    { filter: { first: 2, orderBy: f, orderDirection: "desc" } }
  );
  if (r.errors) {
    console.log(`orderBy="${f}": ERROR: ${r.errors[0].message.slice(0, 120)}`);
  } else {
    console.log(`orderBy="${f}": OK got ${r.data?.pools?.length} pools`);
  }
}

// Try without orderDirection (maybe the default works)
const r2 = await gqlRaw(
  `query { pools(where: { isInitialized: true }, filter: { first: 3, orderBy: "totalValueLockedUsd" }) { address } }`
);
console.log("\nWithout orderDirection:", r2.errors ? r2.errors[0].message.slice(0, 150) : `OK ${r2.data?.pools?.length} pools`);

// Try just first without orderBy
const r3 = await gqlRaw(
  `query { pools(where: { isInitialized: true }, filter: { first: 3 }) { address totalValueLockedUsd } }`
);
console.log("Just first:", r3.errors ? r3.errors[0].message.slice(0, 150) : `OK ${r3.data?.pools?.length} pools, tvl0=${r3.data?.pools?.[0]?.totalValueLockedUsd}`);
