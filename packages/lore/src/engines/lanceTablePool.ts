/**
 * lanceTablePool.ts — Fixed-size pool of LanceDB Table handles fronting
 * one on-disk table.
 *
 * Why this exists:
 *   `verbatimStore.search` did `this.table.vectorSearch(...)` against a
 *   single shared Table handle. Profiling on a high-volume production workspace
 *   showed that single handle serialized 10-concurrent vectorSearch
 *   calls into ~1180ms each (9.1× single-call cost), even though
 *   LanceDB's MVCC architecture supports concurrent reads. The
 *   serialization is somewhere inside the NAPI binding's per-handle
 *   dispatch — we work around it by holding N independent Table handles
 *   and round-robining queries across them.
 *
 *   See Lore node `rc3-deferred-embedding-recall-bottleneck` for the
 *   per-stage breakdown that proved LanceDB (not onnxruntime) owned the
 *   /api/recall latency budget at concurrency 10.
 *
 * Concurrency model (per LanceDB docs + Stage 1 research):
 *   - Reads are MVCC-safe; multiple opens on the same on-disk table
 *     can run vectorSearch in parallel.
 *   - Writes serialize at LanceDB's internal write lock regardless of
 *     handle count — the existing single write path stays as-is in
 *     VerbatimStore; this pool is for READS only.
 *   - Each pooled Table handle is pinned to the snapshot it was
 *     opened on. `checkoutLatest()` is called on acquire so pooled
 *     reads observe writes made between opens.
 *
 * Sizing:
 *   Default 4 (matches Kùzu pool, fits the burst profile). Configurable
 *   via LORE_LANCE_POOL_SIZE, clamped to [1, 32].
 */

import type { Connection, Table } from '@lancedb/lancedb';
import {
    installNativePoolSafetyNet,
    __resetNativePoolSafetyNetForTests,
    __isNativePoolSafetyNetInstalledForTests,
} from './nativePoolSafetyNet.js';
import { log } from '../logger.js';
import {
    DEFAULT_POOL_DRAIN_TIMEOUT_MS,
    PoolExhaustedError,
    PoolAcquireTimeoutError,
    DEFAULT_POOL_MAX_WAITERS,
    DEFAULT_POOL_ACQUIRE_TIMEOUT_MS,
} from './poolLimits.js';

