/**
 * pendingAutolink.ts — in-flight tracking for the ingest-time autolink hook.
 *
 * `nodeService.nodeUpsert` fires `reconnectOneNode` WITHOUT awaiting it, and
 * that is deliberate — not an oversight. Autolink costs one extra ONNX embed
 * plus a vector search per node (see `bulkIngest.ts`'s header: trickle-ingest
 * "is tuned for UX ... autolink fires per-node so the graph stays connected
 * as knowledge accumulates, and embed is async so the UI returns quickly").
 * Awaiting it inline would put a similarity search on the synchronous write
 * path of every single node write — the exact regression bulkIngest exists to
 * avoid. So the hook stays async.
 *
 * What was missing is the other half of that bargain: nothing tracked the
 * fired promises, so a caller that wrote a burst of nodes and then called
 * `dispose()` raced them. The drain closed the graph store + LanceDB (shutdownDrain step
 * 10) while reconnect writes were still in flight, and those writes died
 * against closed handles inside `reconnectOneNode`'s own `catch { }` — edges
 * silently missing, with no signal to the caller that anything was dropped.
 * This is the same use-after-close race L-008 fixed for `migrateV1Sqlite`
 * (test/v1-migration-reconnect-await-unit.ts); that path could simply await
 * inline because it is a batch import, whereas this one cannot.
 *
 * The fix mirrors `backgroundReconnect.ts`: keep a handle on the in-flight
 * work and let the ordered shutdown drain await it before substrate handles
 * close. Unlike that module, autolink can have MANY hooks in flight at once
 * (one per node in a burst), so this tracks a set rather than a single
 * promise.
 *
 * ─── Three properties this module is REQUIRED to have (round 2) ───────────
 *
 * 1. PER-INSTANCE, not module-global. The first cut kept one module-level
 *    `Set` shared by every `createLore()` in the process, so instance A's
 *    dispose() waited on instance B's autolinks — and a hook wedged in B
 *    could hold A's dispose open. The tracker is now an OBJECT
 *    (`PendingAutolinkTracker`) carried on the StorageBundle, i.e. one per
 *    Lore instance, threaded to every autolink call site through
 *    `AutolinkHandles.tracker` (a REQUIRED field, so tsc — not a reviewer —
 *    catches a site that forgets it). `defaultAutolinkTracker` remains for
 *    direct/test callers; production never lands there.
 *
 *    The four hook-construction sites are `mcp/bulkIngest.ts`, `mcp/server.ts`
 *    (×2 — the HTTP node-write and bulk-write orchestration) and
 *    `mcp/tools/memory/storeNode.ts`; `engines/v1Migration.ts` registers
 *    directly. `grep -n 'autolink:' packages/lore/src` is the check. The plain
 *    HTTP node route (`http/routes/nodes/postNode.ts`) is NOT one of them and
 *    never was — it passes only `{ outboxStore, verbatim }` and its own
 *    comment says "REST has no WAL / version / autolink / async_embed paths".
 *    Naming it here (as an earlier draft of this header and of
 *    `StorageBundle.autolinkTracker` both did) is not a harmless inaccuracy in
 *    a module whose entire purpose is coverage: it invites the next reader to
 *    believe a surface is covered when it fires no hook at all.
 *
 * 2. BOUNDED drain. `drain()` takes a deadline and returns rather than
 *    hanging. The previous `while (pending.size > 0)` loop had none, and its
 *    docstring's claim that "the shutdown coordinator's hard timeout is the
 *    backstop" was FALSE for the embedded path — `mcp/lifecycle.ts`
 *    `makeDispose` deliberately never enters the coordinator (its own comment
 *    says so), so one autolink stuck behind SearchGate hung `dispose()`
 *    forever in exactly the deployment mode the original bug was reported in.
 *    Same bounded-vs-perfect tradeoff `shutdownDrain` step 5 already makes for
 *    the embed queue, and the same 5s order of magnitude.
 *
 * 3. SEALING closes the register-after-drain race. Registration is
 *    synchronous with the call, so there is no gap THERE — but nothing
 *    stopped an already-in-flight write (an unawaited embedded `store()`, or
 *    an HTTP request `server.close()` is letting finish) from registering a
 *    NEW autolink AFTER the drain step ran empty, which then died against the
 *    handles closed moments later. You cannot wait for producers you do not
 *    control; you CAN refuse to start new best-effort work once shutdown has
 *    begun. `seal()` runs at the TOP of the drain; `nodeUpsert` checks
 *    `isSealed()` and skips firing autolink at all. The check and the
 *    `track()` are in one synchronous block, so a write is unambiguously
 *    either tracked-and-awaited or never-started. The node's own graph +
 *    verbatim writes are unaffected — only the best-effort edge inference is
 *    skipped, which is what a late-arriving write during shutdown should do.
 *
 * License: original work for groundfloor-lore.
 */

