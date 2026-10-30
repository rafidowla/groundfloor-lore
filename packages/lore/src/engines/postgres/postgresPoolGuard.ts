/**
 * postgresPoolGuard.ts - a per-pool budget for background / expensive Postgres
 * work that keeps a floor of connections free for foreground queries.
 *
 * WHY. One `pg` pool (default max 16) serves every workspace in the process. A
 * multi-minute `CREATE INDEX CONCURRENTLY` or `VACUUM ANALYZE` checked out of it
 * is one connection that foreground recall / writes can no longer use; several at
 * once (or one on a small pool) starve the foreground. The guard bounds that.
 *
 * MECHANISM. A background job calls `guard.run(name, fn)`:
 *   1. it first takes a SLOT. Slots = max(0, poolMax - reserve), capped by
 *      `concurrency`. No slot -> the job WAITS in a FIFO queue, holding no
 *      connection and nothing a foreground query can queue behind;
 *   2. only with a slot does it check a connection out of the pool;
 *   3. it sets `statement_timeout` for the job (default 0 = unbounded: an index build
 *      or VACUUM on a large table can take far longer than the pool's foreground
 *      timeout, and close/cancel already stops it), runs
 *      `fn(client)`, and always resets/discards the connection and frees the slot.
 * So background work can never hold more than `poolMax - reserve` connections:
 * at least `reserve` stay available to foreground code.
 *
 * SMALL POOLS (slots = 0, i.e. poolMax <= reserve - e.g. LORE_PG_POOL_MAX=1). The job
 * is SKIPPED with a one-time warning and `run()` resolves `{ ran: false, reason:
 * 'no-slots' }`. The alternative - "wait until the pool is idle, then run" - was
 * rejected: the moment such a job takes the only connection, a foreground query
 * that arrives next waits for the whole job (minutes for an index build), which is
 * exactly the starvation the guard exists to prevent. Every job under the guard is
 * optional (search stays correct through the scan path, VACUUM and index
 * reconciliation are retried on the next open / scheduled pass), so skipping is
 * safe; running is not.
 *
 * CANCEL. `cancelOwner` / `cancelAll` / an AbortSignal abort the job: a queued job
 * is dropped, a running one has `pg_cancel_backend` sent for its backend pid over a
 * short-lived side connection (so it works even while the pool is saturated). The
 * cancel is repeated every 250 ms until the job settles, because a cancel that
 * lands between two statements is a no-op on Postgres. The connection is only
 * returned after every outstanding cancel finished, so a late cancel can never hit
 * whatever statement runs on that backend next.
 *
 * EXCLUSIVE KEYS. Jobs that pass the same `exclusive` key never run at the same time on
 * one pool: a later one waits in the queue (holding no slot and no connection) until
 * the earlier one finishes, while jobs with other keys or none still start. Every
 * background CREATE INDEX CONCURRENTLY builder uses {@link INDEX_BUILD_EXCLUSIVE}: two
 * concurrent builds in one database wait for each other's transactions (each waits for
 * older snapshots, and a second build on the same table queues on the first's SHARE
 * UPDATE EXCLUSIVE lock), so running two at once can deadlock (40P01), and the loser
 * leaves an INVALID index behind (seen on the 1M-row 3.38.0 upgrade run).
 *
 * Guards are keyed per pool (WeakMap): several workspaces / graphs sharing one
 * pool share one budget. A guard never touches foreground queries.
 */
import { Client, type ClientConfig, type Pool, type PoolClient } from 'pg';

/** Concurrent background jobs allowed per pool (further capped by poolMax - reserve). */
export const DEFAULT_BACKGROUND_CONCURRENCY = 2;
/** Upper bound of the default foreground reserve. */
export const MAX_DEFAULT_BACKGROUND_RESERVE = 4;
const CANCEL_RETRY_MS = 250;
/** The `exclusive` key shared by every background CREATE INDEX CONCURRENTLY job (see the header). */
export const INDEX_BUILD_EXCLUSIVE = 'concurrent-index-build';
/** Background jobs run without a statement timeout unless configured; cancellation (close / AbortSignal) bounds them. */
export const DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS = 0;

/** Operator-facing knobs (also accepted by `createPostgresPool`). */
export interface PoolGuardOptions {
    /** Connections kept free for foreground queries. Default: min(4, max(1, floor(poolMax / 2))), i.e. 4 on the default pool of 16. */
    backgroundReserve?: number;
    /** Max concurrent background jobs on this pool. Default 2. */
    backgroundConcurrency?: number;
    /** `statement_timeout` (ms) for background jobs that do not set their own; 0 = unbounded. Default 0 (unbounded): the pool's foreground session timeout (30 s) would cancel large index builds / VACUUM. */
    backgroundStatementTimeoutMs?: number;
}

export function defaultBackgroundReserve(poolMax: number): number {
    return Math.min(MAX_DEFAULT_BACKGROUND_RESERVE, Math.max(1, Math.floor(poolMax / 2)));
}

