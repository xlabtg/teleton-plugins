/**
 * Memory Plugin — Persistent memory with advanced filtering
 *
 * Provides tag-based, entity-based, and composite-query memory storage and retrieval.
 * All entries are stored in an isolated SQLite database via sdk.db.
 *
 * Tools:
 *   memory_store       — Save a memory entry with optional tags and detected entities
 *   memory_list        — List all entries (paginated), no filters required
 *   memory_search      — Search entries by tags, entity, date range, or free text
 *   memory_update      — Update content and/or tags of an existing entry
 *   memory_delete      — Delete a specific memory entry by ID
 *   memory_list_tags   — List all tags and entities in use with counts
 *   memory_export      — Export all memory entries to JSON for backup/migration
 *   memory_import      — Import memory entries from a previously exported JSON blob
 */

export const manifest = {
  name: "memory",
  version: "1.2.0",
  sdkVersion: ">=1.0.0",
  description: "Persistent memory with tag-based and entity-based advanced filtering",
};

// ─── Database Migration ────────────────────────────────────────────────────────

export function migrate(db, config = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      content     TEXT    NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER,
      user_id     TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_tags (
      entry_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      tag      TEXT    NOT NULL,
      PRIMARY KEY (entry_id, tag)
    );

    CREATE TABLE IF NOT EXISTS memory_entities (
      entry_id    INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      entity_type TEXT    NOT NULL,
      entity_name TEXT    NOT NULL,
      PRIMARY KEY (entry_id, entity_type, entity_name)
    );

    -- Performance indexes
    CREATE INDEX IF NOT EXISTS idx_memory_created_at  ON memory_entries(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_updated_at  ON memory_entries(updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag    ON memory_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_memory_entities    ON memory_entities(entity_name);
    CREATE INDEX IF NOT EXISTS idx_memory_tags_entry  ON memory_tags(entry_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entities_entry ON memory_entities(entry_id);

    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS memory_schema_version (
      version  INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT OR IGNORE INTO memory_schema_version (version) VALUES (1);
  `);

  // v2: add updated_at column if it doesn't exist (safe for existing DBs)
  try {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN updated_at INTEGER`);
    db.exec(`INSERT OR IGNORE INTO memory_schema_version (version) VALUES (2)`);
  } catch {
    // Column already exists — no-op
  }

  // v3: optional associative/link-based memory layer
  // Only created when config.enableAssociativeMode === true
  if (config.enableAssociativeMode) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_relations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        source_entry_id  INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        target_entry_id  INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        relation_type    TEXT    NOT NULL DEFAULT 'related_to',
        confidence       REAL    NOT NULL DEFAULT 1.0,
        created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(source_entry_id, target_entry_id, relation_type)
      );
      CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(source_entry_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(target_entry_id);
    `);
    db.exec(`INSERT OR IGNORE INTO memory_schema_version (version) VALUES (3)`);
  }
}

// ─── Entity Extraction ────────────────────────────────────────────────────────

/**
 * Extract entities from text using pattern matching.
 * Returns an array of { entity_type, entity_name } objects.
 *
 * Supported patterns:
 *   @mention   → person
 *   #hashtag   → tag (also registered as entity for traversal)
 *   domain.tld → domain
 *   Capitalized Multi-Word Name → name
 */
function extractEntities(text) {
  const entities = [];
  const seen = new Set();

  const add = (type, name) => {
    const key = `${type}:${name.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ entity_type: type, entity_name: name.toLowerCase() });
    }
  };

  // @mentions → people
  for (const m of text.matchAll(/@([\w.-]+)/g)) {
    add("person", m[1]);
  }

  // #hashtags → tags (also treated as entities for traversal)
  for (const m of text.matchAll(/#([\w-]+)/g)) {
    add("tag", m[1]);
  }

  // Domains (e.g. ton.org, github.com)
  for (const m of text.matchAll(/\b([\w-]+\.(org|com|io|net|app|dev|xyz|ton))\b/gi)) {
    add("domain", m[1].toLowerCase());
  }

  // Capitalized multi-word names (e.g. "Anton Petrov", "TON AI Agent")
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)+)\b/g)) {
    add("name", m[1]);
  }

  return entities;
}