/** Default ceiling on the autolink drain, mirroring `shutdownDrain` step 5's
 *  embed-queue cap. A wedged hook delays shutdown by at most this. */
export const DEFAULT_AUTOLINK_DRAIN_TIMEOUT_MS = 5000;

/**
 * Default ceiling on the LONG-SWEEP drain — a separate budget for a separate
 * workload, and the reason there are two trackers rather than one.
 *
 * The operator-initiated `/api/graph/reconnect` + `/api/graph/reconsume`
 * sweeps were registered on the INGEST-autolink tracker. Three things went
 * wrong at once, none of them visible in a test:
 *
 *   1. `reconnectGraph` re-embeds and searches the whole corpus and runs for
 *      MINUTES, so it could never finish inside the ingest tracker's 5s. The
 *      drain timed out and step 10 closed the graph store + LanceDB underneath the
 *      still-running sweep — the exact use-after-close the registration was
 *      added to prevent. Drain-VISIBLE is not drain-PROTECTED.
 *   2. The timeout log talks about "ingest autolink hook(s) ... their
 *      semantic_neighbor edges may be missing", which is the wrong subject
 *      entirely for an operator who just called /api/graph/reconnect.
 *   3. Every shutdown that happened to overlap a sweep stalled the full 5s,
 *      because one queue now mixed sub-second hooks with multi-minute sweeps.
 *
 * The deadline is larger than the ingest one but still BOUNDED, and it is only
 * ever reached if a sweep ignores its `shouldAbort` — the sweeps poll it at
 * every page boundary and every search chunk, so the normal path is a fast,
 * clean stop well inside this budget.
 */
export const DEFAULT_SWEEP_DRAIN_TIMEOUT_MS = 30_000;

/** Outcome of a bounded drain — `abandoned` is how many hooks were STILL in
 *  flight when the deadline expired (0 on a clean drain). */
export interface AutolinkDrainOutcome {
    timedOut: boolean;
    abandoned: number;
}

/**
 * One Lore instance's in-flight autolink registry. Construct one per
 * `createLore()` (it lives on the StorageBundle) so a hook wedged in one
 * instance cannot hold a different instance's dispose() open.
 */
export class PendingAutolinkTracker {
    /** Settled-normalised handles on the autolink hooks currently in flight.
     *  Every entry is already `.catch`-neutralised, so awaiting the set can
     *  never surface an autolink error into the drain. */
    private readonly pending = new Set<Promise<void>>();
    private sealed = false;

    /**
     * Register an in-flight autolink hook so the shutdown drain can await it.
     *
     * Takes the promise the caller already built (with its own error logging
     * attached) and stores a settle-only view of it — the tracker never
     * changes whether an autolink failure is logged, only whether it is
     * WAITED for.
     */
    track(p: Promise<unknown>): void {
        const settled = p.then(() => undefined, () => undefined);
        this.pending.add(settled);
        void settled.finally(() => { this.pending.delete(settled); });
    }

    /**
     * Start `work()` — but only if shutdown has not begun — and register the
     * resulting promise so the drain awaits it. Returns `null` when sealed, so
     * the caller can tell its own user (an HTTP 503, a skipped hook) instead of
     * launching work that is guaranteed to write into closing handles.
     *
     * The check and the `track()` are in ONE synchronous block, which is the
     * whole point: a caller that reads `isSealed()` itself, awaits something,
     * and only then starts the work has reopened the race this closes. Use
     * this for any AWAITED-but-long reconnect that runs inside a request
     * (`http/routes/ingestion.ts` reconnect/reconsume): those are covered by
     * neither `backgroundReconnect`'s own drain nor `nodeUpsert`'s hook, so
     * before this they were the one reconnect path the ordered shutdown could
     * not see. The returned promise is the ORIGINAL — rejections still reach
     * the caller; the tracker only ever holds a settle-only view.
     */
    runTracked<T>(work: () => Promise<T>): Promise<T> | null {
        if (this.sealed) return null;
        const p = work();
        this.track(p);
        return p;
    }

