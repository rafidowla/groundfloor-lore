/**
 * sqliteVerbatimSchema.ts — DDL + connection setup for SqliteVerbatimStore.
 *
 * 3.21 step 2 part 1 (design: 321-STEP2-SQLITE-VECTOR-AND-PROMOTION-DESIGN.md
 * section 1). File: `<ws>/.lore/verbatim.sqlite` — separate from
 * `graph.sqlite` so promotion (part 3) can retire it whole.
 *
 * Table `verbatim` mirrors `lore_verbatim` (the LanceDB table) column for
 * column, but unlike Lance's model — where a history snapshot is a SEPARATE
 * physical row keyed by a synthetic `<id>#rev<timestamp>` id string, because
 * LanceDB has no secondary-row concept — SQLite gets a real schema: `id` is
 * NOT unique, multiple rows may share it (the canonical row plus its history
 * snapshots), and `is_canonical` / `is_tombstone` say which one is current.
 * `rowid` (SQLite's native integer key) is the true per-row identity FTS5's
 * external-content table is keyed on, and the promotion tail-copy (part 3)
 * streams in `rowid` order.
 *
 * `vector` is a nullable BLOB (little-endian float32 × dim) — nullable so a
 * text-only row (null embedder, step 3c) is stored and FTS-searchable
 * without a placeholder vector.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../logger.js';

/** sqlite-vec load result — reported via handleCount()/stats so operators
 *  can see which vector search path is actually serving a given store. */
export interface SqliteVecLoadResult {
    loaded: boolean;
    /** Populated when `loaded` is true — `vec_version()`'s return value. */
    version?: string;
    /** Populated when `loaded` is false — the load failure, truncated. */
    error?: string;
}

/**
 * Try to load the sqlite-vec extension into `db`. Never throws — sqlite-vec
 * is an OPTIONAL dependency (package.json `optionalDependencies`) and may be
 * absent (npm skipped it for this platform) or fail to load (unsupported
 * arch/OS combination the prebuilt binary doesn't cover). The store must
 * work either way: the JS brute-force fallback in sqliteVerbatimVector.ts
 * covers every case this returns `loaded: false` for.
 */
export async function tryLoadSqliteVec(db: DatabaseType): Promise<SqliteVecLoadResult> {
    // Test/ops escape hatch — forces the JS brute-force fallback path even
    // when sqlite-vec is installed and would otherwise load, so both paths
    // are exercisable without needing two separate machines/platforms.
    if (process.env.LORE_SQLITE_VECTOR_DISABLE_NATIVE === '1') {
        return { loaded: false, error: 'disabled via LORE_SQLITE_VECTOR_DISABLE_NATIVE' };
    }
    try {
        // Optional dependency — dynamic import() (the same pattern
        // extractors/image.ts uses for `sharp`) so a build/runtime missing
        // the package never throws at module load, only here, where it's
        // caught. sqlite-vec's own package.json ships no ESM `exports`
        // condition worth relying on; its default export is the `{ load }`
        // module object either way.
        const sqliteVec = (await import('sqlite-vec')) as unknown as { load: (db: DatabaseType) => void };
        sqliteVec.load(db);
        const row = db.prepare('select vec_version() as v').get() as { v: string };
        return { loaded: true, version: row.v };
    } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        log.debug(`[SqliteVerbatimStore] sqlite-vec did not load (falling back to JS brute-force vector search): ${message.slice(0, 300)}`);
        return { loaded: false, error: message.slice(0, 300) };
    }
}

/**
 * Open (creating if absent) `<basePath>/.lore/verbatim.sqlite`, apply the
 * same pragma tuning the SQLite graph engine uses (WAL, busy_timeout),
 * create the schema if missing, and try loading sqlite-vec.
 *
 * `tableExisted` in the return value is what
 * `verbatimFingerprintGate.applyFingerprintOnOpen` needs as its
 * `tableExists` argument (skip the fingerprint check on a brand-new store —
 * nothing to compare against yet).
 */
