/**
 * embed/queue.ts — in-process async embed queue (architecture gap #2).
 *
 * Today: every store_node call blocks on the embedder (Xenova local
 * is fast but not free — ~10–50ms per node). A 100k-row import takes
 * 15–80 minutes of blocked event loop. The queue decouples the write
 * from the embed compute:
 *
 *   1. Caller enqueues {nodeId, text} — synchronous, returns instantly.
 *   2. A background worker drains the queue with bounded concurrency,
 *      computing embeddings + writing them to the vector store.
 *   3. Failed jobs retry with exponential backoff up to maxRetries
 *      before being marked permanently failed (callers can inspect via
 *      onPermanentFailure to fall back to outbox/audit).
 *
 * This module is the queue + worker. Integration into actual write
 * paths (store_node, manifest tools, etc.) is a separate concern —
 * each callsite decides whether to enqueue (latency wins, eventual
 * consistency) or block on embed (consistency wins, latency loses).
 *
 * Single-process only — the queue lives in JS memory, doesn't survive
 * a restart. The outbox machinery (gap #1) is the durable layer for
 * "did this embed actually land?"; this queue is the throughput layer
 * for "embed it sometime soon."
 */

export type EmbedJobStatus = 'pending' | 'in_flight' | 'done' | 'failed';

export interface EmbedJob {
    nodeId: string;
    text: string;
    /** RA2-reaudit2 — the workspace this node belongs to, so the executor can
     *  resolve the RIGHT graph + vector store. Absent → the boot/active store
     *  (store_node / bulk paths that target the active workspace). */
    workspace?: string;
    enqueuedAt: number;
    status: EmbedJobStatus;
    /** 0-based attempt counter; bumped on every retry. */
    attempts: number;
    lastError?: string;
    /** C3 3.5 — monotonic per-queue enqueue ordering, stamped at enqueue
     *  time. Supersede-in-place re-stamps the pending job; stale-retry and
     *  stale-completion checks compare against the latest stamped intent
     *  for the job's key. Internal — not part of the executor contract. */
    seq?: number;
}

/** Async function the worker invokes per job. Should compute the
 *  embedding AND persist it (typically: provider.embed → vector.store).
 *  Throw on failure — the worker handles retry/backoff. */
export type EmbedExecutor = (job: { nodeId: string; text: string; workspace?: string }) => Promise<void>;

export interface EmbedQueueOpts {
    /** Max concurrent in-flight executors. Default 4 — modest concurrency
     *  balances embed CPU cost with overlap of waits. Increase for
     *  external-API embedders that benefit from parallelism. */
    concurrency?: number;
    /** Retry budget per job. Default 3. */
    maxRetries?: number;
    /** Initial backoff between retries, ms. Doubles each attempt. */
    initialBackoffMs?: number;
    /** Called once when a job exhausts its retry budget. Caller's
     *  hook to record the permanent failure (e.g. write an outbox
     *  entry for eventual reconciliation). */
    onPermanentFailure?: (job: EmbedJob) => void;
    /** Test hook — override the clock so retries can be tested
     *  without real wall time. */
    now?: () => number;
    /**
     * Sprint E1 (2026-05-24) — soft cap on the number of jobs the
     * future E3 ticker should drain into one BatchedEmbedder.embedBatch
     * call. Stored on the queue so the ticker (lands in E3) reads
     * the same cap that the BatchedEmbedder advertises (256 for
     * local Xenova, 1000 for cloud). E1 only records the value;
     * the per-job executor pump is unchanged so the hot single-write
     * + reconnect paths see no behavioural difference (E-D5 sentinel).
     */
    maxBatchSize?: number;
    /**
     * SP-11 — hard cap on the depth of the pending queue. When the
     * embedder lags (slow cloud provider, model reload) or a bulk import
     * / consistency-sweep enqueues faster than the worker drains, each
     * EmbedJob retains the full embedding TEXT in JS heap (a 50k×8KB
     * import is ~400MB). Without a cap, `pending` is an unbounded OOM
     * vector. When the queue is at capacity, `enqueue()` drops the new
     * job and returns false so callers can apply backpressure (503 /
     * route to the durable outbox) instead of ballooning the heap.
     * Default 10_000 jobs. Set to 0 to disable the cap (legacy behaviour).
     */
    maxQueueSize?: number;
    /**
     * SP-11 — called once per dropped job when the queue is at
     * `maxQueueSize`. Lets the caller record the drop (audit/outbox) so a
     * shed embed isn't silently lost. The job is NOT enqueued.
     * 1.M2 (2026-08-17 audit): the payload now carries `workspace` too —
     * the daemon wires this to re-enqueue the shed embed as a durable
     * outbox embed.batch row, which needs the workspace to route.
     */
    onOverflow?: (dropped: { nodeId: string; text: string; workspace?: string }) => void;
}

