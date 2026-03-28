# Persistent Memory Plugin

Store and retrieve memory entries with advanced filtering: tags, entities, date ranges, and free text — composable in any combination.

## Tools

### `memory_store`
Save a text entry. Tags can be embedded inline (`#work`, `#urgent`) or passed explicitly. Entities (people, domains, names) are auto-extracted.

**Parameters:**
| Parameter | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `content` | string   | Yes      | Text to remember. May include `#tags` and `@mentions`. |
| `tags`    | string[] | No       | Extra tags to attach (e.g. `["work", "urgent"]`). |

**Example:**
```
memory_store("Meeting with @anton about TON AI Agent #work #important")
```

**Error example:**
```json
{ "success": false, "error": "content must not be empty", "hint": "Provide a non-empty string in the content parameter." }
```

---

### `memory_list`
List all memory entries, newest first, with optional pagination. No filters needed.

**Parameters:**
| Parameter | Type    | Required | Description |
|-----------|---------|----------|-------------|
| `limit`   | integer | No       | Max entries to return (default 20, max 100). |
| `offset`  | integer | No       | Entries to skip for pagination (default 0). |

**Example:**
```
memory_list({ limit: 10, offset: 0 })
```

**Response includes:** `results`, `count`, `total`, `offset`, `has_more`

---

### `memory_search`
Query entries with any combination of filters (all optional, AND logic).

**Parameters:**
| Parameter    | Type     | Description |
|--------------|----------|-------------|
| `query`      | string   | Free-text substring match in content. |
| `tags`       | string[] | Entry must have ALL listed tags. |
| `entity`     | string   | Substring match on any extracted entity (person, domain, name). |
| `start_date` | string   | From date, inclusive (`YYYY-MM-DD`). |
| `end_date`   | string   | To date, inclusive (`YYYY-MM-DD`). |
| `limit`      | integer  | Max results (default 20, max 100). |

**Examples:**
```
# Show all work entries from last month
memory_search({ tags: ["work"], start_date: "2026-03-01", end_date: "2026-03-31" })

# What did I learn about @anton?
memory_search({ entity: "anton" })

# All entries tagged #important from this week
memory_search({ tags: ["important"], start_date: "2026-03-18" })

# Full-text search across all entries
memory_search({ query: "TON AI Agent" })

# Composite query
memory_search({ query: "meeting", tags: ["work"], entity: "anton", start_date: "2026-03-01" })
```

**Error examples:**
```json
{ "success": false, "error": "Invalid start_date: \"bad-date\"", "hint": "Use ISO 8601 format: YYYY-MM-DD (e.g. \"2026-03-01\")." }
{ "success": true, "data": { "results": [], "count": 0, "hint": "Try memory_list_tags to see available tags and entities, or broaden your search." } }
```

---

### `memory_update`
Update the content and/or tags of an existing entry. Tags and entities are re-indexed from the new content.

**Parameters:**
| Parameter | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `id`      | integer  | Yes      | ID of the entry to update. |
| `content` | string   | No       | New content (replaces existing). May include `#tags` and `@mentions`. |
| `tags`    | string[] | No       | Tags to attach (replaces existing). |

**Examples:**
```
# Update content (tags and entities are re-extracted automatically)
memory_update({ id: 42, content: "Updated meeting notes with @anton #work #done" })

# Update tags only (keep existing content)
memory_update({ id: 42, tags: ["reviewed", "archived"] })

# Update both content and add extra tags
memory_update({ id: 42, content: "TON AI Agent sprint review #work", tags: ["sprint", "q1"] })
```

**Error examples:**
```json
{ "success": false, "error": "Memory entry #99 not found", "hint": "Use memory_list or memory_search to find valid entry IDs." }
{ "success": false, "error": "id must be a positive integer", "hint": "Use memory_list or memory_search to find valid entry IDs." }
{ "success": false, "error": "content must not be empty", "hint": "Provide a non-empty string, or omit content to update only tags." }
```

---