export async function openSqliteVerbatimDb(basePath: string): Promise<{
    db: DatabaseType;
    dbPath: string;
    tableExisted: boolean;
    vec: SqliteVecLoadResult;
}> {
    const dir = path.join(basePath, '.lore');
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'verbatim.sqlite');
    const existedBefore = fs.existsSync(dbPath);

    const db = new Database(dbPath);
    // Pragma tuning: same as sqliteTableStorage.ts / the SQLite graph
    // engine — WAL for concurrent readers, synchronous=NORMAL is the
    // documented pairing for WAL write performance, busy_timeout so a
    // brief writer/reader collision retries instead of throwing SQLITE_BUSY.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    // Read-path tuning for the native vector-search full scan
    // (sqliteVerbatimVector.ts's nativeVectorSearch): vec_distance_cosine
    // is evaluated once per row with NO index to skip rows, so its cost is
    // dominated by how fast SQLite can get the `vector` BLOB bytes off
    // disk for every row. Measured on a 100K x 384-d store: default
    // pragmas ~62ms/query; mmap_size + a larger page cache ~33ms/query —
    // roughly halved, and the difference between meeting and missing the
    // step-2-part-1 design's 50ms p50 budget. Both are read-only,
    // no-correctness-impact tuning knobs (mmap_size falls back to normal
    // I/O if the OS/filesystem doesn't support it; cache_size just bounds
    // how much page cache SQLite is allowed to hold) — safe to set
    // unconditionally, not gated on which vector-search path ends up
    // running (a JS-fallback-only store still benefits from a warmer page
    // cache on every other read).
    db.pragma('mmap_size = 268435456'); // 256 MiB
    db.pragma('cache_size = -131072'); // 128 MiB (negative = KiB, not pages)

    let tableExisted = existedBefore;
    if (existedBefore) {
        const row = db.prepare(
            `SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='verbatim'`,
        ).get() as { c: number };
        tableExisted = row.c > 0;
    }

    const vec = await tryLoadSqliteVec(db);
    createSchema(db);

    return { db, dbPath, tableExisted, vec };
}

function createSchema(db: DatabaseType): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS verbatim (
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL,
            text TEXT NOT NULL,
            vector BLOB,
            content_hash TEXT,
            type TEXT,
            label TEXT,
            tags TEXT,
            project TEXT,
            ecosystem TEXT,
            updatedAt TEXT,
            security_scopes TEXT,
            is_canonical INTEGER NOT NULL DEFAULT 1,
            is_tombstone INTEGER NOT NULL DEFAULT 0,
            superseded_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Fast "the current row for this id" lookup — canonical rows are
        -- unique per id (history snapshots are not, and are not indexed
        -- here; getHistory scans by id instead, which is cheap at
        -- per-document history depth).
        CREATE UNIQUE INDEX IF NOT EXISTS verbatim_canonical_id_uq
            ON verbatim(id) WHERE is_canonical = 1;
        CREATE INDEX IF NOT EXISTS verbatim_id_idx ON verbatim(id);
        CREATE INDEX IF NOT EXISTS verbatim_content_hash_idx ON verbatim(content_hash);
        CREATE INDEX IF NOT EXISTS verbatim_project_idx ON verbatim(project);

        -- FTS5 external-content table — verbatim.rowid is the join key, so
        -- the index never duplicates the text column's storage. Populated
        -- via triggers below on the ROW itself: history and tombstone rows
        -- are indexed too (search-time filtering excludes them via the
        -- v.is_canonical / v.is_tombstone join), matching Lance's model
        -- where a history/tombstone row is still a real table row.
        CREATE VIRTUAL TABLE IF NOT EXISTS verbatim_fts USING fts5(
            text,
            content='verbatim',
            content_rowid='rowid',
            tokenize='porter unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS verbatim_fts_ai AFTER INSERT ON verbatim BEGIN
            INSERT INTO verbatim_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS verbatim_fts_ad AFTER DELETE ON verbatim BEGIN
            INSERT INTO verbatim_fts(verbatim_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS verbatim_fts_au AFTER UPDATE ON verbatim BEGIN
            INSERT INTO verbatim_fts(verbatim_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
            INSERT INTO verbatim_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
    `);
}

/**
 * changes-log — written by triggers ONLY while a promotion (part 3) is
 * staging, so the tail-copy step knows what changed since the high-water
 * rowid without re-scanning the whole table. Created lazily by the
 * promotion engine (promotion.json existing is the gate), not at every
 * store open — a workspace that never promotes never pays for it.
 */
export function ensureChangesLogTable(db: DatabaseType): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS verbatim_changes_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            row_rowid INTEGER NOT NULL,
            row_id TEXT NOT NULL,
            is_canonical INTEGER NOT NULL,
            op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
            at TEXT NOT NULL
        );
    `);
}

export function dropChangesLogTable(db: DatabaseType): void {
    db.exec(`DROP TABLE IF EXISTS verbatim_changes_log;`);
}

/** The FTS5 tokenizer this schema was created with, at build time. Rebuilt
 *  (part-1-scoped: only at store-empty reconcile, mirroring the Lance path's
 *  `reconcileFtsTokenizer` policy) via `rebuildFtsTable` in
 *  sqliteVerbatimFts.ts when the workspace's detected profile disagrees. */
export const DEFAULT_TOKENIZER = 'porter unicode61 remove_diacritics 2';
export const CJK_TOKENIZER = 'trigram';
