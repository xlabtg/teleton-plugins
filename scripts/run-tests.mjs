/**
 * run-tests.mjs
 *
 * Discovers and runs test files in plugin directories using Node's built-in
 * test runner (node:test). Tests must be in:
 *   plugins/<name>/tests/*.test.js
 *   plugins/<name>/tests/*.test.mjs
 *   plugins/<name>/*.test.js
 *   plugins/<name>/*.test.mjs
 *
 * Also runs any scripts/**.test.mjs files.
 *
 * Used by CI / Test workflow.
 */

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const PLUGINS_DIR = resolve("plugins");
const SCRIPTS_DIR = resolve("scripts");

const testFiles = [];

// Discover plugin test files
const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = join(PLUGINS_DIR, entry.name);

  // Check tests/ subdirectory
  const testsDir = join(dir, "tests");
  if (existsSync(testsDir)) {
    const testEntries = await readdir(testsDir);
    for (const f of testEntries) {
      if (f.endsWith(".test.js") || f.endsWith(".test.mjs")) {
        testFiles.push(join(testsDir, f));
      }
    }
  }

  // Check plugin root
  const rootEntries = await readdir(dir);
  for (const f of rootEntries) {
    if (f.endsWith(".test.js") || f.endsWith(".test.mjs")) {
      testFiles.push(join(dir, f));
    }
  }
}

// Discover scripts test files
if (existsSync(SCRIPTS_DIR)) {
  const scriptEntries = await readdir(SCRIPTS_DIR);
  for (const f of scriptEntries) {
    if (f.endsWith(".test.js") || f.endsWith(".test.mjs")) {
      testFiles.push(join(SCRIPTS_DIR, f));
    }
  }
}

if (testFiles.length === 0) {
  console.log("No test files found. Skipping.");
  process.exit(0);
}

console.log(`\nFound ${testFiles.length} test file(s):\n`);
for (const f of testFiles) {
  console.log(`  ${f}`);
}
console.log();

// Run all tests with Node's built-in test runner
const result = spawnSync(
  process.execPath,
  ["--test", ...testFiles],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  }
);

process.exit(result.status ?? 1);
