/**
 * verbatimWriteBarrier.ts - application-level write barrier for in-process SQLite verbatim writers.
 *
 * 3.35.3 review finding F1. Verbatim promotion (SQLite -> LanceDB) must, at the very end, see a
 * SQLite file that nothing wrote to between "Lance equals SQLite" and the rename that retires it.
 * Without a barrier the final gate races a busy writer forever: every catch-up round leaves a new
 * delta behind, so the gate's `max(seq)` re-check keeps failing. With a barrier the in-process
 * writers of ONE workspace are parked for a short, bounded window while the (small) tail is
 * copied and the gate commits.
 *
 *   - Writers QUEUE, they never fail: `withWriteBarrier` awaits the gate and then runs.
 *   - `raiseWriteBarrier` first waits (bounded by `drainMs`) for writes already in flight to finish
 *     (a `store()` can be mid-embedding); if they do not drain it lowers the barrier and returns
 *     null so the caller backs off instead of stalling anyone.
 *   - The hold is bounded: a timer lowers the barrier `holdMs` after it was raised even if the
 *     promotion forgot to (a crash, a hang). Correctness never depends on the barrier alone: the
 *     gate re-checks `max(seq)` inside `BEGIN EXCLUSIVE`, so a write that slips through (barrier
 *     expired, a write from ANOTHER process) only makes the gate retry, never lose data.
 *   - Keyed by resolved base path, so two store instances on one workspace share the barrier.
 *
 * It covers every in-process vector write because SqliteVerbatimStore routes all eight write
 * methods (store, storeBatch, bulkAddPrebuiltRows, bulkUpsertPrebuiltRows, physicalDelete,
 * physicalDeleteMany, purgeWithHistory, tombstone) through `withWriteBarrier`. Offline CLI tools
 * (reclaim, repair) are other processes and are handled by the gate's re-check and lock retry.
 *
 * COMMIT RETIRES THE BARRIER. When the promotion commits, the SQLite file the parked writers are
 * about to write to has just been renamed away (the store keeps an fd to the retired file until the
 * resolver swaps it for the Lance store). Letting them resume would silently lose exactly the writes
 * the barrier parked, so `retire()` rejects them with `VerbatimStoreRetiredError` instead (nothing
 * was applied; SqliteVerbatimStore replays them on the promoted store, see verbatimRetiredRetry.ts). Writes arriving later on the old
 * store instance are rejected too (D1): see `retireGenerations`.
 *
 * Do not nest `withWriteBarrier` calls: an inner call parked behind a raised barrier would keep its
 * outer call "in flight" until the drain timeout lowers the barrier.
 */
import * as path from 'node:path';

/** Thrown to a write that was parked behind the barrier when the promotion COMMITTED. Nothing was applied. */
export class VerbatimStoreRetiredError extends Error {
    /** Always false: the write was rejected BEFORE it ran, so replaying it on the promoted store cannot double-apply. */
    readonly applied = false as const;
    constructor(basePath: string) {
        super(`[verbatimWriteBarrier] ${basePath} was promoted from SQLite to LanceDB while this write was waiting; it was NOT applied - retry it against the promoted store`);
        this.name = 'VerbatimStoreRetiredError';
    }
}

/** True for a {@link VerbatimStoreRetiredError} (also across module copies, by name). Transient: retry the write. */
export function isVerbatimStoreRetiredError(err: unknown): boolean {
    return err instanceof VerbatimStoreRetiredError || (err as { name?: unknown } | null | undefined)?.name === 'VerbatimStoreRetiredError';
}

type BarrierOutcome = 'open' | 'retired';

interface BarrierState {
    inflight: number;
    raised: boolean;
    /** Resolves when the barrier is lowered; writers parked behind it await this. */
    opened: Promise<BarrierOutcome>;
    open: (outcome: BarrierOutcome) => void;
    drainWaiters: Array<() => void>;
}

const states = new Map<string, BarrierState>();

/**
 * Per-path count of committed promotions (`retire()` calls). It outlives the barrier state on purpose: a store
 * instance opened BEFORE the promotion still holds an fd to the renamed-away SQLite file, and a write arriving
 * AFTER the commit (not parked, so not rejected by `retire()`) used to land in that dead file and vanish. Instances
 * remember the generation they opened under; `withWriteBarrier` rejects a writer whose generation is behind.
 */
const retireGenerations = new Map<string, number>();

/** Number of promotions that committed for this path so far (0 if none). */
export function currentRetireGeneration(basePath: string): number {
    return retireGenerations.get(path.resolve(basePath)) ?? 0;
}

function stateFor(key: string): BarrierState {
    let s = states.get(key);
    if (!s) {
        s = { inflight: 0, raised: false, opened: Promise.resolve<BarrierOutcome>('open'), open: () => undefined, drainWaiters: [] };
        states.set(key, s);
    }
    return s;
}

