/**
 * ingestion/store.ts — engine-neutral source record + ingestion job model.
 *
 * `IIngestionStore` is the port; sqliteStore.ts (local) and
 * engines/postgres/postgresIngestionStore.ts (one store bound to one workspace)
 * implement it. storeFactory.ts picks one from the workspace's engine.
 *
 * Job lifecycle:
 *
 *   queued --claim--> running --done--------------------> succeeded
 *                        |--accepted (async processor)--> awaiting_callback --callback--> succeeded
 *                        |--transient failure, attempts left--> queued (nextAttemptAt = backoff)
 *                        `--permanent failure / attempts exhausted--> dead_letter
 *   awaiting_callback --timeout--> queued/dead_letter (same retry accounting)
 *
 * Job ids are DETERMINISTIC (see makeJobId): enqueueing the same work twice
 * yields the same job and never a duplicate.
 */
import { createHash } from 'node:crypto';

export type JobStage = 'extract' | 'structure';
export type JobState = 'queued' | 'running' | 'awaiting_callback' | 'succeeded' | 'failed' | 'dead_letter';
/**
 * Job states that will never run again on their own. (`dead_letter` can be re-queued by an operator, which then needs the
 * blob: a purged one fails permanently with a "re-upload the file" message.) There is no 'cancelled' state.
 */
export const TERMINAL_JOB_STATES: readonly JobState[] = ['succeeded', 'failed', 'dead_letter'];

export interface SourceRecord {
    sourceId: string;
    workspace: string;
    fileName: string;
    mimeType: string;
    sha256: string;
    sizeBytes: number;
    /** Opaque reference to where the bytes live (path or object key). Never exposed to processors. */
    storageRef: string;
    createdAt: string;
    /**
     * Set when the blob behind `storageRef` was removed by blob retention (see {@link IIngestionStore.claimBlobPurge}).
     * The row itself is never deleted. Re-uploading the same bytes stores a new blob and clears this.
     */
    blobPurgedAt: string | null;
}

export interface IngestionJob {
    jobId: string;
    workspace: string;
    sourceId: string;
    stage: JobStage;
    processorId: string;
    contractVersion: string;
    state: JobState;
    attempts: number;
    maxAttempts: number;
    /** ISO time the job may next be claimed (queued only). */
    nextAttemptAt: string;
    lastError: string | null;
    /** Stage parameters (profile, schema, itemPath, ...) as JSON. */
    params: Record<string, unknown>;
    /** For `structure` jobs: the extract job whose text is the input. */
    parentJobId: string | null;
    remoteRequestId: string | null;
    /** Set once the result has been handed to the result writer. */
    resultsWrittenAt: string | null;
    /** Raw processor result (already validated); kept for retries of the write step. */
    result: unknown | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    /**
     * Claim lease for a `running` job: ISO time after which another worker may reclaim it
     * (see {@link IIngestionStore.reclaimExpiredLeases}). Null outside `running`, and for rows
     * claimed by a pre-lease build.
     */
    leaseUntil: string | null;
}

export interface NewJob {
    workspace: string;
    sourceId: string;
    stage: JobStage;
    processorId: string;
    contractVersion: string;
    params?: Record<string, unknown>;
    parentJobId?: string | null;
    maxAttempts?: number;
}

export interface ReclaimOptions {
    limit: number;
    /** Age (by `updated_at`) after which a lease-less `running` row counts as stuck. */
    legacyGraceMs: number;
    backoff?: BackoffOptions;
}

export const RECLAIM_ERROR = 'lease expired: worker stopped before finishing';

export interface BackoffOptions { baseMs: number; maxMs: number }
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 5_000, maxMs: 15 * 60_000 };
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Exponential backoff for the Nth failed attempt (1-based): base * 2^(n-1), capped. */
export function computeBackoffMs(attempt: number, o: BackoffOptions = DEFAULT_BACKOFF): number {
    const n = Math.max(1, Math.floor(attempt));
    return Math.min(o.maxMs, o.baseMs * 2 ** (n - 1));
}

/** Replay-guard rows (`deliveries`) older than this are eligible for {@link IIngestionStore.purgeOldDeliveries}. */
export const DEFAULT_DELIVERY_RETENTION_DAYS = 30;
/** Rows deleted per `purgeOldDeliveries` call, so one cleanup never holds a long lock. */
export const DEFAULT_PURGE_BATCH = 5_000;