### `memory_delete`
Delete a single entry by its ID (obtained from `memory_search`, `memory_list`, or `memory_store`).

**Parameters:**
| Parameter | Type    | Required | Description |
|-----------|---------|----------|-------------|
| `id`      | integer | Yes      | ID of the entry to delete. |

**Error example:**
```json
{ "success": false, "error": "Memory entry #99 not found", "hint": "Use memory_list or memory_search to find valid entry IDs." }
```

---

### `memory_list_tags`
List all tags and entities currently in use across all memory entries, sorted by frequency.

No parameters required.

**Response includes:** `tags` (with counts), `entities` (with type and counts), `tag_count`, `entity_count`

---

### `memory_export`
Export all memory entries to a JSON blob for backup or migration.

No parameters required.

**Example response:**
```json
{
  "success": true,
  "data": {
    "version": 1,
    "exported_at": "2026-03-25T12:00:00.000Z",
    "count": 42,
    "entries": [ ... ]
  }
}
```

---

### `memory_import`
Import memory entries from a JSON blob previously created by `memory_export`.

**Parameters:**
| Parameter         | Type    | Required | Description |
|-------------------|---------|----------|-------------|
| `entries`         | array   | Yes      | Array of entry objects from `memory_export`. |
| `skip_duplicates` | boolean | No       | Skip entries with identical content (default `true`). |

**Example:**
```
memory_import({ entries: exportedData.entries })
```

**Error example:**
```json
{ "success": false, "error": "entries must be a non-empty array", "hint": "Use memory_export to get a valid export blob, then pass its entries array here." }
```

---

### `memory_relate`
Create an explicit relationship between two memory entries. Requires `enableAssociativeMode: true` in config.

**Parameters:**
| Parameter       | Type    | Required | Description |
|-----------------|---------|----------|-------------|
| `source_id`     | integer | Yes      | ID of the source entry. |
| `target_id`     | integer | Yes      | ID of the target entry. |
| `relation_type` | string  | No       | Relationship label (e.g. `causes`, `depends_on`, `similar_to`). Defaults to `related_to`. |
| `confidence`    | number  | No       | Confidence score 0.0–1.0 for future ML weighting. Defaults to `1.0`. |

**Example:**
```
memory_relate({ source_id: 12, target_id: 34, relation_type: "causes" })
```

**Error examples:**
```json
{ "success": false, "error": "Associative memory mode is not enabled", "hint": "Set enableAssociativeMode: true in the plugin config and restart." }
{ "success": false, "error": "Memory entry #99 not found", "hint": "Use memory_list or memory_search to find valid entry IDs." }
{ "success": false, "error": "source_id and target_id must be different entries", "hint": "A relation requires two distinct memory entries." }
```

---

### `memory_find_connections`
Find memory entries connected to a given entry via explicit relationships. Supports BFS traversal up to 3 hops. Requires `enableAssociativeMode: true` in config.

**Parameters:**
| Parameter       | Type    | Required | Description |
|-----------------|---------|----------|-------------|
| `entry_id`      | integer | Yes      | Starting entry ID for traversal. |
| `relation_type` | string  | No       | Filter by relation type. Omit to include all. |
| `direction`     | string  | No       | `outgoing` (entry is source), `incoming` (entry is target), or `both` (default). |
| `depth`         | integer | No       | Hops to traverse (1–3, default 1). Keep low for performance. |

**Example:**
```
# Direct connections from entry 12
memory_find_connections({ entry_id: 12, depth: 1 })

# Multi-hop traversal: "How is entry 5 connected to anything?"
memory_find_connections({ entry_id: 5, depth: 2, direction: "both" })

# Only entries that depend on entry 7
memory_find_connections({ entry_id: 7, direction: "incoming", relation_type: "depends_on" })
```

**Usage pattern (multi-hop reasoning):**
```
User: "How is TONBANKCARD connected to my DeFi strategy?"

1. memory_search({ query: "TONBANKCARD", entity: "DeFi" }) → finds direct entries
2. For each result, memory_find_connections({ entry_id, depth: 2 }) → expands via relations
3. Synthesize answer using both direct facts and inferred connections
```