function gc(key: string, s: BarrierState): void {
    if (s.inflight === 0 && !s.raised && s.drainWaiters.length === 0) states.delete(key);
}

/** Run a write so a raised barrier parks it first and a raise can wait for it to finish. */
export async function withWriteBarrier<T>(basePath: string, fn: () => Promise<T> | T): Promise<T>;
/** `generation` is the {@link currentRetireGeneration} the caller opened under; a newer one throws VerbatimStoreRetiredError (nothing applied). */
export async function withWriteBarrier<T>(basePath: string, generation: number, fn: () => Promise<T> | T): Promise<T>;
export async function withWriteBarrier<T>(basePath: string, a: number | (() => Promise<T> | T), b?: () => Promise<T> | T): Promise<T> {
    const generation = typeof a === 'number' ? a : undefined;
    const fn = (typeof a === 'number' ? b : a) as () => Promise<T> | T;
    const key = path.resolve(basePath);
    const stale = (): boolean => generation !== undefined && (retireGenerations.get(key) ?? 0) > generation;
    if (stale()) throw new VerbatimStoreRetiredError(key);
    let s = stateFor(key);
    while (s.raised) {
        if ((await s.opened) === 'retired') throw new VerbatimStoreRetiredError(key);
        s = stateFor(key); // the entry may have been collected and recreated while we waited
    }
    if (stale()) throw new VerbatimStoreRetiredError(key);
    s.inflight++;
    try {
        return await fn();
    } finally {
        s.inflight--;
        if (s.inflight === 0) {
            const waiters = s.drainWaiters;
            s.drainWaiters = [];
            for (const w of waiters) w();
        }
        gc(key, s);
    }
}

export interface WriteBarrierHandle {
    /** Epoch ms after which the barrier is lowered automatically. */
    readonly deadline: number;
    /** True while writers are still parked (false once released or expired). */
    isHeld(): boolean;
    /** Idempotent. */
    release(): void;
    /** The promotion committed: reject the parked writers (nothing applied) instead of resuming them. Idempotent with release(). */
    retire(): void;
}

export interface RaiseOptions {
    /** Maximum time writers stay parked once the barrier is up. Default 2000. */
    holdMs?: number;
    /** Maximum time to wait for writes already in flight. Default 1000. */
    drainMs?: number;
}

export const DEFAULT_BARRIER_HOLD_MS = 2000;
export const DEFAULT_BARRIER_DRAIN_MS = 1000;

/**
 * Park new writers for `basePath` and wait for in-flight ones to finish. Returns null (barrier
 * already lowered) when they do not drain within `drainMs`.
 */
export async function raiseWriteBarrier(basePath: string, opts: RaiseOptions = {}): Promise<WriteBarrierHandle | null> {
    const holdMs = opts.holdMs ?? DEFAULT_BARRIER_HOLD_MS;
    const drainMs = opts.drainMs ?? DEFAULT_BARRIER_DRAIN_MS;
    const key = path.resolve(basePath);
    const s = stateFor(key);
    if (s.raised) throw new Error(`[verbatimWriteBarrier] a barrier is already raised for ${key}`);
    s.raised = true;
    s.opened = new Promise<BarrierOutcome>((resolve) => { s.open = resolve; });

    let timer: NodeJS.Timeout | undefined;
    let held = true;
    const lower = (outcome: BarrierOutcome): void => {
        if (!held) return;
        held = false;
        if (timer) clearTimeout(timer);
        s.raised = false;
        s.open(outcome);
        gc(key, s);
    };
    const release = (): void => lower('open');
    let retiredOnce = false;
    const retire = (): void => {
        // Bump even when the hold already expired: the commit happened regardless of the barrier state.
        if (!retiredOnce) { retiredOnce = true; retireGenerations.set(key, (retireGenerations.get(key) ?? 0) + 1); }
        lower('retired');
    };

    if (s.inflight > 0) {
        const drained = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => {
                const i = s.drainWaiters.indexOf(onDrained);
                if (i >= 0) s.drainWaiters.splice(i, 1);
                resolve(false);
            }, drainMs);
            const onDrained = (): void => { clearTimeout(t); resolve(true); };
            s.drainWaiters.push(onDrained);
        });
        if (!drained) { release(); return null; }
    }

    const deadline = Date.now() + holdMs;
    // Not unref'd: parked writers are bare promises, and the auto-release is what resumes them if the
    // promotion hangs. It is cleared on release, so it keeps the process alive for at most holdMs.
    timer = setTimeout(release, holdMs);
    return { deadline, isHeld: () => held, release, retire };
}

/** Test seam: number of workspaces with live barrier state (0 when idle). */
export function writeBarrierStateCount(): number {
    return states.size;
}
