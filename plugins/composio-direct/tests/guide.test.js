import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guidePath = join(__dirname, "..", "GUIDE.md");

describe("composio-direct agent guide", () => {
  it("documents the core agent workflow and all exported tool families", async () => {
    const guide = await readFile(guidePath, "utf8");

    for (const requiredText of [
      "Composio Direct Agent Guide",
      "composio_search_tools",
      "composio_get_tool_schemas",
      "composio_execute_tool",
      "composio_multi_execute",
      "composio_auth_link",
      "composio_list_connections",
      "composio_manage_connections",
      "composio_list_toolkits",
      "composio_request_file_upload",
      "composio_list_trigger_types",
      "composio_create_webhook",
      "composio_remote_bash",
      "composio_remote_workbench",
      "Security Rules",
    ]) {
      assert.match(guide, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
