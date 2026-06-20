import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readPluginFile(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

test("secret setup guide documents every required secret", async () => {
  const manifest = JSON.parse(await readPluginFile("manifest.json"));
  const readme = await readPluginFile("README.md");

  assert.match(readme, /\[.*SECRETS\.md.*\]\(.*SECRETS\.md.*\)/);

  const guide = await readPluginFile("SECRETS.md");
  for (const [name, spec] of Object.entries(manifest.secrets)) {
    assert.equal(spec.required, true, `${name} should stay documented as required`);
    assert.match(guide, new RegExp(`\\\`${name}\\\``), `${name} is missing from SECRETS.md`);
    assert.match(guide, new RegExp(`/secret set polymarket ${name}\\b`), `${name} is missing a Teleton command`);
  }

  assert.match(guide, /POLYMARKET_EVM_PRIVATE_KEY/);
  assert.match(guide, /createOrDeriveApiKey/);
  assert.match(guide, /ChangeNOW/);
});
