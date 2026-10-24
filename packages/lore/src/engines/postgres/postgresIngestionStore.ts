/**
 * postgresIngestionStore.ts — Postgres implementation of IIngestionStore.
 *
 * TENANCY: one store instance is BOUND to one workspace (`workspace_id` is the
 * hard tenant column and Dataplane tenant id). The port's id-only methods
 * (getJob, markSucceeded, recordDelivery, claimDue ...) carry no workspace
 * argument, so the binding supplies it: EVERY statement below filters on
 * `workspace_id = $1` (or writes it). A job id from another workspace is simply
 * "not found" here; writes that name another workspace throw. A host that serves
 * several workspaces opens one store (and one coordinator) per workspace.
 *
 * EXACTLY-ONCE CLAIM: `claimDue` is one statement: a MATERIALIZED CTE that picks
 * `... FOR UPDATE SKIP LOCKED LIMIT n`, joined into the UPDATE (a plain
 * `job_id IN (subquery)` lets the planner re-run the LIMIT subquery per outer row
 * and over-claim, which the contract test caught) — concurrent claimers (other
 * workers, other processes) skip rows another transaction has locked, so a job
 * is handed to exactly one of them. The outer `state = 'queued'` re-check closes
 * the READ COMMITTED re-evaluation window.
 *
 * POOL: uses the process-wide shared pool (postgresPoolOwner) and never ends it;
 * `close()` only retires this handle. Schema goes through runSchemaBootstrap
 * (advisory-locked, idempotent). No fallback to SQLite when LORE_PG_URL is unset.
 */
import type { Pool } from 'pg';
import {
    DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS, RECLAIM_ERROR, computeBackoffMs, makeJobId, makeSourceId, resolvePurge,
    type BackoffOptions, type IIngestionStore, type IngestionJob, type JobState, type NewJob, type PendingStructured,
    type PurgeDeliveriesOptions, type ReclaimOptions, type SourceRecord,
} from '../../ingestion/store.js';
import { withTransaction } from './postgresClient.js';
import { sharedPostgresPool } from './postgresPoolOwner.js';
import { runSchemaBootstrap } from './postgresStartup.js';
import { INGEST_TABLES, ingestionSchema_ddl } from './postgresIngestionSchema.js';

const { sources: SOURCES, jobs: JOBS, pending: PENDING, deliveries: DELIVERIES } = INGEST_TABLES;

type Row = Record<string, any>;

