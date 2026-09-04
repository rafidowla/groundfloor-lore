/**
 * storage/loadJobsRunner.ts — Sprint Z2 background runner that turns
 * Z1's received-bytes (status='received', temp_file_path on disk) into
 * substrate-resident rows via the bulkLoader adapters.
 *
 * Lifecycle (matches outbox replicator + Sprint E ticker patterns):
 *
 *   wireLoadJobsRunner({...}) -> LoadJobsRunner
 *   runner.start()       // begin polling
 *   runner.stop()        // graceful shutdown
 *   runner.tickOnce()    // deterministic single-shot for tests
 *
 * Per tick:
 *
 *   1. listReceived(limit)  -> the oldest few 'received' jobs
 *   2. For each: claim by flipping status='running' + started_at=now
 *   3. Open per-format parser on temp_file_path
 *   4. For each parsed row, dispatcher.dispatch(row, idx)
 *   5. Every PROGRESS_INTERVAL rows, flush dispatcher buffers + write
 *      progress into load_jobs
 *   6. At EOF: flushAll, mark status='complete' (or 'failed' if the
 *      whole-job error rate exceeded a threshold; Z2 default = no
 *      threshold, every per-row failure surfaces but the job still
 *      'completes')
 *   7. Emit one load.done outbox entry
 *
 * Per Sprint Z principle clauses:
 *   - clause 3 — substrate-native via the dispatcher (no per-row
 *                upsertNode call)
 *   - clause 5 — per-row failure isolation; errors stream into
 *                load_jobs.errors_json (capped)
 *   - clause 8 — embed mode defaults to 'skip' for queued/skip jobs;
 *                'inline' only for tests + small loads
 *   - Sprint L — workspace check is preserved at the dispatcher level
 *                (every row's workspace is matched against opts.workspace
 *                in each adapter)
 *   - Sprint O — emits load.done; per-chunk outbox emission is the
 *                dispatcher's responsibility (NOT the runner's) so the
 *                runner stays format-agnostic. Exception (1.8 fix,
 *                2026-08-17): for embed='queued' jobs the runner itself
 *                emits one embed.batch outbox row per durable flush —
 *                the lance adapter's zero-vector placeholder contract
 *                names the runner as the emitter, and nothing else did it.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { LoadJobsStore, LoadJob, LoadJobError } from './loadJobsStore.js';
import {
    LoadCancelledError,
    LoadJobAbortRegistry,
    isLoadCancelled,
} from './loadJobsAbort.js';
import type { OutboxStore, OutboxEntry } from '../outbox/types.js';
import {
    LoaderDispatcher,
    type LoaderDispatcherDeps,
    type ParsedRow,
} from '../bulkLoader/loaderDispatcher.js';
import {
    WorkspaceConcurrencyManager,
    TempFileSweeper,
} from './loadJobsConcurrency.js';
import { recordHotWriteBatch } from '../outbox/hotLane.js';

/** How often to flush dispatcher buffers + persist progress. */
export const PROGRESS_INTERVAL_ROWS = 1_000;

/**
 * Sprint Z3 — checkpoint persisted to load_jobs every N rows.
 * Default 10k per Sprint Z principle clause 4. Crash mid-load
 * loses at most this many rows; idempotent substrate writes (sqlite
 * INSERT OR REPLACE; surreal UPSERT; lance dedupe-by-id) make resume safe.
 */
export const DEFAULT_CHECKPOINT_ROWS = 10_000;

/** Idle sleep between empty polls. */
const IDLE_MS_DEFAULT = 500;
/** Sleep between non-empty ticks. */
const BUSY_MS_DEFAULT = 10;

export interface LoadJobsRunnerConfig {
    idleMs?: number;
    busyMs?: number;
    /** Max jobs claimed per tick. Default 4 (one per CPU on a typical
     *  dev box; Sprint Z3 will add per-tenant concurrency caps that
     *  shrink this to per-tenant). */
    maxJobsPerTick?: number;
    /** Flush + progress write interval. */
    progressIntervalRows?: number;
    /** Sprint Z3 — checkpoint write interval (default 10k). */
    checkpointIntervalRows?: number;
    /** Test hook: log function. */
    log?: (msg: string) => void;
}