**Error examples:**
```json
{ "success": false, "error": "Associative memory mode is not enabled", "hint": "Set enableAssociativeMode: true in the plugin config and restart." }
{ "success": false, "error": "Memory entry #99 not found", "hint": "Use memory_list or memory_search to find valid entry IDs." }
{ "success": false, "error": "entry_id must be a positive integer", "hint": "Use memory_list or memory_search to find valid entry IDs." }
```

---

## Entity Extraction

Entities are automatically detected from entry content:

| Pattern | Entity Type | Example |
|---------|-------------|---------|
| `@name` | `person`    | `@anton` → person `anton` |
| `#tag`  | `tag`       | `#work` → tag `work` |
| `domain.tld` | `domain` | `ton.org` → domain `ton.org` |
| `Capitalized Names` | `name` | `TON AI Agent` → name `ton ai agent` |

---

## Schema Reference

This plugin uses an isolated SQLite database (`sdk.db`) with the following schema:

### `memory_entries`
| Column       | Type    | Description |
|--------------|---------|-------------|
| `id`         | INTEGER | Primary key, auto-incremented |
| `content`    | TEXT    | The stored memory text |
| `created_at` | INTEGER | Unix timestamp of creation |
| `updated_at` | INTEGER | Unix timestamp of last update (nullable) |
| `user_id`    | TEXT    | Sender ID from context (nullable) |

### `memory_tags`
| Column     | Type    | Description |
|------------|---------|-------------|
| `entry_id` | INTEGER | Foreign key → `memory_entries.id` (cascade delete) |
| `tag`      | TEXT    | Lowercase tag name (without `#`) |

### `memory_entities`
| Column        | Type    | Description |
|---------------|---------|-------------|
| `entry_id`    | INTEGER | Foreign key → `memory_entries.id` (cascade delete) |
| `entity_type` | TEXT    | One of: `person`, `tag`, `domain`, `name` |
| `entity_name` | TEXT    | Lowercase entity value |

### `memory_schema_version`
| Column       | Type    | Description |
|--------------|---------|-------------|
| `version`    | INTEGER | Schema version number |
| `applied_at` | INTEGER | Unix timestamp when version was applied |

### `memory_relations` _(optional, requires `enableAssociativeMode: true`)_
| Column            | Type    | Description |
|-------------------|---------|-------------|
| `id`              | INTEGER | Primary key, auto-incremented |
| `source_entry_id` | INTEGER | Foreign key → `memory_entries.id` (cascade delete) |
| `target_entry_id` | INTEGER | Foreign key → `memory_entries.id` (cascade delete) |
| `relation_type`   | TEXT    | Label for the relationship (e.g. `causes`, `depends_on`, `related_to`) |
| `confidence`      | REAL    | Confidence score 0.0–1.0 (reserved for future ML weighting) |
| `created_at`      | INTEGER | Unix timestamp of creation |

### Indexes
- `idx_memory_created_at` — fast date-range queries on entries
- `idx_memory_updated_at` — fast sort by last modified
- `idx_memory_tags_tag` — fast tag lookups
- `idx_memory_tags_entry` — fast tag fetch per entry
- `idx_memory_entities` — fast entity name lookups
- `idx_memory_entities_entry` — fast entity fetch per entry
- `idx_relations_source` — fast outgoing relation lookups _(when associative mode enabled)_
- `idx_relations_target` — fast incoming relation lookups _(when associative mode enabled)_

---

## Error Handling

