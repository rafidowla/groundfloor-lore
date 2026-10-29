/**
 * postgresIngestionStore.ts — Postgres implementation of IIngestionStore.
 *
 * TENANCY: one store instance is BOUND to one workspace (`workspace_id`, holding the workspace's PERMANENT id,
 * is the hard tenant column and Dataplane tenant id; callers and returned records use the workspace NAME). The port's id-only methods
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
    DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS, RECLAIM_ERROR, TERMINAL_JOB_STATES, computeBackoffMs, makeJobId, makeSourceId, resolvePurge,
    type BackoffOptions, type IIngestionStore, type IngestionJob, type JobState, type NewJob, type PendingStructured,
    type PurgeDeliveriesOptions, type ReclaimOptions, type SourceRecord,
} from '../../ingestion/store.js';
import { withTransaction } from './postgresClient.js';
import { ensureRekeyed } from './postgresRekey.js';
import { sharedPostgresPool } from './postgresPoolOwner.js';
import { runSchemaBootstrap } from './postgresStartup.js';
import { INGEST_TABLES, ingestionSchema_ddl, ensureIngestionWorkspaceKeys } from './postgresIngestionSchema.js';

const { sources: SOURCES, jobs: JOBS, pending: PENDING, deliveries: DELIVERIES } = INGEST_TABLES;

/**
 * While the legacy single-column keys still exist next to the workspace-led ones (Phase 0 expand, until the contract step),
 * two concurrent inserts of the same row can trip the NON-arbiter key (23505) instead of reaching the ON CONFLICT arm. A
 * retry finds the committed row through the arbiter and takes the conflict path, so the caller sees the old behaviour.
 */
async function retryUniqueRace<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try { return await fn(); }
        catch (err) {
            if ((err as { code?: string }).code !== '23505' || attempt >= 3) throw err;
        }
    }
}

/** Re-runs of the open-time schema + key steps after a deadlock (40P01) between concurrent first opens. */
const OPEN_DEADLOCK_RETRIES = 5;

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

function toJob(r: Row, workspace: string): IngestionJob {
    return {
        jobId: r.job_id, workspace, sourceId: r.source_id, stage: r.stage, processorId: r.processor_id,
        contractVersion: r.contract_version, state: r.state, attempts: r.attempts, maxAttempts: r.max_attempts,
        nextAttemptAt: iso(r.next_attempt_at)!, lastError: r.last_error, params: r.params ?? {},
        parentJobId: r.parent_job_id, remoteRequestId: r.remote_request_id, resultsWrittenAt: iso(r.results_written_at),
        result: r.result === undefined ? null : r.result,
        createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, completedAt: iso(r.completed_at),
        leaseUntil: iso(r.lease_until),
    };
}

function toSource(r: Row, workspace: string): SourceRecord {
    return { sourceId: r.source_id, workspace, fileName: r.file_name, mimeType: r.mime_type, sha256: r.sha256,
        sizeBytes: Number(r.size_bytes), storageRef: r.storage_ref, createdAt: iso(r.created_at)!, blobPurgedAt: iso(r.blob_purged_at) };
}

export class PostgresIngestionStore implements IIngestionStore {
    /**
     * `workspace` is the name callers use (it is what every returned record carries and what writes must name);
     * `key` is the `workspace_id` stored in Postgres: the workspace's PERMANENT id. New job and source ids hash the
     * KEY, never the name: `job_id` is a global primary key, so a successor workspace that reuses a deleted workspace's
     * name must not derive the same ids. Rows written before that (ids hashed from the NAME) are still found, only
     * inside this workspace's own rows, so re-submitting identical work after the upgrade does not create a second job.
     */
    private constructor(private readonly pool: Pool, readonly workspace: string, private readonly key: string) {}

