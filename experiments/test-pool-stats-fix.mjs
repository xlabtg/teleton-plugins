/**
 * Test fix for tonco_get_pool_stats pool_address undefined bug
 * 
 * The fix: convert any user-provided address (EQ.../UQ.../raw) to raw 0:xxx format
 * before passing to the TONCO indexer, which only accepts raw format.
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
const _require = createRequire(realpathSync(process.argv[1]));
const { Address } = _require("@ton/core");

const INDEXER_URL = "https://indexer.tonco.io/graphql";

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

/**
 * Normalize a TON address to raw format (0:xxxx) that TONCO indexer accepts.
 * The indexer's server-side resolvers call Address.parseRaw() which crashes
 * on bounceable (EQ.../UQ...) or non-standard formats.
 */
function normalizeToRaw(addr) {
  if (!addr) return addr;
  try {
    const parsed = Address.parse(addr.trim());
    return `0:${parsed.hash.toString("hex")}`;
  } catch {
    // If parse fails, return as-is (indexer will give its own error)
    return addr.trim();
  }
}

const query = `
  query GetPool($where: PoolWhere) {
    pools(where: $where) {
      address
      name
      totalValueLockedUsd
    }
  }
`;

// Test with bounceable address (EQ... format) - the bug case
const testCases = [
  "EQCUUQ4JkETDPTRLlNaMBx5vGFhMn0OC1184AfdnBKKaGK2M",
  "EQC_R1hCuGK8Q8FfHJFbimp0-EHznTuyJsdJjDl7swWYnrF0",
  "0:00c49a30777e2b69dc3a43f93218286e5e8c7fbb303a60195caa3385b838df42",
];

for (const addr of testCases) {
  const normalized = normalizeToRaw(addr);
  console.log(`\nInput:      ${addr}`);
  console.log(`Normalized: ${normalized}`);
  
  const result = await gqlQuery(query, { where: { address: normalized } });
  if (result.errors) {
    console.log(`Error: ${result.errors[0].message}`);
  } else {
    const pools = result.data?.pools ?? [];
    if (pools.length > 0) {
      console.log(`Found pool: ${pools[0].name}, TVL: $${parseFloat(pools[0].totalValueLockedUsd || 0).toFixed(2)}`);
    } else {
      console.log(`No pool found with this address`);
    }
  }
}
