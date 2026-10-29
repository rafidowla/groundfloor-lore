/**
 * ingestion/coordinator.ts — the ingestion coordinator (slice 1).
 *
 * Lore stores, indexes, links and COORDINATES; processors turn files into text
 * (contract A) and text into structured fields (contract B). The coordinator:
 *
 *   enqueueFile()  record the source (idempotent), pick processors under the
 *                  workspace policy, create the job(s) (idempotent ids)
 *   runDue()       claim due jobs, dispatch to the processor, write results
 *   handleCallback (callbackHandler.ts) completes asynchronous (hosted) jobs
 *   reapStale()    turns callbacks that never came into retries / dead-letter
 *
 * Policy is enforced at selection (enqueue) AND at dispatch AND when a
 * callback result arrives, so changing a workspace to `local-only` stops
 * hosted work that was queued earlier.
 */
import { jobBearerToken, type CallbackAuthConfig } from './callbackAuth.js';
import { BlobNotFoundError, sha256Hex, type IBlobStore } from './blobStore.js';
import { log } from '../logger.js';
import {
    CONTRACT_A_VERSION, CONTRACT_B_VERSION, ProcessorError, contractMajor,
    type ExtractResult, type StructureRequest, type StructureResult,
} from './contracts.js';
import { EndpointNotAllowedError } from './endpointAllowlist.js';
import { writeExtractedMemories, type MemoryWritePort } from './memoryWriter.js';
import { PolicyViolationError, assertProcessorAllowed, type IPolicyProvider } from './policy.js';
import { buildStructuringText } from './pages.js';
import type { ProcessorRegistry } from './registry.js';
import { DEFAULT_BACKOFF, type BackoffOptions, type IIngestionStore, type IngestionJob, type SourceRecord } from './store.js';
import { writeStructuredFields, type TablePort } from './tableWriter.js';

/** What to do with the extracted text. Stored in the extract job's params. */
export interface StructureSpec {
    processorId: string;
    profile?: string;
    outputSchema?: Record<string, unknown>;
    itemPath?: string;
    itemKey?: string[];
    sourceRefs?: boolean;
    reviewThreshold?: number;
    instructions?: string;
    /** Base name for the destination table. Defaults to profile or last itemPath segment. */
    tableName?: string;
}

export interface EnqueueFileArgs {
    workspace: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
    /** Pin an extractor. Omit to let the registry pick (local first). */
    extractorId?: string;
    structure?: StructureSpec;
}

export interface CoordinatorDeps {
    store: IIngestionStore;
    registry: ProcessorRegistry;
    policy: IPolicyProvider;
    blobs: IBlobStore;
    memory: MemoryWritePort;
    tables: TablePort;
    /** Lore-owned public base URL processors post callbacks to (NOT taken from any request). */
    callbackBaseUrl: string;
    callbackAuth: CallbackAuthConfig;
    /** Short-lived fetch URL for a hosted extractor. Absent => hosted extract jobs fail permanently. */
    fileUrlFor?: (source: SourceRecord, job: IngestionJob) => Promise<string>;
    ecosystem?: string;
    backoff?: BackoffOptions;
    maxAttempts?: number;
    /**
     * Claim lease for jobs `runDue` takes (default 5 min). A heartbeat extends it while the job is being
     * processed, so only a job whose worker died (or hung past the lease) is reclaimed by `reclaimStuck`.
     */
    leaseMs?: number;
    /**
     * Blob retention. When a positive number of days, {@link IngestionCoordinator.purgeTerminalBlobs} deletes the stored
     * file of every source whose jobs are all terminal and finished that many days ago (the source row is kept).
     * Absent / 0 => nothing is ever deleted (history deletion is opt-in).
     */
    blobRetentionDays?: number;
    now?: () => Date;
}

/** Counters for the blob retention sweep, since process start. */
export interface BlobRetentionStats { sweeps: number; purged: number; failed: number; lastSweepAt: string | null }

export const DEFAULT_LEASE_MS = 5 * 60_000;

export interface RunSummary { claimed: number; succeeded: number; awaiting: number; retried: number; deadLettered: number }

