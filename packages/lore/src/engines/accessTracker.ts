/**
 * accessTracker.ts — Debounced read-access accumulator (maintain coldness).
 *
 * Problem: stamping a per-node access time on every read is a write-on-read.
 * Done naively through upsertNode it would (a) bump the read-cache epoch and
 * invalidate the recall cache on every recall, and (b) reset syncedAt /
 * updatedAt and trigger re-sync + re-embed. Both are unacceptable on the hot
 * path.
 *
 * Solution: handlers call `touch(ids, source)` — an O(1) in-memory Map insert,
 * no I/O. A background timer (or a manual flush) drains the accumulator and
 * writes all pending stamps in ONE batched pass via `stampAccessTimes`, which
 * bypasses the epoch and the sync/embed triggers. Read volume no longer maps
 * to write volume: N reads in an interval collapse to ≤1 batched write.
 *
 * `source`:
 *   - 'read'      any read (recall internal hydration, getNode, traverse,
 *                 graph-view topology). Sets lastAccessedAt only.
 *   - 'retrieval' intentional retrieval (recall/search/get_full results).
 *                 Sets lastAccessedAt AND last_retrieved_at. `maintain`'s
 *                 default cold_signal='retrieval' trusts this clock so that
 *                 merely browsing the graph never saves a node from cleanup.
 *
 * Cache visibility: because the flush deliberately does NOT bump the read-
 * cache epoch (that's the whole point — reads must not invalidate the recall
 * cache), a freshly-stamped access time is not visible to a cached getNode/
 * listNodes until that entry's TTL lapses or a real write bumps the epoch.
 * This staleness is bounded (cache TTL, default 60s) and irrelevant to the
 * only consumer — nightly `lore maintain` retention, which is coarse by days.
 *
 * Crash semantics: the accumulator is in-memory; an unflushed interval is
 * lost on hard crash. Access time is an approximate signal, so this is
 * acceptable. A best-effort `beforeExit` flush (registered in start())
 * narrows loss on a clean idle exit; a hard SIGKILL still loses ≤1 interval.
 */

export type AccessSource = 'read' | 'retrieval';

/** Minimal graph surface the tracker needs (LocalGraph implements it). */
export interface AccessStampTarget {
    stampAccessTimes(
        entries: Array<{ id: string; accessedAt: string; retrievedAt?: string }>,
    ): Promise<number>;
}

interface Pending {
    accessedAt: string;
    /** Set only when the node was retrieved (not merely browsed) this window. */
    retrievedAt?: string;
}

export class AccessTracker {
    private pending = new Map<string, Pending>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private flushing = false;
    /**
     * NW-7g (conc-accesstracker-stop-flush-skipped): in-flight flush handle.
     * `flush()` already snapshots+clears the accumulator up front so a touch()
     * during the await isn't lost from the NEXT flush. But `flush()`'s
     * single-flight guard (`if (this.flushing) return 0`) makes a concurrent
     * call a no-op, including the one from `stop()`. Result: on shutdown,
     * stamps that arrived AFTER the in-flight flush snapshot were left in
     * `this.pending` and never written. The shutdown handler returned 0 with
     * no flush actually happening for them.
     *
     * Fix: track the in-flight promise so stop() can await it AND then run
     * one more flush to drain whatever accumulated during the await.
     */
    private flushPromise: Promise<number> | null = null;
    /**
     * TW-7e (err-accesstracker-beforeexit-leak-embedded): handle on the
     * process-global `beforeExit` listener so stop()/dispose() can REMOVE it.
     * The old code registered an anonymous `process.once('beforeExit', …)` that
     * dispose() never cleaned up — in embedded mode (the tracker lives in the
     * HOST process) that left a permanent listener on the host after the Lore
     * instance was disposed, violating the TW-2b no-host-pollution rule. Now
     * the listener is (a) registered ONLY when the tracker is daemon-owned and
     * (b) always removable via process.off in stop(). Null when not registered.
     */
    private beforeExitListener: (() => void) | null = null;

    constructor(
        private readonly target: AccessStampTarget,
        private readonly opts: { intervalMs?: number; now?: () => number; registerBeforeExit?: boolean } = {},
    ) {}