/** Slots available to background work on a pool of `poolMax` connections. */
export function backgroundSlots(poolMax: number, reserve: number, concurrency: number): number {
    return Math.max(0, Math.min(Math.trunc(concurrency), Math.trunc(poolMax) - Math.trunc(reserve)));
}

export type BackgroundResult<T> =
    | { ran: true; value: T }
    | { ran: false; reason: 'no-slots' | 'cancelled' };

export interface BackgroundJobOptions {
    /** Tag used by `cancelOwner` (a store cancels its own jobs on close). */
    owner?: object;
    /** Abort drops a queued job and cancels a running one. */
    signal?: AbortSignal;
    /** `statement_timeout` for this job in ms; 0 = unbounded. Undefined = the guard default (`backgroundStatementTimeoutMs`, itself 0 = unbounded unless configured). */
    timeoutMs?: number;
    /** Jobs with the same key never run at the same time on this pool (see the header). */
    exclusive?: string;
}

export interface PoolGuardStats {
    slots: number; reserve: number; concurrency: number; poolMax: number;
    active: number; waiting: number;
    started: number; completed: number; skipped: number; cancelled: number;
}

interface Job {
    name: string;
    owner: object | undefined;
    exclusive: string | undefined;
    aborted: boolean;
    pid: number | null;
    cancelTimer: NodeJS.Timeout | null;
    inflightCancels: Set<Promise<void>>;
    done: Promise<void>;
    finish: () => void;
}
interface Waiter { job: Job; resolve: (granted: boolean) => void }

export class PoolGuard {
    private active = 0;
    private closed = false;
    private readonly waiters: Waiter[] = [];
    private readonly jobs = new Set<Job>();
    private readonly heldKeys = new Set<string>();
    private readonly warned = new Set<string>();
    private counters = { started: 0, completed: 0, skipped: 0, cancelled: 0 };

    constructor(private readonly pool: Pool, private readonly opts: PoolGuardOptions = {}) {}

    private get poolMax(): number { return this.pool.options.max ?? 10; }
    private get reserve(): number { return this.opts.backgroundReserve ?? defaultBackgroundReserve(this.poolMax); }
    private get concurrency(): number { return this.opts.backgroundConcurrency ?? DEFAULT_BACKGROUND_CONCURRENCY; }
    get slots(): number { return backgroundSlots(this.poolMax, this.reserve, this.concurrency); }

    stats(): PoolGuardStats {
        return {
            slots: this.slots, reserve: this.reserve, concurrency: this.concurrency, poolMax: this.poolMax,
            active: this.active, waiting: this.waiters.length, ...this.counters,
        };
    }

    /**
     * run - execute `fn` as a guarded background job. Rejects with `fn`'s own error
     * (never for a cancel: that resolves `{ ran: false, reason: 'cancelled' }`).
     */
    async run<T>(name: string, fn: (client: PoolClient) => Promise<T>, opts: BackgroundJobOptions = {}): Promise<BackgroundResult<T>> {
        if (this.closed || opts.signal?.aborted) { this.counters.cancelled++; return { ran: false, reason: 'cancelled' }; }
        if (this.slots === 0) {
            this.counters.skipped++;
            if (!this.warned.has(name)) {
                this.warned.add(name);
                console.warn(`[lore-pg] background job "${name}" skipped: pool max ${this.poolMax} leaves no connection beyond the `
                    + `${this.reserve} reserved for foreground queries. Raise LORE_PG_POOL_MAX (or lower LORE_PG_BACKGROUND_RESERVE) to let it run.`);
            }
            return { ran: false, reason: 'no-slots' };
        }
        let finish!: () => void;
        const job: Job = {
            name, owner: opts.owner, exclusive: opts.exclusive, aborted: false, pid: null, cancelTimer: null, inflightCancels: new Set(),
            done: new Promise<void>((r) => { finish = r; }), finish: () => finish(),
        };
        this.jobs.add(job);
        const onAbort = (): void => this.abortJob(job);
        opts.signal?.addEventListener('abort', onAbort, { once: true });

        let granted = false;
        let client: PoolClient | undefined;
        let broken: Error | undefined;
        let timeoutSet = false;
        try {
            granted = await this.acquire(job);
            if (!granted || job.aborted) { this.counters.cancelled++; return { ran: false, reason: 'cancelled' }; }
            client = await this.pool.connect();
            job.pid = Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
            if (job.aborted) { this.counters.cancelled++; return { ran: false, reason: 'cancelled' }; }
            this.counters.started++;
            const timeoutMs = opts.timeoutMs ?? this.opts.backgroundStatementTimeoutMs ?? DEFAULT_BACKGROUND_STATEMENT_TIMEOUT_MS;
            await client.query(`SET statement_timeout = ${Math.max(0, Math.trunc(timeoutMs))}`);
            timeoutSet = true;
            const value = await fn(client);
            this.counters.completed++;
            return { ran: true, value };
        } catch (err) {
            broken = err instanceof Error ? err : new Error(String(err));
            if (job.aborted) { this.counters.cancelled++; return { ran: false, reason: 'cancelled' }; }
            throw err;
        } finally {
            opts.signal?.removeEventListener('abort', onAbort);
            if (job.cancelTimer) { clearInterval(job.cancelTimer); job.cancelTimer = null; }
            await Promise.allSettled([...job.inflightCancels]); // no cancel may land after the connection is handed back
            if (client) {
                if (!broken && timeoutSet) {
                    try { await client.query('RESET statement_timeout'); } catch (e) { broken = e instanceof Error ? e : new Error(String(e)); }
                }
                // A cancelled or failed job's connection may hold session state (timeout, advisory lock): discard it.
                client.release(broken ?? (job.aborted ? new Error('background job cancelled') : undefined));
            }
            this.jobs.delete(job);
            if (granted) this.releaseSlot(job);
            job.finish();
        }
    }

