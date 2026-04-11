/**
 * Test address format conversion using @ton/core
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
const _require = createRequire(realpathSync(process.argv[1]));
const { Address } = _require("@ton/core");

// Test pool address from the issue
const testAddresses = [
  "EQCUUQ4JkETDPTRLlNaMBx5vGFhMn0OC1184AfdnBKKaGK2M",
  "EQC_R1hCuGK8Q8FfHJFbimp0-EHznTuyJsdJjDl7swWYnrF0",
  "0:00c49a30777e2b69dc3a43f93218286e5e8c7fbb303a60195caa3385b838df42",
];

for (const addr of testAddresses) {
  try {
    const parsed = Address.parse(addr);
    const raw = `0:${parsed.hash.toString("hex")}`;
    console.log(`Input: ${addr}`);
    console.log(`Raw:   ${raw}`);
    console.log();
  } catch (e) {
    console.error(`Failed to parse ${addr}: ${e.message}`);
  }
}