    private nowIso(): string {
        const ms = this.opts.now ? this.opts.now() : Date.now();
        return new Date(ms).toISOString();
    }

    /** Record access for one or more node ids. Cheap; never throws. */
    touch(ids: string | string[], source: AccessSource): void {
        const list = Array.isArray(ids) ? ids : [ids];
        const ts = this.nowIso();
        for (const id of list) {
            if (!id) continue;
            const cur = this.pending.get(id) ?? { accessedAt: ts };
            cur.accessedAt = ts;
            if (source === 'retrieval') cur.retrievedAt = ts;
            this.pending.set(id, cur);
        }
    }

    /** Number of distinct node ids awaiting flush (for diagnostics/tests). */
    pendingCount(): number {
        return this.pending.size;
    }

    /** Drain the accumulator and write all pending stamps in one batch. */
    async flush(): Promise<number> {
        if (this.flushing || this.pending.size === 0) return 0;
        this.flushing = true;
        // Snapshot + clear up front so touches during the await aren't lost.
        const batch = [...this.pending.entries()].map(([id, p]) => ({
            id,
            accessedAt: p.accessedAt,
            ...(p.retrievedAt ? { retrievedAt: p.retrievedAt } : {}),
        }));
        this.pending.clear();
        // NW-7g — publish the in-flight promise so stop() can await it.
        const p = (async () => {
            try {
                return await this.target.stampAccessTimes(batch);
            } catch (err) {
                console.error(`[accessTracker] flush failed (${batch.length} pending dropped): ${(err as Error).message}`);
                return 0;
            } finally {
                this.flushing = false;
                this.flushPromise = null;
            }
        })();
        this.flushPromise = p;
        return await p;
    }

    /** Start the periodic flush timer. Idempotent. */
    start(): void {
        if (this.timer) return;
        const interval = this.opts.intervalMs ?? 60_000;
        this.timer = setInterval(() => { void this.flush(); }, interval);
        // Don't keep the event loop alive solely for access flushing.
        if (typeof this.timer.unref === 'function') this.timer.unref();
        // TW-7e — best-effort graceful flush when the loop drains, but ONLY
        // when daemon-owned. In embedded mode the tracker runs inside the host
        // process, so a permanent `beforeExit` listener would outlive the
        // disposed Lore instance and pollute the host (TW-2b violation). The
        // daemon opts in via `registerBeforeExit: true`; we keep the handle so
        // stop()/dispose() can remove it. (The flush-on-stop path below still
        // narrows interval loss on a clean shutdown in BOTH modes.)
        if (this.opts.registerBeforeExit && !this.beforeExitListener) {
            const listener = (): void => { void this.flush(); };
            this.beforeExitListener = listener;
            process.on('beforeExit', listener);
        }
    }

    /** Stop the timer and flush any remaining stamps (call on shutdown).
     *
     * NW-7g (conc-accesstracker-stop-flush-skipped): if a flush was already
     * in flight when stop() was called, the old code's `await this.flush()`
     * short-circuited (single-flight guard returns 0) and any stamps
     * accumulated DURING that in-flight flush were never persisted. Now we:
     *   1. await any in-flight flush so its snapshot completes,
     *   2. run one MORE flush to drain whatever touched-during-await.
     *
     * Two flushes is the worst case; the second is cheap if no new stamps
     * arrived (early-return on `pending.size === 0`).
     */
    async stop(): Promise<void> {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        // TW-7e — remove the process-global beforeExit listener (if the daemon
        // registered one) so dispose() leaves the host's listener set unchanged.
        if (this.beforeExitListener) {
            process.off('beforeExit', this.beforeExitListener);
            this.beforeExitListener = null;
        }
        // Step 1: drain any in-flight flush.
        if (this.flushPromise) {
            try { await this.flushPromise; } catch { /* error already logged in flush() */ }
        }
        // Step 2: flush anything that arrived since the snapshot.
        await this.flush();
    }
}

