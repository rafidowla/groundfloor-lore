/**
 * ingestion/sqliteStore.ts — SQLite implementation of IIngestionStore.
 *
 * Separate `<dir>/ingestion.sqlite` file (same pattern as storage/loadJobsStore):
 * coordination state is operational data, not graph data, and must not share a
 * write lock with the graph engine. `busy_timeout` is set so a concurrent
 * writer waits instead of failing a job with "database is locked".
 */
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS, computeBackoffMs, makeJobId, makeSourceId, resolvePurge,
    RECLAIM_ERROR, TERMINAL_JOB_STATES, type BackoffOptions, type IIngestionStore, type IngestionJob, type JobState, type NewJob, type PendingStructured, type PurgeDeliveriesOptions, type ReclaimOptions, type SourceRecord,
} from './store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest_sources (
  source_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, storage_ref TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (workspace, sha256));
CREATE TABLE IF NOT EXISTS ingest_jobs (
  job_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, source_id TEXT NOT NULL, stage TEXT NOT NULL,
  processor_id TEXT NOT NULL, contract_version TEXT NOT NULL, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
  last_error TEXT, params_json TEXT NOT NULL, parent_job_id TEXT, remote_request_id TEXT,
  results_written_at TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
CREATE INDEX IF NOT EXISTS ingest_jobs_due ON ingest_jobs (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS ingest_jobs_ws ON ingest_jobs (workspace, state);
CREATE INDEX IF NOT EXISTS ingest_jobs_src ON ingest_jobs (source_id);
CREATE TABLE IF NOT EXISTS ingest_pending (
  job_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, source_id TEXT NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ingest_deliveries (
  job_id TEXT NOT NULL, delivery_id TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (job_id, delivery_id));
CREATE INDEX IF NOT EXISTS ingest_deliveries_seen ON ingest_deliveries (seen_at);
`;

type Row = Record<string, any>;

function toJob(r: Row): IngestionJob {
    return {
        jobId: r.job_id, workspace: r.workspace, sourceId: r.source_id, stage: r.stage, processorId: r.processor_id,
        contractVersion: r.contract_version, state: r.state, attempts: r.attempts, maxAttempts: r.max_attempts,
        nextAttemptAt: r.next_attempt_at, lastError: r.last_error, params: JSON.parse(r.params_json),
        parentJobId: r.parent_job_id, remoteRequestId: r.remote_request_id, resultsWrittenAt: r.results_written_at,
        result: r.result_json == null ? null : JSON.parse(r.result_json),
        createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
        leaseUntil: r.lease_until ?? null,
    };
}

export class SqliteIngestionStore implements IIngestionStore {
    private readonly db: DB;
    constructor(dbPath: string) {
        if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(SCHEMA);
        this.migrate();
    }

    /** Additive column migrations for stores created by an older build. */
    private migrate(): void {
        const cols = this.db.prepare('PRAGMA table_info(ingest_jobs)').all() as Row[];
        if (!cols.some((c) => c.name === 'lease_until')) this.db.exec('ALTER TABLE ingest_jobs ADD COLUMN lease_until TEXT');
        const srcCols = this.db.prepare('PRAGMA table_info(ingest_sources)').all() as Row[];
        if (!srcCols.some((c) => c.name === 'blob_purged_at')) this.db.exec('ALTER TABLE ingest_sources ADD COLUMN blob_purged_at TEXT');
    }

    /** One file per workspace, so ids never collide across workspaces: they keep hashing the name (no change for existing files). */
    async resolveSourceId(workspace: string, sha256: string): Promise<string> {
        return makeSourceId(workspace, sha256);
    }

    async upsertSource(s: Omit<SourceRecord, 'sourceId' | 'createdAt' | 'blobPurgedAt'>): Promise<SourceRecord> {
        const sourceId = makeSourceId(s.workspace, s.sha256);
        this.db.prepare(`INSERT OR IGNORE INTO ingest_sources (source_id, workspace, file_name, mime_type, sha256, size_bytes, storage_ref, created_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(sourceId, s.workspace, s.fileName, s.mimeType, s.sha256, s.sizeBytes, s.storageRef, new Date().toISOString());
        return (await this.getSource(s.workspace, sourceId))!;
    }

    async getSource(workspace: string, sourceId: string): Promise<SourceRecord | undefined> {
        const r = this.db.prepare('SELECT * FROM ingest_sources WHERE workspace = ? AND source_id = ?').get(workspace, sourceId) as Row | undefined;
        return r && { sourceId: r.source_id, workspace: r.workspace, fileName: r.file_name, mimeType: r.mime_type, sha256: r.sha256, sizeBytes: r.size_bytes, storageRef: r.storage_ref, createdAt: r.created_at, blobPurgedAt: r.blob_purged_at ?? null };
    }

    async setSourceBlob(workspace: string, sourceId: string, storageRef: string): Promise<void> {
        this.db.prepare('UPDATE ingest_sources SET storage_ref = ?, blob_purged_at = NULL WHERE workspace = ? AND source_id = ?').run(storageRef, workspace, sourceId);
    }

    async claimBlobPurge(cutoff: Date, now: Date, limit: number): Promise<Array<{ workspace: string; sourceId: string; storageRef: string }>> {
        const terminal = TERMINAL_JOB_STATES.map((t) => `'${t}'`).join(',');
        const tx = this.db.transaction(() => {
            const rows = this.db.prepare(`SELECT s.workspace, s.source_id, s.storage_ref FROM ingest_sources s
                WHERE s.blob_purged_at IS NULL
                  AND EXISTS (SELECT 1 FROM ingest_jobs j WHERE j.source_id = s.source_id)
                  AND NOT EXISTS (SELECT 1 FROM ingest_jobs j WHERE j.source_id = s.source_id AND j.state NOT IN (${terminal}))
                  AND (SELECT MAX(COALESCE(j.completed_at, j.updated_at)) FROM ingest_jobs j WHERE j.source_id = s.source_id) <= ?
                  AND NOT EXISTS (SELECT 1 FROM ingest_sources o WHERE o.storage_ref = s.storage_ref AND o.source_id <> s.source_id AND o.blob_purged_at IS NULL
                      AND (NOT EXISTS (SELECT 1 FROM ingest_jobs j WHERE j.source_id = o.source_id)
                           OR EXISTS (SELECT 1 FROM ingest_jobs j WHERE j.source_id = o.source_id AND j.state NOT IN (${terminal}))))
                ORDER BY s.created_at, s.source_id LIMIT ?`).all(cutoff.toISOString(), Math.max(1, Math.floor(limit))) as Row[];
            const upd = this.db.prepare('UPDATE ingest_sources SET blob_purged_at = ? WHERE source_id = ? AND blob_purged_at IS NULL');
            return rows.filter((r) => upd.run(now.toISOString(), r.source_id).changes === 1).map((r) => ({ workspace: r.workspace as string, sourceId: r.source_id as string, storageRef: r.storage_ref as string }));
        });
        return tx.immediate();
    }

    async releaseBlobPurge(workspace: string, sourceId: string): Promise<void> {
        this.db.prepare('UPDATE ingest_sources SET blob_purged_at = NULL WHERE workspace = ? AND source_id = ?').run(workspace, sourceId);
    }

    async listSourceBlobRefs(workspace: string | null, limit: number, after?: string): Promise<Array<{ sourceId: string; storageRef: string }>> {
        const n = Math.max(1, Math.floor(limit));
        const rows = (workspace === null
            ? this.db.prepare('SELECT source_id, storage_ref FROM ingest_sources WHERE blob_purged_at IS NULL AND source_id > ? ORDER BY source_id LIMIT ?').all(after ?? '', n)
            : this.db.prepare('SELECT source_id, storage_ref FROM ingest_sources WHERE workspace = ? AND blob_purged_at IS NULL AND source_id > ? ORDER BY source_id LIMIT ?').all(workspace, after ?? '', n)) as Row[];
        return rows.map((r) => ({ sourceId: r.source_id as string, storageRef: r.storage_ref as string }));
    }

    async createJob(j: NewJob, now: Date): Promise<{ job: IngestionJob; created: boolean }> {
        const jobId = makeJobId(j);
        const iso = now.toISOString();
        const info = this.db.prepare(`INSERT OR IGNORE INTO ingest_jobs (job_id, workspace, source_id, stage, processor_id, contract_version, state,
            attempts, max_attempts, next_attempt_at, params_json, parent_job_id, created_at, updated_at) VALUES (?,?,?,?,?,?, 'queued', 0, ?, ?, ?, ?, ?, ?)`)
            .run(jobId, j.workspace, j.sourceId, j.stage, j.processorId, j.contractVersion, j.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, iso,
                JSON.stringify(j.params ?? {}), j.parentJobId ?? null, iso, iso);
        return { job: (await this.getJob(jobId))!, created: info.changes === 1 };
    }

    async getJob(jobId: string): Promise<IngestionJob | undefined> {
        const r = this.db.prepare('SELECT * FROM ingest_jobs WHERE job_id = ?').get(jobId) as Row | undefined;
        return r && toJob(r);
    }

    async listJobs(workspace: string, state?: JobState, limit = 100): Promise<IngestionJob[]> {
        const rows = state
            ? this.db.prepare('SELECT * FROM ingest_jobs WHERE workspace = ? AND state = ? ORDER BY created_at LIMIT ?').all(workspace, state, limit)
            : this.db.prepare('SELECT * FROM ingest_jobs WHERE workspace = ? ORDER BY created_at LIMIT ?').all(workspace, limit);
        return (rows as Row[]).map(toJob);
    }

    async claimDue(now: Date, limit: number, leaseMs?: number): Promise<IngestionJob[]> {
        const iso = now.toISOString();
        const lease = leaseMs && leaseMs > 0 ? new Date(now.getTime() + leaseMs).toISOString() : null;
        const tx = this.db.transaction(() => {
            const rows = this.db.prepare(`SELECT job_id FROM ingest_jobs WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, created_at LIMIT ?`).all(iso, limit) as Row[];
            const upd = this.db.prepare(`UPDATE ingest_jobs SET state = 'running', updated_at = ?, lease_until = ? WHERE job_id = ? AND state = 'queued'`);
            return rows.filter((r) => upd.run(iso, lease, r.job_id).changes === 1).map((r) => r.job_id as string);
        });
        const ids = tx.immediate();
        return ids.map((id) => toJob(this.db.prepare('SELECT * FROM ingest_jobs WHERE job_id = ?').get(id) as Row));
    }

    async extendLease(jobId: string, leaseUntil: Date, now: Date): Promise<boolean> {
        return this.db.prepare(`UPDATE ingest_jobs SET lease_until = ?, updated_at = ? WHERE job_id = ? AND state = 'running'`)
            .run(leaseUntil.toISOString(), now.toISOString(), jobId).changes === 1;
    }

    async reclaimExpiredLeases(now: Date, opts: ReclaimOptions): Promise<IngestionJob[]> {
        const iso = now.toISOString();
        const legacyCutoff = new Date(now.getTime() - opts.legacyGraceMs).toISOString();
        const backoff = opts.backoff ?? DEFAULT_BACKOFF;
        const tx = this.db.transaction(() => {
            const rows = this.db.prepare(`SELECT * FROM ingest_jobs WHERE state = 'running'
                AND ((lease_until IS NOT NULL AND lease_until <= ?) OR (lease_until IS NULL AND updated_at <= ?)) ORDER BY updated_at LIMIT ?`)
                .all(iso, legacyCutoff, opts.limit) as Row[];
            const out: string[] = [];
            for (const r of rows) {
                const attempts = r.attempts + 1;
                if (attempts < r.max_attempts) {
                    const next = new Date(now.getTime() + computeBackoffMs(attempts, backoff)).toISOString();
                    this.db.prepare(`UPDATE ingest_jobs SET state = 'queued', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?, lease_until = NULL WHERE job_id = ? AND state = 'running'`)
                        .run(attempts, next, RECLAIM_ERROR, iso, r.job_id);
                } else {
                    this.db.prepare(`UPDATE ingest_jobs SET state = 'dead_letter', attempts = ?, last_error = ?, updated_at = ?, completed_at = ?, lease_until = NULL WHERE job_id = ? AND state = 'running'`)
                        .run(attempts, RECLAIM_ERROR, iso, iso, r.job_id);
                }
                out.push(r.job_id as string);
            }
            return out;
        });
        return tx.immediate().map((id) => toJob(this.db.prepare('SELECT * FROM ingest_jobs WHERE job_id = ?').get(id) as Row));
    }

    async markAwaitingCallback(jobId: string, remoteRequestId: string | null, now: Date): Promise<void> {
        this.db.prepare(`UPDATE ingest_jobs SET state = 'awaiting_callback', lease_until = NULL, remote_request_id = ?, updated_at = ? WHERE job_id = ? AND state IN ('running','awaiting_callback')`)
            .run(remoteRequestId, now.toISOString(), jobId);
    }

    async markSucceeded(jobId: string, result: unknown, now: Date): Promise<boolean> {
        const iso = now.toISOString();
        return this.db.prepare(`UPDATE ingest_jobs SET state = 'succeeded', lease_until = NULL, result_json = ?, completed_at = ?, updated_at = ?, last_error = NULL
            WHERE job_id = ? AND state IN ('running','awaiting_callback','queued')`).run(JSON.stringify(result), iso, iso, jobId).changes === 1;
    }

    async markResultsWritten(jobId: string, now: Date): Promise<void> {
        this.db.prepare('UPDATE ingest_jobs SET results_written_at = ?, updated_at = ? WHERE job_id = ?').run(now.toISOString(), now.toISOString(), jobId);
    }

    async recordFailure(jobId: string, error: string, retryable: boolean, now: Date, backoff: BackoffOptions = DEFAULT_BACKOFF): Promise<IngestionJob | undefined> {
        const tx = this.db.transaction(() => {
            const r = this.db.prepare('SELECT * FROM ingest_jobs WHERE job_id = ?').get(jobId) as Row | undefined;
            if (!r || r.state === 'succeeded' || r.state === 'dead_letter') return;
            const attempts = r.attempts + 1;
            const iso = now.toISOString();
            const msg = error.slice(0, 2000);
            if (retryable && attempts < r.max_attempts) {
                const next = new Date(now.getTime() + computeBackoffMs(attempts, backoff)).toISOString();
                this.db.prepare(`UPDATE ingest_jobs SET state = 'queued', lease_until = NULL, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE job_id = ?`).run(attempts, next, msg, iso, jobId);
            } else {
                this.db.prepare(`UPDATE ingest_jobs SET state = 'dead_letter', lease_until = NULL, attempts = ?, last_error = ?, updated_at = ?, completed_at = ? WHERE job_id = ?`).run(attempts, msg, iso, iso, jobId);
            }
        });
        tx.immediate();
        return this.getJob(jobId);
    }

    async requeueDeadLetter(jobId: string, now: Date): Promise<boolean> {
        const iso = now.toISOString();
        return this.db.prepare(`UPDATE ingest_jobs SET state = 'queued', attempts = 0, next_attempt_at = ?, completed_at = NULL, updated_at = ? WHERE job_id = ? AND state = 'dead_letter'`).run(iso, iso, jobId).changes === 1;
    }

    async listStaleAwaiting(olderThan: Date, limit: number): Promise<IngestionJob[]> {
        return (this.db.prepare(`SELECT * FROM ingest_jobs WHERE state = 'awaiting_callback' AND updated_at <= ? ORDER BY updated_at LIMIT ?`).all(olderThan.toISOString(), limit) as Row[]).map(toJob);
    }

    async recordDelivery(jobId: string, deliveryId: string, now: Date): Promise<boolean> {
        return this.db.prepare('INSERT OR IGNORE INTO ingest_deliveries (job_id, delivery_id, seen_at) VALUES (?,?,?)').run(jobId, deliveryId, now.toISOString()).changes === 1;
    }

    async purgeOldDeliveries(now: Date, opts?: PurgeDeliveriesOptions): Promise<number> {
        const { cutoff, limit } = resolvePurge(now, opts);
        return this.db.prepare('DELETE FROM ingest_deliveries WHERE rowid IN (SELECT rowid FROM ingest_deliveries WHERE seen_at < ? ORDER BY seen_at LIMIT ?)')
            .run(cutoff.toISOString(), limit).changes;
    }

    async recordPending(p: PendingStructured, now: Date): Promise<void> {
        this.db.prepare('INSERT OR REPLACE INTO ingest_pending (job_id, workspace, source_id, reason, payload_json, created_at) VALUES (?,?,?,?,?,?)')
            .run(p.jobId, p.workspace, p.sourceId, p.reason.slice(0, 1000), JSON.stringify(p.payload), now.toISOString());
    }

    async listPending(workspace: string, limit = 100): Promise<PendingStructured[]> {
        return (this.db.prepare('SELECT * FROM ingest_pending WHERE workspace = ? ORDER BY created_at LIMIT ?').all(workspace, limit) as Row[])
            .map((r) => ({ jobId: r.job_id, workspace: r.workspace, sourceId: r.source_id, reason: r.reason, payload: JSON.parse(r.payload_json) }));
    }

    async clearPending(jobId: string): Promise<void> { this.db.prepare('DELETE FROM ingest_pending WHERE job_id = ?').run(jobId); }

    async close(): Promise<void> { this.db.close(); }
}
