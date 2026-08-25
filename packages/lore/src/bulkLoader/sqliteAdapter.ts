/**
 * bulkLoader/sqliteAdapter.ts — Sprint Z2 SQLite-substrate loader.
 *
 * Per Sprint Z principle clause 3 + Z0 audit Section 6.1: SQLite has
 * no COPY; the fast path is prepared INSERT inside a db.transaction
 * wrapper. Z0 measured the floor at ~81 ms / 100k rows (1.23M rps);
 * Z2's end-to-end target is 100k <5min so this substrate is not the
 * bottleneck — kuzu graph + lance vector dominate.
 *
 * What this adapter writes:
 *   - Verbatim documents (id, text, metadata, workspace, ...) into
 *     the verbatim_docs table that VerbatimStore reads. Today the
 *     verbatim sqlite metadata is held inside the VerbatimStore as
 *     an in-process state — we open OUR own connection into a
 *     dedicated 'bulk_verbatim.sqlite' file co-located in loreDir
 *     so we don't have to call across the VerbatimStore mutex.
 *     Z3 will reconcile (callback hook so VerbatimStore knows new
 *     rows exist for embed-backfill purposes).
 *
 * Per-row failure isolation (Sprint Z principle clause 5):
 *   prepared statement bindings can throw (TypeError on bad shape).
 *   We catch per-row inside the transaction so one bad row doesn't
 *   abort the whole 1000-row batch. The bad row is reported in
 *   BatchResult.errors and the transaction commits the rest.
 *
 * The runner provides the (already-parsed + validated) rows; this
 * adapter is the LAST mile of the substrate write.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type {
    BulkLoaderAdapter,
    BulkLoaderOpts,
    BatchResult,
    BulkLoaderCheckpoint,
} from './types.js';

/** Verbatim row shape — what the runner hands to writeBatch(). */
export interface SqliteVerbatimRow {
    id: string;
    text: string;
    /** Free-form metadata; JSON-stringified into the metadata column. */
    metadata?: Record<string, unknown>;
    /** Workspace for Sprint L scoping; the runner pre-validates. */
    workspace: string;
}

/** Schema file co-located in loreDir. Z3 will surface a reader hook
 *  so VerbatimStore can pick up bulk-loaded rows for embed backfill. */
export const BULK_VERBATIM_SQLITE_FILE = 'bulk-verbatim.sqlite';

