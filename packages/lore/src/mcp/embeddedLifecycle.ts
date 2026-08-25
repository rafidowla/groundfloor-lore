/**
 * embeddedLifecycle.ts — embedded (in-process) run-mode lifecycle (TW-2a).
 *
 * The embedded path of `createLore()` is NOT the daemon. The daemon's
 * `main()` owns transport selection, signal handlers, boot-recovery, the
 * outbox replicator start, and `process.exit`. An embedded host owns its own
 * process: it gets a usable instance from `createLore({deploymentMode:
 * 'embedded'})` and tears it down with `dispose()`.
 *
 * Three concerns live here so server.ts stays inside its file-size baseline:
 *
 *  (a) START REPLICATION IN-PROCESS — the embedded write path records
 *      `verbatim.upsert` / `node.upsert` outbox rows exactly like the daemon,
 *      but pre-TW-2a nothing drained them (the replicator start + boot
 *      recovery lived in main()'s `--http` daemon branch, AFTER the embedded
 *      early-return). So a host write enqueued an embed job that was never
 *      replicated → semantic recall silently missed it and the outbox grew
 *      unbounded. {@link startEmbeddedReplication} runs boot-recovery then
 *      starts the replicator in-process — NO port, NO daemon-only schedulers
 *      (load-jobs runner / migration coordinator stay daemon-only).
 *
 *  (c) CLEAN UP ON INIT-THROW — `createLore()` starts background timers
 *      (rate-limiter sweep, retention bootstrap, token sweeper, consistency
 *      sweep, active-session sweep) BEFORE the embedded substrate init. If a
 *      later init step throws (corrupt Kùzu, locked LanceDB), the caller never
 *      receives a `LoreInstance`, so `dispose()` — the only thing that stops
 *      those timers — is unreachable and they leak into the host event loop.
 *      {@link initEmbeddedSubstrates} wraps the init body so ANY throw runs the
 *      SAME cleanup that `dispose()` uses (the ordered drain) before rethrowing.
 *
 * (Concern (b), threading `dataDir` through the path resolvers, lives in
 *  server.ts / bootSteps.ts / localGraphRegistry.ts — see those files.)
 */

import { log } from '../logger.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
import type { VerbatimStore } from '../engines/verbatimStore.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../outbox/workspaceVerbatimResolver.js';
import { buildGraphRegistryForLocalMode, primeWorkspaceVerbatimResolver } from './bootSteps.js';

/** Minimal structural contract for the outbox wiring this module drives —
 *  kept loose so server.ts passes its existing `wireOutbox()` result without
 *  a new adapter type. */
export interface EmbeddedReplicationWiring {
    runBootRecovery(): Promise<void>;
    replicator: { start(): void };
}

/** Structural contract for the Kùzu-backed graph the embedded outbox writes
 *  through — only the members the guarded wrapper needs. Exported so callers
 *  (e.g. server.ts's own local wrapper) can stay generic/structural instead
 *  of re-narrowing to a concrete graph class. */
export interface GuardableGraph {
    getNode(id: string): Promise<unknown | null>;
    upsertNode(payload: unknown): Promise<unknown>;
}

/**
 * embeddedGuardedGraph — wrap a LocalGraph so the OUTBOX REPLICATOR's
 * `node.upsert` re-application becomes a no-op when the node already exists
 * (TW-2a).
 *
 * Why: in embedded mode the host's in-process write path
 * (`LoreInstance.nodeUpsert`) applies the graph node SYNCHRONOUSLY (nodeService
 * step 2) BEFORE the replicator ever sees the outbox row. The replicator then
 * re-applying the same `upsertNode` is pure redundancy — and, because Kùzu
 * permits exactly one write transaction at a time, that redundant write RACES
 * any concurrent host write (e.g. a long-held `withBulkConnection`) and trips
 * "Only one write transaction at a time". The daemon never hit this because no
 * replicator ran in-process alongside arbitrary host graph writes.
 *
 * The wrapper preserves boot-RECOVERY correctness: a row left by a PRIOR run
 * whose inline graph write never landed (crash between outbox-record and graph
 * write) has NO existing node, so the wrapper applies it normally. Only the
 * already-applied steady-state rows are skipped — exactly the redundant,
 * racy ones. Verbatim/embedding rows (LanceDB) are unaffected (separate
 * substrate, no Kùzu txn) and still drain so semantic recall works.
 *
 * Every other graph member is delegated untouched via the prototype, so the
 * wrapper is transparent to the dispatcher's other call sites.
 */