    /** How many autolink hooks are currently in flight. Test/diagnostic hook. */
    count(): number {
        return this.pending.size;
    }

    /** True once the shutdown drain has begun. Callers MUST consult this
     *  before constructing a new autolink promise (see the module header,
     *  property 3) — not after, or the doomed work has already started. */
    isSealed(): boolean {
        return this.sealed;
    }

    /** Refuse new registrations. Called at the top of the ordered shutdown
     *  drain. Idempotent. Does NOT wait — `drain()` does that. */
    seal(): void {
        this.sealed = true;
    }

    /** Test seam: return the tracker to its pre-shutdown state. Production
     *  never unseals — a disposed instance's bundle is discarded. */
    unsealForTests(): void {
        this.sealed = false;
    }

    /**
     * Resolve when every in-flight autolink hook has settled, OR when
     * `timeoutMs` elapses — whichever comes first. Wired into the ordered
     * shutdown drain (shutdownDrain.ts step 8.5) right beside
     * `awaitBackgroundReconnect()`, so both kinds of reconnect work land
     * before `graph.close()` / `verbatimStore.close()` run. No-op when idle.
     *
     * Loops rather than awaiting one snapshot: a hook can be registered while
     * an earlier batch is still settling. Entries are deleted explicitly after
     * each batch settles so termination does not depend on `finally`-callback
     * microtask ordering. The deadline spans the WHOLE loop, not each
     * iteration, so a stream of re-registrations cannot extend it.
     */
    async drain(timeoutMs: number = DEFAULT_AUTOLINK_DRAIN_TIMEOUT_MS): Promise<AutolinkDrainOutcome> {
        if (this.pending.size === 0) return { timedOut: false, abandoned: 0 };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
            // Never let the deadline itself hold the event loop open — the
            // race below already owns the ordering (same unref() convention
            // as shutdownDrain step 5 and shutdownCoordinator.timeoutMs).
            if (typeof timer.unref === 'function') timer.unref();
        });
        try {
            while (this.pending.size > 0) {
                const batch = [...this.pending];
                const outcome = await Promise.race([
                    Promise.allSettled(batch).then(() => 'settled' as const),
                    expired,
                ]);
                if (outcome === 'timeout') {
                    return { timedOut: true, abandoned: this.pending.size };
                }
                for (const p of batch) this.pending.delete(p);
            }
            return { timedOut: false, abandoned: 0 };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

/**
 * Fallback tracker for callers that have no instance handle — direct library
 * use and tests. Production wires the StorageBundle's own tracker into every
 * autolink hook (see `AutolinkHandles.tracker`), so nothing real accumulates
 * here; `test/autolink-drain-before-dispose-unit.ts` pins that.
 */
export const defaultAutolinkTracker = new PendingAutolinkTracker();

/** Back-compat free function — registers against `tracker` (default: the
 *  process-wide fallback). Prefer `tracker.track(p)` at wired call sites. */
export function trackPendingAutolink(
    p: Promise<unknown>,
    tracker: PendingAutolinkTracker = defaultAutolinkTracker,
): void {
    tracker.track(p);
}

/** How many autolink hooks are in flight on `tracker`. Test/diagnostic hook. */
export function pendingAutolinkCount(
    tracker: PendingAutolinkTracker = defaultAutolinkTracker,
): number {
    return tracker.count();
}

/** Bounded drain of `tracker`. See {@link PendingAutolinkTracker.drain}. */
export function awaitPendingAutolinks(
    tracker: PendingAutolinkTracker = defaultAutolinkTracker,
    timeoutMs: number = DEFAULT_AUTOLINK_DRAIN_TIMEOUT_MS,
): Promise<AutolinkDrainOutcome> {
    return tracker.drain(timeoutMs);
}