export interface EmbedQueueStats {
    pending: number;
    inFlight: number;
    completed: number;
    permanentlyFailed: number;
    retries: number;
    /** SP-11 — jobs shed because the queue was at maxQueueSize. */
    droppedOverflow: number;
}

/**
 * In-memory async embed queue. Construct one per VerbatimStore (or
 * one per workspace). `start(executor)` kicks the worker; `enqueue`
 * adds jobs; `stop()` drains and shuts down.
 */
export class EmbedQueue {
    private readonly pending: EmbedJob[] = [];
    /** C3 3.5 — pending jobs indexed by (workspace, nodeId) so enqueue() can
     *  supersede a not-yet-started job for the same node IN PLACE instead of
     *  pushing a second independent job that races it. Mirrors `pending`. */
    private readonly pendingByKey = new Map<string, EmbedJob>();
    /** C3 3.5 — (workspace, nodeId) keys currently being executed. pump()
     *  holds a pending job whose key is in here until the in-flight job
     *  completes — per-id serialization, so the temporally-LAST enqueue is
     *  always the last write to land in the vector row. */
    private readonly inFlightKeys = new Set<string>();
    /** C3 3.5 — latest enqueue intent per key. Lives until the queue goes
     *  fully idle (cleared in maybeResolveDrained) so a retry re-enqueue can
     *  tell it was superseded while sitting in the backoff gap — re-running
     *  it would write the STALE captured text over the newer job's row. */
    private readonly latestSeqByKey = new Map<string, number>();
    private seqCounter = 0;
    private readonly opts: Required<Omit<EmbedQueueOpts, 'onPermanentFailure' | 'now' | 'maxBatchSize' | 'onOverflow'>> & {
        onPermanentFailure?: (job: EmbedJob) => void;
        now: () => number;
        maxBatchSize: number;
        onOverflow?: (dropped: { nodeId: string; text: string; workspace?: string }) => void;
    };
    /** SP-11 — count of jobs shed because the queue was at capacity. */
    private droppedOverflow = 0;
    private inFlight = 0;
    /** Jobs in the setTimeout-backoff gap between a failed attempt and
     *  re-enqueue. Counted as "still working" so drained() doesn't
     *  spuriously resolve during the gap. */
    private scheduledRetries = 0;
    private completed = 0;
    private permanentlyFailed = 0;
    private retries = 0;
    private running = false;
    private executor: EmbedExecutor | null = null;
    private idleResolvers: Array<() => void> = [];

    constructor(opts: EmbedQueueOpts = {}) {
        this.opts = {
            concurrency: opts.concurrency ?? 4,
            maxRetries: opts.maxRetries ?? 3,
            initialBackoffMs: opts.initialBackoffMs ?? 100,
            onPermanentFailure: opts.onPermanentFailure,
            now: opts.now ?? Date.now,
            // Sprint E1 — default matches LOCAL_XENOVA_MAX_BATCH so the
            // E3 ticker has a sane default without importing the
            // BatchedEmbedder constant (avoids a circular reference
            // between embed/queue.ts and embed/batchedEmbedder.ts).
            maxBatchSize: opts.maxBatchSize ?? 256,
            // SP-11 — bound the pending queue. Default 10k jobs.
            maxQueueSize: opts.maxQueueSize ?? 10_000,
            onOverflow: opts.onOverflow,
        };
    }