// ─── Helper: coerce a tags value to an array ─────────────────────────────────

/**
 * LLMs occasionally serialize array arguments as a JSON string
 * (e.g. '["work","urgent"]' instead of ["work","urgent"]).
 * This helper normalises both forms so downstream code always receives
 * a plain JS array (or undefined/null for missing values).
 */
function coerceToArray(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Not valid JSON — fall through and treat as a single tag
      }
    }
    // Single tag provided as a plain string (e.g. "work")
    return trimmed ? [trimmed] : [];
  }
  return value;
}

// ─── Helper: parse tags from content and explicit list ───────────────────────

function parseTags(content, extraTags) {
  const tags = new Set();

  // Inline #hashtags from content
  for (const m of content.matchAll(/#([\w-]+)/g)) {
    tags.add(m[1].toLowerCase());
  }

  // Explicitly provided tags — coerce to array first to handle JSON strings
  const normalised = coerceToArray(extraTags);
  if (Array.isArray(normalised)) {
    for (const t of normalised) {
      if (typeof t === "string" && t.trim()) {
        tags.add(t.replace(/^#/, "").toLowerCase().trim());
      }
    }
  }

  return [...tags];
}

// ─── Helper: format entry for output ─────────────────────────────────────────

function formatEntry(entry, tags, entities) {
  return {
    id: entry.id,
    content: entry.content,
    created_at: new Date(entry.created_at * 1000).toISOString(),
    updated_at: entry.updated_at ? new Date(entry.updated_at * 1000).toISOString() : null,
    user_id: entry.user_id ?? null,
    tags: tags.map((r) => `#${r.tag}`),
    entities: entities.map((r) => ({ type: r.entity_type, name: r.entity_name })),
  };
}

// ─── Helper: fetch tags and entities for an entry ────────────────────────────

function loadTagsAndEntities(sdk, entryId) {
  const tags = sdk.db
    .prepare(`SELECT tag FROM memory_tags WHERE entry_id = ?`)
    .all(entryId);
  const entities = sdk.db
    .prepare(`SELECT entity_type, entity_name FROM memory_entities WHERE entry_id = ?`)
    .all(entryId);
  return { tags, entities };
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export const tools = (sdk) => [
  // ── memory_store ──────────────────────────────────────────────────────────
  {
    name: "memory_store",
    description:
      "Save a memory entry with optional tags and auto-detected entities (people, projects, domains). " +
      "Tags can be inline (#work, #urgent) or passed via the tags parameter. " +
      "Use this whenever the user wants to remember something for later.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text to remember. May include inline #tags and @mentions.",
        },
        tags: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            { type: "string" },
          ],
          description: "Optional list of tags to attach (e.g. [\"work\", \"urgent\"]). #prefix is optional. May also be provided as a JSON-encoded string.",
        },
      },
      required: ["content"],
    },
    execute: async (params, context) => {
      try {
        const { content, tags: extraTags } = params;
        if (!content || !content.trim()) {
          return {
            success: false,
            error: "content must not be empty",
            hint: "Provide a non-empty string in the content parameter.",
          };
        }

        const userId = String(context.senderId ?? "");
        const allTags = parseTags(content, extraTags);
        const entities = extractEntities(content);

        const result = sdk.db
          .prepare(`INSERT INTO memory_entries (content, user_id) VALUES (?, ?)`)
          .run(content.trim(), userId || null);

        const entryId = result.lastInsertRowid;

        const insertTag = sdk.db.prepare(
          `INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)`
        );
        const insertEntity = sdk.db.prepare(
          `INSERT OR IGNORE INTO memory_entities (entry_id, entity_type, entity_name) VALUES (?, ?, ?)`
        );

        for (const tag of allTags) {
          insertTag.run(entryId, tag);
        }
        for (const { entity_type, entity_name } of entities) {
          insertEntity.run(entryId, entity_type, entity_name);
        }

        sdk.log.info(`memory_store: saved entry #${entryId} with ${allTags.length} tags, ${entities.length} entities`);

        return {
          success: true,
          data: {
            id: entryId,
            tags: allTags.map((t) => `#${t}`),
            entities: entities.map((e) => ({ type: e.entity_type, name: e.entity_name })),
            message: `Memory saved (id ${entryId})`,
          },
        };
      } catch (error) {
        sdk.log.error(`memory_store error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Check that content is a valid string. Use memory_list_tags to see available tags.",
        };
      }
    },
  },

  // ── memory_list ───────────────────────────────────────────────────────────
  {
    name: "memory_list",
    description:
      "List all memory entries, newest first, with optional pagination. " +
      "Use this to browse all stored memories without filters. " +
      "For filtered search, use memory_search instead.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum number of entries to return (default 20, max 100).",
          minimum: 1,
          maximum: 100,
        },
        offset: {
          type: "integer",
          description: "Number of entries to skip for pagination (default 0).",
          minimum: 0,
        },
      },
    },
    execute: async (params, _context) => {
      try {
        const limit = Math.min(Number(params.limit ?? 20), 100);
        const offset = Math.max(Number(params.offset ?? 0), 0);

        const total = sdk.db
          .prepare(`SELECT COUNT(*) AS n FROM memory_entries`)
          .get().n;

        const entries = sdk.db
          .prepare(
            `SELECT id, content, created_at, updated_at, user_id
             FROM memory_entries
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(limit, offset);

        const results = entries.map((entry) => {
          const { tags, entities } = loadTagsAndEntities(sdk, entry.id);
          return formatEntry(entry, tags, entities);
        });

        sdk.log.info(`memory_list: returned ${results.length} of ${total} entries`);

        return {
          success: true,
          data: {
            results,
            count: results.length,
            total,
            offset,
            has_more: offset + results.length < total,
          },
        };
      } catch (error) {
        sdk.log.error(`memory_list error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Ensure limit is 1–100 and offset is non-negative.",
        };
      }
    },
  },

  // ── memory_search ─────────────────────────────────────────────────────────
  {
    name: "memory_search",
    description:
      "Search saved memory entries with advanced filtering. " +
      "Supports: free text search, tag filter (one or more), entity filter (person/project/domain), " +
      "date range (start_date / end_date in YYYY-MM-DD), and result limit. " +
      "All filters are optional and can be combined (AND logic). " +
      "Examples: search({ tags: [\"work\"] }), search({ entity: \"anton\" }), " +
      "search({ query: \"TON\", start_date: \"2026-03-01\" })",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text search within memory content (case-insensitive substring match).",
        },
        tags: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            { type: "string" },
          ],
          description: "Filter entries that have ALL of the specified tags. May also be provided as a JSON-encoded string.",
        },
        entity: {
          type: "string",
          description: "Filter entries mentioning this entity (person @mention, project name, domain, etc.).",
        },
        start_date: {
          type: "string",
          description: "Start of date range (YYYY-MM-DD), inclusive.",
        },
        end_date: {
          type: "string",
          description: "End of date range (YYYY-MM-DD), inclusive.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return (default 20, max 100).",
          minimum: 1,
          maximum: 100,
        },
      },
    },
    execute: async (params, _context) => {
      try {
        const {
          query,
          tags: filterTags,
          entity,
          start_date,
          end_date,
          limit = 20,
        } = params;

        const maxLimit = Math.min(Number(limit) || 20, 100);

        const conditions = [];
        const bindings = [];

        if (query && query.trim()) {
          conditions.push(`e.content LIKE ?`);
          bindings.push(`%${query.trim()}%`);
        }

        if (start_date) {
          const ts = Math.floor(new Date(start_date).getTime() / 1000);
          if (isNaN(ts)) {
            return {
              success: false,
              error: `Invalid start_date: "${start_date}"`,
              hint: "Use ISO 8601 format: YYYY-MM-DD (e.g. \"2026-03-01\").",
            };
          }
          conditions.push(`e.created_at >= ?`);
          bindings.push(ts);
        }

        if (end_date) {
          const ts = Math.floor(new Date(`${end_date}T23:59:59Z`).getTime() / 1000);
          if (isNaN(ts)) {
            return {
              success: false,
              error: `Invalid end_date: "${end_date}"`,
              hint: "Use ISO 8601 format: YYYY-MM-DD (e.g. \"2026-03-31\").",
            };
          }
          conditions.push(`e.created_at <= ?`);
          bindings.push(ts);
        }

        if (entity && entity.trim()) {
          const eName = entity.trim().replace(/^@/, "").toLowerCase();
          conditions.push(
            `e.id IN (SELECT entry_id FROM memory_entities WHERE entity_name LIKE ?)`
          );
          bindings.push(`%${eName}%`);
        }

        // Tag filtering: entry must have ALL requested tags
        // coerceToArray handles JSON-string inputs from LLMs
        const coercedTags = coerceToArray(filterTags);
        const normalizedTags = Array.isArray(coercedTags)
          ? coercedTags.map((t) => t.replace(/^#/, "").toLowerCase().trim()).filter(Boolean)
          : [];

        for (const tag of normalizedTags) {
          conditions.push(
            `e.id IN (SELECT entry_id FROM memory_tags WHERE tag = ?)`
          );
          bindings.push(tag);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const entries = sdk.db
          .prepare(
            `SELECT e.id, e.content, e.created_at, e.updated_at, e.user_id
             FROM memory_entries e
             ${whereClause}
             ORDER BY e.created_at DESC
             LIMIT ?`
          )
          .all(...bindings, maxLimit);

        if (entries.length === 0) {
          return {
            success: true,
            data: {
              results: [],
              count: 0,
              message: "No matching memory entries found.",
              hint: "Try memory_list_tags to see available tags and entities, or broaden your search.",
            },
          };
        }

        const results = entries.map((entry) => {
          const { tags, entities } = loadTagsAndEntities(sdk, entry.id);
          return formatEntry(entry, tags, entities);
        });

        sdk.log.info(`memory_search: returned ${results.length} entries`);

        return {
          success: true,
          data: { results, count: results.length },
        };
      } catch (error) {
        sdk.log.error(`memory_search error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Try memory_list_tags to see available tags and entities.",
        };
      }
    },
  },

  // ── memory_update ─────────────────────────────────────────────────────────
  {
    name: "memory_update",
    description:
      "Update the content and/or tags of an existing memory entry. " +
      "Tags and entities are re-extracted from the new content automatically. " +
      "Use memory_search or memory_list first to find the entry ID.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "The ID of the memory entry to update.",
        },
        content: {
          type: "string",
          description: "New content to replace the existing entry. May include inline #tags and @mentions.",
        },
        tags: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            { type: "string" },
          ],
          description: "Optional list of tags to attach (replaces existing tags). #prefix is optional. May also be provided as a JSON-encoded string.",
        },
      },
      required: ["id"],
    },
    execute: async (params, _context) => {
      try {
        const id = Number(params.id);
        if (!Number.isInteger(id) || id < 1) {
          return {
            success: false,
            error: "id must be a positive integer",
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }

        const entry = sdk.db
          .prepare(`SELECT id, content FROM memory_entries WHERE id = ?`)
          .get(id);

        if (!entry) {
          return {
            success: false,
            error: `Memory entry #${id} not found`,
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }

        const newContent = params.content !== undefined ? String(params.content).trim() : null;
        if (newContent !== null && !newContent) {
          return {
            success: false,
            error: "content must not be empty",
            hint: "Provide a non-empty string, or omit content to update only tags.",
          };
        }

        const contentToUse = newContent ?? entry.content;
        const now = Math.floor(Date.now() / 1000);

        sdk.db
          .prepare(`UPDATE memory_entries SET content = ?, updated_at = ? WHERE id = ?`)
          .run(contentToUse, now, id);

        // Re-index tags and entities from new content
        sdk.db.prepare(`DELETE FROM memory_tags WHERE entry_id = ?`).run(id);
        sdk.db.prepare(`DELETE FROM memory_entities WHERE entry_id = ?`).run(id);

        const allTags = parseTags(contentToUse, params.tags);
        const entities = extractEntities(contentToUse);

        const insertTag = sdk.db.prepare(
          `INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)`
        );
        const insertEntity = sdk.db.prepare(
          `INSERT OR IGNORE INTO memory_entities (entry_id, entity_type, entity_name) VALUES (?, ?, ?)`
        );

        for (const tag of allTags) {
          insertTag.run(id, tag);
        }
        for (const { entity_type, entity_name } of entities) {
          insertEntity.run(id, entity_type, entity_name);
        }

        sdk.log.info(`memory_update: updated entry #${id}`);

        const { tags, entities: ents } = loadTagsAndEntities(sdk, id);
        const updatedEntry = sdk.db
          .prepare(`SELECT id, content, created_at, updated_at, user_id FROM memory_entries WHERE id = ?`)
          .get(id);

        return {
          success: true,
          data: {
            entry: formatEntry(updatedEntry, tags, ents),
            message: `Memory entry #${id} updated successfully.`,
          },
        };
      } catch (error) {
        sdk.log.error(`memory_update error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Use memory_list or memory_search to find valid entry IDs.",
        };
      }
    },
  },

  // ── memory_delete ─────────────────────────────────────────────────────────
  {
    name: "memory_delete",
    description:
      "Delete a specific memory entry by its ID. " +
      "Use memory_search or memory_list first to find the entry ID. " +
      "Tags and entities associated with the entry are removed automatically.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "The ID of the memory entry to delete.",
        },
      },
      required: ["id"],
    },
    execute: async (params, _context) => {
      try {
        const id = Number(params.id);
        if (!Number.isInteger(id) || id < 1) {
          return {
            success: false,
            error: "id must be a positive integer",
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }

        const entry = sdk.db
          .prepare(`SELECT id FROM memory_entries WHERE id = ?`)
          .get(id);

        if (!entry) {
          return {
            success: false,
            error: `Memory entry #${id} not found`,
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }

        sdk.db.prepare(`DELETE FROM memory_entries WHERE id = ?`).run(id);

        sdk.log.info(`memory_delete: removed entry #${id}`);

        return {
          success: true,
          data: { message: `Memory entry #${id} deleted successfully.` },
        };
      } catch (error) {
        sdk.log.error(`memory_delete error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Use memory_list or memory_search to find valid entry IDs.",
        };
      }
    },
  },

  // ── memory_list_tags ──────────────────────────────────────────────────────
  {
    name: "memory_list_tags",
    description:
      "List all tags and entities currently in use across all memory entries, with usage counts. " +
      "Useful for discovering what tags exist before filtering with memory_search.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_params, _context) => {
      try {
        const tags = sdk.db
          .prepare(
            `SELECT tag, COUNT(*) AS count
             FROM memory_tags
             GROUP BY tag
             ORDER BY count DESC, tag ASC`
          )
          .all();

        const entities = sdk.db
          .prepare(
            `SELECT entity_type, entity_name, COUNT(*) AS count
             FROM memory_entities
             GROUP BY entity_type, entity_name
             ORDER BY count DESC, entity_name ASC
             LIMIT 50`
          )
          .all();

        return {
          success: true,
          data: {
            tags: tags.map((r) => ({ tag: `#${r.tag}`, count: r.count })),
            entities: entities.map((r) => ({
              type: r.entity_type,
              name: r.entity_name,
              count: r.count,
            })),
            tag_count: tags.length,
            entity_count: entities.length,
          },
        };
      } catch (error) {
        sdk.log.error(`memory_list_tags error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "If the database is empty, try memory_store to add your first entry.",
        };
      }
    },
  },

  // ── memory_export ─────────────────────────────────────────────────────────
  {
    name: "memory_export",
    description:
      "Export all memory entries to a JSON blob for backup or migration. " +
      "The exported data can be imported into another instance using memory_import.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_params, _context) => {
      try {
        const entries = sdk.db
          .prepare(`SELECT id, content, created_at, updated_at, user_id FROM memory_entries ORDER BY id ASC`)
          .all();

        const exported = entries.map((entry) => {
          const { tags, entities } = loadTagsAndEntities(sdk, entry.id);
          return {
            id: entry.id,
            content: entry.content,
            created_at: new Date(entry.created_at * 1000).toISOString(),
            updated_at: entry.updated_at ? new Date(entry.updated_at * 1000).toISOString() : null,
            user_id: entry.user_id ?? null,
            tags: tags.map((r) => r.tag),
            entities: entities.map((r) => ({ type: r.entity_type, name: r.entity_name })),
          };
        });

        sdk.log.info(`memory_export: exported ${exported.length} entries`);

        return {
          success: true,
          data: {
            version: 1,
            exported_at: new Date().toISOString(),
            count: exported.length,
            entries: exported,
          },
        };
      } catch (error) {
        sdk.log.error(`memory_export error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Ensure the database is accessible and not corrupted.",
        };
      }
    },
  },

  // ── memory_import ─────────────────────────────────────────────────────────
  {
    name: "memory_import",
    description:
      "Import memory entries from a JSON blob previously created by memory_export. " +
      "Entries are inserted with new IDs to avoid conflicts with existing data. " +
      "Duplicate content (exact match) is skipped by default.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          description: "Array of entry objects from memory_export output.",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              created_at: { type: "string" },
            },
            required: ["content"],
          },
        },
        skip_duplicates: {
          type: "boolean",
          description: "Skip entries whose exact content already exists (default true).",
        },
      },
      required: ["entries"],
    },
    execute: async (params, _context) => {
      try {
        const { entries, skip_duplicates = true } = params;

        if (!Array.isArray(entries) || entries.length === 0) {
          return {
            success: false,
            error: "entries must be a non-empty array",
            hint: "Use memory_export to get a valid export blob, then pass its entries array here.",
          };
        }

        const insertEntry = sdk.db.prepare(
          `INSERT INTO memory_entries (content, created_at, user_id) VALUES (?, ?, ?)`
        );
        const insertTag = sdk.db.prepare(
          `INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)`
        );
        const insertEntity = sdk.db.prepare(
          `INSERT OR IGNORE INTO memory_entities (entry_id, entity_type, entity_name) VALUES (?, ?, ?)`
        );
        const checkDup = sdk.db.prepare(
          `SELECT id FROM memory_entries WHERE content = ? LIMIT 1`
        );

        let imported = 0;
        let skipped = 0;
        const errors = [];

        for (const item of entries) {
          if (!item.content || !String(item.content).trim()) {
            skipped++;
            continue;
          }

          const content = String(item.content).trim();

          if (skip_duplicates && checkDup.get(content)) {
            skipped++;
            continue;
          }

          try {
            // Preserve original created_at if provided and valid
            let createdAt = Math.floor(Date.now() / 1000);
            if (item.created_at) {
              const ts = Math.floor(new Date(item.created_at).getTime() / 1000);
              if (!isNaN(ts)) createdAt = ts;
            }

            const result = insertEntry.run(content, createdAt, item.user_id ?? null);
            const entryId = result.lastInsertRowid;

            const allTags = parseTags(content, item.tags);
            const entities = extractEntities(content);

            for (const tag of allTags) {
              insertTag.run(entryId, tag);
            }
            for (const { entity_type, entity_name } of entities) {
              insertEntity.run(entryId, entity_type, entity_name);
            }

            imported++;
          } catch (err) {
            errors.push({ content: content.slice(0, 50), error: err.message });
          }
        }

        sdk.log.info(`memory_import: imported ${imported}, skipped ${skipped}, errors ${errors.length}`);

        return {
          success: true,
          data: {
            imported,
            skipped,
            errors: errors.length > 0 ? errors : undefined,
            message: `Imported ${imported} entries. Skipped ${skipped}.`,
          },
        };
      } catch (error) {
        sdk.log.error(`memory_import error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Ensure entries is a valid array from memory_export output.",
        };
      }
    },
  },

  // ── memory_relate ─────────────────────────────────────────────────────────
  // Only functional when config.enableAssociativeMode === true
  {
    name: "memory_relate",
    description:
      "Create an explicit relationship between two memory entries. " +
      "Requires enableAssociativeMode to be enabled in config. " +
      "Use this to encode connections such as 'causes', 'depends_on', 'similar_to', 'related_to'. " +
      "Relationships are undirected by default (source→target), but direction can be queried via memory_find_connections.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        source_id: {
          type: "integer",
          description: "ID of the source memory entry.",
        },
        target_id: {
          type: "integer",
          description: "ID of the target memory entry.",
        },
        relation_type: {
          type: "string",
          description:
            "Type of relationship (e.g. 'causes', 'depends_on', 'similar_to', 'related_to'). Defaults to 'related_to'.",
        },
        confidence: {
          type: "number",
          description: "Confidence score (0.0–1.0) for future ML weighting. Defaults to 1.0.",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["source_id", "target_id"],
    },
    execute: async (params, _context) => {
      try {
        // Check associative mode
        const modeCheck = sdk.db
          .prepare(`SELECT version FROM memory_schema_version WHERE version = 3`)
          .get();
        if (!modeCheck) {
          return {
            success: false,
            error: "Associative memory mode is not enabled",
            hint: "Set enableAssociativeMode: true in the plugin config and restart.",
          };
        }

        const sourceId = Number(params.source_id);
        const targetId = Number(params.target_id);

        if (!Number.isInteger(sourceId) || sourceId < 1) {
          return {
            success: false,
            error: "source_id must be a positive integer",
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }
        if (!Number.isInteger(targetId) || targetId < 1) {
          return {
            success: false,
            error: "target_id must be a positive integer",
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }
        if (sourceId === targetId) {
          return {
            success: false,
            error: "source_id and target_id must be different entries",
            hint: "A relation requires two distinct memory entries.",
          };
        }

        // Verify both entries exist
        const source = sdk.db
          .prepare(`SELECT id FROM memory_entries WHERE id = ?`)
          .get(sourceId);
        if (!source) {
          return {
            success: false,
            error: `Memory entry #${sourceId} not found`,
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }
        const target = sdk.db
          .prepare(`SELECT id FROM memory_entries WHERE id = ?`)
          .get(targetId);
        if (!target) {
          return {
            success: false,
            error: `Memory entry #${targetId} not found`,
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }

        const relationType = (params.relation_type ?? "related_to").trim() || "related_to";
        const confidence = Math.max(0, Math.min(1, Number(params.confidence ?? 1.0)));

        const result = sdk.db
          .prepare(
            `INSERT OR REPLACE INTO memory_relations
               (source_entry_id, target_entry_id, relation_type, confidence)
             VALUES (?, ?, ?, ?)`
          )
          .run(sourceId, targetId, relationType, confidence);

        sdk.log.info(
          `memory_relate: linked #${sourceId} -[${relationType}]-> #${targetId}`
        );

        return {
          success: true,
          data: {
            id: Number(result.lastInsertRowid),
            source_id: sourceId,
            target_id: targetId,
            relation_type: relationType,
            confidence,
            message: `Relation created: entry #${sourceId} -[${relationType}]-> entry #${targetId}`,
          },
        };
      } catch (error) {
        sdk.log.error(`memory_relate error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Ensure source_id and target_id are valid, distinct entry IDs.",
        };
      }
    },
  },

  // ── memory_find_connections ────────────────────────────────────────────────
  // Only functional when config.enableAssociativeMode === true
  {
    name: "memory_find_connections",
    description:
      "Find memory entries connected to a given entry via explicit relationships. " +
      "Requires enableAssociativeMode to be enabled in config. " +
      "Supports BFS traversal up to 3 hops, optional direction and relation_type filters. " +
      "Useful for multi-hop reasoning: 'How is A connected to B?'",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        entry_id: {
          type: "integer",
          description: "Starting entry ID for graph traversal.",
        },
        relation_type: {
          type: "string",
          description: "Filter by relation type (e.g. 'causes', 'depends_on'). Omit to include all.",
        },
        direction: {
          type: "string",
          enum: ["outgoing", "incoming", "both"],
          description:
            "Traverse direction: 'outgoing' (entry is source), 'incoming' (entry is target), or 'both'. Defaults to 'both'.",
        },
        depth: {
          type: "integer",
          description: "Number of hops to traverse (1–3). Defaults to 1.",
          minimum: 1,
          maximum: 3,
        },
      },
      required: ["entry_id"],
    },
    execute: async (params, _context) => {
      try {
        // Check associative mode
        const modeCheck = sdk.db
          .prepare(`SELECT version FROM memory_schema_version WHERE version = 3`)
          .get();
        if (!modeCheck) {
          return {
            success: false,
            error: "Associative memory mode is not enabled",
            hint: "Set enableAssociativeMode: true in the plugin config and restart.",
          };
        }

        const startId = Number(params.entry_id);
        if (!Number.isInteger(startId) || startId < 1) {
          return {
            success: false,
            error: "entry_id must be a positive integer",
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }

        const entry = sdk.db
          .prepare(`SELECT id FROM memory_entries WHERE id = ?`)
          .get(startId);
        if (!entry) {
          return {
            success: false,
            error: `Memory entry #${startId} not found`,
            hint: "Use memory_list or memory_search to find valid entry IDs.",
          };
        }

        const direction = params.direction ?? "both";
        const maxDepth = Math.max(1, Math.min(3, Number(params.depth ?? 1)));
        const filterRelType = params.relation_type ? String(params.relation_type).trim() : null;

        // BFS traversal
        const visited = new Set([startId]);
        const paths = [];

        // Queue entries: { id, depth, path }
        const queue = [{ id: startId, depth: 0, path: [] }];

        while (queue.length > 0) {
          const { id: currentId, depth, path } = queue.shift();

          if (depth >= maxDepth) continue;

          // Build neighbour query based on direction
          let neighbourRows = [];

          if (direction === "outgoing" || direction === "both") {
            const rows = sdk.db
              .prepare(
                `SELECT r.id AS rel_id, r.target_entry_id AS neighbour_id,
                        r.relation_type, r.confidence, 'outgoing' AS dir
                 FROM memory_relations r
                 WHERE r.source_entry_id = ?
                   ${filterRelType ? `AND r.relation_type = ?` : ""}
                 ORDER BY r.confidence DESC`
              )
              .all(...[currentId, ...(filterRelType ? [filterRelType] : [])]);
            neighbourRows = neighbourRows.concat(rows);
          }

          if (direction === "incoming" || direction === "both") {
            const rows = sdk.db
              .prepare(
                `SELECT r.id AS rel_id, r.source_entry_id AS neighbour_id,
                        r.relation_type, r.confidence, 'incoming' AS dir
                 FROM memory_relations r
                 WHERE r.target_entry_id = ?
                   ${filterRelType ? `AND r.relation_type = ?` : ""}
                 ORDER BY r.confidence DESC`
              )
              .all(...[currentId, ...(filterRelType ? [filterRelType] : [])]);
            neighbourRows = neighbourRows.concat(rows);
          }

          for (const row of neighbourRows) {
            const neighbourId = Number(row.neighbour_id);
            if (visited.has(neighbourId)) continue;
            visited.add(neighbourId);

            const neighbourEntry = sdk.db
              .prepare(
                `SELECT id, content, created_at, updated_at, user_id FROM memory_entries WHERE id = ?`
              )
              .get(neighbourId);

            if (!neighbourEntry) continue;

            const { tags, entities } = loadTagsAndEntities(sdk, neighbourId);
            const step = {
              entry: formatEntry(neighbourEntry, tags, entities),
              relation_type: row.relation_type,
              direction: row.dir,
              confidence: row.confidence,
              depth: depth + 1,
              path: [...path, currentId],
            };
            paths.push(step);

            if (depth + 1 < maxDepth) {
              queue.push({ id: neighbourId, depth: depth + 1, path: [...path, currentId] });
            }
          }
        }

        sdk.log.info(
          `memory_find_connections: found ${paths.length} connections from #${startId} (depth ${maxDepth})`
        );

        return {
          success: true,
          data: {
            start_id: startId,
            connections: paths,
            count: paths.length,
            depth_searched: maxDepth,
          },
        };
      } catch (error) {
        sdk.log.error(`memory_find_connections error: ${error.message}`);
        return {
          success: false,
          error: String(error.message).slice(0, 500),
          hint: "Ensure entry_id is a valid ID and enableAssociativeMode is enabled.",
        };
      }
    },
  },
];