export interface PurgeDeliveriesOptions {
    /** Default: `LORE_INGEST_DELIVERY_RETENTION_DAYS`, else 30. */
    retentionDays?: number;
    /** Max rows deleted by this call (default 5000). Call again while the result equals the limit. */
    limit?: number;
}

/** Retention in days from `LORE_INGEST_DELIVERY_RETENTION_DAYS`. A set-but-invalid value fails loudly. */
export function deliveryRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env['LORE_INGEST_DELIVERY_RETENTION_DAYS'];
    if (raw === undefined || raw.trim() === '') return DEFAULT_DELIVERY_RETENTION_DAYS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`LORE_INGEST_DELIVERY_RETENTION_DAYS must be a positive number, got ${JSON.stringify(raw)}`);
    return n;
}

/** Resolve purge options to a concrete cutoff time and batch size. */
export function resolvePurge(now: Date, o: PurgeDeliveriesOptions = {}): { cutoff: Date; limit: number } {
    const days = o.retentionDays ?? deliveryRetentionDays();
    if (!Number.isFinite(days) || days <= 0) throw new Error(`retentionDays must be a positive number, got ${days}`);
    const limit = Math.max(1, Math.floor(o.limit ?? DEFAULT_PURGE_BATCH));
    return { cutoff: new Date(now.getTime() - days * 86_400_000), limit };
}

/** `workspace` is the id scope: the workspace name for per-workspace stores, the permanent id for shared (Postgres) stores. */
export function makeSourceId(workspace: string, sha256: string): string {
    return 'src_' + createHash('sha256').update(`${workspace}\0${sha256}`).digest('hex').slice(0, 32);
}

/**
 * Same workspace + source + stage + processor + contract + params => same id. `workspace` is the id scope (see
 * {@link makeSourceId}): a store that shares one job-id namespace across workspaces must pass something that is never reused.
 */
export function makeJobId(j: Pick<NewJob, 'workspace' | 'sourceId' | 'stage' | 'processorId' | 'contractVersion'> & { params?: Record<string, unknown>; parentJobId?: string | null }): string {
    const h = createHash('sha256');
    h.update([j.workspace, j.sourceId, j.stage, j.processorId, j.contractVersion, j.parentJobId ?? '', stableJson(j.params ?? {})].join('\0'));
    return 'job_' + h.digest('hex').slice(0, 32);
}

/** JSON.stringify with sorted keys so equal params hash equally. */
export function stableJson(v: unknown): string {
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
    }
    return JSON.stringify(v) ?? 'null';
}

export interface IIngestionStore {
    /**
     * The source id this store uses (or already uses) for `sha256` in `workspace`. Callers that look a source up before
     * uploading ({@link getSource}) must ask the store rather than call {@link makeSourceId} themselves: a store whose
     * ids hash something other than the workspace name (Postgres: the permanent id) says so here, and a source created
     * under an older id scheme keeps answering with its original id.
     */
    resolveSourceId(workspace: string, sha256: string): Promise<string>;
    /** Idempotent on (workspace, sha256). Returns the existing record on repeat. */
    upsertSource(s: Omit<SourceRecord, 'sourceId' | 'createdAt' | 'blobPurgedAt'>): Promise<SourceRecord>;
    getSource(workspace: string, sourceId: string): Promise<SourceRecord | undefined>;
    /** Point a source at a freshly stored blob and clear its purged mark (re-upload after retention, or blob repair). */
    setSourceBlob(workspace: string, sourceId: string, storageRef: string): Promise<void>;
    /**
     * Blob retention, step 1. Atomically marks up to `limit` sources as purged (`blobPurgedAt = now`) and returns them:
     * a source qualifies only when it has at least one job, EVERY job is terminal ({@link TERMINAL_JOB_STATES}), the newest
     * job finished at or before `cutoff`, its blob is not already purged, and no other source that is not purged and
     * not fully terminal points at the same `storageRef`. The row is kept. The caller then deletes the blob and, if that
     * fails, calls {@link releaseBlobPurge}.
     */
    claimBlobPurge(cutoff: Date, now: Date, limit: number): Promise<Array<{ workspace: string; sourceId: string; storageRef: string }>>;
    /** Undo a {@link claimBlobPurge} mark whose blob could not be deleted, so a later sweep retries it. */
    releaseBlobPurge(workspace: string, sourceId: string): Promise<void>;
    /**
     * Workspace erase, step 1 (read-only). One page of the sources whose blob may still exist, in `sourceId` order:
     * `workspace` = the workspace key to list (a store bound to one workspace returns nothing for any other key), or
     * `null` for every source in the store (legitimate only when the store is dedicated to the workspace being erased,
     * e.g. its own SQLite file). Sources already marked purged are left out. Pass the last `sourceId` as `after` for the next page.
     */
    listSourceBlobRefs(workspace: string | null, limit: number, after?: string): Promise<Array<{ sourceId: string; storageRef: string }>>;
    /**
     * The string a blob store hashes to file `workspace`'s NEW blobs (FsBlobStore: the `<sha256(scope)[:16]>` folder). A store
     * whose rows are keyed by a permanent workspace id (Postgres) returns that id, so a successor workspace that reuses a deleted
     * workspace's NAME never lands on the old workspace's blob refs. Omitted: the caller uses the workspace name (SQLite, one file
     * per workspace). Refs minted before this existed hash the name; they stay valid and are never rewritten.
     */
    blobScope?(workspace: string): string;