    /**
     * Enqueue a job. Returns `true` when accepted, `false` when the queue
     * is at `maxQueueSize` and the job was shed (SP-11). Callers that care
     * about backpressure should check the return value and route the
     * embed to the durable outbox / return 503 instead of relying on the
     * in-memory queue. Callers that don't care can ignore it (a dropped
     * embed is recoverable via the consistency sweep).
     */
    enqueue(nodeId: string, text: string, workspace?: string): boolean {
        const key = EmbedQueue.jobKey(nodeId, workspace);
        const seq = ++this.seqCounter;
        // C3 3.5 — supersede-in-place: if a job for this node is still
        // PENDING (not yet started), replace its captured text/args with this
        // call's rather than pushing a second job. Two pending jobs for one
        // node run concurrently under pump()'s fan-out, and the executor
        // persists the text captured at ENQUEUE time — so whichever write
        // landed last won regardless of enqueue order, permanently leaving
        // the superseded text in the vector row (verified live: 5/10 nodes).
        // Supersede is checked BEFORE the cap: it doesn't grow the queue.
        const existingPending = this.pendingByKey.get(key);
        if (existingPending) {
            existingPending.text = text;
            existingPending.workspace = workspace;
            existingPending.enqueuedAt = this.opts.now();
            existingPending.seq = seq;
            this.latestSeqByKey.set(key, seq);
            return true;
        }
        const cap = this.opts.maxQueueSize;
        if (cap > 0 && this.pending.length >= cap) {
            this.droppedOverflow++;
            this.opts.onOverflow?.({ nodeId, text, workspace });
            return false;
        }
        this.latestSeqByKey.set(key, seq);
        const job: EmbedJob = {
            nodeId, text, workspace,
            enqueuedAt: this.opts.now(),
            status: 'pending',
            attempts: 0,
            seq,
        };
        this.pending.push(job);
        this.pendingByKey.set(key, job);
        // Fire-and-forget pump — async so the caller's stack unwinds
        // before the worker starts (matches "returns instantly").
        if (this.running) void this.pump();
        return true;
    }

    /** C3 3.5 — coalescing key. nodeIds are only unique within a workspace,
     *  so the workspace is part of the key (two workspaces may hold the same
     *  node id; their embeds must not merge). */
    private static jobKey(nodeId: string, workspace?: string): string {
        return `${workspace ?? ''}\n${nodeId}`;
    }

    /** SP-11 — current pending depth. Consumed by metrics.ts:191 and by
     *  routes that want to apply outbox-lag-style backpressure before
     *  enqueueing (e.g. import.ts). */
    depth(): number {
        return this.pending.length;
    }

    /** Begin draining. Idempotent — calling start twice is a no-op. */
    start(executor: EmbedExecutor): void {
        if (this.running) return;
        this.executor = executor;
        this.running = true;
        void this.pump();
    }

    /** Stop accepting new pumps. In-flight jobs run to completion.
     *  Call await drained() afterwards to know when everything is done. */
    stop(): void {
        this.running = false;
    }

    /** Resolves when pending === 0 and inFlight === 0. Useful for tests
     *  + graceful shutdown. */
    async drained(): Promise<void> {
        if (this.pending.length === 0 && this.inFlight === 0 && this.scheduledRetries === 0) return;
        return new Promise<void>(resolve => { this.idleResolvers.push(resolve); });
    }

    stats(): EmbedQueueStats {
        return {
            pending: this.pending.length,
            inFlight: this.inFlight,
            completed: this.completed,
            permanentlyFailed: this.permanentlyFailed,
            retries: this.retries,
            droppedOverflow: this.droppedOverflow,
        };
    }