const BULK_VERBATIM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bulk_verbatim (
  id          TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  text        TEXT NOT NULL,
  metadata    TEXT,
  job_id      TEXT NOT NULL,
  row_index   INTEGER NOT NULL,
  inserted_at TEXT NOT NULL,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX IF NOT EXISTS idx_bulk_verbatim_job
  ON bulk_verbatim(job_id);
CREATE INDEX IF NOT EXISTS idx_bulk_verbatim_workspace_inserted
  ON bulk_verbatim(workspace, inserted_at DESC);
`;

/** Idempotent open-or-create. */
export function openBulkVerbatimDb(loreDir: string): DatabaseType {
    fs.mkdirSync(loreDir, { recursive: true });
    const dbPath = path.join(loreDir, BULK_VERBATIM_SQLITE_FILE);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(BULK_VERBATIM_SCHEMA_SQL);
    return db;
}

export interface SqliteAdapterDeps {
    loreDir: string;
    /** Test hook — override the db handle (in-memory). */
    dbOverride?: DatabaseType;
}

export class SqliteBulkLoaderAdapter implements BulkLoaderAdapter<SqliteVerbatimRow> {
    public readonly substrate = 'sqlite' as const;

    private readonly db: DatabaseType;
    private readonly ownDb: boolean;
    private opts: BulkLoaderOpts | null = null;
    private insertStmt: Statement | null = null;
    private batchTxn: ((rows: SqliteVerbatimRow[]) => BatchResult) | null = null;
    private inTransaction = false;

    constructor(deps: SqliteAdapterDeps) {
        if (deps.dbOverride) {
            this.db = deps.dbOverride;
            this.ownDb = false;
            // Ensure schema even on injected handle.
            this.db.exec(BULK_VERBATIM_SCHEMA_SQL);
        } else {
            this.db = openBulkVerbatimDb(deps.loreDir);
            this.ownDb = true;
        }
    }

    async begin(opts: BulkLoaderOpts): Promise<void> {
        this.opts = opts;
        // Prepare the INSERT statement ONCE per session; better-sqlite3
        // reuses the bytecode per .run() call (the Z0 measured floor
        // path).
        this.insertStmt = this.db.prepare(
            `INSERT OR REPLACE INTO bulk_verbatim
             (id, workspace, text, metadata, job_id, row_index, inserted_at)
             VALUES (@id, @workspace, @text, @metadata, @job_id, @row_index, @inserted_at)`,
        );
        // Wrap a single per-batch transaction. Per-row try/catch lives
        // INSIDE the wrapped function so a bad row doesn't abort the
        // batch; the transaction still commits the good rows.
        this.batchTxn = this.db.transaction((rows: SqliteVerbatimRow[]): BatchResult => {
            const errors: BatchResult['errors'] = [];
            let written = 0;
            const insertedAt = new Date().toISOString();
            const o = this.opts!;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (!row) {
                    errors.push({ rowIndex: o.baseRowIndex + i, errorMessage: 'null_row' });
                    continue;
                }
                try {
                    // Sprint L invariant — workspace match. The runner
                    // pre-validates; this is defense-in-depth.
                    if (row.workspace !== o.workspace) {
                        errors.push({
                            rowIndex: o.baseRowIndex + i,
                            errorMessage: `workspace_mismatch (expected ${o.workspace}, got ${row.workspace})`,
                        });
                        continue;
                    }
                    if (typeof row.id !== 'string' || row.id.length === 0) {
                        errors.push({
                            rowIndex: o.baseRowIndex + i,
                            errorMessage: 'missing_or_invalid_id',
                        });
                        continue;
                    }
                    this.insertStmt!.run({
                        id: row.id,
                        workspace: row.workspace,
                        text: row.text ?? '',
                        metadata: row.metadata ? JSON.stringify(row.metadata) : null,
                        job_id: o.jobId,
                        row_index: o.baseRowIndex + i,
                        inserted_at: insertedAt,
                    });
                    written++;
                } catch (err) {
                    errors.push({
                        rowIndex: o.baseRowIndex + i,
                        errorMessage: (err as Error).message?.slice(0, 500) ?? 'unknown_error',
                    });
                }
            }
            return { written, failed: errors.length, errors };
        });
        this.inTransaction = true;
    }

    async writeBatch(rows: SqliteVerbatimRow[]): Promise<BatchResult> {
        if (!this.batchTxn || !this.opts) {
            throw new Error('SqliteBulkLoaderAdapter.writeBatch called before begin()');
        }
        if (rows.length === 0) {
            return { written: 0, failed: 0, errors: [] };
        }
        // db.transaction() invokes synchronously; we wrap in a
        // resolved Promise to match the async contract.
        const result = this.batchTxn(rows);
        // Advance the baseRowIndex so the NEXT writeBatch's errors
        // carry the right offset (the runner can also just pass a new
        // baseRowIndex; doing both keeps the contract robust).
        this.opts = { ...this.opts, baseRowIndex: this.opts.baseRowIndex + rows.length };
        return result;
    }

    async checkpoint(): Promise<BulkLoaderCheckpoint> {
        // SQLite WAL checkpoint — flushes the WAL to the main DB so a
        // crash here loses no committed rows. Z3 will integrate this
        // with the runner's load_jobs checkpoint logic; Z2 just
        // exposes the operation.
        try {
            this.db.pragma('wal_checkpoint(PASSIVE)');
        } catch { /* best-effort */ }
        const cp = this.opts?.baseRowIndex ?? 0;
        return {
            checkpointRowId: cp,
            offset: cp,
            at: new Date().toISOString(),
        };
    }

    async commit(): Promise<void> {
        // better-sqlite3 transactions auto-commit at the end of the
        // wrapped function — there's no explicit commit per batch.
        // We finalize the prepared statement and (if we own the db)
        // close it so the temp file handle releases.
        this.inTransaction = false;
        this.insertStmt = null;
        this.batchTxn = null;
    }

    async rollback(): Promise<void> {
        // No-op: better-sqlite3 wrapped transactions auto-rollback if
        // the function throws; we never call .run() outside the wrapper
        // so by the time rollback() is reached there's nothing in
        // flight. This is the Z2 contract; Z3 will introduce an
        // explicit cross-batch rollback for the checkpoint path.
        this.inTransaction = false;
        this.insertStmt = null;
        this.batchTxn = null;
    }

    /** Test + shutdown — release the db handle if we own it. */
    close(): void {
        if (this.ownDb) {
            try { this.db.close(); } catch { /* ignore */ }
        }
    }
}