    /** Cancel every job tagged with `owner` (queued ones are dropped, running ones get pg_cancel_backend) and wait for them to settle. */
    async cancelOwner(owner: object): Promise<void> {
        const mine = [...this.jobs].filter((j) => j.owner === owner);
        for (const j of mine) this.abortJob(j);
        await Promise.all(mine.map((j) => j.done));
    }

    /** Cancel everything and refuse further jobs (the pool is being closed). */
    async cancelAll(): Promise<void> {
        this.closed = true;
        const all = [...this.jobs];
        for (const j of all) this.abortJob(j);
        await Promise.all(all.map((j) => j.done));
    }

    private canStart(job: Job): boolean {
        return this.active < this.slots && (job.exclusive === undefined || !this.heldKeys.has(job.exclusive));
    }

    private grant(job: Job): void {
        this.active++;
        if (job.exclusive !== undefined) this.heldKeys.add(job.exclusive);
    }

    private acquire(job: Job): Promise<boolean> {
        if (this.canStart(job)) { this.grant(job); return Promise.resolve(true); }
        return new Promise<boolean>((resolve) => { this.waiters.push({ job, resolve }); });
    }

    /** Free the job's slot and key, then start every queued job that can now run, in queue order. */
    private releaseSlot(job: Job): void {
        this.active--;
        if (job.exclusive !== undefined) this.heldKeys.delete(job.exclusive);
        for (let i = 0; i < this.waiters.length && this.active < this.slots;) {
            const w = this.waiters[i]!;
            if (!this.canStart(w.job)) { i++; continue; }
            this.waiters.splice(i, 1);
            this.grant(w.job);
            w.resolve(true);
        }
    }

    private abortJob(job: Job): void {
        if (job.aborted) return;
        job.aborted = true;
        const idx = this.waiters.findIndex((w) => w.job === job);
        if (idx >= 0) { this.waiters.splice(idx, 1)[0]!.resolve(false); return; }
        this.startCancel(job);
    }

    private startCancel(job: Job): void {
        if (job.pid === null || job.cancelTimer) return; // pid unknown: run() re-checks `aborted` right after connecting
        const fire = (): void => {
            const p: Promise<void> = this.cancelBackend(job.pid!).finally(() => { job.inflightCancels.delete(p); });
            job.inflightCancels.add(p);
        };
        fire();
        job.cancelTimer = setInterval(fire, CANCEL_RETRY_MS);
        job.cancelTimer.unref();
    }

    /** pg_cancel_backend over a side connection, so it neither waits for a pool slot nor consumes one. Best effort. */
    private async cancelBackend(pid: number): Promise<void> {
        const side = new Client(this.pool.options as ClientConfig);
        side.on('error', () => undefined);
        try {
            await side.connect();
            await side.query('SELECT pg_cancel_backend($1)', [pid]);
        } catch { /* retried by the cancel timer */ } finally {
            try { await side.end(); } catch { /* already gone */ }
        }
    }
}

const guards = new WeakMap<Pool, PoolGuard>();

/** Register the guard config for a pool (createPostgresPool does this); replaces any lazily-made default guard. */
export function configurePoolGuard(pool: Pool, opts: PoolGuardOptions): PoolGuard {
    const g = new PoolGuard(pool, opts);
    guards.set(pool, g);
    return g;
}

/** The pool's guard; a pool built elsewhere (tests, injected) gets one with the defaults. */
export function poolGuardFor(pool: Pool): PoolGuard {
    let g = guards.get(pool);
    if (!g) { g = new PoolGuard(pool); guards.set(pool, g); }
    return g;
}

/** Cancel all background work on a pool and refuse more; closePostgresPool calls this before `pool.end()`. */
export async function cancelBackgroundWork(pool: Pool): Promise<void> {
    const g = guards.get(pool);
    if (g) await g.cancelAll();
}
