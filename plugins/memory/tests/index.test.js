/**
 * Unit tests for memory plugin
 *
 * Tests manifest exports, tool definitions, and tool execute behavior
 * using Node's built-in test runner (node:test).
 *
 * All database calls are mocked — no real disk access.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

const PLUGIN_DIR = resolve("plugins/memory");
const PLUGIN_URL = pathToFileURL(join(PLUGIN_DIR, "index.js")).href;

// ─── Mock DB ──────────────────────────────────────────────────────────────────

/**
 * Build an in-memory mock DB that supports exec, prepare().run(), .get(), .all()
 * and tracks inserted rows by table name.
 */
function makeMockDb(overrides = {}, opts = {}) {
  const store = {
    memory_entries: [],
    memory_tags: [],
    memory_entities: [],
    memory_schema_version: [],
    memory_relations: [],
    nextId: 1,
    nextRelId: 1,
  };

  // Seed schema version 3 when associative mode is enabled
  if (opts.enableAssociativeMode) {
    store.memory_schema_version.push({ version: 3 });
  }

  return {
    _store: store,

    exec: () => {},

    prepare(sql) {
      const s = sql.trim().toUpperCase();

      return {
        run(...args) {
          if (s.startsWith("INSERT INTO MEMORY_ENTRIES") || s.startsWith("INSERT OR IGNORE INTO MEMORY_ENTRIES")) {
            const id = store.nextId++;
            store.memory_entries.push({
              id,
              content: args[0],
              created_at: args[1] ?? Math.floor(Date.now() / 1000),
              updated_at: null,
              user_id: args[2] ?? null,
            });
            return { lastInsertRowid: id };
          }
          if (s.startsWith("INSERT") && s.includes("MEMORY_TAGS")) {
            store.memory_tags.push({ entry_id: args[0], tag: args[1] });
            return {};
          }
          if (s.startsWith("INSERT") && s.includes("MEMORY_ENTITIES")) {
            store.memory_entities.push({
              entry_id: args[0],
              entity_type: args[1],
              entity_name: args[2],
            });
            return {};
          }
          if ((s.startsWith("INSERT") || s.startsWith("INSERT OR REPLACE")) && s.includes("MEMORY_RELATIONS")) {
            // Remove existing relation with same (source, target, type) if replacing
            store.memory_relations = store.memory_relations.filter(
              (r) =>
                !(
                  r.source_entry_id === args[0] &&
                  r.target_entry_id === args[1] &&
                  r.relation_type === args[2]
                )
            );
            const relId = store.nextRelId++;
            store.memory_relations.push({
              id: relId,
              source_entry_id: args[0],
              target_entry_id: args[1],
              relation_type: args[2],
              confidence: args[3] ?? 1.0,
              created_at: Math.floor(Date.now() / 1000),
            });
            return { lastInsertRowid: relId };
          }
          if (s.startsWith("DELETE FROM MEMORY_ENTRIES")) {
            store.memory_entries = store.memory_entries.filter((e) => e.id !== args[0]);
            return {};
          }
          if (s.startsWith("DELETE FROM MEMORY_TAGS")) {
            store.memory_tags = store.memory_tags.filter((t) => t.entry_id !== args[0]);
            return {};
          }
          if (s.startsWith("DELETE FROM MEMORY_ENTITIES")) {
            store.memory_entities = store.memory_entities.filter((e) => e.entry_id !== args[0]);
            return {};
          }
          if (s.startsWith("UPDATE MEMORY_ENTRIES")) {
            const entry = store.memory_entries.find((e) => e.id === args[2]);
            if (entry) {
              entry.content = args[0];
              entry.updated_at = args[1];
            }
            return {};
          }
          return {};
        },

        get(...args) {
          if (s.includes("COUNT(*)")) {
            return { n: store.memory_entries.length };
          }
          if (s.includes("FROM MEMORY_SCHEMA_VERSION") && s.includes("WHERE VERSION")) {
            // Version number may be embedded in SQL (e.g. WHERE version = 3) or passed as arg
            const versionInSql = s.match(/WHERE VERSION\s*=\s*(\d+)/);
            const versionNum = versionInSql ? Number(versionInSql[1]) : args[0];
            return store.memory_schema_version.find((v) => v.version === versionNum) ?? null;
          }
          if (s.includes("FROM MEMORY_ENTRIES") && s.includes("WHERE ID")) {
            return store.memory_entries.find((e) => e.id === args[0]) ?? null;
          }
          if (s.includes("FROM MEMORY_ENTRIES") && s.includes("WHERE CONTENT")) {
            return store.memory_entries.find((e) => e.content === args[0]) ?? null;
          }
          if (s.includes("FROM MEMORY_ENTRIES") && args.length > 0) {
            return store.memory_entries.find((e) => e.id === args[0]) ?? null;
          }
          return null;
        },

        all(...args) {
          if (s.includes("FROM MEMORY_TAGS") && s.includes("WHERE ENTRY_ID")) {
            return store.memory_tags.filter((t) => t.entry_id === args[0]);
          }
          if (s.includes("FROM MEMORY_ENTITIES") && s.includes("WHERE ENTRY_ID")) {
            return store.memory_entities.filter((e) => e.entry_id === args[0]);
          }
          if (s.includes("FROM MEMORY_RELATIONS") && s.includes("WHERE R.SOURCE_ENTRY_ID")) {
            // Outgoing: WHERE r.source_entry_id = ?
            let rows = store.memory_relations.filter((r) => r.source_entry_id === args[0]);
            if (args[1] !== undefined) {
              rows = rows.filter((r) => r.relation_type === args[1]);
            }
            return rows.map((r) => ({
              rel_id: r.id,
              neighbour_id: r.target_entry_id,
              relation_type: r.relation_type,
              confidence: r.confidence,
              dir: "outgoing",
            }));
          }
          if (s.includes("FROM MEMORY_RELATIONS") && s.includes("WHERE R.TARGET_ENTRY_ID")) {
            // Incoming: WHERE r.target_entry_id = ?
            let rows = store.memory_relations.filter((r) => r.target_entry_id === args[0]);
            if (args[1] !== undefined) {
              rows = rows.filter((r) => r.relation_type === args[1]);
            }
            return rows.map((r) => ({
              rel_id: r.id,
              neighbour_id: r.source_entry_id,
              relation_type: r.relation_type,
              confidence: r.confidence,
              dir: "incoming",
            }));
          }
          if (s.includes("FROM MEMORY_ENTRIES")) {
            let results = [...store.memory_entries];
            // Support LIMIT ? OFFSET ? — limit is first numeric arg, offset is second
            const numericArgs = args.filter((a) => typeof a === "number");
            const limit = numericArgs[0];
            const offset = numericArgs[1] ?? 0;
            if (limit !== undefined) {
              results = results.slice(offset, offset + limit);
            }
            return results;
          }
          if (s.includes("FROM MEMORY_TAGS") && s.includes("GROUP BY")) {
            const counts = {};
            for (const t of store.memory_tags) counts[t.tag] = (counts[t.tag] ?? 0) + 1;
            return Object.entries(counts).map(([tag, count]) => ({ tag, count }));
          }
          if (s.includes("FROM MEMORY_ENTITIES") && s.includes("GROUP BY")) {
            const counts = {};
            for (const e of store.memory_entities) {
              const key = `${e.entity_type}:${e.entity_name}`;
              counts[key] = counts[key] ?? { entity_type: e.entity_type, entity_name: e.entity_name, count: 0 };
              counts[key].count++;
            }
            return Object.values(counts);
          }
          return [];
        },
      };
    },

    ...overrides,
  };
}