export interface LoadJobsRunnerWiring {
    store: LoadJobsStore;
    /** Outbox for emitting load.done. Optional in tests. */
    outboxStore?: OutboxStore;
    /** Factory that builds the dispatcher dependencies (with the
     *  three live substrate adapters bound to the live graph + verbatim
     *  store). The runner calls this PER JOB so adapters can scope
     *  their per-job options (workspace, jobId). */
    buildDispatcherDeps: (job: LoadJob) => Promise<LoaderDispatcherDeps>;
    /** Sprint Z3 — shared concurrency manager (constructed by caller so
     *  the HTTP route can interrogate it for the 429 check). */
    concurrencyManager?: WorkspaceConcurrencyManager;
    /** Sprint Z3 — optional sweeper. If supplied, runner starts it. */
    sweeper?: TempFileSweeper;
    config?: LoadJobsRunnerConfig;
}

export class LoadJobsRunner {
    private readonly store: LoadJobsStore;
    private readonly outboxStore?: OutboxStore;
    private readonly buildDeps: LoadJobsRunnerWiring['buildDispatcherDeps'];
    private readonly idleMs: number;
    private readonly busyMs: number;
    private readonly maxJobsPerTick: number;
    private readonly progressInterval: number;
    private readonly checkpointInterval: number;
    private readonly log: (msg: string) => void;
    private readonly concurrency: WorkspaceConcurrencyManager;
    private readonly sweeper?: TempFileSweeper;
    private readonly abort = new LoadJobAbortRegistry();

    private running = false;
    private looping = false;
    private startupReconciled = false;

    constructor(w: LoadJobsRunnerWiring) {
        this.store = w.store;
        this.outboxStore = w.outboxStore;
        this.buildDeps = w.buildDispatcherDeps;
        this.idleMs = w.config?.idleMs ?? IDLE_MS_DEFAULT;
        this.busyMs = w.config?.busyMs ?? BUSY_MS_DEFAULT;
        this.maxJobsPerTick = w.config?.maxJobsPerTick ?? 4;
        this.progressInterval = w.config?.progressIntervalRows ?? PROGRESS_INTERVAL_ROWS;
        this.checkpointInterval = w.config?.checkpointIntervalRows ?? DEFAULT_CHECKPOINT_ROWS;
        this.log = w.config?.log ?? ((m) => console.error(`[loadJobsRunner] ${m}`));
        this.concurrency = w.concurrencyManager ?? new WorkspaceConcurrencyManager();
        this.sweeper = w.sweeper;
    }

    /** Sprint Z3 — expose concurrency manager so /api/load can do the
     *  429 check before creating a new job row. */
    getConcurrencyManager(): WorkspaceConcurrencyManager {
        return this.concurrency;
    }

    /** Cooperative cancel — HTTP cancel route + tests. Polled per parsed row. */
    requestCancel(jobId: string): void {
        this.abort.requestCancel(jobId);
    }

    private throwIfCancelled(jobId: string): void {
        if (this.abort.isCancelled(jobId)) throw new LoadCancelledError();
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        // RA2-reaudit2 — start the poll loop ONLY AFTER startupReconcileAndResume
        // has taken its listRunning() snapshot of crash-leftover jobs. Pre-fix
        // both ran fire-and-forget concurrently: a tick could flip a 'received'
        // job to 'running' during the resume's first await, so listRunning()
        // then re-picked it as a "crash leftover" → the SAME job ran twice.
        // (The crash-leftover resumes inside remain fire-and-forget; only the
        // snapshot must precede the loop.)
        void this.startupReconcileAndResume()
            .catch((err) => {
                this.log(`startup reconcile threw: ${(err as Error).message}`);
            })
            .finally(() => {
                if (this.running) void this.loop();
            });
        if (this.sweeper) this.sweeper.start();
        this.log('started');
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.sweeper) this.sweeper.stop();
        // Wait one tick boundary so any in-flight job finishes its
        // current row-batch before we return. Bounded to one idle
        // interval so shutdown isn't ever-blocking.
        const deadline = Date.now() + Math.max(this.idleMs, 1_000);
        while (this.looping && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        this.log('stopped');
    }