    private async pump(): Promise<void> {
        if (!this.executor) return;
        while (this.running && this.inFlight < this.opts.concurrency && this.pending.length > 0) {
            // C3 3.5 — per-id serialization: skip jobs whose key has an
            // IN-FLIGHT sibling; they dispatch when that sibling completes
            // (runJob's finally re-pumps). Jobs for OTHER keys behind a held
            // job still dispatch — the hold is per-id, not a head-of-line
            // block for the whole queue.
            const idx = this.pending.findIndex(
                (j) => !this.inFlightKeys.has(EmbedQueue.jobKey(j.nodeId, j.workspace)),
            );
            if (idx === -1) break;
            const job = this.pending.splice(idx, 1)[0]!;
            this.pendingByKey.delete(EmbedQueue.jobKey(job.nodeId, job.workspace));
            this.inFlightKeys.add(EmbedQueue.jobKey(job.nodeId, job.workspace));
            this.inFlight++;
            // Fire each job in its own task so the while-loop can keep
            // dispatching up to concurrency.
            void this.runJob(job);
        }
    }

    private async runJob(job: EmbedJob): Promise<void> {
        const key = EmbedQueue.jobKey(job.nodeId, job.workspace);
        job.status = 'in_flight';
        try {
            await this.executor!({ nodeId: job.nodeId, text: job.text, workspace: job.workspace });
            job.status = 'done';
            this.completed++;
        } catch (err) {
            job.lastError = (err as Error).message;
            if (job.attempts < this.opts.maxRetries) {
                job.attempts++;
                this.retries++;
                // Exponential backoff. Re-enqueue at the front so retries
                // don't get starved behind newer arrivals. Counted as
                // a scheduled retry so drained() doesn't fire during
                // the setTimeout gap.
                this.scheduledRetries++;
                const delay = this.opts.initialBackoffMs * Math.pow(2, job.attempts - 1);
                // SP-02 — do NOT unref() this retry timer. The retry is
                // counted in scheduledRetries, so drained() (awaited on
                // graceful shutdown) blocks until the re-enqueued job
                // lands. unref()'ing it let the process exit before the
                // retry fired, silently dropping the embed.
                setTimeout(() => {
                    this.scheduledRetries--;
                    // SW-03 (B10) — if stop() ran during the backoff gap,
                    // pump() is guarded on `running` and will never dispatch
                    // this job again: re-parking it in `pending` strands it
                    // there forever AND hangs any drained() awaiter (the
                    // graceful-shutdown caller blocks on drained()). When not
                    // running, re-route the job to permanent failure so it is
                    // RECORDED (onPermanentFailure → outbox/audit) instead of
                    // silently lost, then resolve the drain. Otherwise resume
                    // the normal retry: re-enqueue at the front and pump.
                    if (this.running) {
                        // C3 3.5 — stale-retry drop: a NEWER enqueue for this
                        // key arrived while this job sat in the backoff gap
                        // (or already ran). Re-running would write this job's
                        // superseded captured text over the newer intent's
                        // vector row. The newer job carries the current text
                        // and has its own retry budget, so dropping this one
                        // loses nothing.
                        if (this.latestSeqByKey.get(key) !== job.seq) {
                            this.maybeResolveDrained();
                            return;
                        }
                        job.status = 'pending';
                        this.pending.unshift(job);
                        this.pendingByKey.set(key, job);
                        void this.pump();
                    } else {
                        job.status = 'failed';
                        this.permanentlyFailed++;
                        this.opts.onPermanentFailure?.(job);
                        this.maybeResolveDrained();
                    }
                }, delay);
            } else {
                job.status = 'failed';
                this.permanentlyFailed++;
                this.opts.onPermanentFailure?.(job);
            }
        } finally {
            this.inFlight--;
            this.inFlightKeys.delete(key);
            this.maybeResolveDrained();
            // Pump again in case concurrency just opened up.
            if (this.pending.length > 0) void this.pump();
        }
    }

    private maybeResolveDrained(): void {
        if (this.pending.length === 0 && this.inFlight === 0 && this.scheduledRetries === 0) {
            // Fully idle: no job can reappear except via a fresh enqueue,
            // so the C3 3.5 intent ledger can be dropped — it exists only
            // to let in-backoff retries detect that a newer enqueue
            // superseded them.
            this.latestSeqByKey.clear();
            const resolvers = this.idleResolvers.splice(0);
            for (const r of resolvers) r();
        }
    }
}
