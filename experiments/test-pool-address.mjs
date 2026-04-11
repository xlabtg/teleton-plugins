/**
 * Test to reproduce the tonco_get_pool_stats pool_address undefined bug
 * 
 * Tests what happens when we query the TONCO GraphQL indexer with 
 * different address filter field names.
 */

const INDEXER_URL = "https://indexer.tonco.io/graphql";
const TEST_POOL = "EQCUUQ4JkETDPTRLlNaMBx5vGFhMn0OC1184AfdnBKKaGK2M";

async function gqlQuery(query, variables = {}) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TONCO indexer error: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  console.log("Raw response:", JSON.stringify(json, null, 2).slice(0, 1000));
  return json;
}

// Test 1: Current implementation - query by address
console.log("\n=== Test 1: Query by 'address' field (current implementation) ===");
try {
  const query1 = `
    query GetPool($where: PoolWhere) {
      pools(where: $where) {
        address
        name
      }
    }
  `;
  const result1 = await gqlQuery(query1, { where: { address: TEST_POOL } });
  console.log("Result:", JSON.stringify(result1, null, 2).slice(0, 500));
} catch (e) {
  console.error("Error:", e.message);
}

// Test 2: Try with isInitialized + address
console.log("\n=== Test 2: Introspection - what fields does PoolWhere have? ===");
try {
  const introspect = `
    {
      __type(name: "PoolWhere") {
        name
        inputFields {
          name
          type { name kind }
        }
      }
    }
  `;
  const result2 = await gqlQuery(introspect, {});
  console.log("PoolWhere fields:", JSON.stringify(result2, null, 2).slice(0, 2000));
} catch (e) {
  console.error("Error:", e.message);
}
