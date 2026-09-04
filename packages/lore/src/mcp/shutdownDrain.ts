/**
 * shutdownDrain.ts — the daemon's ORDERED graceful-shutdown drain (SP-02).
 *
 * Extracted from server.ts (file-size cap) so the boot orchestrator stays
 * under budget. server.ts builds this with the live singletons and passes
 * the returned function to startHttpLifecycle as `onShutdown`; the shared
 * shutdownCoordinator runs it (once, under a hard timeout) on SIGINT /
 * SIGTERM AND on /api/workspaces/switch + /api/daemon/restart.
 *
 * The ordering is load-bearing: stop PRODUCERS first, drain QUEUES, flush
 * CACHES, await SWEEPS, then close SUBSTRATE handles LAST — closing the
 * graph engine/LanceDB before the drains would abort in-flight transactions.
 * Every step is awaited and individually try/caught so one failing
 * component can't strand the others.
 */

import { VerbatimStore } from '../engines/verbatimStore.js';
import { awaitBackgroundReconnect } from '../engines/backgroundReconnect.js';
import {
    defaultAutolinkTracker,
    DEFAULT_AUTOLINK_DRAIN_TIMEOUT_MS,
    DEFAULT_SWEEP_DRAIN_TIMEOUT_MS,
    PendingAutolinkTracker,
} from '../engines/pendingAutolink.js';

/** Minimal structural contracts — kept loose so server.ts can pass its
 *  existing singletons without new adapter types. */
export interface ShutdownDrainDeps {
    graph: unknown;
    /**
     * The storage bundle, for the one substrate the drain must flush that is
     * not the graph: the hot-session cache. Optional so older/test wiring that
     * omits it still type-checks — but when absent nothing is flushed, which is
     * why every production caller passes it.
     */
    store?: {
        sessionCache?: { flushNow(): void };
        /** THIS instance's in-flight INGEST autolink registry (step 8.5).
         *  Optional so test wiring can omit the bundle; absent ⇒ the
         *  process-wide default tracker is drained instead, which is what a
         *  hand-built dep set without a bundle actually registers against. */
        autolinkTracker?: PendingAutolinkTracker;
        /** THIS instance's in-flight LONG-SWEEP registry (step 8.6) — the
         *  operator-initiated /api/graph/reconnect + /api/graph/reconsume
         *  rebuilds. Separate from `autolinkTracker` because the two workloads
         *  have completely different time budgets; see StorageBundle.sweepTracker.
         *  Optional for the same test-wiring reason; absent ⇒ a private empty
         *  tracker, so the step is a no-op rather than accidentally draining
         *  the ingest queue twice. */
        sweepTracker?: PendingAutolinkTracker;
    };
    verbatimStore: unknown;
    syncPoller: { stop(): Promise<void> | void };
    outboxReplicator: { stop(): Promise<void> };
    embedQueue: { drained(): Promise<void>; stop(): void };
    consistencySweeper: { stop(): Promise<void> };
    /** HOUSEKEEPING — scheduled LanceDB compaction sweeper. Optional so
     *  older/test wiring that doesn't pass one still type-checks; when
     *  present the drain awaits any in-flight compact() the same way it
     *  awaits the consistency sweeper. */
    compactionSweeper?: { stop(): Promise<void> };
    /** Scheduled version-history prune (versionPruneScheduler.ts). Optional,
     *  same reason as compactionSweeper — the drain awaits any in-flight
     *  VACUUM so process.exit can't cut it mid-run. */
    versionPruneSweeper?: { stop(): Promise<void> };
    /** May be null until the load-jobs runner is wired (Sprint Z2). */
    getLoadJobsRunner: () => { stop(): Promise<void> } | null;
    /** May be undefined when migrations aren't wired. */
    migrationWiring?: { close(): void };
    authTokenSweeper: { stop(): void };
    stopAllLocalWatchers: () => void;
    /** SP-11 — rate limiter's idle-bucket sweep timer. Optional so
     *  embedded/test wiring can omit it. */
    rateLimiter?: { stopSweeper(): void };
    /** SP-11 — local graph registry's idle-workspace eviction timer.
     *  Optional (undefined in cloud mode).
     *
     *  TW-7e — `disposeAll()` physically closes every lazily-opened sibling
     *  graph the registry holds (the boot graph stays pinned and is closed by
     *  graph.close() below). Optional so older/cloud wiring that passes a
     *  bare {stopEvictionSweep} still type-checks; the drain falls back to
     *  stopEvictionSweep() when disposeAll is absent. */
    graphRegistry?: { stopEvictionSweep(): void; disposeAll?: () => Promise<void> };
    /** Wave 4.3 — per-workspace SyncEngine registry. Optional (undefined in
     *  cloud mode / wiring without it). `disposeAll()` stops auto-sync on
     *  every cached engine and drops references; synchronous (SyncEngine
     *  holds no native handles). */
    syncEngineRegistry?: { disposeAll(): void };
    /** Hard ceiling on the embed-queue drain (default 5s). */
    embedDrainTimeoutMs?: number;
    /** Hard ceiling on the ingest-autolink drain (default 5s — same order of
     *  magnitude and the same bounded-vs-perfect tradeoff as the embed queue
     *  above). Required because the EMBEDDED path has no outer backstop:
     *  `lifecycle.makeDispose` deliberately never enters the
     *  shutdownCoordinator, so an unbounded wait here hung dispose() forever. */
    autolinkDrainTimeoutMs?: number;
    /** Hard ceiling on the LONG-SWEEP drain (default 30s). Larger than the
     *  ingest budget because these sweeps legitimately run for minutes, and
     *  still bounded because nothing may hang a dispose(). Reached only if a
     *  sweep ignores its `shouldAbort` poll. */
    sweepDrainTimeoutMs?: number;
}