All tools return a consistent response envelope:

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` on success, `false` on error |
| `data` | object | Present when `success` is `true` |
| `error` | string | Human-readable error message (when `success` is `false`) |
| `hint` | string | Actionable suggestion to resolve the error (when `success` is `false`) |

### Common errors and how to resolve them

| Error | Cause | Resolution |
|-------|-------|------------|
| `content must not be empty` | Empty or whitespace-only content passed | Provide a non-empty string |
| `id must be a positive integer` | Invalid ID (0, negative, or non-integer) | Use `memory_list` to find valid IDs |
| `Memory entry #N not found` | ID does not exist in the database | Use `memory_list` or `memory_search` to find existing IDs |
| `Invalid start_date: "…"` | Date string is not ISO 8601 (`YYYY-MM-DD`) | Use format `"2026-03-01"` |
| `Invalid end_date: "…"` | Date string is not ISO 8601 (`YYYY-MM-DD`) | Use format `"2026-03-31"` |
| `entries must be a non-empty array` | Empty or missing array passed to `memory_import` | Use `memory_export` first, then pass its `entries` array |
| `Associative memory mode is not enabled` | `memory_relate` or `memory_find_connections` called without opt-in | Set `enableAssociativeMode: true` in config and restart |
| `source_id and target_id must be different entries` | Both IDs are the same | Provide two distinct entry IDs |

### Example error responses

```json
// Empty content
{ "success": false, "error": "content must not be empty", "hint": "Provide a non-empty string in the content parameter." }

// Entry not found
{ "success": false, "error": "Memory entry #99 not found", "hint": "Use memory_list or memory_search to find valid entry IDs." }

// Invalid date format
{ "success": false, "error": "Invalid start_date: \"bad-date\"", "hint": "Use ISO 8601 format: YYYY-MM-DD (e.g. \"2026-03-01\")." }

// No results (not an error — success: true with empty results and a hint)
{ "success": true, "data": { "results": [], "count": 0, "hint": "Try memory_list_tags to see available tags and entities, or broaden your search." } }

// Import with empty array
{ "success": false, "error": "entries must be a non-empty array", "hint": "Use memory_export to get a valid export blob, then pass its entries array here." }
```

---

## Associative Memory (Optional)

The associative memory layer enables graph-based reasoning by encoding explicit relationships between entries. It is **disabled by default** (zero impact on existing setups) and must be explicitly opted in.

### Enabling

Set `enableAssociativeMode: true` in the plugin config. On the next load, the `memory_relations` table and its indexes are created automatically.

### Relation types

Any string is valid. Common conventions:

| Relation type | Meaning |
|---------------|---------|
| `related_to`  | Generic connection (default) |
| `causes`      | Entry A is a cause of entry B |
| `depends_on`  | Entry A depends on entry B |
| `similar_to`  | Entries are semantically similar |
| `contradicts` | Entries conflict with each other |

### Graph traversal example

```
# Store some entries
memory_store({ content: "TONBANKCARD launched #defi #product" })       → id 1
memory_store({ content: "DeFi strategy requires low-fee chain #defi" }) → id 2
memory_store({ content: "TON chain offers low fees #ton #defi" })       → id 3

# Create relations
memory_relate({ source_id: 1, target_id: 2, relation_type: "related_to" })
memory_relate({ source_id: 2, target_id: 3, relation_type: "depends_on" })

# Multi-hop traversal: 2 hops from entry 1
memory_find_connections({ entry_id: 1, depth: 2 })
# → finds entry 2 (hop 1) and entry 3 (hop 2 via entry 2)
```

---

## Migration

Schema migrations are applied automatically via the `migrate()` function on plugin load. A `memory_schema_version` table tracks applied versions. New columns are added safely with `ALTER TABLE … ADD COLUMN` (no-op if already present).

For data migration between instances, use `memory_export` + `memory_import`.

### Export/import edge cases

| Scenario | Behavior |
|----------|----------|
| Exporting an empty database | Returns `{ count: 0, entries: [] }` — no error |
| Importing with `skip_duplicates: true` (default) | Entries whose content already exists are skipped; `skipped` count is returned |
| Importing with `skip_duplicates: false` | Duplicate content is inserted again |
| Importing entries with invalid `created_at` | Falls back to current timestamp; no error thrown |
| Importing entries with empty content | Silently skipped; counted in `skipped` |
| Partial failure during import | Per-entry errors are collected in `data.errors`; other entries are still imported |