export function embeddedGuardedGraph<T extends GuardableGraph>(graph: T): T {
    return new Proxy(graph, {
        get(target, prop, receiver) {
            if (prop === 'upsertNode') {
                return async (payload: { id?: unknown }) => {
                    const id = payload?.id;
                    if (typeof id === 'string') {
                        const existing = await target.getNode(id);
                        if (existing) return existing; // already applied inline — skip the racy re-write
                    }
                    return target.upsertNode(payload);
                };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as T;
}

/** The extra createLore()-time timers the ordered shutdown drain
 *  (buildShutdownDrain) does NOT clear — they never bit the long-lived daemon,
 *  but in an embedding HOST they leak after dispose()/init-throw. TW-2a clears
 *  them in the embedded path WITHOUT touching the shared daemon drain. */
export interface EmbeddedExtraTimers {
    /** scheduleRetentionSweep bootstrap timer (setTimeout, 60 s → daily). */
    retentionBootstrapTimer?: NodeJS.Timeout;
    /** createActiveSessionTracker idle-sweep (setInterval). HTTP-only — pure
     *  leak in embedded (no transport). */
    activeSessionsSweepTimer?: NodeJS.Timeout;
    /** wireOrchestration plan-tick (setInterval). */
    orchestrationTickTimer?: NodeJS.Timeout;
    /** wireAuditExporterOnBoot's exporter.stop() — the default file exporter
     *  (audit/fileTailExporter.ts) arms an unref()'d setInterval flush that
     *  the shared ordered drain never touches (it is attached to the AuditLog
     *  AFTER buildShutdownDrain's dep set is closed over). Unref()'d means it
     *  never holds the host's event loop open, but it still FIRES after
     *  dispose() — a breach of the embedded clean-host contract. Stopping it
     *  here (best-effort, mirrors the other embedded-only extras) also
     *  flushes any queued entries synchronously, same as the daemon shutdown
     *  path. Optional because tests / hosts without an exporter attached
     *  simply skip it. */
    stopAuditExporter?: () => Promise<void> | void;
}

/**
 * composeEmbeddedDrain — wrap the shared ordered drain so it ALSO clears the
 * embedded-only leaked timers (retention bootstrap, active-session sweep,
 * orchestration tick) that buildShutdownDrain leaves running. Used by BOTH the
 * embedded dispose() and the init-throw cleanup so the same teardown runs in
 * both. clearing is idempotent + safe on an already-fired/cleared handle.
 */
export function composeEmbeddedDrain(
    baseDrain: (reason: string) => Promise<void>,
    timers: EmbeddedExtraTimers,
): (reason: string) => Promise<void> {
    return async function drain(reason: string): Promise<void> {
        try {
            await baseDrain(reason);
        } finally {
            try {
                if (timers.retentionBootstrapTimer) clearTimeout(timers.retentionBootstrapTimer);
                if (timers.activeSessionsSweepTimer) clearInterval(timers.activeSessionsSweepTimer);
                if (timers.orchestrationTickTimer) clearInterval(timers.orchestrationTickTimer);
            } catch { /* non-fatal */ }
            try {
                await timers.stopAuditExporter?.();
            } catch { /* non-fatal — mirrors the other best-effort clears above */ }
        }
    };
}

/** Substrate handles + scope the embedded readiness steps operate over. */
export interface EmbeddedInitDeps {
    deploymentMode: 'local' | 'cloud';
    graph: LoreGraphHandle;
    verbatimStore: VerbatimStore | { initialize(): Promise<void> };
    workspaceVerbatimResolver: WorkspaceVerbatimResolver | undefined;
    detectedWorkspace: string;
    dataHome: string;
    outboxWiring: EmbeddedReplicationWiring;
    /** Stores the graph registry built here back onto the createLore closure. */
    setGraphRegistry(reg: LocalGraphRegistry | undefined): void;
    /** Re-evaluated INSIDE init-failure cleanup so the drain captures whatever
     *  was assigned (graph/registry) before the failing step. */
    buildDrain(): (reason: string) => Promise<void>;
}

/**
 * (a) Start the outbox replicator + run boot-recovery for the EMBEDDED path.
 *
 * Mirrors the daemon's `outboxWiring.runBootRecovery()` +
 * `outboxWiring.replicator.start()` so verbatim/embedding outbox rows are
 * actually drained in-process. Unlike the daemon path this binds NO port and
 * starts NO daemon-only schedulers (load-jobs runner, migration coordinator) —
 * the embedded contract forbids them.
 *
 * Boot-recovery is best-effort (it re-enqueues/replays pending rows from a
 * prior run); a failure there must not prevent the replicator from starting,
 * so it's caught and logged rather than rethrown. The replicator's own
 * `start()` is idempotent and no-ops if the store lacks the universal-write
 * methods.
 */
export async function startEmbeddedReplication(wiring: EmbeddedReplicationWiring): Promise<void> {
    try {
        await wiring.runBootRecovery();
    } catch (recoveryErr) {
        log.error(`[Lore MCP] embedded boot-recovery failed (non-fatal): ${(recoveryErr as Error).message}`);
    }
    // Drain verbatim/embedding outbox rows in-process. No port, no
    // daemon-only schedulers — the embedded contract is in-process only.
    wiring.replicator.start();
}

/**
 * (c) Run the embedded substrate-init body with cleanup-on-throw.
 *
 * `init` performs the embedded substrate readiness steps (graph.initialize,
 * verbatim.initialize, registry build, resolver prime, replication start).
 * If ANY of them throws, `cleanup` (the ordered drain shared with `dispose()`)
 * runs to stop every started timer and close every opened handle, and only
 * then is the original error rethrown — so a failed `createLore()` leaves the
 * host process exactly as it found it (no leaked timers, no orphaned handles).
 *
 * The cleanup is itself try/caught so a teardown error can't mask the real
 * init failure the caller needs to see.
 */
export async function initEmbeddedSubstrates(
    init: () => Promise<void>,
    cleanup: (reason: string) => Promise<void>,
): Promise<void> {
    try {
        await init();
    } catch (initErr) {
        log.error(`[Lore MCP] embedded init failed — running cleanup before rethrow: ${(initErr as Error).message}`);
        try {
            await cleanup('embedded-init-failure');
        } catch (cleanupErr) {
            // Surface but don't mask the original init error.
            log.error(`[Lore MCP] embedded init-failure cleanup threw (non-fatal): ${(cleanupErr as Error).message}`);
        }
        throw initErr;
    }
}

/**
 * runEmbeddedInit — the full embedded substrate-readiness sequence (TW-2a),
 * extracted from createLore() so server.ts stays inside its file-size
 * baseline. In the embedded (in-process library) path there is no daemon
 * `main()` to bring the substrates up, so `createLore()` must do it before
 * returning a usable instance — minus any transport/listener/signal wiring.
 *
 * Wrapped by {@link initEmbeddedSubstrates} so ANY throw runs the ordered
 * drain (shared with dispose()) before rethrowing. The steps:
 *   1. graph.initialize() + verbatimStore.initialize().
 *   2. (b) build the instance-scoped LocalGraph registry — `dataHome` scopes
 *      its workspaces.json reads; autoEvict:false so NO idle-sweep timer is
 *      started (embedded drives evictIdle from dispose()).
 *   3. prime the per-workspace verbatim resolver with the boot store.
 *   4. (a) start the outbox replicator + run boot-recovery in-process so
 *      verbatim/embedding rows are actually drained (local mode only). NO
 *      port, NO daemon-only schedulers.
 */
export async function runEmbeddedInit(deps: EmbeddedInitDeps): Promise<void> {
    await initEmbeddedSubstrates(
        async () => {
            await (deps.graph as { initialize(): Promise<void> }).initialize();
            await deps.verbatimStore.initialize();
            const reg = buildGraphRegistryForLocalMode(
                deps.deploymentMode, deps.graph, deps.detectedWorkspace, deps.dataHome, { autoEvict: false },
            );
            deps.setGraphRegistry(reg);
            primeWorkspaceVerbatimResolver(
                deps.workspaceVerbatimResolver,
                deps.verbatimStore as unknown as VerbatimStore,
                deps.detectedWorkspace,
                deps.dataHome,
            );
            if (deps.deploymentMode === 'local') {
                await startEmbeddedReplication(deps.outboxWiring);
            }
        },
        (reason) => deps.buildDrain()(reason),
    );
}