interface Waiter {
    resolve: (table: Table) => void;
    reject: (err: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
}

export const DEFAULT_LANCE_POOL_SIZE = 16;
export const MIN_LANCE_POOL_SIZE = 1;
export const MAX_LANCE_POOL_SIZE = 32;

/** Read LORE_LANCE_POOL_SIZE, clamp + fall back to default. Exported
 *  so tests and the verbatim-store constructor compute the same value
 *  the pool ultimately uses. */
export function resolveLancePoolSize(envValue: string | undefined = process.env.LORE_LANCE_POOL_SIZE): number {
    if (envValue === undefined || envValue === '') return DEFAULT_LANCE_POOL_SIZE;
    const parsed = Number.parseInt(envValue, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_LANCE_POOL_SIZE;
    return Math.max(MIN_LANCE_POOL_SIZE, Math.min(MAX_LANCE_POOL_SIZE, parsed));
}

/**
 * Safety net (NW-1c, supersedes the pool-local handler):
 * @lancedb/lancedb is a native NAPI-RS binding and a misuse could
 * surface as a native-side crash that bypasses normal try/catch
 * (e.g. an async callback firing after a Table is mid-close).
 *
 * The handler-install has moved to the shared `nativePoolSafetyNet`
 * module so the Kùzu and Lance pools share ONE listener pair under ONE
 * policy. The policy is SURVIVE — log via the structured logger and
 * keep the daemon alive (matches the SW-19 / E1b daemon-resilience
 * contract). Previously this pool installed its own listener that
 * called `process.exit(1)`; because Node fires every registered
 * uncaughtException listener, that exit silently defeated the survive
 * policy whenever both pools were loaded together. See
 * nativePoolSafetyNet.ts for the full policy + history. (Audit
 * findings: conc-dual-safety-net-exit, err-contradictory-uncaught-handlers.)
 */

/** Test-only hooks for the safety-net idempotency contract. Re-exported
 *  from the shared module so existing imports keep working. */
export function __resetLanceSafetyNetForTests(): void {
    __resetNativePoolSafetyNetForTests();
}
export function __isLanceSafetyNetInstalledForTests(): boolean {
    return __isNativePoolSafetyNetInstalledForTests();
}

export class LanceTablePool {
    private readonly tables: Table[] = [];
    private readonly idle: Table[] = [];
    private readonly waiters: Waiter[] = [];
    private closed = false;
    private nativeClosed = false;
    // NW-1e — count of borrowed Tables (acquired but not yet released).
    // `drain()` waits until this hits zero before native close, to
    // avoid use-after-close on a Table mid-vectorSearch.
    private inFlight = 0;
    private drainPromise: Promise<void> | null = null;
    private drainResolve: (() => void) | null = null;
    private initPromise: Promise<void> | null = null;
    private initialized = false;
    public readonly size: number;

    private readonly maxWaiters: number | undefined;
    private readonly acquireTimeoutMs: number | undefined;

    constructor(
        private readonly connection: Connection,
        private readonly tableName: string,
        size: number = DEFAULT_LANCE_POOL_SIZE,
        options?: { maxWaiters?: number; acquireTimeoutMs?: number },
    ) {
        // TW-2b — OPT-IN: no-op unless the process owner armed the net (daemon
        // path). Embedded createLore() never arms it, so this pool attaches NO
        // process-global handlers to a host it doesn't own. Per-pool drain/reopen
        // resilience (NW-1c) is unchanged regardless of the global gate.
        installNativePoolSafetyNet();
        this.size = Math.max(MIN_LANCE_POOL_SIZE, Math.min(MAX_LANCE_POOL_SIZE, Math.trunc(size)));
        this.maxWaiters = options?.maxWaiters;
        this.acquireTimeoutMs = options?.acquireTimeoutMs;
    }

    /** Open N Table handles in parallel. Safe to call concurrently —
     *  the second caller awaits the first's initPromise. Must be
     *  called before acquire/withTable. Throws if the underlying table
     *  doesn't exist; callers (VerbatimStore) should swallow that and
     *  treat the pool as unavailable, same way they handle a missing
     *  single-handle today. */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._initializeOnce()
            .then(() => { this.initialized = true; })
            .finally(() => { this.initPromise = null; });
        return this.initPromise;
    }

    private async _initializeOnce(): Promise<void> {
        const opened = await Promise.all(
            Array.from({ length: this.size }, () => this.connection.openTable(this.tableName)),
        );
        for (const t of opened) {
            this.tables.push(t);
            this.idle.push(t);
        }
    }

    /** Acquire one Table handle. Resolves immediately if idle;
     *  otherwise queues FIFO. Rejects if the pool is closed before a
     *  handle becomes free. */
    acquire(): Promise<Table> {
        if (this.closed) {
            return Promise.reject(new Error('LanceTablePool: pool is closed'));
        }
        if (!this.initialized) {
            return Promise.reject(new Error('LanceTablePool: not initialized — call initialize() first'));
        }
        const t = this.idle.shift();
        if (t) {
            // NW-1e — bump in-flight only on the idle-list path. The
            // waiter path keeps net inFlight unchanged (borrow handed
            // off in release()).
            this.inFlight += 1;
            return Promise.resolve(t);
        }
        if (this.maxWaiters !== undefined && this.waiters.length >= this.maxWaiters) {
            return Promise.reject(new PoolExhaustedError(
                `LanceTablePool: waiter queue full (${this.waiters.length}/${this.maxWaiters})`,
            ));
        }
        return new Promise<Table>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject };
            this.waiters.push(waiter);
            if (this.acquireTimeoutMs !== undefined) {
                waiter.timer = setTimeout(() => {
                    const idx = this.waiters.indexOf(waiter);
                    if (idx !== -1) this.waiters.splice(idx, 1);
                    reject(new PoolAcquireTimeoutError(
                        `LanceTablePool: acquire timed out after ${this.acquireTimeoutMs}ms`,
                    ));
                }, this.acquireTimeoutMs);
                waiter.timer.unref?.();
            }
        });
    }

    /** Return a Table handle to the pool. Hand directly to a waiter
     *  if queued; otherwise push to idle. No-op after close — but the
     *  in-flight count is still decremented so drain() observes it. */
    release(table: Table): void {
        if (this.closed) {
            if (this.inFlight > 0) this.inFlight -= 1;
            if (this.inFlight === 0 && this.drainResolve) {
                const r = this.drainResolve;
                this.drainResolve = null;
                r();
            }
            return;
        }
        const waiter = this.waiters.shift();
        if (waiter) {
            // Borrow transferred — no net inFlight change.
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve(table);
            return;
        }
        if (this.inFlight > 0) this.inFlight -= 1;
        this.idle.push(table);
    }

    /** Acquire → optionally refresh → run → release. The
     *  `refreshLatest` flag calls `Table.checkoutLatest()` before
     *  invoking `fn` so the pooled handle observes writes that may
     *  have landed on the on-disk table since it was opened. Default
     *  true for read-correctness in the recall hot path; tests can
     *  pass false to measure raw vectorSearch cost without the
     *  refresh tax. */
    async withTable<T>(
        fn: (table: Table) => Promise<T>,
        refreshLatest: boolean = true,
    ): Promise<T> {
        const table = await this.acquire();
        try {
            if (refreshLatest) {
                // checkoutLatest is a cheap metadata read in the
                // common case (manifest pointer unchanged). It must
                // run on the acquired handle so the subsequent fn()
                // sees the same snapshot we just refreshed to.
                await table.checkoutLatest();
            }
            return await fn(table);
        } finally {
            this.release(table);
        }
    }

    available(): number { return this.idle.length; }
    waitingCount(): number { return this.waiters.length; }
    /** NW-1e — currently-borrowed Table count. Observability + drain
     *  accounting. */
    inFlightCount(): number { return this.inFlight; }

    /**
     * NW-1e — Drain the pool: stop issuing new borrows, then await
     * every in-flight borrow to be released. Returns the number of
     * still-outstanding borrows when it returns (zero on clean drain,
     * > 0 if the timeout fired). The closed flag stays set so the pool
     * will never hand out another Table after this.
     *
     * Default timeout = DEFAULT_POOL_DRAIN_TIMEOUT_MS (5s). On timeout
     * a warning is logged with the still-outstanding count; the
     * daemon is NOT crashed — the caller proceeds to close natives as
     * a best-effort. See audit `conc-close-does-not-drain-inflight-reads`.
     */
    async drain(timeoutMs: number = DEFAULT_POOL_DRAIN_TIMEOUT_MS): Promise<number> {
        if (!this.closed) {
            this.closed = true;
            const drained = this.waiters.splice(0, this.waiters.length);
            for (const w of drained) {
                if (w.timer) clearTimeout(w.timer);
                w.reject(new Error('LanceTablePool: closed during acquire'));
            }
        }
        if (this.inFlight === 0) return 0;
        if (!this.drainPromise) {
            this.drainPromise = new Promise<void>((resolve) => {
                this.drainResolve = resolve;
            });
        }
        let timer: NodeJS.Timeout | null = null;
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const result = await Promise.race([
            this.drainPromise.then(() => 'drained' as const),
            timeout,
        ]);
        if (timer) clearTimeout(timer);
        if (result === 'timeout') {
            log.warn('LanceTablePool: drain timed out — proceeding to close with in-flight borrows', {
                inFlight: this.inFlight,
                timeoutMs,
            });
            return this.inFlight;
        }
        return 0;
    }

    /** Close all pooled tables and reject queued waiters. Drains
     *  in-flight borrows first (see drain()) so we never close a
     *  Table mid-vectorSearch — that was a documented native
     *  use-after-close on darwin-arm64 (audit:
     *  conc-close-does-not-drain-inflight-reads). Idempotent. */
    async close(timeoutMs: number = DEFAULT_POOL_DRAIN_TIMEOUT_MS): Promise<void> {
        if (this.nativeClosed) return;
        await this.drain(timeoutMs);
        this.nativeClosed = true;
        // Table.close is synchronous (returns void). Errors are
        // swallowed — close is best-effort shutdown, not a place to
        // surface mid-shutdown anomalies.
        for (const t of this.tables) {
            try { t.close(); } catch { /* ignore */ }
        }
    }
}