    /**
     * Open (bootstrapping the schema if needed) a store bound to `workspace`. Throws if LORE_PG_URL is unset.
     * `key` is the Postgres row key (the permanent workspace id; see postgresWorkspaceKey.ts). Production callers
     * always pass it; a caller that omits it (tests, tools holding a ready-made key) says the string IS the key.
     */
    static async open(workspace: string, pool: Pool = sharedPostgresPool(), key: string = workspace): Promise<PostgresIngestionStore> {
        if (!workspace) throw new Error('PostgresIngestionStore.open: workspace is required');
        if (!key) throw new Error('PostgresIngestionStore.open: key is required');
        for (let attempt = 0; ; attempt++) {
            try {
                await runSchemaBootstrap(pool, {}, async (client) => { for (const stmt of ingestionSchema_ddl()) await client.query(stmt); });
                await ensureIngestionWorkspaceKeys(pool); // workspace-led unique keys the ON CONFLICT targets need (built CONCURRENTLY, outside the schema lock)
                break;
            } catch (err) {
                // Concurrent first opens: one opener's schema DDL (ALTER TABLE ... IF NOT EXISTS still takes ACCESS EXCLUSIVE)
                // can deadlock against another opener's CONCURRENTLY key build. Postgres aborts one side (40P01); both steps
                // are idempotent and an INVALID index left by an aborted build is dropped and rebuilt, so re-running finishes.
                if ((err as { code?: string }).code !== '40P01' || attempt >= OPEN_DEADLOCK_RETRIES) throw err;
                await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + Math.random() * 50));
            }
        }
        await ensureRekeyed(pool, key); // one-time name -> permanent-id row rewrite (postgresRekey.ts)
        return new PostgresIngestionStore(pool, workspace, key);
    }

    private own(workspace: string): void {
        if (workspace !== this.workspace) throw new IngestionWorkspaceMismatchError(this.workspace, workspace);
    }

    /** An existing source keeps the id it was created with (name-hashed before the id-keyed rewrite); a new one gets a key-hashed id. */
    async resolveSourceId(workspace: string, sha256: string): Promise<string> {
        this.own(workspace);
        const r = await this.pool.query(`SELECT source_id FROM ${SOURCES} WHERE workspace_id = $1 AND sha256 = $2`, [this.key, sha256]);
        return r.rows[0] ? (r.rows[0].source_id as string) : makeSourceId(this.key, sha256);
    }

    async upsertSource(s: Omit<SourceRecord, 'sourceId' | 'createdAt' | 'blobPurgedAt'>): Promise<SourceRecord> {
        this.own(s.workspace);
        const sourceId = makeSourceId(this.key, s.sha256);
        await this.pool.query(
            `INSERT INTO ${SOURCES} (workspace_id, source_id, file_name, mime_type, sha256, size_bytes, storage_ref, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [this.key, sourceId, text(s.fileName), text(s.mimeType), s.sha256, s.sizeBytes, text(s.storageRef), new Date()]);
        // Conflict key is (workspace, sha256) OR (workspace, source_id); the id derives from both, so read back by sha256.
        const r = await this.pool.query(`SELECT * FROM ${SOURCES} WHERE workspace_id = $1 AND sha256 = $2`, [this.key, s.sha256]);
        return toSource(r.rows[0]!, this.workspace);
    }

    async getSource(workspace: string, sourceId: string): Promise<SourceRecord | undefined> {
        if (workspace !== this.workspace) return undefined;
        const r = await this.pool.query(`SELECT * FROM ${SOURCES} WHERE workspace_id = $1 AND source_id = $2`, [this.key, sourceId]);
        return r.rows[0] && toSource(r.rows[0], this.workspace);
    }

    async setSourceBlob(workspace: string, sourceId: string, storageRef: string): Promise<void> {
        this.own(workspace);
        await this.pool.query(`UPDATE ${SOURCES} SET storage_ref = $3, blob_purged_at = NULL WHERE workspace_id = $1 AND source_id = $2`, [this.key, sourceId, text(storageRef)]);
    }

    async claimBlobPurge(cutoff: Date, now: Date, limit: number): Promise<Array<{ workspace: string; sourceId: string; storageRef: string }>> {
        const terminal = TERMINAL_JOB_STATES.map((t) => `'${t}'`).join(',');
        // One statement: candidates are row-locked (SKIP LOCKED, so two sweepers never take the same source) and marked in place.
        const r = await this.pool.query(
            `WITH cand AS MATERIALIZED (
                 SELECT s.source_id FROM ${SOURCES} s
                 WHERE s.workspace_id = $1 AND s.blob_purged_at IS NULL
                   AND EXISTS (SELECT 1 FROM ${JOBS} j WHERE j.workspace_id = s.workspace_id AND j.source_id = s.source_id)
                   AND NOT EXISTS (SELECT 1 FROM ${JOBS} j WHERE j.workspace_id = s.workspace_id AND j.source_id = s.source_id AND j.state NOT IN (${terminal}))
                   AND (SELECT MAX(COALESCE(j.completed_at, j.updated_at)) FROM ${JOBS} j WHERE j.workspace_id = s.workspace_id AND j.source_id = s.source_id) <= $2
                   AND NOT EXISTS (SELECT 1 FROM ${SOURCES} o WHERE o.workspace_id = s.workspace_id AND o.storage_ref = s.storage_ref AND o.source_id <> s.source_id AND o.blob_purged_at IS NULL
                       AND (NOT EXISTS (SELECT 1 FROM ${JOBS} j WHERE j.workspace_id = o.workspace_id AND j.source_id = o.source_id)
                            OR EXISTS (SELECT 1 FROM ${JOBS} j WHERE j.workspace_id = o.workspace_id AND j.source_id = o.source_id AND j.state NOT IN (${terminal}))))
                 ORDER BY s.created_at, s.source_id LIMIT $3 FOR UPDATE OF s SKIP LOCKED)
             UPDATE ${SOURCES} s SET blob_purged_at = $4 FROM cand
             WHERE s.workspace_id = $1 AND s.source_id = cand.source_id AND s.blob_purged_at IS NULL
             RETURNING s.workspace_id, s.source_id, s.storage_ref`,
            [this.key, cutoff, Math.max(1, Math.floor(limit)), now]);
        return r.rows.map((x: Row) => ({ workspace: this.workspace, sourceId: x.source_id as string, storageRef: x.storage_ref as string }));
    }

    async releaseBlobPurge(workspace: string, sourceId: string): Promise<void> {
        this.own(workspace);
        await this.pool.query(`UPDATE ${SOURCES} SET blob_purged_at = NULL WHERE workspace_id = $1 AND source_id = $2`, [this.key, sourceId]);
    }

    async listSourceBlobRefs(workspace: string | null, limit: number, after?: string): Promise<Array<{ sourceId: string; storageRef: string }>> {
        if (workspace !== null && workspace !== this.workspace) return [];
        const r = await this.pool.query(
            `SELECT source_id, storage_ref FROM ${SOURCES} WHERE workspace_id = $1 AND blob_purged_at IS NULL AND source_id > $2 ORDER BY source_id LIMIT $3`,
            [this.key, after ?? '', Math.max(1, Math.floor(limit))]);
        return r.rows.map((x: Row) => ({ sourceId: x.source_id as string, storageRef: x.storage_ref as string }));
    }

    /** New blobs are filed under the permanent workspace id (see {@link IIngestionStore.blobScope}). */
    blobScope(workspace: string): string {
        this.own(workspace);
        return this.key;
    }

    async createJob(j: NewJob, now: Date): Promise<{ job: IngestionJob; created: boolean }> {
        this.own(j.workspace);
        const jobId = makeJobId({ ...j, workspace: this.key });
        if (this.key !== this.workspace) {
            // Jobs created before ids hashed the permanent id were named by the workspace name. Match them (own rows only)
            // so an identical resubmission is a repeat, not a second job with duplicate memory nodes (memoryNodeId derives from the job id).
            const legacy = await this.getJob(makeJobId(j));
            if (legacy) return { job: legacy, created: false };
        }
        const ins = await this.pool.query(
            `INSERT INTO ${JOBS} (job_id, workspace_id, source_id, stage, processor_id, contract_version, state, attempts, max_attempts,
                next_attempt_at, params, parent_job_id, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,'queued',0,$7,$8,$9::jsonb,$10,$8,$8) ON CONFLICT DO NOTHING`,
            [jobId, this.key, j.sourceId, j.stage, text(j.processorId), text(j.contractVersion), j.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, now,
                jsonb(j.params ?? {}), j.parentJobId ?? null]);
        const job = await this.getJob(jobId);
        // The id hashes the permanent id, so an existing row under another workspace would be a hash collision: refuse loudly.
        if (!job) throw new Error(`createJob: job id ${jobId} exists but is not visible to workspace '${this.workspace}'`);
        return { job, created: ins.rowCount === 1 };
    }

    async getJob(jobId: string): Promise<IngestionJob | undefined> {
        const r = await this.pool.query(`SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND job_id = $2`, [this.key, jobId]);
        return r.rows[0] && toJob(r.rows[0], this.workspace);
    }

    async listJobs(workspace: string, state?: JobState, limit = 100): Promise<IngestionJob[]> {
        if (workspace !== this.workspace) return [];
        const r = state
            ? await this.pool.query(`SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND state = $2 ORDER BY created_at, job_id LIMIT $3`, [this.key, state, limit])
            : await this.pool.query(`SELECT * FROM ${JOBS} WHERE workspace_id = $1 ORDER BY created_at, job_id LIMIT $2`, [this.key, limit]);
        return r.rows.map((x: Row) => toJob(x, this.workspace));
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
            [this.key, now, Math.floor(limit), lease]);
        // RETURNING order is unspecified; restore the claim order.
        return r.rows.map((x: Row) => toJob(x, this.workspace)).sort((a, b) =>
            a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
    }

    async extendLease(jobId: string, leaseUntil: Date, now: Date): Promise<boolean> {
        const r = await this.pool.query(
            `UPDATE ${JOBS} SET lease_until = $3, updated_at = $4 WHERE workspace_id = $1 AND job_id = $2 AND state = 'running'`,
            [this.key, jobId, leaseUntil, now]);
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
                [this.key, now, legacyCutoff, Math.floor(opts.limit)]);
            const out: IngestionJob[] = [];
            for (const r of cur.rows) {
                const attempts = r.attempts + 1;
                const upd = attempts < r.max_attempts
                    ? await c.query(`UPDATE ${JOBS} SET state = 'queued', attempts = $3, next_attempt_at = $4, last_error = $5, updated_at = $6, lease_until = NULL
                                     WHERE workspace_id = $1 AND job_id = $2 RETURNING *`,
                        [this.key, r.job_id, attempts, new Date(now.getTime() + computeBackoffMs(attempts, backoff)), RECLAIM_ERROR, now])
                    : await c.query(`UPDATE ${JOBS} SET state = 'dead_letter', attempts = $3, last_error = $4, updated_at = $5, completed_at = $5, lease_until = NULL
                                     WHERE workspace_id = $1 AND job_id = $2 RETURNING *`,
                        [this.key, r.job_id, attempts, RECLAIM_ERROR, now]);
                out.push(toJob(upd.rows[0], this.workspace));
            }
            return out;
        });
    }

    async markAwaitingCallback(jobId: string, remoteRequestId: string | null, now: Date): Promise<void> {
        await this.pool.query(
            `UPDATE ${JOBS} SET state = 'awaiting_callback', lease_until = NULL, remote_request_id = $3, updated_at = $4
             WHERE workspace_id = $1 AND job_id = $2 AND state IN ('running','awaiting_callback')`,
            [this.key, jobId, remoteRequestId === null ? null : text(remoteRequestId), now]);
    }

    async markSucceeded(jobId: string, result: unknown, now: Date): Promise<boolean> {
        const r = await this.pool.query(
            `UPDATE ${JOBS} SET state = 'succeeded', lease_until = NULL, result = $3::jsonb, completed_at = $4, updated_at = $4, last_error = NULL
             WHERE workspace_id = $1 AND job_id = $2 AND state IN ('running','awaiting_callback','queued')`,
            [this.key, jobId, jsonb(result), now]);
        return r.rowCount === 1;
    }

    async markResultsWritten(jobId: string, now: Date): Promise<void> {
        await this.pool.query(`UPDATE ${JOBS} SET results_written_at = $3, updated_at = $3 WHERE workspace_id = $1 AND job_id = $2`, [this.key, jobId, now]);
    }

    async recordFailure(jobId: string, error: string, retryable: boolean, now: Date, backoff: BackoffOptions = DEFAULT_BACKOFF): Promise<IngestionJob | undefined> {
        return withTransaction(this.pool, async (c) => {
            const cur = await c.query(`SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND job_id = $2 FOR UPDATE`, [this.key, jobId]);
            const r = cur.rows[0];
            if (!r) return undefined;
            if (r.state === 'succeeded' || r.state === 'dead_letter') return toJob(r, this.workspace);
            const attempts = r.attempts + 1;
            const msg = text(error.slice(0, 2000));
            const retry = retryable && attempts < r.max_attempts;
            const upd = retry
                ? await c.query(`UPDATE ${JOBS} SET state = 'queued', lease_until = NULL, attempts = $3, next_attempt_at = $4, last_error = $5, updated_at = $6
                                 WHERE workspace_id = $1 AND job_id = $2 RETURNING *`,
                    [this.key, jobId, attempts, new Date(now.getTime() + computeBackoffMs(attempts, backoff)), msg, now])
                : await c.query(`UPDATE ${JOBS} SET state = 'dead_letter', lease_until = NULL, attempts = $3, last_error = $4, updated_at = $5, completed_at = $5
                                 WHERE workspace_id = $1 AND job_id = $2 RETURNING *`,
                    [this.key, jobId, attempts, msg, now]);
            return toJob(upd.rows[0], this.workspace);
        });
    }

    async requeueDeadLetter(jobId: string, now: Date): Promise<boolean> {
        const r = await this.pool.query(
            `UPDATE ${JOBS} SET state = 'queued', attempts = 0, next_attempt_at = $3, completed_at = NULL, updated_at = $3
             WHERE workspace_id = $1 AND job_id = $2 AND state = 'dead_letter'`,
            [this.key, jobId, now]);
        return r.rowCount === 1;
    }

    async listStaleAwaiting(olderThan: Date, limit: number): Promise<IngestionJob[]> {
        const r = await this.pool.query(
            `SELECT * FROM ${JOBS} WHERE workspace_id = $1 AND state = 'awaiting_callback' AND updated_at <= $2 ORDER BY updated_at, job_id LIMIT $3`,
            [this.key, olderThan, limit]);
        return r.rows.map((x: Row) => toJob(x, this.workspace));
    }

    /** True when this (job, delivery) pair is new. A job that is not in this workspace never records (false): otherwise
     *  another tenant could pre-claim a delivery id and make the owner's real callback look like a replay. */
    async recordDelivery(jobId: string, deliveryId: string, now: Date): Promise<boolean> {
        const r = await retryUniqueRace(() => this.pool.query(
            `INSERT INTO ${DELIVERIES} (job_id, delivery_id, workspace_id, seen_at)
             SELECT job_id, $2, workspace_id, $3 FROM ${JOBS} WHERE job_id = $1 AND workspace_id = $4
             ON CONFLICT (workspace_id, job_id, delivery_id) DO NOTHING`,
            [jobId, text(deliveryId), now, this.key]));
        return r.rowCount === 1;
    }

    async purgeOldDeliveries(now: Date, opts?: PurgeDeliveriesOptions): Promise<number> {
        const { cutoff, limit } = resolvePurge(now, opts);
        const r = await this.pool.query(
            `DELETE FROM ${DELIVERIES} WHERE (workspace_id, job_id, delivery_id) IN (
                 SELECT workspace_id, job_id, delivery_id FROM ${DELIVERIES} WHERE workspace_id = $1 AND seen_at < $2 ORDER BY seen_at LIMIT $3)`,
            [this.key, cutoff, limit]);
        return r.rowCount ?? 0;
    }

    async recordPending(p: PendingStructured, now: Date): Promise<void> {
        this.own(p.workspace);
        // Replace semantics (SQLite INSERT OR REPLACE) but never take over another tenant's row.
        // The job must be in this workspace, so one tenant can never occupy (and thereby block) another tenant's pending slot.
        const r = await retryUniqueRace(() => this.pool.query(
            `INSERT INTO ${PENDING} (job_id, workspace_id, source_id, reason, payload, created_at)
             SELECT job_id, workspace_id, $2, $3, $4::jsonb, $5 FROM ${JOBS} WHERE job_id = $1 AND workspace_id = $6
             ON CONFLICT (workspace_id, job_id) DO UPDATE SET source_id = EXCLUDED.source_id, reason = EXCLUDED.reason,
                 payload = EXCLUDED.payload, created_at = EXCLUDED.created_at`,
            [p.jobId, p.sourceId, text(p.reason.slice(0, 1000)), jsonb(p.payload), now, this.key]));
        if (r.rowCount !== 1) throw new Error(`recordPending: job ${p.jobId} is not in workspace '${this.workspace}'`);
    }

    async listPending(workspace: string, limit = 100): Promise<PendingStructured[]> {
        if (workspace !== this.workspace) return [];
        const r = await this.pool.query(`SELECT * FROM ${PENDING} WHERE workspace_id = $1 ORDER BY created_at, job_id LIMIT $2`, [this.key, limit]);
        return r.rows.map((x: Row) => ({ jobId: x.job_id, workspace: this.workspace, sourceId: x.source_id, reason: x.reason, payload: x.payload }));
    }

    async clearPending(jobId: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${PENDING} WHERE workspace_id = $1 AND job_id = $2`, [this.key, jobId]);
    }

    /** Retires this handle only; the shared pool belongs to postgresPoolOwner. */
    async close(): Promise<void> { /* nothing owned */ }
}