    /** Idempotent on the deterministic job id; `created=false` when it already existed. */
    createJob(j: NewJob, now: Date): Promise<{ job: IngestionJob; created: boolean }>;
    getJob(jobId: string): Promise<IngestionJob | undefined>;
    listJobs(workspace: string, state?: JobState, limit?: number): Promise<IngestionJob[]>;

    /**
     * Atomically move up to `limit` due `queued` jobs to `running` and return them. With `leaseMs`
     * the claim also stamps `leaseUntil = now + leaseMs` so a crashed claimer can be reclaimed.
     */
    claimDue(now: Date, limit: number, leaseMs?: number): Promise<IngestionJob[]>;
    /** Heartbeat: push a `running` job's lease out to `leaseUntil`. False when the job is no longer `running`. */
    extendLease(jobId: string, leaseUntil: Date, now: Date): Promise<boolean>;
    /**
     * Stuck-job reclaim. Atomically (row-locked; safe with several processes on one store) takes `running` jobs
     * whose lease has expired — or, for rows with no lease, whose `updated_at` is older than `legacyGraceMs` —
     * and records a failed attempt on each: back to `queued` with backoff, or `dead_letter` once attempts are
     * spent. Returns the jobs after the transition.
     */
    reclaimExpiredLeases(now: Date, opts: ReclaimOptions): Promise<IngestionJob[]>;
    markAwaitingCallback(jobId: string, remoteRequestId: string | null, now: Date): Promise<void>;
    /** Store the validated result and move to `succeeded`. No-op (returns false) if already terminal. */
    markSucceeded(jobId: string, result: unknown, now: Date): Promise<boolean>;
    markResultsWritten(jobId: string, now: Date): Promise<void>;
    /**
     * Record a failed attempt. Transient + attempts left => back to `queued` with
     * backoff; otherwise `dead_letter`. Returns the updated job.
     */
    recordFailure(jobId: string, error: string, retryable: boolean, now: Date, backoff?: BackoffOptions): Promise<IngestionJob | undefined>;
    /** Put a dead-lettered job back in the queue (operator action). Resets attempts. */
    requeueDeadLetter(jobId: string, now: Date): Promise<boolean>;
    /** `awaiting_callback` jobs not completed by `olderThan` — reaper input. */
    listStaleAwaiting(olderThan: Date, limit: number): Promise<IngestionJob[]>;

    /** Replay/duplicate-delivery guard. Returns false if (jobId, deliveryId) was seen. */
    recordDelivery(jobId: string, deliveryId: string, now: Date): Promise<boolean>;
    /**
     * Bounded retention: delete up to `limit` delivery rows seen before `now - retentionDays`.
     * Opt-in — the host calls it (there is no timer); loop while the result equals the limit.
     */
    purgeOldDeliveries(now: Date, opts?: PurgeDeliveriesOptions): Promise<number>;
    /** Structured fields that could not be written to a table (no table support / evolution failed). Idempotent per job. */
    recordPending(p: PendingStructured, now: Date): Promise<void>;
    listPending(workspace: string, limit?: number): Promise<PendingStructured[]>;
    clearPending(jobId: string): Promise<void>;
    close(): Promise<void>;
}

export interface PendingStructured {
    jobId: string;
    workspace: string;
    sourceId: string;
    reason: string;
    /** The validated StructureResult, so a later pass can write it once tables exist. */
    payload: unknown;
}
