/**
 * sqlite/sqliteGraphSchema.ts — DDL, pragmas, and connection open/close for
 * the SqliteGraph engine (Lore 3.21 step 1b).
 *
 * One file: `<ws>/.lore/graph.sqlite`. This module owns the schema and the
 * `lore_lower` predicate function; every other `sqlite/*.ts` module is
 * handed an already-open `Database` and never touches DDL or pragmas
 * itself.
 *
 * Column set is exactly the fields `rowToLoreNode` (`engines/loreNodeRow.ts`)
 * reads, using the SAME empty-value conventions SurrealGraph's
 * `toNodeDocument` uses (`''` for an absent string field, `0`/`false` for
 * numeric/boolean flags) — so the shared `rowToLoreNode` mapper produces an
 * identical `LoreNode` from either engine's row. `tags` and
 * `security_scopes` are genuine arrays on SurrealDB's document store; SQLite
 * has no array column type, so they are stored as JSON text and parsed back
 * to arrays by `sqliteGraphRow.ts` on every read — see that file for why the
 * parse has to happen before a row reaches `rowToLoreNode` or a raw-row
 * consumer (bulkList, schema ops).
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SqliteDb = InstanceType<typeof Database>;

/** Where the SQLite graph store lives under a workspace's `.lore/` dir. */
export function sqliteGraphDataPath(basePath: string): string {
    return path.join(basePath, '.lore', 'graph.sqlite');
}

const NODES_DDL = `
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    project TEXT NOT NULL DEFAULT '*',
    ecosystem TEXT NOT NULL DEFAULT '*',
    metadata TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL DEFAULT '',
    syncedAt TEXT NOT NULL DEFAULT '',
    security_scopes TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL DEFAULT '',
    ephemeral INTEGER NOT NULL DEFAULT 0,
    ttl_ms INTEGER NOT NULL DEFAULT 0,
    stale INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    classification TEXT NOT NULL DEFAULT 'tactical',
    anchor_stale INTEGER NOT NULL DEFAULT 0,
    anchor_stale_since TEXT NOT NULL DEFAULT '',
    validFrom TEXT NOT NULL DEFAULT '',
    validUntil TEXT NOT NULL DEFAULT '',
    supersededBy TEXT NOT NULL DEFAULT '',
    supersededAt TEXT NOT NULL DEFAULT '',
    supersededReason TEXT NOT NULL DEFAULT '',
    lastAccessedAt TEXT NOT NULL DEFAULT '',
    last_retrieved_at TEXT NOT NULL DEFAULT '',
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    partial_count INTEGER NOT NULL DEFAULT 0,
    confirmation_score REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_updatedAt ON nodes(updatedAt DESC, id);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
CREATE INDEX IF NOT EXISTS idx_nodes_ecosystem ON nodes(ecosystem);
CREATE INDEX IF NOT EXISTS idx_nodes_supersededBy ON nodes(supersededBy);
CREATE INDEX IF NOT EXISTS idx_nodes_validtime ON nodes(validFrom, validUntil);
`;

/**
 * Edge columns are exactly the fields `LoreEdge` has (sourceId/targetId/
 * relation/confidence/confidenceScore) — no `weight` or `metadata` column,
 * because SurrealGraph's edge documents don't carry them either (see
 * `surreal/surrealGraphWrites.ts`'s `addEdge`: the RELATE payload is
 * `{ relation, confidence, confidenceScore }`, nothing else). A schema that
 * stored fields no write path ever populates would not be parity — it would
 * be an unused column masquerading as one.
 */
const EDGES_DDL = `
CREATE TABLE IF NOT EXISTS edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'extracted',
    confidenceScore REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
`;

/**
 * lore_lower — registered JS predicate function backing every case-fold in
 * this engine's search/tag predicates.
 *
 * NOT SQLite's built-in `lower()`, which is ASCII-only (it does not fold
 * non-ASCII letters at all, e.g. "É" stays "É"). JS `String.toLowerCase()`
 * and Rust's `to_lowercase()` (what SurrealDB's `string::lowercase()` uses
 * under the hood) agree on every code point except contextual final-sigma
 * (Greek "Σ" at a word's end lowercases to final-form "ς" in some Unicode-
 * aware normalizers but not this one) — an edge case documented here, not
 * silently papered over. The parity fixture includes non-ASCII and CJK text
 * specifically to exercise this function rather than SQLite's `lower()`,
 * which would have silently NOT matched a non-ASCII query and broken parity
 * on the first accented character.
 */
function loreLower(s: unknown): string {
    return typeof s === 'string' ? s.toLowerCase() : '';
}

export interface SqliteGraphConnection {
    db: SqliteDb;
    dataPath: string;
}

/**
 * openSqliteGraph — open (creating on first use) the graph store at
 * `<basePath>/.lore/graph.sqlite`, apply pragmas, register `lore_lower`, and
 * ensure the schema exists.
 *
 * Pragmas mirror the design doc: WAL for concurrent-reader-friendly writes,
 * `synchronous=NORMAL` (durable enough with WAL, without fsync-per-write
 * cost), `foreign_keys=OFF` (SurrealGraph enforces no FK-style constraint
 * either — a dangling edge endpoint is refused at the APPLICATION layer in
 * `addEdge`, not by the storage engine), `busy_timeout=5000` so a
 * lock-contended read/write waits instead of throwing SQLITE_BUSY
 * immediately.
 */
export function openSqliteGraph(basePath: string): SqliteGraphConnection {
    const dataPath = sqliteGraphDataPath(basePath);
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    const db = new Database(dataPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = OFF');
    db.pragma('busy_timeout = 5000');
    db.function('lore_lower', loreLower);
    db.exec(NODES_DDL);
    db.exec(EDGES_DDL);
    return { db, dataPath };
}

/**
 * closeSqliteGraph — `db.close()`. Unlike SurrealGraph's `close()`, there is
 * no deferred background flush to wait out: better-sqlite3 is synchronous
 * and its `close()` call returns only once every page is flushed to the WAL
 * / main file, so this is the whole shutdown sequence. Idempotent —
 * better-sqlite3's own `close()` is a no-op on an already-closed handle.
 */
export function closeSqliteGraph(db: SqliteDb): void {
    if (db.open) db.close();
}
