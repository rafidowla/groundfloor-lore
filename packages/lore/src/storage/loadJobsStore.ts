/**
 * storage/loadJobsStore.ts — Sprint Z1 SQLite abstraction over the
 * `load_jobs` table.
 *
 * Storage layout: separate `<loreDir>/load-jobs.sqlite` file (see
 * loadJobsMigration.ts for the rationale). The store owns a long-
 * lived DB handle; routes/load.ts holds a single instance threaded
 * through the dispatcher deps.
 *
 * Sprint Z1 surface (Z2 + Z3 will extend):
 *   - create(spec)              — insert a new 'received' row
 *   - get(jobId)                — read one row (or undefined)
 *   - list(workspace, limit?)   — recent rows desc by created_at
 *   - updateStatus(jobId, ...)  — flip status + started/completed_at
 *   - incrementBytesReceived    — additive byte-count update from
 *                                 chunked-upload progress reporters
 *   - close()                   — for tests / clean shutdown
 *
 * All methods are synchronous on the SQLite side (better-sqlite3 is
 * sync) but return Promises so future cloud-backed impls can swap in.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { openLoadJobsDb } from './loadJobsMigration.js';

export type LoadJobFormat = 'jsonl' | 'csv' | 'arrow';
export type LoadJobEmbedMode = 'inline' | 'queued' | 'skip';
export type LoadJobStatus =
    | 'received'    // Z1 terminal state; Z2 promotes to 'running'
    | 'running'
    | 'complete'
    | 'failed'
    | 'cancelled';

export interface LoadJobError {
    rowIndex: number;
    errorMessage: string;
}

export interface LoadJobSpec {
    jobId: string;
    workspace: string;
    format: LoadJobFormat;
    embedMode: LoadJobEmbedMode;
    tempFilePath: string;
    createdAt: string;
}

export interface LoadJob {
    jobId: string;
    workspace: string;
    format: LoadJobFormat;
    embedMode: LoadJobEmbedMode;
    status: LoadJobStatus;
    rowsReceived: number;
    rowsProcessed: number;
    rowsFailed: number;
    errors: LoadJobError[];
    tempFilePath: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    bytesReceived: number;
    /** Sprint Z3 — last persisted row index for crash-resumable loads. */
    checkpointRow: number;
    /** Sprint Z3 — ISO timestamp of last checkpoint write. */
    checkpointAt: string | null;
}

interface Row {
    job_id: string;
    workspace: string;
    format: string;
    embed_mode: string;
    status: string;
    rows_received: number;
    rows_processed: number;
    rows_failed: number;
    errors_json: string | null;
    temp_file_path: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    bytes_received: number;
    checkpoint_row: number | null;
    checkpoint_at: string | null;
}

function rowToJob(r: Row): LoadJob {
    let errors: LoadJobError[] = [];
    if (r.errors_json) {
        try {
            const parsed = JSON.parse(r.errors_json);
            if (Array.isArray(parsed)) errors = parsed as LoadJobError[];
        } catch {
            // Corrupted errors blob — treat as empty rather than throwing.
            errors = [];
        }
    }
    return {
        jobId: r.job_id,
        workspace: r.workspace,
        format: r.format as LoadJobFormat,
        embedMode: r.embed_mode as LoadJobEmbedMode,
        status: r.status as LoadJobStatus,
        rowsReceived: r.rows_received,
        rowsProcessed: r.rows_processed,
        rowsFailed: r.rows_failed,
        errors,
        tempFilePath: r.temp_file_path,
        createdAt: r.created_at,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        bytesReceived: r.bytes_received,
        checkpointRow: r.checkpoint_row ?? 0,
        checkpointAt: r.checkpoint_at,
    };
}

export class LoadJobsStore {
    private readonly db: DatabaseType;

    constructor(loreDir: string) {
        this.db = openLoadJobsDb(loreDir);
    }

    /** Tests + graceful shutdown. */
    close(): void {
        try { this.db.close(); } catch { /* ignore double-close */ }
    }

    async create(spec: LoadJobSpec): Promise<LoadJob> {
        this.db.prepare(
            `INSERT INTO load_jobs
             (job_id, workspace, format, embed_mode, status,
              rows_received, rows_processed, rows_failed,
              errors_json, temp_file_path,
              created_at, started_at, completed_at, bytes_received)
             VALUES
             (@job_id, @workspace, @format, @embed_mode, 'received',
              0, 0, 0,
              NULL, @temp_file_path,
              @created_at, NULL, NULL, 0)`,
        ).run({
            job_id: spec.jobId,
            workspace: spec.workspace,
            format: spec.format,
            embed_mode: spec.embedMode,
            temp_file_path: spec.tempFilePath,
            created_at: spec.createdAt,
        });
        const job = await this.get(spec.jobId);
        if (!job) throw new Error(`loadJobsStore.create: insert succeeded but get returned undefined for ${spec.jobId}`);
        return job;
    }