    /**
     * Sprint Z3 — boot-time recovery. Reconciles the in-memory
     * concurrency counter from the store, then enqueues a resume for
     * every job left in status='running' (crash mid-load). Resume is
     * driven by tickOnce reading 'running' rows after this method
     * marks them eligible. We tickle by calling the resume path
     * directly so the runner can re-enter even if listReceived is
     * empty.
     */
    async startupReconcileAndResume(): Promise<void> {
        if (this.startupReconciled) return;
        this.startupReconciled = true;
        await this.concurrency.reconcile(this.store);
        const running = await this.store.listRunning();
        if (running.length > 0) {
            this.log(`startup resume: ${running.length} job(s) in 'running' status`);
        }
        for (const job of running) {
            // Fire-and-forget resume — runOneJob handles errors + marks
            // failed on terminal exceptions. We do NOT await here so a
            // long crash-recovery resume doesn't block the daemon boot.
            void this.runOneJob(job).catch((err) => {
                this.log(`resume ${job.jobId} failed: ${(err as Error).message}`);
            });
        }
    }

    private async loop(): Promise<void> {
        while (this.running) {
            this.looping = true;
            try {
                const processed = await this.tickOnce();
                this.looping = false;
                if (processed === 0) {
                    await new Promise((r) => setTimeout(r, this.idleMs));
                } else {
                    await new Promise((r) => setTimeout(r, this.busyMs));
                }
            } catch (err) {
                this.looping = false;
                this.log(`tick threw: ${(err as Error).message}`);
                await new Promise((r) => setTimeout(r, this.idleMs));
            }
        }
        this.looping = false;
    }

    /** Process up to maxJobsPerTick received jobs. Returns the count
     *  of jobs whose status advanced (to complete or failed) this
     *  tick. Test entry point — does NOT spin the background loop. */
    async tickOnce(): Promise<number> {
        const jobs = await this.store.listReceived(this.maxJobsPerTick);
        if (jobs.length === 0) return 0;
        let advanced = 0;
        for (const job of jobs) {
            // Sprint Z3 — bump the per-workspace counter as the job
            // transitions from 'received' to 'running'. The /api/load
            // route already 429'd the submission if the cap was hit,
            // so this is normally a no-op increment (the count was
            // bumped by the route at submit time). We use forceIncrement
            // here only if the route did NOT bump (legacy paths /
            // resume-from-disk via tests).
            try {
                await this.runOneJob(job);
                advanced++;
            } catch (err) {
                this.log(`job ${job.jobId} failed: ${(err as Error).message}`);
                try {
                    await this.store.trySetTerminal(job.jobId, 'failed', {
                        completedAt: new Date().toISOString(),
                    });
                } catch { /* best-effort */ }
                // (concurrency slot is released by runOneJob's finally — re-audit 2026-06-25)
            }
        }
        return advanced;
    }

    /**
     * re-audit 2026-06-25 (MEDIUM, concurrency) — release the per-workspace
     * concurrency slot EXACTLY ONCE per job, in a finally that covers every
     * exit (success, in-try failure, AND a pre-try failure like a missing temp
     * file). Previously success/in-try released inside the job body while
     * tickOnce ALSO released on the rethrow → a double release that let the
     * per-workspace cap be exceeded; the resume caller meanwhile LEAKED a slot
     * on a pre-try failure. One release here balances both callers.
     */
    private async runOneJob(job: LoadJob): Promise<void> {
        try {
            await this.runOneJobInner(job);
        } finally {
            this.concurrency.release(job.workspace);
        }
    }