function makeSdkWithAssociativeMode() {
  return {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    db: makeMockDb({}, { enableAssociativeMode: true }),
  };
}

// ─── Minimal mock SDK ─────────────────────────────────────────────────────────

function makeSdk(overrides = {}) {
  return {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    db: makeMockDb(),
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    chatId: 123456789,
    senderId: 987654321,
    ...overrides,
  };
}

// ─── Load plugin once ─────────────────────────────────────────────────────────

let mod;

before(async () => {
  mod = await import(PLUGIN_URL);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("memory plugin", () => {
  // ── Manifest ────────────────────────────────────────────────────────────────
  describe("manifest", () => {
    it("exports manifest object", () => {
      assert.ok(mod.manifest, "manifest should be exported");
      assert.equal(typeof mod.manifest, "object");
    });

    it("manifest name is 'memory'", () => {
      assert.equal(mod.manifest.name, "memory");
    });

    it("manifest has version", () => {
      assert.ok(mod.manifest.version, "manifest.version should exist");
    });

    it("manifest has sdkVersion", () => {
      assert.ok(mod.manifest.sdkVersion, "manifest.sdkVersion should exist");
    });
  });

  // ── migrate ──────────────────────────────────────────────────────────────────
  describe("migrate", () => {
    it("exports migrate function", () => {
      assert.equal(typeof mod.migrate, "function");
    });

    it("migrate calls db.exec without throwing", () => {
      const executed = [];
      const mockDb = {
        exec: (sql) => executed.push(sql),
        prepare: () => ({ run: () => {} }),
      };
      assert.doesNotThrow(() => mod.migrate(mockDb));
      assert.ok(executed.length >= 1);
      assert.ok(executed[0].includes("memory_entries"));
      assert.ok(executed[0].includes("memory_tags"));
      assert.ok(executed[0].includes("memory_entities"));
    });
  });

  // ── tools export ────────────────────────────────────────────────────────────
  describe("tools export", () => {
    it("exports tools as a function", () => {
      assert.equal(typeof mod.tools, "function");
    });

    it("tools(sdk) returns an array", () => {
      const toolList = mod.tools(makeSdk());
      assert.ok(Array.isArray(toolList));
    });

    it("exports exactly 10 tools", () => {
      const toolList = mod.tools(makeSdk());
      assert.equal(toolList.length, 10);
    });

    it("all tools have name, description, and execute", () => {
      const toolList = mod.tools(makeSdk());
      for (const tool of toolList) {
        assert.ok(tool.name, "tool should have name");
        assert.ok(tool.description, `tool "${tool.name}" should have description`);
        assert.equal(typeof tool.execute, "function", `tool "${tool.name}" should have execute function`);
      }
    });

    it("tool names match expected set", () => {
      const toolList = mod.tools(makeSdk());
      const names = toolList.map((t) => t.name);
      const expected = [
        "memory_store",
        "memory_list",
        "memory_search",
        "memory_update",
        "memory_delete",
        "memory_list_tags",
        "memory_export",
        "memory_import",
        "memory_relate",
        "memory_find_connections",
      ];
      for (const name of expected) {
        assert.ok(names.includes(name), `missing tool: ${name}`);
      }
    });
  });

  // ── memory_store ─────────────────────────────────────────────────────────────
  describe("memory_store", () => {
    it("stores a simple entry and returns id", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_store");
      const result = await tool.execute({ content: "Hello world" }, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.id >= 1);
      assert.equal(result.data.message, `Memory saved (id ${result.data.id})`);
    });

    it("parses inline #tags from content", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_store");
      const result = await tool.execute({ content: "Meeting #work #important" }, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.tags.includes("#work"));
      assert.ok(result.data.tags.includes("#important"));
    });

    it("accepts explicit tags parameter", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_store");
      const result = await tool.execute(
        { content: "Note", tags: ["urgent", "#follow-up"] },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.ok(result.data.tags.includes("#urgent"));
      assert.ok(result.data.tags.includes("#follow-up"));
    });

    it("extracts @mention entities", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_store");
      const result = await tool.execute({ content: "Chat with @anton about TON" }, makeContext());
      assert.equal(result.success, true);
      const personEntity = result.data.entities.find((e) => e.type === "person" && e.name === "anton");
      assert.ok(personEntity, "should extract @anton as person entity");
    });

    it("accepts tags as a JSON-encoded string (LLM serialization quirk)", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_store");
      const result = await tool.execute(
        { content: "Important rule", tags: '["rules", "github"]' },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.ok(result.data.tags.includes("#rules"), "should parse #rules from JSON string");
      assert.ok(result.data.tags.includes("#github"), "should parse #github from JSON string");
    });

    it("accepts tags as a single plain string", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_store");
      const result = await tool.execute(
        { content: "Note", tags: "work" },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.ok(result.data.tags.includes("#work"), "should treat plain string as a single tag");
    });

    it("returns error when content is empty", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_store");
      const result = await tool.execute({ content: "" }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("empty"));
      assert.ok(result.hint);
    });

    it("returns error when content is missing", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_store");
      const result = await tool.execute({}, makeContext());
      assert.equal(result.success, false);
    });
  });

  // ── memory_list ──────────────────────────────────────────────────────────────
  describe("memory_list", () => {
    it("returns all entries with count and total", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "Entry one" }, makeContext());
      await store.execute({ content: "Entry two" }, makeContext());

      const list = mod.tools(sdk).find((t) => t.name === "memory_list");
      const result = await list.execute({}, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.count >= 2);
      assert.ok("has_more" in result.data);
      assert.ok("offset" in result.data);
    });

    it("supports limit parameter", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      for (let i = 0; i < 5; i++) {
        await store.execute({ content: `Entry ${i}` }, makeContext());
      }
      const list = mod.tools(sdk).find((t) => t.name === "memory_list");
      const result = await list.execute({ limit: 2 }, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.count <= 2);
    });
  });

  // ── memory_search ────────────────────────────────────────────────────────────
  describe("memory_search", () => {
    it("returns results for a basic query", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "TON AI Agent meeting" }, makeContext());

      const search = mod.tools(sdk).find((t) => t.name === "memory_search");
      const result = await search.execute({ query: "TON" }, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.count >= 1);
    });

    it("returns empty results with hint when nothing matches", async () => {
      const sdk = makeSdk();
      const search = mod.tools(sdk).find((t) => t.name === "memory_search");
      const result = await search.execute({ query: "zzznomatch" }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.count, 0);
      assert.ok(result.data.hint);
    });

    it("returns error on invalid start_date format", async () => {
      const sdk = makeSdk();
      const search = mod.tools(sdk).find((t) => t.name === "memory_search");
      const result = await search.execute({ start_date: "not-a-date" }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("start_date"));
      assert.ok(result.hint);
    });

    it("returns error on invalid end_date format", async () => {
      const sdk = makeSdk();
      const search = mod.tools(sdk).find((t) => t.name === "memory_search");
      const result = await search.execute({ end_date: "bad" }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("end_date"));
    });

    it("accepts tags filter as a JSON-encoded string (LLM serialization quirk)", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "GitHub workflow note", tags: ["github"] }, makeContext());

      const search = mod.tools(sdk).find((t) => t.name === "memory_search");
      const result = await search.execute({ tags: '["github"]' }, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.count >= 1, "should find entry via JSON-string tags filter");
    });
  });

  // ── memory_update ────────────────────────────────────────────────────────────
  describe("memory_update", () => {
    it("updates content of an existing entry", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const storeResult = await store.execute({ content: "Original content #old" }, makeContext());
      const id = storeResult.data.id;

      const update = mod.tools(sdk).find((t) => t.name === "memory_update");
      const result = await update.execute(
        { id, content: "Updated content #new #done" },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.entry.id, id);
      assert.equal(result.data.entry.content, "Updated content #new #done");
      assert.ok(result.data.entry.tags.includes("#new"));
      assert.ok(result.data.entry.tags.includes("#done"));
    });

    it("updates only tags without changing content", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const storeResult = await store.execute({ content: "Some content" }, makeContext());
      const id = storeResult.data.id;

      const update = mod.tools(sdk).find((t) => t.name === "memory_update");
      const result = await update.execute(
        { id, tags: ["updated", "reviewed"] },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.entry.content, "Some content");
    });

    it("returns error when entry not found", async () => {
      const sdk = makeSdk();
      const update = mod.tools(sdk).find((t) => t.name === "memory_update");
      const result = await update.execute({ id: 9999 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("9999"));
      assert.ok(result.hint.includes("memory_list"));
    });

    it("returns error when id is not a positive integer", async () => {
      const sdk = makeSdk();
      const update = mod.tools(sdk).find((t) => t.name === "memory_update");
      const result = await update.execute({ id: -1 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("positive integer"));
    });

    it("returns error when new content is empty string", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const storeResult = await store.execute({ content: "Valid content" }, makeContext());
      const id = storeResult.data.id;

      const update = mod.tools(sdk).find((t) => t.name === "memory_update");
      const result = await update.execute({ id, content: "   " }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("empty"));
    });
  });

  // ── memory_delete ─────────────────────────────────────────────────────────────
  describe("memory_delete", () => {
    it("deletes an existing entry", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const storeResult = await store.execute({ content: "To be deleted" }, makeContext());
      const id = storeResult.data.id;

      const del = mod.tools(sdk).find((t) => t.name === "memory_delete");
      const result = await del.execute({ id }, makeContext());
      assert.equal(result.success, true);
      assert.ok(result.data.message.includes(String(id)));
    });

    it("returns error when entry not found", async () => {
      const sdk = makeSdk();
      const del = mod.tools(sdk).find((t) => t.name === "memory_delete");
      const result = await del.execute({ id: 9999 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("9999"));
    });

    it("returns error when id is invalid", async () => {
      const sdk = makeSdk();
      const del = mod.tools(sdk).find((t) => t.name === "memory_delete");
      const result = await del.execute({ id: 0 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("positive integer"));
    });
  });

  // ── memory_list_tags ──────────────────────────────────────────────────────────
  describe("memory_list_tags", () => {
    it("returns tags and entities lists", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "Note #work @anton" }, makeContext());

      const listTags = mod.tools(sdk).find((t) => t.name === "memory_list_tags");
      const result = await listTags.execute({}, makeContext());
      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.data.tags));
      assert.ok(Array.isArray(result.data.entities));
      assert.ok("tag_count" in result.data);
      assert.ok("entity_count" in result.data);
    });
  });

  // ── memory_export ─────────────────────────────────────────────────────────────
  describe("memory_export", () => {
    it("exports all entries with version and count", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "Export entry one #work" }, makeContext());
      await store.execute({ content: "Export entry two @alice" }, makeContext());

      const exp = mod.tools(sdk).find((t) => t.name === "memory_export");
      const result = await exp.execute({}, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.version, 1);
      assert.ok(result.data.exported_at);
      assert.equal(result.data.count, 2);
      assert.ok(Array.isArray(result.data.entries));
      assert.equal(result.data.entries.length, 2);
    });

    it("exported entries include tags and entities arrays", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "Meeting with @bob #work" }, makeContext());

      const exp = mod.tools(sdk).find((t) => t.name === "memory_export");
      const result = await exp.execute({}, makeContext());
      assert.equal(result.success, true);
      const entry = result.data.entries[0];
      assert.ok("tags" in entry, "exported entry should have tags");
      assert.ok("entities" in entry, "exported entry should have entities");
      assert.ok("created_at" in entry, "exported entry should have created_at");
      assert.ok("content" in entry, "exported entry should have content");
    });

    it("returns empty entries array when no data exists", async () => {
      const sdk = makeSdk();
      const exp = mod.tools(sdk).find((t) => t.name === "memory_export");
      const result = await exp.execute({}, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.count, 0);
      assert.deepEqual(result.data.entries, []);
    });
  });

  // ── memory_import ─────────────────────────────────────────────────────────────
  describe("memory_import", () => {
    it("imports entries and returns count", async () => {
      const sdk = makeSdk();
      const imp = mod.tools(sdk).find((t) => t.name === "memory_import");
      const entries = [
        { content: "Imported entry one #work", tags: ["work"] },
        { content: "Imported entry two @carol", created_at: "2026-03-01T00:00:00.000Z" },
      ];
      const result = await imp.execute({ entries }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.imported, 2);
      assert.equal(result.data.skipped, 0);
    });

    it("skips duplicates by default", async () => {
      const sdk = makeSdk();
      // Pre-store an entry
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "Duplicate content" }, makeContext());

      const imp = mod.tools(sdk).find((t) => t.name === "memory_import");
      const result = await imp.execute(
        { entries: [{ content: "Duplicate content" }] },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.skipped, 1);
      assert.equal(result.data.imported, 0);
    });

    it("imports duplicates when skip_duplicates is false", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "Same content" }, makeContext());

      const imp = mod.tools(sdk).find((t) => t.name === "memory_import");
      const result = await imp.execute(
        { entries: [{ content: "Same content" }], skip_duplicates: false },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.imported, 1);
    });

    it("preserves original created_at timestamps", async () => {
      const sdk = makeSdk();
      const imp = mod.tools(sdk).find((t) => t.name === "memory_import");
      const entries = [{ content: "Historical entry", created_at: "2025-01-15T10:00:00.000Z" }];
      const result = await imp.execute({ entries }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.imported, 1);

      // Verify timestamp was stored
      const entry = sdk.db._store.memory_entries.find((e) => e.content === "Historical entry");
      assert.ok(entry, "entry should be stored");
      const expectedTs = Math.floor(new Date("2025-01-15T10:00:00.000Z").getTime() / 1000);
      assert.equal(entry.created_at, expectedTs);
    });

    it("returns error when entries is empty array", async () => {
      const sdk = makeSdk();
      const imp = mod.tools(sdk).find((t) => t.name === "memory_import");
      const result = await imp.execute({ entries: [] }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("non-empty array"));
      assert.ok(result.hint.includes("memory_export"));
    });

    it("returns error when entries is missing", async () => {
      const sdk = makeSdk();
      const imp = mod.tools(sdk).find((t) => t.name === "memory_import");
      const result = await imp.execute({}, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("skips items with empty content silently", async () => {
      const sdk = makeSdk();
      const imp = mod.tools(sdk).find((t) => t.name === "memory_import");
      const entries = [
        { content: "Valid entry" },
        { content: "" },
        { content: "   " },
      ];
      const result = await imp.execute({ entries }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.imported, 1);
      assert.equal(result.data.skipped, 2);
    });

    it("round-trips: export then import restores all entries", async () => {
      const sdk = makeSdk();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      await store.execute({ content: "Round-trip entry A #alpha" }, makeContext());
      await store.execute({ content: "Round-trip entry B @dave" }, makeContext());

      const exp = mod.tools(sdk).find((t) => t.name === "memory_export");
      const exportResult = await exp.execute({}, makeContext());
      assert.equal(exportResult.success, true);
      assert.equal(exportResult.data.count, 2);

      // Import into a fresh SDK (fresh DB)
      const sdk2 = makeSdk();
      const imp = mod.tools(sdk2).find((t) => t.name === "memory_import");
      const importResult = await imp.execute(
        { entries: exportResult.data.entries },
        makeContext()
      );
      assert.equal(importResult.success, true);
      assert.equal(importResult.data.imported, 2);
      assert.equal(importResult.data.skipped, 0);

      // Verify entries are in the new DB
      const list = mod.tools(sdk2).find((t) => t.name === "memory_list");
      const listResult = await list.execute({}, makeContext());
      assert.equal(listResult.success, true);
      assert.equal(listResult.data.total, 2);
    });
  });

  // ── memory_relate ────────────────────────────────────────────────────────────
  describe("memory_relate", () => {
    it("returns error when associative mode is not enabled", async () => {
      const sdk = makeSdk(); // no associative mode
      const tool = mod.tools(sdk).find((t) => t.name === "memory_relate");
      const result = await tool.execute({ source_id: 1, target_id: 2 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("not enabled"));
      assert.ok(result.hint.includes("enableAssociativeMode"));
    });

    it("creates a relation between two existing entries", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const r1 = await store.execute({ content: "Entry A" }, makeContext());
      const r2 = await store.execute({ content: "Entry B" }, makeContext());
      const idA = r1.data.id;
      const idB = r2.data.id;

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      const result = await relate.execute(
        { source_id: idA, target_id: idB, relation_type: "causes" },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.source_id, idA);
      assert.equal(result.data.target_id, idB);
      assert.equal(result.data.relation_type, "causes");
      assert.ok(result.data.message.includes("causes"));
    });

    it("defaults relation_type to related_to", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const r1 = await store.execute({ content: "Entry X" }, makeContext());
      const r2 = await store.execute({ content: "Entry Y" }, makeContext());

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      const result = await relate.execute(
        { source_id: r1.data.id, target_id: r2.data.id },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.relation_type, "related_to");
    });

    it("returns error when source_id is invalid", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      const result = await relate.execute(
        { source_id: 0, target_id: 1 },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("source_id"));
    });

    it("returns error when source_id and target_id are the same", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const r = await store.execute({ content: "Self-loop entry" }, makeContext());

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      const result = await relate.execute(
        { source_id: r.data.id, target_id: r.data.id },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("different"));
    });

    it("returns error when source entry does not exist", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const r = await store.execute({ content: "Existing entry" }, makeContext());

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      const result = await relate.execute(
        { source_id: 9999, target_id: r.data.id },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("not found"));
    });

    it("returns error when target entry does not exist", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const r = await store.execute({ content: "Existing entry" }, makeContext());

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      const result = await relate.execute(
        { source_id: r.data.id, target_id: 9999 },
        makeContext()
      );
      assert.equal(result.success, false);
      assert.ok(result.error.includes("not found"));
    });

    it("clamps confidence to [0, 1]", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const r1 = await store.execute({ content: "C1" }, makeContext());
      const r2 = await store.execute({ content: "C2" }, makeContext());

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      const result = await relate.execute(
        { source_id: r1.data.id, target_id: r2.data.id, confidence: 1.5 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.confidence, 1.0);
    });
  });

  // ── memory_find_connections ───────────────────────────────────────────────────
  describe("memory_find_connections", () => {
    it("returns error when associative mode is not enabled", async () => {
      const sdk = makeSdk();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_find_connections");
      const result = await tool.execute({ entry_id: 1 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("not enabled"));
    });

    it("returns error when entry does not exist", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_find_connections");
      const result = await tool.execute({ entry_id: 9999 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("not found"));
    });

    it("returns empty connections for isolated entry", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const r = await store.execute({ content: "Isolated entry" }, makeContext());

      const tool = mod.tools(sdk).find((t) => t.name === "memory_find_connections");
      const result = await tool.execute({ entry_id: r.data.id }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.count, 0);
      assert.deepEqual(result.data.connections, []);
    });

    it("finds direct outgoing connections (depth 1)", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const rA = await store.execute({ content: "Node A" }, makeContext());
      const rB = await store.execute({ content: "Node B" }, makeContext());

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      await relate.execute(
        { source_id: rA.data.id, target_id: rB.data.id, relation_type: "causes" },
        makeContext()
      );

      const find = mod.tools(sdk).find((t) => t.name === "memory_find_connections");
      const result = await find.execute(
        { entry_id: rA.data.id, direction: "outgoing", depth: 1 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.count, 1);
      assert.equal(result.data.connections[0].entry.id, rB.data.id);
      assert.equal(result.data.connections[0].relation_type, "causes");
      assert.equal(result.data.connections[0].direction, "outgoing");
    });

    it("finds direct incoming connections (depth 1)", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const rA = await store.execute({ content: "Source node" }, makeContext());
      const rB = await store.execute({ content: "Target node" }, makeContext());

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      await relate.execute(
        { source_id: rA.data.id, target_id: rB.data.id, relation_type: "depends_on" },
        makeContext()
      );

      const find = mod.tools(sdk).find((t) => t.name === "memory_find_connections");
      const result = await find.execute(
        { entry_id: rB.data.id, direction: "incoming", depth: 1 },
        makeContext()
      );
      assert.equal(result.success, true);
      assert.equal(result.data.count, 1);
      assert.equal(result.data.connections[0].entry.id, rA.data.id);
      assert.equal(result.data.connections[0].direction, "incoming");
    });

    it("finds connections in both directions by default", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const rA = await store.execute({ content: "Center node" }, makeContext());
      const rB = await store.execute({ content: "Outgoing target" }, makeContext());
      const rC = await store.execute({ content: "Incoming source" }, makeContext());

      const relate = mod.tools(sdk).find((t) => t.name === "memory_relate");
      await relate.execute({ source_id: rA.data.id, target_id: rB.data.id }, makeContext());
      await relate.execute({ source_id: rC.data.id, target_id: rA.data.id }, makeContext());

      const find = mod.tools(sdk).find((t) => t.name === "memory_find_connections");
      const result = await find.execute({ entry_id: rA.data.id }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.count, 2);
    });

    it("returns error for invalid entry_id", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const tool = mod.tools(sdk).find((t) => t.name === "memory_find_connections");
      const result = await tool.execute({ entry_id: -1 }, makeContext());
      assert.equal(result.success, false);
      assert.ok(result.error.includes("entry_id"));
    });

    it("clamps depth to maximum of 3", async () => {
      const sdk = makeSdkWithAssociativeMode();
      const store = mod.tools(sdk).find((t) => t.name === "memory_store");
      const r = await store.execute({ content: "Depth test entry" }, makeContext());

      const find = mod.tools(sdk).find((t) => t.name === "memory_find_connections");
      const result = await find.execute({ entry_id: r.data.id, depth: 10 }, makeContext());
      assert.equal(result.success, true);
      assert.equal(result.data.depth_searched, 3);
    });
  });
});
