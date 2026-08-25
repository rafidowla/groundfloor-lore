/**
 * storage/loadJobsMigration.ts — Sprint Z1 schema bootstrap for the
 * load_jobs table.
 *
 * Sprint Z1 (2026-05-24) introduces POST /api/load + GET /api/load/jobs
 * (see routes/load.ts). The endpoint persists per-upload job state in
 * SQLite so a polling client can resume after a daemon restart.
 *
 * Storage layout decision (per Z1 spec — "co-locate in outbox.sqlite OR
 * separate file; pick whichever is cleaner; document"):
 *
 *   SEPARATE FILE chosen — `<loreDir>/load-jobs.sqlite`.
 *
 * Why separate:
 *   1. The outbox SQLite schema is governed by Sprint O3c + O6 invariants
 *      and the gate test Z-D8 asserts `batchRecord` / `OutboxOperationKind`
 *      remain green. Co-locating load_jobs as a sibling table inside
 *      `outbox.sqlite` would couple the two surfaces' schema migrations
 *      and risk Z-D8 regressions every time Z2/Z3/Z4 extends the
 *      load-jobs schema.
 *   2. Z3 will land a retention sweeper that drops old load_jobs rows AND
 *      the associated temp files. A standalone file makes the sweep
 *      operation a single `DELETE FROM load_jobs WHERE ...` against an
 *      isolated DB; no chance of accidentally pruning outbox rows.
 *   3. Outbox is on the hot path for every write (WAL writes per request);
 *      load_jobs is bursty (one write per chunk-receive, one INSERT per
 *      upload). Separating their WALs means a long bulk-upload's WAL
 *      growth doesn't interleave with the outbox WAL's checkpointing.
 *   4. The contract with the outbox is still preserved: `load.received`
 *      outbox rows reference `load_jobs.job_id` (via entry.payload.jobId),
 *      so a Z2 substrate handler can join the two by id at consumption
 *      time without needing a foreign key.
 *
 * Idempotent — `initLoadJobsSchema()` is safe to call on every boot.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

export const LOAD_JOBS_SQLITE_FILE = 'load-jobs.sqlite';

const LOAD_JOBS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS load_jobs (
  job_id          TEXT PRIMARY KEY,
  workspace       TEXT NOT NULL,
  format          TEXT NOT NULL,
  embed_mode      TEXT NOT NULL,
  status          TEXT NOT NULL,
  rows_received   INTEGER NOT NULL DEFAULT 0,
  rows_processed  INTEGER NOT NULL DEFAULT 0,
  rows_failed     INTEGER NOT NULL DEFAULT 0,
  errors_json     TEXT,
  temp_file_path  TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  bytes_received  INTEGER NOT NULL DEFAULT 0,
  checkpoint_row  INTEGER NOT NULL DEFAULT 0,
  checkpoint_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_load_jobs_workspace_created
  ON load_jobs(workspace, created_at);
CREATE INDEX IF NOT EXISTS idx_load_jobs_status_workspace
  ON load_jobs(status, workspace);
`;

/**
 * Sprint Z3 — additive column migration. Idempotent: SQLite's PRAGMA
 * table_info is queried first; columns are added only when missing.
 * This is safe to call repeatedly (boot + tests).
 */
function applyZ3AdditiveColumns(db: DatabaseType): void {
    const cols = db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('checkpoint_row')) {
        db.exec(`ALTER TABLE load_jobs ADD COLUMN checkpoint_row INTEGER NOT NULL DEFAULT 0`);
    }
    if (!names.has('checkpoint_at')) {
        db.exec(`ALTER TABLE load_jobs ADD COLUMN checkpoint_at TEXT`);
    }
}

/**
 * Open (creating if necessary) the load-jobs SQLite database and apply
 * the schema. WAL mode + NORMAL synchronous matches the outbox pragmas
 * for consistency. Safe to call multiple times.
 */
export function openLoadJobsDb(loreDir: string): DatabaseType {
    fs.mkdirSync(loreDir, { recursive: true });
    const dbPath = path.join(loreDir, LOAD_JOBS_SQLITE_FILE);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(LOAD_JOBS_SCHEMA_SQL);
    applyZ3AdditiveColumns(db);
    return db;
}

/**
 * initLoadJobsSchema — boot-time entry point. Opens the DB, applies
 * the schema, and closes the handle. Use this when callers only need
 * to ensure the file exists; the long-lived handle belongs to
 * LoadJobsStore (see loadJobsStore.ts).
 */
export function initLoadJobsSchema(loreDir: string): void {
    const db = openLoadJobsDb(loreDir);
    db.close();
}