function logStepError(step: string, e: unknown): void {
    console.error(`[Lore MCP] ${step}:`, (e as Error).message);
}

/**
 * Build the ordered async drain. Returns a function suitable for
 * `HttpLifecycleInput.onShutdown` — it does NOT close the HTTP server or
 * exit; the lifecycle/coordinator own those.
 */
export function buildShutdownDrain(deps: ShutdownDrainDeps): (reason: string) => Promise<void> {
    const embedTimeoutMs = deps.embedDrainTimeoutMs ?? 5000;
    const autolinkTimeoutMs = deps.autolinkDrainTimeoutMs ?? DEFAULT_AUTOLINK_DRAIN_TIMEOUT_MS;
    const autolinkTracker = deps.store?.autolinkTracker ?? defaultAutolinkTracker;
    const sweepTimeoutMs = deps.sweepDrainTimeoutMs ?? DEFAULT_SWEEP_DRAIN_TIMEOUT_MS;
    // A PRIVATE empty tracker when unwired — not `defaultAutolinkTracker`,
    // which would make step 8.6 drain the ingest queue a second time under the
    // sweep deadline and reproduce the conflation this split removes.
    const sweepTracker = deps.store?.sweepTracker ?? new PendingAutolinkTracker();

    return async function drain(reason: string): Promise<void> {
        console.error(`[Lore MCP] graceful shutdown begin (${reason})`);

        // 0. SEAL the ingest-autolink registry FIRST, before any producer is
        //    stopped. Registration is synchronous with the write, so there is
        //    no gap at the registration site — but a write already in flight
        //    when the drain started (an unawaited embedded `store()`, or an
        //    HTTP request `server.close()` is letting finish) could otherwise
        //    register a NEW autolink AFTER step 8.5 had already drained empty,
        //    and that hook then wrote into the handles step 10 closes moments
        //    later. Sealing does not cancel anything already registered (8.5
        //    still awaits those); it makes `nodeUpsert` decline to START a new
        //    best-effort autolink once shutdown has begun. The node's own
        //    graph + verbatim writes are unaffected.
        try { autolinkTracker.seal(); } catch (e) { logStepError('autolink.seal', e); }
        // 0b. SEAL the long-sweep registry too, and for a second reason beyond
        //     refusing new work: an ALREADY-RUNNING sweep polls `isSealed()`
        //     through its `shouldAbort` hook at every page boundary and search
        //     chunk, so sealing here is what lets a multi-minute rebuild stop
        //     cooperatively and actually finish inside step 8.6's deadline.
        //     Registering it was never enough on its own — a sweep the drain
        //     can SEE but cannot outwait still gets its substrates closed
        //     underneath it at step 10.
        try { sweepTracker.seal(); } catch (e) { logStepError('sweep.seal', e); }

        // 1. Stop the sync poller and AWAIT any in-flight tick
        //    (mid-applySnapshot fs.writeFile must finish first).
        try { await deps.syncPoller.stop(); } catch (e) { logStepError('syncPoller.stop', e); }

        // 2. Stop the load-jobs runner BEFORE the replicator so any
        //    in-flight load.done outbox writes make it onto the outbox
        //    store before the replicator drains it (Sprint Z2 "shutdown
        //    order race").
        const loadJobsRunner = deps.getLoadJobsRunner();
        if (loadJobsRunner) {
            try { await loadJobsRunner.stop(); } catch (e) { logStepError('loadJobsRunner.stop', e); }
        }

        // 3. Close MigrationCoordinator handles BEFORE the replicator
        //    finishes draining. Synchronous + idempotent; any final
        //    migration.* notification was already enqueued onto the
        //    outbox by apply()/advance(), preserving the outbox-first
        //    invariant (Sprint H4).
        if (deps.migrationWiring) {
            try { deps.migrationWiring.close(); } catch (e) { logStepError('migration.close', e); }
        }

        // 4. Stop + drain the outbox replicator (Sprint O1). stop()
        //    awaits the loop to finish its current tick, so rows
        //    mid-replication land instead of staying status='in_flight'.
        try { await deps.outboxReplicator.stop(); } catch (e) { logStepError('replicator.stop', e); }

        // 5. Drain the embed queue. AWAIT drained() FIRST (queue still
        //    running so pending + in-flight + scheduled retries pump to
        //    completion — a node's vector mirror lands instead of being
        //    silently dropped), THEN stop(). No new producers can enqueue
        //    here: the HTTP server is closing and the sync poller +
        //    replicator already stopped. Bounded by a race so a wedged
        //    executor can't block the exit.
        try {
            await Promise.race([
                deps.embedQueue.drained(),
                new Promise<void>((r) => { const t = setTimeout(r, embedTimeoutMs); if (typeof t.unref === 'function') t.unref(); }),
            ]);
            deps.embedQueue.stop();
        } catch (e) { logStepError('embedQueue.drain', e); }

        // 6. Flush the session cache (last 0–1000ms of debounced recent_nodes
        //    pushes). Taken from the BUNDLE, not from the graph: the manager is
        //    a JSON file keyed on the workspace path and was only ever reachable
        //    through LocalGraph by accident of ownership. The bundle already
        //    holds the single instance TW-7e requires — with a LocalGraph it IS
        //    the graph's, without one it is the only one in existence — so this
        //    flushes the same object it used to, on either engine.
        try { deps.store?.sessionCache?.flushNow(); } catch (e) { logStepError('sessionCache.flushNow', e); }

        // 7. Stop the consistency sweeper and AWAIT any in-flight sweep
        //    (mid-LanceDB-write / mid-graph-delete).
        try { await deps.consistencySweeper.stop(); } catch (e) { logStepError('consistencySweep.stop', e); }

        // 7.5 HOUSEKEEPING — stop the scheduled compaction sweeper and AWAIT
        //     any in-flight pass (mid-LanceDB optimize) before substrate
        //     handles close below.
        if (deps.compactionSweeper) {
            try { await deps.compactionSweeper.stop(); } catch (e) { logStepError('compactionSweep.stop', e); }
        }
        if (deps.versionPruneSweeper) {
            try { await deps.versionPruneSweeper.stop(); } catch (e) { logStepError('versionPruneSweep.stop', e); }
        }

        // 8. Await any in-flight first-install background reconnect so a
        //    near-complete run lands its cursor + edges before the
        //    substrate handles close. No-op when idle.
        //
        //    BOUNDED by the same sweep budget as step 8.6, and for the same
        //    reason: this step's own comment used to say the coordinator's
        //    hard timeout backed it, which pendingAutolink.ts property 2
        //    documents as FALSE for the embedded path (lifecycle.makeDispose
        //    never enters the coordinator). When the boot path passed the
        //    instance's sweepTracker the run is ALSO registered there and
        //    polls `isSealed()` — `sweepTracker.seal()` ran at the top of this
        //    drain — so it stops cooperatively and this await returns fast.
        //    The unbounded version could hang dispose() forever.
        try {
            const bg = await awaitBackgroundReconnect(sweepTimeoutMs);
            if (bg.timedOut) {
                console.error('[Lore] shutdown: first-install background reconnect did not stop within the sweep budget; proceeding (its cursor is not written, so it re-runs on next start)');
            }
        } catch (e) { logStepError('reconnect.await', e); }

        // 8.5 Await the ingest-time autolink hooks nodeUpsert fires without
        //     awaiting (deliberately — an ONNX embed + vector search per node
        //     must not sit on the synchronous write path). Untracked, a burst
        //     of writes followed by dispose() raced step 10's graph.close():
        //     in-flight reconnect writes hit closed graph engine/LanceDB handles and
        //     were swallowed by reconnectOneNode's own catch, dropping edges
        //     with no signal to the caller. Same class as the L-008
        //     migrateV1Sqlite fix, and placed here for the same reason as the
        //     background reconnect above: BEFORE substrate handles close.
        //
        //     BOUNDED, like the embed-queue drain at step 5. An unbounded wait
        //     here is not safe: the embedded path (`lifecycle.makeDispose`)
        //     deliberately bypasses the shutdownCoordinator's hard timeout, so
        //     one autolink stuck behind SearchGate hung dispose() forever — in
        //     exactly the deployment mode this bug was reported in. On timeout
        //     we log how many hooks were abandoned and proceed: the same
        //     bounded-vs-perfect tradeoff trickle/bulk ingest already accepts,
        //     and a lost inferred edge is recoverable (`reconnect` rebuilds
        //     them) whereas a hung host process is not.
        try {
            const outcome = await autolinkTracker.drain(autolinkTimeoutMs);
            if (outcome.timedOut) {
                console.error(
                    `[Lore MCP] autolink drain exceeded ${autolinkTimeoutMs}ms — ` +
                    `${outcome.abandoned} ingest autolink hook(s) abandoned; ` +
                    'their semantic_neighbor edges may be missing (re-run reconnect to rebuild)',
                );
            }
        } catch (e) { logStepError('autolink.await', e); }

        // 8.6 Await the operator-initiated graph sweeps (/api/graph/reconnect,
        //     /api/graph/reconsume). SEPARATE tracker, SEPARATE deadline: these
        //     run for minutes and could never settle inside step 8.5's 5s, so
        //     sharing that queue meant the drain timed out and step 10 closed
        //     the graph engine + LanceDB underneath a live sweep — while logging a message
        //     about "ingest autolink hooks", which is not what the operator
        //     just ran. Step 0b sealed the tracker, so a sweep in flight is
        //     already unwinding at its next page boundary; this waits for that
        //     unwind to finish before the substrate handles close.
        try {
            const outcome = await sweepTracker.drain(sweepTimeoutMs);
            if (outcome.timedOut) {
                console.error(
                    `[Lore MCP] graph-sweep drain exceeded ${sweepTimeoutMs}ms — ` +
                    `${outcome.abandoned} reconnect/reconsume sweep(s) still running; ` +
                    'they did not stop at a page boundary. Re-run the sweep after restart.',
                );
            }
        } catch (e) { logStepError('sweep.await', e); }

        // 9. Auth-registry sweeper + rate-limiter sweeper + local file
        //    watchers. Sync clearInterval; idempotent on restart re-entry.
        try {
            deps.authTokenSweeper.stop();
            deps.rateLimiter?.stopSweeper();
            deps.graphRegistry?.stopEvictionSweep();
            deps.stopAllLocalWatchers();
        } catch { /* non-fatal */ }

        // 9.5 TW-7e (conc-dispose-leaks-lazy-opened-sibling-workspace-graphs) —
        //     physically close every lazily-opened SIBLING workspace graph the
        //     registry holds. Before this, dispose only drained the pinned boot
        //     graph (closed below in step 10) and reference-dropped the
        //     siblings, leaking their graph engine/LanceDB native handles for the life
        //     of the host process (acute in embedded mode). The sweep is already
        //     stopped (step 9), so no concurrent eviction races this. The boot
        //     graph stays pinned and is NOT closed here — step 10 owns it.
        if (deps.graphRegistry?.disposeAll) {
            try { await deps.graphRegistry.disposeAll(); } catch (e) { logStepError('graphRegistry.disposeAll', e); }
        }

        // 9.6 Wave 4.3 — stop auto-sync on every cached SyncEngine (the boot
        //     engine + any lazily-opened siblings) and drop references.
        //     Synchronous (no native handles); must run before graph.close()
        //     below so a mid-tick auto-sync push/pull isn't racing a closing
        //     graph engine connection pool.
        if (deps.syncEngineRegistry) {
            try { deps.syncEngineRegistry.disposeAll(); } catch (e) { logStepError('syncEngineRegistry.disposeAll', e); }
        }

        // 10. Close substrate handles LAST, after every write has
        //     drained. Local mode only (DataplaneGraph has no close()).
        //
        //     CAPABILITY-probed, not `instanceof LocalGraph`. The registry's
        //     `disposeAll()` deliberately skips the pinned boot entry ("boot
        //     graph closed by the drain"), so this is the ONLY thing that
        //     closes the boot workspace's handle. Once a workspace could
        //     declare `graphEngine: 'surreal'`, `createGraph()` started
        //     returning a SurrealGraph here — which failed the instanceof and
        //     was silently never closed, leaving the locked surrealkv
        //     directory the registry's own dual-handle comment warns about.
        //     Probe for close() instead: LocalGraph and SurrealGraph both have
        //     it, DataplaneGraph (cloud) has none and is correctly skipped.
        const closableGraph = deps.graph as { close?: () => Promise<void> | void } | null;
        if (typeof closableGraph?.close === 'function') {
            try { await closableGraph.close(); } catch (e) { logStepError('graph.close', e); }
        }
        if (deps.verbatimStore instanceof VerbatimStore) {
            try { await deps.verbatimStore.close(); } catch (e) { logStepError('verbatimStore.close', e); }
        }

        console.error('[Lore MCP] graceful shutdown complete');
    };
}