    private async runOneJobInner(job: LoadJob): Promise<void> {
        // Sprint Z3 — resume support. If checkpoint_row > 0 we re-read
        // the temp file from the top but SKIP dispatches for row indices
        // strictly below checkpointRow. Substrate idempotency
        // (SQLite INSERT OR REPLACE, surreal UPSERT +
        // per-triple edge dedup, lance dedupe-by-id)
        // guarantees the boundary row is safe even if it was partially
        // written before the crash.
        const resumeFromRow = job.checkpointRow ?? 0;
        const isResume = resumeFromRow > 0;
        const startedAt = isResume ? (job.startedAt ?? new Date().toISOString()) : new Date().toISOString();
        if (!isResume) {
            const claimed = await this.store.tryClaimRunning(job.jobId, startedAt);
            if (!claimed) {
                this.log(`job ${job.jobId} not claimed (cancelled or gone)`);
                return;
            }
        } else {
            this.throwIfCancelled(job.jobId);
        }
        if (isResume) {
            this.log(`resuming job ${job.jobId} from row ${resumeFromRow}`);
        }

        if (!job.tempFilePath) {
            throw new Error(`job ${job.jobId} has no temp_file_path`);
        }
        if (!fs.existsSync(job.tempFilePath)) {
            throw new Error(`job ${job.jobId} temp_file_path does not exist on disk: ${job.tempFilePath}`);
        }

        const deps = await this.buildDeps(job);
        const dispatcher = new LoaderDispatcher(deps);
        await dispatcher.begin({
            embed: job.embedMode === 'skip' ? 'skip' : (job.embedMode === 'inline' ? 'inline' : 'queued'),
            workspace: job.workspace,
            jobId: job.jobId,
            baseRowIndex: resumeFromRow,
        });

        let rowIdx = resumeFromRow;
        let lastFlushIdx = resumeFromRow;
        let lastCheckpointIdx = resumeFromRow;
        // Source-file row counter for the SKIP-on-resume path. Increments
        // for every line read; rowIdx only increments for dispatched rows.
        let sourceRowIdx = 0;
        // Runner-level error tally (parse errors); separate from dispatcher.
        const runnerErrors: LoadJobError[] = [];
        // High-water mark of dispatcher errors already persisted, so each
        // flush only appends the newly-discovered ones.
        let persistedDispatcherErrors = 0;
        let persistedRunnerErrors = 0;

        // 1.8 (2026-08-17 audit) — embed='queued' is a documented /api/load
        // mode, but the runner NEVER emitted the embed.batch outbox rows the
        // lance adapter's contract (bulkLoader/lanceAdapter.ts header)
        // assigns to it, so every loaded row kept its zero placeholder
        // vector forever. Accumulate the texts/ids of verbatim+vector rows
        // and emit ONE embed.batch row per flush AFTER the zero-vector rows
        // are durable (the replicator's storeEmbedBatch upsert must win over
        // the placeholder, so enqueue strictly after flush).
        const queuedEmbedTexts: string[] = [];
        const queuedEmbedIds: string[] = [];
        const emitQueuedEmbeds = async (): Promise<void> => {
            if (queuedEmbedIds.length === 0) return;
            if (!this.outboxStore) {
                // No outbox wired (test wiring) — nothing can drain an
                // embed.batch row; drop rather than accumulate unbounded.
                queuedEmbedTexts.length = 0;
                queuedEmbedIds.length = 0;
                return;
            }
            const texts = queuedEmbedTexts.slice();
            const ids = queuedEmbedIds.slice();
            try {
                await recordHotWriteBatch(this.outboxStore, [{
                    workspace: job.workspace,
                    operationKind: 'embed.batch',
                    payload: { texts, targetNodeIds: ids },
                    initiator: 'loadJobsRunner',
                    operation: 'embed.batch',
                }]);
                queuedEmbedTexts.length = 0;
                queuedEmbedIds.length = 0;
            } catch (err) {
                // Keep the accumulators for retry at the next flush, and
                // surface the failure in the job's error stream instead of
                // silently losing the embeds (the original bug class).
                runnerErrors.push({
                    rowIndex: rowIdx,
                    errorMessage: `embed_batch_enqueue_failed: ${(err as Error).message}`,
                });
            }
        };

        const flushProgress = async () => {
            // 1.7 (2026-08-17 audit) — actually FLUSH the dispatcher's
            // substrate buffers before counting rows as processed (the file
            // header always claimed this; snapshot() is explicitly the
            // non-flushing accessor, so progress/checkpoint counters used to
            // cover rows that were not yet durable).
            const snap = await dispatcher.flushAll();
            await emitQueuedEmbeds();
            const totalProcessed = snap.written;
            const totalFailed = snap.failed + runnerErrors.length;
            const newRunnerErrs = runnerErrors.slice(persistedRunnerErrors);
            const newDispatcherErrs = snap.errors.slice(persistedDispatcherErrors);
            const combined = newRunnerErrs.concat(newDispatcherErrs);
            await this.store.updateProgress(job.jobId, totalProcessed, totalFailed, combined);
            persistedRunnerErrors = runnerErrors.length;
            persistedDispatcherErrors = snap.errors.length;
        };

        try {
            this.throwIfCancelled(job.jobId);
            await this.streamParse(job, async (parsed) => {
                this.throwIfCancelled(job.jobId);
                // Sprint Z3 resume — skip rows whose source-index is
                // below the checkpoint. We re-read the temp file from
                // the top because the underlying file stream API does
                // not support arbitrary seeks for line-oriented
                // readers; the skip cost is bounded by checkpoint_row
                // (default 10k worst-case extra parse work).
                if (sourceRowIdx < resumeFromRow) {
                    sourceRowIdx++;
                    return;
                }
                sourceRowIdx++;
                if (parsed === null) {
                    // Parse error — record as a per-row failure but
                    // don't abort the job.
                    runnerErrors.push({
                        rowIndex: rowIdx,
                        errorMessage: 'parse_error',
                    });
                    rowIdx++;
                    return;
                }
                await dispatcher.dispatch(parsed, rowIdx);
                // 1.8 — queued embed: remember the row for the post-flush
                // embed.batch outbox emission (verbatim + vector targets only;
                // graph.node rows carry no text to embed here).
                if (job.embedMode === 'queued' && (parsed.target === 'verbatim' || parsed.target === 'vector')) {
                    queuedEmbedTexts.push(parsed.row.text);
                    queuedEmbedIds.push(parsed.row.id);
                }
                rowIdx++;
                if (rowIdx - lastFlushIdx >= this.progressInterval) {
                    this.throwIfCancelled(job.jobId);
                    await flushProgress();
                    lastFlushIdx = rowIdx;
                }
                if (rowIdx - lastCheckpointIdx >= this.checkpointInterval) {
                    this.throwIfCancelled(job.jobId);
                    // Sprint Z3 — atomic checkpoint write. Combines
                    // rows_processed/failed + checkpoint_row in one
                    // UPDATE so a crash never desyncs them.
                    // 1.7 — flush FIRST: checkpoint_row must only ever
                    // advance past rows that are truly durable; a
                    // non-flushing snapshot would let a crash-resume
                    // permanently skip buffered-but-unwritten rows.
                    const snap = await dispatcher.flushAll();
                    await emitQueuedEmbeds();
                    const totalProcessed = snap.written;
                    const totalFailed = snap.failed + runnerErrors.length;
                    const newRunnerErrs = runnerErrors.slice(persistedRunnerErrors);
                    const newDispatcherErrs = snap.errors.slice(persistedDispatcherErrors);
                    const combined = newRunnerErrs.concat(newDispatcherErrs);
                    await this.store.writeCheckpoint(job.jobId, totalProcessed, totalFailed, rowIdx, combined);
                    persistedRunnerErrors = runnerErrors.length;
                    persistedDispatcherErrors = snap.errors.length;
                    lastFlushIdx = rowIdx;
                    lastCheckpointIdx = rowIdx;
                }
            });

            this.throwIfCancelled(job.jobId);
            const finalResult = await dispatcher.flushAll();
            this.throwIfCancelled(job.jobId);
            // 1.8 — drain any remaining queued-embed rows now that every
            // row is durable, BEFORE the job flips to 'complete'.
            await emitQueuedEmbeds();
            const totalProcessed = finalResult.written;
            const totalFailed = finalResult.failed + runnerErrors.length;
            const newRunnerErrs = runnerErrors.slice(persistedRunnerErrors);
            const newDispatcherErrs = finalResult.errors.slice(persistedDispatcherErrors);
            const finalPending = newRunnerErrs.concat(newDispatcherErrs);
            await this.store.updateProgress(job.jobId, totalProcessed, totalFailed, finalPending);
            await dispatcher.commit();

            const completedAt = new Date().toISOString();
            // Sprint Z2 status decision: complete unless 100% failure
            // (in which case the load is meaningfully broken). A
            // partial failure is normal and surfaces in rows_failed.
            const status = (totalProcessed === 0 && totalFailed > 0) ? 'failed' : 'complete';
            const stamped = await this.store.trySetTerminal(job.jobId, status, { completedAt });
            if (!stamped) {
                this.log(`job ${job.jobId} cancel won the race against ${status}`);
                return;
            }

            await this.emitLoadDone(job, status, totalProcessed, totalFailed, deps);
            this.log(`job ${job.jobId} ${status}: ${totalProcessed} written, ${totalFailed} failed`);
        } catch (err) {
            try { await dispatcher.rollback(); } catch { /* ignore */ }
            const completedAt = new Date().toISOString();
            if (isLoadCancelled(err)) {
                await this.store.trySetTerminal(job.jobId, 'cancelled', { completedAt });
                const snap = dispatcher.snapshot();
                await this.emitLoadDone(job, 'cancelled', snap.written, snap.failed + runnerErrors.length, deps);
                this.log(`job ${job.jobId} cancelled`);
                return;
            }
            await this.store.trySetTerminal(job.jobId, 'failed', { completedAt });
            const snap = dispatcher.snapshot();
            await this.emitLoadDone(job, 'failed', snap.written, snap.failed + runnerErrors.length, deps);
            throw err;
        } finally {
            this.abort.clear(job.jobId);
        }
    }