/** A write named a workspace other than the one this store is bound to. */
export class IngestionWorkspaceMismatchError extends Error {
    constructor(readonly bound: string, readonly requested: string) {
        super(`ingestion store is bound to workspace '${bound}' and refused a write for '${requested}'`);
        this.name = 'IngestionWorkspaceMismatchError';
    }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Postgres `text` cannot hold NUL; strip it. */
function text(s: string): string { return s.replace(/\0/g, ''); }

/**
 * JSON for a JSONB parameter. JSONB (unlike SQLite TEXT) rejects `\u0000` and lone
 * surrogates, both of which extracted document text can contain, so string values
 * are made well-formed and NUL-free (lossy only for those characters).
 */
function jsonb(v: unknown): string | null {
    const s = JSON.stringify(v, (_k, x) => (typeof x === 'string' ? x.replace(LONE_SURROGATE, '\uFFFD').replace(/\0/g, '') : x));
    return s === undefined ? null : s;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function toJob(r: Row): IngestionJob {
    return {
        jobId: r.job_id, workspace: r.workspace_id, sourceId: r.source_id, stage: r.stage, processorId: r.processor_id,
        contractVersion: r.contract_version, state: r.state, attempts: r.attempts, maxAttempts: r.max_attempts,
        nextAttemptAt: iso(r.next_attempt_at)!, lastError: r.last_error, params: r.params ?? {},
        parentJobId: r.parent_job_id, remoteRequestId: r.remote_request_id, resultsWrittenAt: iso(r.results_written_at),
        result: r.result === undefined ? null : r.result,
        createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, completedAt: iso(r.completed_at),
        leaseUntil: iso(r.lease_until),
    };
}

function toSource(r: Row): SourceRecord {
    return { sourceId: r.source_id, workspace: r.workspace_id, fileName: r.file_name, mimeType: r.mime_type, sha256: r.sha256,
        sizeBytes: Number(r.size_bytes), storageRef: r.storage_ref, createdAt: iso(r.created_at)! };
}

export class PostgresIngestionStore implements IIngestionStore {
    private constructor(private readonly pool: Pool, readonly workspace: string) {}

    /** Open (bootstrapping the schema if needed) a store bound to `workspace`. Throws if LORE_PG_URL is unset. */
    static async open(workspace: string, pool: Pool = sharedPostgresPool()): Promise<PostgresIngestionStore> {
        if (!workspace) throw new Error('PostgresIngestionStore.open: workspace is required');
        await runSchemaBootstrap(pool, {}, async (client) => { for (const stmt of ingestionSchema_ddl()) await client.query(stmt); });
        return new PostgresIngestionStore(pool, workspace);
    }

    private own(workspace: string): void {
        if (workspace !== this.workspace) throw new IngestionWorkspaceMismatchError(this.workspace, workspace);
    }

    async upsertSource(s: Omit<SourceRecord, 'sourceId' | 'createdAt'>): Promise<SourceRecord> {
        this.own(s.workspace);
        const sourceId = makeSourceId(s.workspace, s.sha256);
        await this.pool.query(
            `INSERT INTO ${SOURCES} (workspace_id, source_id, file_name, mime_type, sha256, size_bytes, storage_ref, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [this.workspace, sourceId, text(s.fileName), text(s.mimeType), s.sha256, s.sizeBytes, text(s.storageRef), new Date()]);
        // Conflict key is (workspace, sha256) OR (workspace, source_id); the id derives from both, so read back by sha256.
        const r = await this.pool.query(`SELECT * FROM ${SOURCES} WHERE workspace_id = $1 AND sha256 = $2`, [this.workspace, s.sha256]);
        return toSource(r.rows[0]!);
    }

    async getSource(workspace: string, sourceId: string): Promise<SourceRecord | undefined> {
        if (workspace !== this.workspace) return undefined;
        const r = await this.pool.query(`SELECT * FROM ${SOURCES} WHERE workspace_id = $1 AND source_id = $2`, [this.workspace, sourceId]);
        return r.rows[0] && toSource(r.rows[0]);
    }

    async createJob(j: NewJob, now: Date): Promise<{ job: IngestionJob; created: boolean }> {
        this.own(j.workspace);
        const jobId = makeJobId(j);
        const ins = await this.pool.query(
            `INSERT INTO ${JOBS} (job_id, workspace_id, source_id, stage, processor_id, contract_version, state, attempts, max_attempts,
                next_attempt_at, params, parent_job_id, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,'queued',0,$7,$8,$9::jsonb,$10,$8,$8) ON CONFLICT DO NOTHING`,
            [jobId, this.workspace, j.sourceId, j.stage, text(j.processorId), text(j.contractVersion), j.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, now,
                jsonb(j.params ?? {}), j.parentJobId ?? null]);
        const job = await this.getJob(jobId);
        // The id hashes the workspace, so an existing row under another tenant would be a hash collision: refuse loudly.
        if (!job) throw new Error(`createJob: job id ${jobId} exists but is not visible to workspace '${this.workspace}'`);
        return { job, created: ins.rowCount === 1 };
    }

    async getJob(jobId: string): Promise<IngestionJob | undefined> {
        const r = await this.pool.query(`SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND job_id = $2`, [this.workspace, jobId]);
        return r.rows[0] && toJob(r.rows[0]);
    }

    async listJobs(workspace: string, state?: JobState, limit = 100): Promise<IngestionJob[]> {
        if (workspace !== this.workspace) return [];
        const r = state
            ? await this.pool.query(`SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND state = $2 ORDER BY created_at, job_id LIMIT $3`, [this.workspace, state, limit])
            : await this.pool.query(`SELECT * FROM ${JOBS} WHERE workspace_id = $1 ORDER BY created_at, job_id LIMIT $2`, [this.workspace, limit]);
        return r.rows.map(toJob);
    }

    async claimDue(now: Date, limit: number, leaseMs?: number): Promise<IngestionJob[]> {
        if (limit < 1) return [];
        const lease = leaseMs && leaseMs > 0 ? new Date(now.getTime() + leaseMs) : null;
        const r = await this.pool.query(
            `WITH picked AS MATERIALIZED (
                 SELECT job_id FROM ${JOBS}
                 WHERE workspace_id = $1 AND state = 'queued' AND next_attempt_at <= $2
                 ORDER BY next_attempt_at, created_at, job_id
                 FOR UPDATE SKIP LOCKED LIMIT $3)
             UPDATE ${JOBS} j SET state = 'running', updated_at = $2, lease_until = $4
             FROM picked
             WHERE j.job_id = picked.job_id AND j.workspace_id = $1 AND j.state = 'queued'
             RETURNING j.*`,
            [this.workspace, now, Math.floor(limit), lease]);
        // RETURNING order is unspecified; restore the claim order.
        return r.rows.map(toJob).sort((a, b) =>
            a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
    }

    async extendLease(jobId: string, leaseUntil: Date, now: Date): Promise<boolean> {
        const r = await this.pool.query(
            `UPDATE ${JOBS} SET lease_until = $3, updated_at = $4 WHERE workspace_id = $1 AND job_id = $2 AND state = 'running'`,
            [this.workspace, jobId, leaseUntil, now]);
        return r.rowCount === 1;
    }

    /** One transaction: lock the expired rows (`FOR UPDATE SKIP LOCKED`, so a concurrent reclaimer skips them) and fail each attempt. */
    async reclaimExpiredLeases(now: Date, opts: ReclaimOptions): Promise<IngestionJob[]> {
        if (opts.limit < 1) return [];
        const backoff = opts.backoff ?? DEFAULT_BACKOFF;
        const legacyCutoff = new Date(now.getTime() - opts.legacyGraceMs);
        return withTransaction(this.pool, async (c) => {
            const cur = await c.query(
                `SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND state = 'running'
                   AND ((lease_until IS NOT NULL AND lease_until <= $2) OR (lease_until IS NULL AND updated_at <= $3))
                 ORDER BY updated_at, job_id FOR UPDATE SKIP LOCKED LIMIT $4`,
                [this.workspace, now, legacyCutoff, Math.floor(opts.limit)]);
            const out: IngestionJob[] = [];
            for (const r of cur.rows) {
                const attempts = r.attempts + 1;
                const upd = attempts < r.max_attempts
                    ? await c.query(`UPDATE ${JOBS} SET state = 'queued', attempts = $3, next_attempt_at = $4, last_error = $5, updated_at = $6, lease_until = NULL
                                     WHERE workspace_id = $1 AND job_id = $2 RETURNING *`,
                        [this.workspace, r.job_id, attempts, new Date(now.getTime() + computeBackoffMs(attempts, backoff)), RECLAIM_ERROR, now])
                    : await c.query(`UPDATE ${JOBS} SET state = 'dead_letter', attempts = $3, last_error = $4, updated_at = $5, completed_at = $5, lease_until = NULL
                                     WHERE workspace_id = $1 AND job_id = $2 RETURNING *`,
                        [this.workspace, r.job_id, attempts, RECLAIM_ERROR, now]);
                out.push(toJob(upd.rows[0]));
            }
            return out;
        });
    }

    async markAwaitingCallback(jobId: string, remoteRequestId: string | null, now: Date): Promise<void> {
        await this.pool.query(
            `UPDATE ${JOBS} SET state = 'awaiting_callback', lease_until = NULL, remote_request_id = $3, updated_at = $4
             WHERE workspace_id = $1 AND job_id = $2 AND state IN ('running','awaiting_callback')`,
            [this.workspace, jobId, remoteRequestId === null ? null : text(remoteRequestId), now]);
    }

    async markSucceeded(jobId: string, result: unknown, now: Date): Promise<boolean> {
        const r = await this.pool.query(
            `UPDATE ${JOBS} SET state = 'succeeded', lease_until = NULL, result = $3::jsonb, completed_at = $4, updated_at = $4, last_error = NULL
             WHERE workspace_id = $1 AND job_id = $2 AND state IN ('running','awaiting_callback','queued')`,
            [this.workspace, jobId, jsonb(result), now]);
        return r.rowCount === 1;
    }

    async markResultsWritten(jobId: string, now: Date): Promise<void> {
        await this.pool.query(`UPDATE ${JOBS} SET results_written_at = $3, updated_at = $3 WHERE workspace_id = $1 AND job_id = $2`, [this.workspace, jobId, now]);
    }

    async recordFailure(jobId: string, error: string, retryable: boolean, now: Date, backoff: BackoffOptions = DEFAULT_BACKOFF): Promise<IngestionJob | undefined> {
        return withTransaction(this.pool, async (c) => {
            const cur = await c.query(`SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND job_id = $2 FOR UPDATE`, [this.workspace, jobId]);
            const r = cur.rows[0];
            if (!r) return undefined;
            if (r.state === 'succeeded' || r.state === 'dead_letter') return toJob(r);
            const attempts = r.attempts + 1;
            const msg = text(error.slice(0, 2000));
            const retry = retryable && attempts < r.max_attempts;
            const upd = retry
                ? await c.query(`UPDATE ${JOBS} SET state = 'queued', lease_until = NULL, attempts = $3, next_attempt_at = $4, last_error = $5, updated_at = $6
                                 WHERE workspace_id = $1 AND job_id = $2 RETURNING *`,
                    [this.workspace, jobId, attempts, new Date(now.getTime() + computeBackoffMs(attempts, backoff)), msg, now])
                : await c.query(`UPDATE ${JOBS} SET state = 'dead_letter', lease_until = NULL, attempts = $3, last_error = $4, updated_at = $5, completed_at = $5
                                 WHERE workspace_id = $1 AND job_id = $2 RETURNING *`,
                    [this.workspace, jobId, attempts, msg, now]);
            return toJob(upd.rows[0]);
        });
    }

    async requeueDeadLetter(jobId: string, now: Date): Promise<boolean> {
        const r = await this.pool.query(
            `UPDATE ${JOBS} SET state = 'queued', attempts = 0, next_attempt_at = $3, completed_at = NULL, updated_at = $3
             WHERE workspace_id = $1 AND job_id = $2 AND state = 'dead_letter'`,
            [this.workspace, jobId, now]);
        return r.rowCount === 1;
    }

    async listStaleAwaiting(olderThan: Date, limit: number): Promise<IngestionJob[]> {
        const r = await this.pool.query(
            `SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND state = 'awaiting_callback' AND updated_at <= $2 ORDER BY updated_at, job_id LIMIT $3`,
            [this.workspace, olderThan, limit]);
        return r.rows.map(toJob);
    }

    /** True when this (job, delivery) pair is new. A job that is not in this workspace never records (false): otherwise
     *  another tenant could pre-claim a delivery id and make the owner's real callback look like a replay. */
    async recordDelivery(jobId: string, deliveryId: string, now: Date): Promise<boolean> {
        const r = await this.pool.query(
            `INSERT INTO ${DELIVERIES} (job_id, delivery_id, workspace_id, seen_at)
             SELECT job_id, $2, workspace_id, $3 FROM ${JOBS} WHERE job_id = $1 AND workspace_id = $4
             ON CONFLICT DO NOTHING`,
            [jobId, text(deliveryId), now, this.workspace]);
        return r.rowCount === 1;
    }

    async purgeOldDeliveries(now: Date, opts?: PurgeDeliveriesOptions): Promise<number> {
        const { cutoff, limit } = resolvePurge(now, opts);
        const r = await this.pool.query(
            `DELETE FROM ${DELIVERIES} WHERE (job_id, delivery_id) IN (
                 SELECT job_id, delivery_id FROM ${DELIVERIES} WHERE workspace_id = $1 AND seen_at < $2 ORDER BY seen_at LIMIT $3)
             AND workspace_id = $1`,
            [this.workspace, cutoff, limit]);
        return r.rowCount ?? 0;
    }

    async recordPending(p: PendingStructured, now: Date): Promise<void> {
        this.own(p.workspace);
        // Replace semantics (SQLite INSERT OR REPLACE) but never take over another tenant's row.
        // The job must be in this workspace, so one tenant can never occupy (and thereby block) another tenant's pending slot.
        const r = await this.pool.query(
            `INSERT INTO ${PENDING} (job_id, workspace_id, source_id, reason, payload, created_at)
             SELECT job_id, workspace_id, $2, $3, $4::jsonb, $5 FROM ${JOBS} WHERE job_id = $1 AND workspace_id = $6
             ON CONFLICT (job_id) DO UPDATE SET source_id = EXCLUDED.source_id, reason = EXCLUDED.reason, payload = EXCLUDED.payload,
                 created_at = EXCLUDED.created_at
             WHERE ${PENDING}.workspace_id = EXCLUDED.workspace_id`,
            [p.jobId, p.sourceId, text(p.reason.slice(0, 1000)), jsonb(p.payload), now, this.workspace]);
        if (r.rowCount !== 1) throw new Error(`recordPending: job ${p.jobId} is not in workspace '${this.workspace}'`);
    }

    async listPending(workspace: string, limit = 100): Promise<PendingStructured[]> {
        if (workspace !== this.workspace) return [];
        const r = await this.pool.query(`SELECT * FROM ${PENDING} WHERE workspace_id = $1 ORDER BY created_at, job_id LIMIT $2`, [this.workspace, limit]);
        return r.rows.map((x: Row) => ({ jobId: x.job_id, workspace: x.workspace_id, sourceId: x.source_id, reason: x.reason, payload: x.payload }));
    }

    async clearPending(jobId: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${PENDING} WHERE workspace_id = $1 AND job_id = $2`, [this.workspace, jobId]);
    }

    /** Retires this handle only; the shared pool belongs to postgresPoolOwner. */
    async close(): Promise<void> { /* nothing owned */ }
}