    async get(jobId: string): Promise<LoadJob | undefined> {
        const r = this.db.prepare(
            `SELECT * FROM load_jobs WHERE job_id = ?`,
        ).get(jobId) as Row | undefined;
        if (!r) return undefined;
        return rowToJob(r);
    }

    async list(workspace: string, limit = 50): Promise<LoadJob[]> {
        const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
        const rows = this.db.prepare(
            `SELECT * FROM load_jobs
             WHERE workspace = ?
             ORDER BY created_at DESC
             LIMIT ?`,
        ).all(workspace, safeLimit) as Row[];
        return rows.map(rowToJob);
    }

    async updateStatus(
        jobId: string,
        status: LoadJobStatus,
        opts?: { startedAt?: string; completedAt?: string },
    ): Promise<void> {
        this.db.prepare(
            `UPDATE load_jobs
             SET status = @status,
                 started_at   = COALESCE(@started_at, started_at),
                 completed_at = COALESCE(@completed_at, completed_at)
             WHERE job_id = @job_id`,
        ).run({
            job_id: jobId,
            status,
            started_at: opts?.startedAt ?? null,
            completed_at: opts?.completedAt ?? null,
        });
    }

    async incrementBytesReceived(jobId: string, n: number): Promise<void> {
        if (n <= 0) return;
        this.db.prepare(
            `UPDATE load_jobs
             SET bytes_received = bytes_received + ?
             WHERE job_id = ?`,
        ).run(n, jobId);
    }

    /**
     * Sprint Z2 — atomic progress update from the runner. Replaces
     * (NOT increments) the rows_processed / rows_failed counters so
     * the runner can keep the source of truth in memory and flush
     * periodically without read-modify-write races. `errorsAppend`
     * adds new per-row failures to the accumulated errors_json blob;
     * the store reads, splices, and re-serializes inside the
     * UPDATE so a single transaction covers the merge.
     */
    async updateProgress(
        jobId: string,
        rowsProcessed: number,
        rowsFailed: number,
        errorsAppend?: LoadJobError[],
    ): Promise<void> {
        const txn = this.db.transaction(() => {
            if (errorsAppend && errorsAppend.length > 0) {
                const cur = this.db.prepare(
                    `SELECT errors_json FROM load_jobs WHERE job_id = ?`,
                ).get(jobId) as { errors_json: string | null } | undefined;
                let existing: LoadJobError[] = [];
                if (cur?.errors_json) {
                    try {
                        const parsed = JSON.parse(cur.errors_json);
                        if (Array.isArray(parsed)) existing = parsed as LoadJobError[];
                    } catch { /* corrupted — reset */ }
                }
                // Cap accumulated errors to avoid unbounded blob growth.
                // 1000 per job is enough for triage; further failures
                // are still counted in rows_failed.
                const MAX_ERRORS = 1000;
                const merged = existing.concat(errorsAppend).slice(-MAX_ERRORS);
                this.db.prepare(
                    `UPDATE load_jobs
                     SET rows_processed = @rp,
                         rows_failed    = @rf,
                         errors_json    = @ej
                     WHERE job_id = @id`,
                ).run({
                    id: jobId,
                    rp: rowsProcessed,
                    rf: rowsFailed,
                    ej: JSON.stringify(merged),
                });
            } else {
                this.db.prepare(
                    `UPDATE load_jobs
                     SET rows_processed = @rp,
                         rows_failed    = @rf
                     WHERE job_id = @id`,
                ).run({ id: jobId, rp: rowsProcessed, rf: rowsFailed });
            }
        });
        txn();
    }