    /**
     * Stream-parse the temp file row-by-row, invoking `onRow` for each
     * parsed ParsedRow. Per-format parsers:
     *   - JSONL: one JSON object per line, parsed and shape-routed
     *   - CSV:   minimal CSV with header row; routes to verbatim
     *            (Z3 will extend to graph node/edge CSV variants)
     *   - Arrow: not yet implemented in Z2; throws so the runner
     *            marks the job failed (Z3 will wire @apache/arrow)
     *
     * Per Sprint Z principle clause 5: a single malformed row
     * passes `null` to onRow so the runner can record the failure
     * without throwing.
     */
    private async streamParse(
        job: LoadJob,
        onRow: (row: ParsedRow | null) => Promise<void>,
    ): Promise<void> {
        if (job.format === 'jsonl') {
            await this.streamJsonl(job.tempFilePath!, job.workspace, onRow);
            return;
        }
        if (job.format === 'csv') {
            await this.streamCsv(job.tempFilePath!, job.workspace, onRow);
            return;
        }
        if (job.format === 'arrow') {
            // Z2 scope guard: Arrow file reader requires @apache/arrow
            // wired into the lore package. The dependency is already
            // present (via lancedb's transitive Arrow), but the
            // streaming reader needs format-specific work. Document
            // the gap and surface a clean failure so the runner can
            // mark the job failed without crashing.
            throw new Error('arrow_format_not_implemented_in_Z2');
        }
        throw new Error(`unknown_format ${job.format}`);
    }