/* ─── Process-wide singleton ─────────────────────────────────────────
 * Read handlers call ensureAccessTracker(graph)?.touch(...) — the tracker is
 * created + started lazily on the first retrieval (no boot wiring, so the
 * daemon's giant server.ts is untouched). Null in cloud mode (no
 * stampAccessTimes) and before first use, so non-daemon unit tests are
 * unaffected. getAccessTracker() returns the current instance (or null).
 */
let singleton: AccessTracker | null = null;

// R3 #3 — one AccessTracker PER target graph, keyed by graph identity. The old
// process-wide `singleton` bound to the FIRST graph ensureAccessTracker ever saw
// and returned it regardless of the target, so a recall/search against a
// NON-active workspace stamped last_retrieved_at / lastAccessedAt onto the BOOT
// graph — corrupting the coldness/retention signal `lore maintain` prunes on
// (acutely on id reuse across one human's workspaces). A per-graph map routes
// each stamp to its own workspace's graph store. WeakMap so an evicted graph's tracker
// is GC'd with it.
const trackers = new WeakMap<object, AccessTracker>();

export function setAccessTracker(tracker: AccessTracker | null): void {
    singleton = tracker;
}

export function getAccessTracker(): AccessTracker | null {
    return singleton;
}

/**
 * ensureAccessTracker — Lazily create + start the singleton on first use,
 * bound to the active workspace graph. Read handlers call this instead of
 * boot-wiring the tracker (keeps the daemon's giant server.ts untouched).
 *
 * Feature-detects `stampAccessTimes`: in cloud mode the DataplaneGraph lacks
 * it (access coldness is a local-disk capacity concern), so this is a no-op
 * and returns null. Idempotent — subsequent calls return the existing
 * singleton regardless of the target passed.
 */
export function ensureAccessTracker(target: unknown): AccessTracker | null {
    const t = target as Partial<AccessStampTarget> | null | undefined;
    if (!t || typeof t.stampAccessTimes !== 'function') return null;
    // Per-graph: return THIS graph's tracker (create on first use), not a
    // first-seen singleton — so the stamp lands on the workspace being read.
    const key = t as object;
    const existing = trackers.get(key);
    if (existing) return existing;
    const flushMs = Number(process.env['LORE_ACCESS_FLUSH_MS'] ?? '60000');
    const tracker = new AccessTracker(t as AccessStampTarget, {
        intervalMs: Number.isFinite(flushMs) && flushMs > 0 ? flushMs : 60_000,
        // TW-7e — lazy ensure path runs in BOTH daemon and embedded (host)
        // processes; it cannot tell them apart, and neither drain calls
        // tracker.stop(). A process-global `beforeExit` listener here would leak
        // into the host on every embedded recall/search (TW-2b violation). The
        // timer is unref'd and stop() flushes, so skipping the beforeExit hook
        // only forgoes a best-effort idle-exit flush (≤1 interval) — acceptable
        // per this file's own crash-semantics note. Daemon boot wiring that
        // wants the hook can construct an AccessTracker with
        // `registerBeforeExit: true` and own its stop().
        registerBeforeExit: false,
    });
    tracker.start();
    trackers.set(key, tracker);
    singleton = tracker; // back-compat for get/setAccessTracker (unused today)
    return tracker;
}

/**
 * re-audit 2026-06-25 (concurrency) — stop + drop a graph's tracker when the
 * registry closes/evicts that graph. The lazily-created per-graph interval timer
 * otherwise OUTLIVES the graph: it pins a ref to the closed LocalGraph, its
 * flush perpetually fails against a closed pool, and every access/retrieval
 * stamp for the evicted (non-active) workspace is dropped. Call right after
 * graph.close() in the registry's eviction/close/dispose paths. Idempotent
 * (no-op when the graph has no tracker, e.g. it was never read).
 */
export async function disposeAccessTracker(target: unknown): Promise<void> {
    const key = target as object | null | undefined;
    if (!key) return;
    const tracker = trackers.get(key);
    if (!tracker) return;
    trackers.delete(key);
    if (singleton === tracker) singleton = null;
    await tracker.stop(); // flushes any pending stamps, clears the interval + beforeExit hook
}