    /**
     * Sprint Z2 — list jobs in 'received' status across all workspaces.
     * The runner polls this on its tick. Limited to `limit` rows so a
     * burst of receives can't make the runner allocate a huge array;
     * subsequent ticks drain the remainder. Order is oldest-first so
     * we process FIFO.
     */
    /**
     * Sprint Z3 — atomic checkpoint write. Updates rows_processed
     * + rows_failed + checkpoint_row + checkpoint_at in a single
     * UPDATE so a crash between rows_processed and checkpoint_row
     * never leaves the two out of sync. `errorsAppend` is merged
     * into errors_json (same shape as updateProgress).
     */
    async writeCheckpoint(
        jobId: string,
        rowsProcessed: number,
        rowsFailed: number,
        checkpointRow: number,
        errorsAppend?: LoadJobError[],
    ): Promise<void> {
        const checkpointAt = new Date().toISOString();
        const txn = this.db.transaction(() => {
            if (errorsAppend && errorsAppend.length > 0) {
                const cur = this.db.prepare(
                    `SELECT errors_json FROM load_jobs WHERE job_id = ?`,
                ).get(jobId) as { errors_json: string | null } | undefined;
                let existing: LoadJobError[] = [];
                if (cur?.errors_json) {
                    try {
                        const parsed = JSON.parse(cur.errors_json);
                        if (Array.isArray(parsed)) existing = parsed as LoadJobError[];
                    } catch { /* corrupted — reset */ }
                }
                const MAX_ERRORS = 1000;
                const merged = existing.concat(errorsAppend).slice(-MAX_ERRORS);
                this.db.prepare(
                    `UPDATE load_jobs
                     SET rows_processed = @rp,
                         rows_failed    = @rf,
                         checkpoint_row = @cr,
                         checkpoint_at  = @ca,
                         errors_json    = @ej
                     WHERE job_id = @id`,
                ).run({ id: jobId, rp: rowsProcessed, rf: rowsFailed, cr: checkpointRow, ca: checkpointAt, ej: JSON.stringify(merged) });
            } else {
                this.db.prepare(
                    `UPDATE load_jobs
                     SET rows_processed = @rp,
                         rows_failed    = @rf,
                         checkpoint_row = @cr,
                         checkpoint_at  = @ca
                     WHERE job_id = @id`,
                ).run({ id: jobId, rp: rowsProcessed, rf: rowsFailed, cr: checkpointRow, ca: checkpointAt });
            }
        });
        txn();
    }

    /**
     * Sprint Z3 — list jobs left in 'running' status (e.g. after
     * daemon crash). The runner queries this on startup and resumes
     * each from its checkpoint_row.
     */
    async listRunning(limit = 100): Promise<LoadJob[]> {
        const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
        const rows = this.db.prepare(
            `SELECT * FROM load_jobs
             WHERE status = 'running'
             ORDER BY created_at ASC
             LIMIT ?`,
        ).all(safeLimit) as Row[];
        return rows.map(rowToJob);
    }

    /**
     * Sprint Z3 — per-workspace count of in-flight jobs. Used by the
     * concurrency cap reconciler at startup + by /api/load to decide
     * whether to 429 a new submission.
     */
    async countRunningByWorkspace(): Promise<Map<string, number>> {
        const rows = this.db.prepare(
            `SELECT workspace, COUNT(*) AS n FROM load_jobs
             WHERE status IN ('received','running')
             GROUP BY workspace`,
        ).all() as Array<{ workspace: string; n: number }>;
        const m = new Map<string, number>();
        for (const r of rows) m.set(r.workspace, r.n);
        return m;
    }

    /**
     * Sprint Z3 — list completed/failed jobs whose temp_file_path is
     * past the retention window. The sweeper deletes the temp file and
     * NULLs temp_file_path. Returns the rows to act on.
     */
    async listTempRetentionExpired(now: Date, retentionMsComplete: number, retentionMsFailed: number): Promise<LoadJob[]> {
        const completedCutoff = new Date(now.getTime() - retentionMsComplete).toISOString();
        const failedCutoff = new Date(now.getTime() - retentionMsFailed).toISOString();
        const rows = this.db.prepare(
            `SELECT * FROM load_jobs
             WHERE temp_file_path IS NOT NULL
               AND (
                 (status = 'complete' AND completed_at IS NOT NULL AND completed_at < @ccut)
                 OR (status = 'failed' AND completed_at IS NOT NULL AND completed_at < @fcut)
               )
             LIMIT 200`,
        ).all({ ccut: completedCutoff, fcut: failedCutoff }) as Row[];
        return rows.map(rowToJob);
    }

    /** Sprint Z3 — clear temp_file_path after sweeper deletes the file. */
    async clearTempFilePath(jobId: string): Promise<void> {
        this.db.prepare(
            `UPDATE load_jobs SET temp_file_path = NULL WHERE job_id = ?`,
        ).run(jobId);
    }

    async listReceived(limit = 50): Promise<LoadJob[]> {
        const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
        const rows = this.db.prepare(
            `SELECT * FROM load_jobs
             WHERE status = 'received'
             ORDER BY created_at ASC
             LIMIT ?`,
        ).all(safeLimit) as Row[];
        return rows.map(rowToJob);
    }
}
