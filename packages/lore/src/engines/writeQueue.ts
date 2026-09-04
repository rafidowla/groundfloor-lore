/**
 * engines/writeQueue.ts — single-writer serialization queue
 * (architecture gaps #4 + #5).
 *
 * SurrealDB and SQLite are both single-writer per database. Today,
 * concurrent unrelated writes (sync + migration + user + external)
 * collide at the substrate's internal mutex with no fairness, no
 * ordering guarantees, and no observability into how deep the
 * contention is.
 *
 * This is a reusable queue: one instance per substrate (or per
 * hot-write subdomain). Callers `enqueue(label, executor)` and get
 * back a promise that resolves with the executor's result. Executors
 * run strictly serially (FIFO), so the substrate sees one writer at
 * a time even when many callers race.
 *
 * The queue does NOT increase substrate throughput — SurrealDB/SQLite
 * remain single-writer underneath. What it adds:
 *
 *   - Explicit ordering (FIFO) so behavior is reproducible.
 *   - Backpressure observability via `depth()` and `inFlight()`.
 *   - Per-task labels for log/metrics correlation.
 *   - A single failure point for adding fairness, prioritization,
 *     or admission control later (cap depth, drop low-priority tasks,
 *     etc.) without touching every callsite.
 *
 * Shipped as a standalone module. Per-callsite integration (wrap
 * `localGraph.upsertNode` etc. behind a queue) is a separate
 * decision per write path.
 */

export interface WriteQueueOpts {
    /** Cap on queued + in-flight tasks. enqueue() rejects when
     *  exceeded so the daemon can shed load instead of OOM'ing.
     *  Default Infinity (no cap). */
    maxDepth?: number;
}

export interface WriteQueueStats {
    /** Tasks waiting in line (not yet executing). */
    queued: number;
    /** Always 0 or 1 — the queue serialises. Exposed for symmetry
     *  with other queue stats consumers. */
    inFlight: number;
    /** Cumulative count of tasks the queue has run to completion. */
    completed: number;
    /** Cumulative count of tasks that threw. */
    failed: number;
    /** Cumulative count of tasks rejected at enqueue time due to
     *  maxDepth. */
    rejected: number;
    /** Wait time of the oldest still-queued task, in milliseconds.
     *  0 when the queue is empty. Surfaces backpressure latency for
     *  operators — a queue that's draining stays near 0; a stuck
     *  drainer pegs this at the age of the head-of-line task. */
    longestWaitMs: number;
}

interface QueuedTask {
    label: string;
    executor: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    enqueuedAt: number;
}

/**
 * KeyedMutex — per-key promise-chain serialization (NW-1d).
 *
 * `WriteQueue` (above) serializes ALL writers through one queue —
 * useful when the substrate is single-writer globally and you want
 * one explicit FIFO line. `KeyedMutex` is the orthogonal primitive:
 * it serializes only writers that share a key (e.g. the same node
 * id) and lets independent keys proceed in parallel.
 *
 * The motivating bug (audit `conc-upsertnode-toctou-no-write-serialization`):
 * `LocalGraph.upsertNode` does `getNode(id) → branch CREATE-vs-SET`.
 * Two concurrent calls for the same not-yet-existing id both observe
 * `existingNode === null`, both CREATE, and the second hits a PK
 * collision (or a duplicate-edge state). Wrapping just the upsert
 * call in this primitive — keyed by node id — collapses that race
 * into a strict ordering: the second call's getNode runs only after
 * the first's CREATE has committed, so it sees the row and takes
 * the SET branch.
 *
 * Same pattern that lives in `tsSdkAdapter.serializeById`, lifted
 * into a reusable class so other engines can use it without copying
 * the map+catch+cleanup dance.
 *
 * Different ids never contend. Map entries are deleted once their
 * tail settles (and only when no newer op has chained on), so the
 * map stays small under steady-state load.
 */
export class KeyedMutex {
    private readonly chains = new Map<string, Promise<unknown>>();

    /**
     * Run `op` after any in-flight op for the same key has settled.
     * Different keys run in parallel; same-key ops run strictly FIFO.
     *
     * A predecessor's rejection does NOT propagate to the next op —
     * only its ORDERING is observed. The predecessor's own caller
     * still sees its error; this guarantees one failed upsert
     * doesn't poison every subsequent same-id write.
     */
    async run<T>(key: string, op: () => Promise<T>): Promise<T> {
        const prev = this.chains.get(key) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(op);
        this.chains.set(key, run);
        try {
            return await run;
        } finally {
            if (this.chains.get(key) === run) this.chains.delete(key);
        }
    }

    /** Test helper — number of distinct keys with an in-flight tail. */
    size(): number {
        return this.chains.size;
    }
}

export class WriteQueue {
    private readonly tasks: QueuedTask[] = [];
    private inFlight = 0;
    private completed = 0;
    private failed = 0;
    private rejected = 0;
    private running = false;
    private readonly maxDepth: number;
    private idleResolvers: Array<() => void> = [];

    constructor(opts: WriteQueueOpts = {}) {
        this.maxDepth = opts.maxDepth ?? Infinity;
    }

    /**
     * Enqueue a writer. Returns a promise that resolves with the
     * executor's return value once it has finished. Throws (rejects)
     * immediately if depth would exceed maxDepth.
     */
    async enqueue<T>(label: string, executor: () => Promise<T>): Promise<T> {
        if (this.tasks.length + this.inFlight >= this.maxDepth) {
            this.rejected++;
            throw new Error(
                `WriteQueue: maxDepth ${this.maxDepth} exceeded; rejecting '${label}'`,
            );
        }
        return new Promise<T>((resolve, reject) => {
            this.tasks.push({
                label,
                executor: executor as () => Promise<unknown>,
                resolve: resolve as (value: unknown) => void,
                reject,
                enqueuedAt: Date.now(),
            });
            void this.pump();
        });
    }

    /** Resolves when queued === 0 and inFlight === 0. */
    async drained(): Promise<void> {
        if (this.tasks.length === 0 && this.inFlight === 0) return;
        return new Promise<void>(r => { this.idleResolvers.push(r); });
    }

    stats(): WriteQueueStats {
        const head = this.tasks[0];
        return {
            queued: this.tasks.length,
            inFlight: this.inFlight,
            completed: this.completed,
            failed: this.failed,
            rejected: this.rejected,
            longestWaitMs: head ? Date.now() - head.enqueuedAt : 0,
        };
    }

    /** Test helper — peek labels of currently-queued tasks in FIFO order. */
    peekLabels(): string[] {
        return this.tasks.map(t => t.label);
    }

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.tasks.length > 0) {
                const task = this.tasks.shift()!;
                this.inFlight = 1;
                try {
                    const value = await task.executor();
                    this.completed++;
                    task.resolve(value);
                } catch (err) {
                    this.failed++;
                    task.reject(err);
                } finally {
                    this.inFlight = 0;
                }
            }
        } finally {
            this.running = false;
            if (this.tasks.length === 0 && this.inFlight === 0) {
                const resolvers = this.idleResolvers.splice(0);
                for (const r of resolvers) r();
            }
        }
    }
}