    private async streamJsonl(
        path: string,
        workspace: string,
        onRow: (row: ParsedRow | null) => Promise<void>,
    ): Promise<void> {
        const stream = fs.createReadStream(path, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            if (line.trim().length === 0) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                await onRow(null);
                continue;
            }
            const routed = routeJsonlObject(parsed, workspace);
            await onRow(routed);
        }
    }

    private async streamCsv(
        path: string,
        workspace: string,
        onRow: (row: ParsedRow | null) => Promise<void>,
    ): Promise<void> {
        const stream = fs.createReadStream(path, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let header: string[] | null = null;
        for await (const line of rl) {
            if (line.trim().length === 0) continue;
            const cells = parseCsvLine(line);
            if (!header) {
                header = cells.map((c) => c.trim());
                continue;
            }
            try {
                const obj: Record<string, string> = {};
                for (let i = 0; i < header.length; i++) {
                    obj[header[i]!] = cells[i] ?? '';
                }
                const routed: ParsedRow = {
                    target: 'verbatim',
                    row: {
                        id: obj['id'] ?? '',
                        text: obj['text'] ?? '',
                        workspace,
                        metadata: obj,
                    },
                };
                await onRow(routed);
            } catch {
                await onRow(null);
            }
        }
    }

    private async emitLoadDone(
        job: LoadJob,
        status: 'complete' | 'failed' | 'cancelled',
        rowsProcessed: number,
        rowsFailed: number,
        deps: LoaderDispatcherDeps,
    ): Promise<void> {
        if (!this.outboxStore) return;
        const now = new Date().toISOString();
        const entry: OutboxEntry = {
            id: `load.done-${job.jobId}`,
            operation: 'load.done',
            initiator: 'loadJobsRunner',
            createdAt: now,
            updatedAt: now,
            steps: [],
            completed: false,
            workspace: job.workspace,
            operationKind: 'load.done',
            payload: {
                jobId: job.jobId,
                workspace: job.workspace,
                status,
                rowsProcessed,
                rowsFailed,
                // Engine-neutral graph observability: this field was once
                // named after the legacy engine's own internal write-path
                // field ('copy'|'merge'); now it names WHICH graph engine
                // loaded the rows — a local load is Surreal-backed or
                // graphless. No code reads these keys back — load.done is a
                // notification-only outbox kind (see outbox/dispatcher.ts)
                // — so the rename carries no compat surface.
                graphEngine: deps.surreal ? 'surreal' : null,
                graphPath: deps.surreal?.activePath ?? null,
            },
            status: 'pending',
            attempts: 0,
        };
        try {
            await this.outboxStore.record(entry);
        } catch (err) {
            this.log(`outbox record load.done for ${job.jobId} failed: ${(err as Error).message}`);
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Route a parsed JSONL object to its target. Supports three shapes:
 *   - { target: 'graph.node', ... }  — explicit target
 *   - { id, type, label, ...        } — assumed graph.node
 *   - { from, to, relationship      } — assumed graph.edge
 *   - { id, text                    } — assumed verbatim
 * The workspace is force-set from the job (Sprint L invariant —
 * a malicious row can't escape into a different workspace).
 */
export function routeJsonlObject(obj: unknown, workspace: string): ParsedRow | null {
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    const explicit = typeof o['target'] === 'string' ? (o['target'] as string) : null;

    if (explicit === 'graph.node' || (!explicit && typeof o['id'] === 'string' && typeof o['type'] === 'string' && !o['from'])) {
        return {
            target: 'graph.node',
            row: {
                id: String(o['id'] ?? ''),
                type: String(o['type'] ?? ''),
                label: String(o['label'] ?? ''),
                content: String(o['content'] ?? ''),
                tags: o['tags'] as string[] | string | undefined,
                project: o['project'] as string | undefined,
                ecosystem: o['ecosystem'] as string | undefined,
                metadata: typeof o['metadata'] === 'string' ? (o['metadata'] as string) : JSON.stringify(o['metadata'] ?? {}),
                workspace,
            },
        };
    }
    if (explicit === 'graph.edge' || (!explicit && typeof o['from'] === 'string' && typeof o['to'] === 'string')) {
        return {
            target: 'graph.edge',
            row: {
                from: String(o['from'] ?? ''),
                to: String(o['to'] ?? ''),
                relationship: String(o['relationship'] ?? o['rel'] ?? ''),
                workspace,
                metadata: typeof o['metadata'] === 'string' ? (o['metadata'] as string) : JSON.stringify(o['metadata'] ?? {}),
            },
        };
    }
    if (explicit === 'vector') {
        return {
            target: 'vector',
            row: {
                id: String(o['id'] ?? ''),
                text: String(o['text'] ?? ''),
                workspace,
                metadata: o['metadata'] as Record<string, unknown> | undefined,
            },
        };
    }
    // Fallback: verbatim if there's any text-y content.
    if (typeof o['id'] === 'string') {
        return {
            target: 'verbatim',
            row: {
                id: String(o['id']),
                text: String(o['text'] ?? ''),
                workspace,
                metadata: o['metadata'] as Record<string, unknown> | undefined,
            },
        };
    }
    return null;
}

/** Minimal CSV-line parser — handles quoted strings + escaped quotes.
 *  Doesn't handle embedded newlines inside quoted cells (Z3 will
 *  swap in a proper streaming CSV reader). */
function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQ = false;
                }
            } else {
                cur += ch;
            }
        } else {
            if (ch === ',') {
                cells.push(cur);
                cur = '';
            } else if (ch === '"' && cur === '') {
                inQ = true;
            } else {
                cur += ch;
            }
        }
    }
    cells.push(cur);
    return cells;
}

/**
 * Factory matching the outbox-replicator pattern. Returns the
 * constructed-but-not-started service. Caller decides when to
 * `.start()` (test mode constructs without spinning the loop).
 */
export function wireLoadJobsRunner(w: LoadJobsRunnerWiring): LoadJobsRunner {
    return new LoadJobsRunner(w);
}