export class IngestionCoordinator {
    readonly now: () => Date;
    /** Serialises enqueue and purge batches within this process so a sweep cannot delete a blob an enqueue just reused. */
    private blobChain: Promise<unknown> = Promise.resolve();
    private readonly retention: BlobRetentionStats = { sweeps: 0, purged: 0, failed: 0, lastSweepAt: null };
    constructor(readonly deps: CoordinatorDeps) { this.now = deps.now ?? (() => new Date()); }

    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.blobChain.then(fn, fn);
        this.blobChain = run.catch(() => undefined);
        return run;
    }

    get blobRetentionStats(): Readonly<BlobRetentionStats> { return { ...this.retention }; }
    get blobRetentionEnabled(): boolean { return (this.deps.blobRetentionDays ?? 0) > 0 && !!this.deps.blobs.delete; }

    async enqueueFile(a: EnqueueFileArgs): Promise<{ source: SourceRecord; job: IngestionJob; created: boolean }> {
        const policy = await this.deps.policy.policyFor(a.workspace);
        // Selection throws PolicyViolationError / NoProcessorError synchronously: nothing is recorded for a refused request.
        const extractor = this.deps.registry.selectExtract(a.workspace, policy, a.mimeType, a.extractorId);
        if (a.structure) this.deps.registry.selectStructure(a.workspace, policy, a.structure.processorId);

        const sha = sha256Hex(a.bytes);
        const source = await this.exclusive(async () => {
            // A repeat upload reuses the stored blob when it is still there (a remote store's `put` is not idempotent, so
            // re-putting would leak a copy). A purged or missing blob is stored again and the record is repaired.
            const existing = await this.deps.store.getSource(a.workspace, await this.deps.store.resolveSourceId(a.workspace, sha));
            let ref = existing?.storageRef ?? '';
            const present = !!existing && !existing.blobPurgedAt && ref !== ''
                && (this.deps.blobs.has ? await this.deps.blobs.has(ref) : true);
            if (!present) ref = await this.deps.blobs.put(this.deps.store.blobScope?.(a.workspace) ?? a.workspace, sha, a.bytes);
            const rec = await this.deps.store.upsertSource({
                workspace: a.workspace, fileName: a.fileName, mimeType: a.mimeType, sha256: sha, sizeBytes: a.bytes.length, storageRef: ref,
            });
            if (existing && !present) {
                await this.deps.store.setSourceBlob(a.workspace, rec.sourceId, ref);
                return { ...rec, storageRef: ref, blobPurgedAt: null };
            }
            return rec;
        });
        const { job, created } = await this.deps.store.createJob({
            workspace: a.workspace, sourceId: source.sourceId, stage: 'extract', processorId: extractor.info.id,
            contractVersion: CONTRACT_A_VERSION, params: a.structure ? { structure: a.structure } : {}, maxAttempts: this.deps.maxAttempts,
        }, this.now());
        return { source, job, created };
    }

    /**
     * Blob retention sweep: delete the stored file of sources whose jobs are all terminal and older than the configured
     * number of days. The source row, its jobs and their results are kept (`blobPurgedAt` records when). A blob still
     * referenced by a source that is not finished is never deleted. Re-uploading the same bytes stores the file again.
     * A no-op unless `blobRetentionDays` is set and the blob store can delete.
     */
    async purgeTerminalBlobs(limit = 100): Promise<{ purged: number; failed: number }> {
        const days = this.deps.blobRetentionDays ?? 0;
        const del = this.deps.blobs.delete?.bind(this.deps.blobs);
        if (!(days > 0) || !del) return { purged: 0, failed: 0 };
        return this.exclusive(async () => {
            const now = this.now();
            const claimed = await this.deps.store.claimBlobPurge(new Date(now.getTime() - days * 86_400_000), now, limit);
            let purged = 0, failed = 0;
            for (const c of claimed) {
                try { await del(c.storageRef); purged++; }
                catch (e) {
                    failed++;
                    // Put the source back in the queue for the next sweep; if even that fails the next claim skips it
                    // (marked purged) and the blob is orphaned, which is logged, not hidden.
                    await this.deps.store.releaseBlobPurge(c.workspace, c.sourceId).catch(() => log.warn('[Ingest] could not release a blob purge mark; the blob may be orphaned'));
                    log.warn(`[Ingest] blob purge failed (${e instanceof Error ? e.name : typeof e}); will retry next sweep`);
                }
            }
            this.retention.sweeps++; this.retention.purged += purged; this.retention.failed += failed; this.retention.lastSweepAt = now.toISOString();
            if (purged || failed) log.info(`[Ingest] blob retention: purged=${purged} failed=${failed} retentionDays=${days}`);
            return { purged, failed };
        });
    }

    /** Claim and process due jobs. Sequential: one slow processor must not starve the DB lock. */
    async runDue(limit = 10): Promise<RunSummary> {
        const jobs = await this.deps.store.claimDue(this.now(), limit, this.leaseMs);
        const s: RunSummary = { claimed: jobs.length, succeeded: 0, awaiting: 0, retried: 0, deadLettered: 0 };
        for (const job of jobs) {
            const after = await this.processLeased(job);
            if (after.state === 'succeeded') s.succeeded++;
            else if (after.state === 'awaiting_callback') s.awaiting++;
            else if (after.state === 'queued') s.retried++;
            else if (after.state === 'dead_letter') s.deadLettered++;
        }
        return s;
    }

    /** Callbacks that never arrived become failed attempts (retry with backoff, then dead-letter). */
    async reapStale(maxAgeMs: number, limit = 100): Promise<number> {
        const stale = await this.deps.store.listStaleAwaiting(new Date(this.now().getTime() - maxAgeMs), limit);
        for (const j of stale) await this.fail(j.jobId, 'callback timeout', true);
        return stale.length;
    }

    private get leaseMs(): number { return this.deps.leaseMs ?? DEFAULT_LEASE_MS; }

    /** processJob with a heartbeat that keeps the claim lease alive while the processor works. */
    private async processLeased(job: IngestionJob): Promise<IngestionJob> {
        const lease = this.leaseMs;
        const beat = setInterval(() => {
            const now = this.now();
            // A failed heartbeat just lets the lease run out; the reclaim path then owns the job.
            this.deps.store.extendLease(job.jobId, new Date(now.getTime() + lease), now).catch(() => undefined);
        }, Math.max(1, Math.floor(lease / 3)));
        beat.unref();
        try { return await this.processJob(job); } finally { clearInterval(beat); }
    }

    /**
     * Reclaim `running` jobs whose lease expired (their worker crashed or hung): retry with backoff, or
     * dead-letter when attempts are spent. Atomic in the store, so several processes sharing one database
     * never reclaim the same job twice. Safe to call on boot and periodically.
     */
    async reclaimStuck(limit = 100): Promise<number> {
        const jobs = await this.deps.store.reclaimExpiredLeases(this.now(), {
            limit, legacyGraceMs: this.leaseMs * 2, backoff: this.deps.backoff ?? DEFAULT_BACKOFF,
        });
        return jobs.length;
    }

    async processJob(job: IngestionJob): Promise<IngestionJob> {
        try {
            if (job.stage === 'extract') await this.dispatchExtract(job);
            else await this.dispatchStructure(job);
        } catch (err) {
            await this.fail(job.jobId, this.describe(err), this.isRetryable(err));
        }
        return (await this.deps.store.getJob(job.jobId))!;
    }

    private isRetryable(err: unknown): boolean {
        if (err instanceof ProcessorError) return err.retryable;
        if (err instanceof PolicyViolationError || err instanceof EndpointNotAllowedError) return false;
        return true; // unknown (I/O, storage): bounded by maxAttempts
    }
    private describe(err: unknown): string {
        const e = err as Error;
        return `${e.name ?? 'Error'}: ${e.message ?? String(err)}`;
    }
    async fail(jobId: string, message: string, retryable: boolean): Promise<IngestionJob | undefined> {
        return this.deps.store.recordFailure(jobId, message, retryable, this.now(), this.deps.backoff ?? DEFAULT_BACKOFF);
    }

    private callbackUrl(jobId: string): string {
        return this.deps.callbackBaseUrl.replace(/\/+$/, '') + '/api/ingest/callback/' + encodeURIComponent(jobId);
    }

    private async dispatchExtract(job: IngestionJob): Promise<void> {
        const policy = await this.deps.policy.policyFor(job.workspace);
        const proc = this.deps.registry.getExtract(job.processorId);
        if (!proc) throw new ProcessorError(`extractor '${job.processorId}' is not registered`, false);
        assertProcessorAllowed(job.workspace, policy, proc.info);
        this.assertContract(job.contractVersion, CONTRACT_A_VERSION);
        const source = await this.deps.store.getSource(job.workspace, job.sourceId);
        if (!source) throw new ProcessorError('source record missing', false);

        const hosted = proc.info.locality === 'hosted';
        const localBytes = hosted ? undefined : await this.readBlob(source);
        const outcome = await proc.extract({
            contractVersion: CONTRACT_A_VERSION, jobId: job.jobId, workspace: job.workspace, sourceId: source.sourceId,
            fileName: source.fileName, mimeType: source.mimeType,
            ...(hosted ? {
                fileUrl: await this.requireFileUrl(source, job),
                callbackUrl: this.callbackUrl(job.jobId),
                callbackBearer: jobBearerToken(this.deps.callbackAuth.masterSecret, job.jobId),
            } : { bytes: localBytes! }),
        });
        if (outcome.status === 'accepted') await this.deps.store.markAwaitingCallback(job.jobId, outcome.remoteRequestId ?? null, this.now());
        else await this.completeExtract(job, source, outcome.result);
    }

    /** A missing blob is permanent (retrying cannot bring it back): say how to fix it. */
    private async readBlob(source: SourceRecord): Promise<Buffer> {
        if (source.blobPurgedAt) throw new ProcessorError('the source file was removed by blob retention; upload the file again', false);
        try { return await this.deps.blobs.get(source.storageRef); }
        catch (e) {
            if (e instanceof BlobNotFoundError) throw new ProcessorError('the source file is no longer in blob storage; upload the file again', false);
            throw e;
        }
    }

    private async requireFileUrl(source: SourceRecord, job: IngestionJob): Promise<string> {
        if (!this.deps.fileUrlFor) throw new ProcessorError('no fileUrlFor configured: hosted extraction cannot fetch the file', false);
        return this.deps.fileUrlFor(source, job);
    }

    private assertContract(have: string, want: string): void {
        if (contractMajor(have) !== contractMajor(want)) throw new ProcessorError(`contract mismatch: job ${have}, coordinator ${want}`, false);
    }

    /** Write memories, then mark the job succeeded and chain the structure stage. Idempotent. */
    async completeExtract(job: IngestionJob, source: SourceRecord, result: ExtractResult): Promise<void> {
        const w = await writeExtractedMemories({ port: this.deps.memory, ecosystem: this.deps.ecosystem ?? '*', source, jobId: job.jobId, result });
        if (w.failed > 0) throw new ProcessorError(`${w.failed} memory write(s) failed`, true);
        if (!(await this.deps.store.markSucceeded(job.jobId, result, this.now()))) return;
        await this.deps.store.markResultsWritten(job.jobId, this.now());
        const spec = job.params.structure as StructureSpec | undefined;
        if (spec) {
            await this.deps.store.createJob({
                workspace: job.workspace, sourceId: job.sourceId, stage: 'structure', processorId: spec.processorId,
                contractVersion: CONTRACT_B_VERSION, params: { ...spec }, parentJobId: job.jobId, maxAttempts: this.deps.maxAttempts,
            }, this.now());
        }
    }

    private async dispatchStructure(job: IngestionJob): Promise<void> {
        const policy = await this.deps.policy.policyFor(job.workspace);
        const proc = this.deps.registry.getStructure(job.processorId);
        if (!proc) throw new ProcessorError(`structurer '${job.processorId}' is not registered`, false);
        assertProcessorAllowed(job.workspace, policy, proc.info);
        this.assertContract(job.contractVersion, CONTRACT_B_VERSION);
        const parent = job.parentJobId ? await this.deps.store.getJob(job.parentJobId) : undefined;
        if (!parent || parent.state !== 'succeeded' || !parent.result) throw new ProcessorError('parent extract job has no result', false);
        const ex = parent.result as ExtractResult;
        const spec = job.params as unknown as StructureSpec;
        const hosted = proc.info.locality === 'hosted';
        const req: StructureRequest = {
            contractVersion: CONTRACT_B_VERSION, jobId: job.jobId, workspace: job.workspace, sourceId: job.sourceId,
            text: buildStructuringText(ex.text, ex.chunks),
            profile: spec.profile, outputSchema: spec.outputSchema, itemPath: spec.itemPath, itemKey: spec.itemKey,
            sourceRefs: spec.sourceRefs ?? true, reviewThreshold: spec.reviewThreshold, instructions: spec.instructions,
            ...(hosted ? { callbackUrl: this.callbackUrl(job.jobId), callbackBearer: jobBearerToken(this.deps.callbackAuth.masterSecret, job.jobId) } : {}),
        };
        const outcome = await proc.structure(req);
        if (outcome.status === 'accepted') await this.deps.store.markAwaitingCallback(job.jobId, outcome.remoteRequestId ?? null, this.now());
        else await this.completeStructure(job, outcome.result);
    }

    async completeStructure(job: IngestionJob, result: StructureResult): Promise<void> {
        const source = await this.deps.store.getSource(job.workspace, job.sourceId);
        if (!source) throw new ProcessorError('source record missing', false);
        const spec = job.params as unknown as StructureSpec;
        const tableBase = spec.tableName ?? spec.profile ?? (spec.itemPath?.split('.').filter(Boolean).pop() ?? 'items');
        const out = await writeStructuredFields({ port: this.deps.tables, source, jobId: job.jobId, result, itemPath: spec.itemPath, tableBase });
        if (out.kind === 'pending') await this.deps.store.recordPending({ jobId: job.jobId, workspace: job.workspace, sourceId: job.sourceId, reason: out.reason, payload: result }, this.now());
        else await this.deps.store.clearPending(job.jobId);
        if (!(await this.deps.store.markSucceeded(job.jobId, result, this.now()))) return;
        await this.deps.store.markResultsWritten(job.jobId, this.now());
    }
}
