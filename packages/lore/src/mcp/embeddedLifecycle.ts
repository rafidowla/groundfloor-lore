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
 *      later init step throws (corrupt graph store, locked LanceDB), the caller never
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
import type { VerbatimStoreApi } from '../engines/verbatimStoreApi.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../outbox/workspaceVerbatimResolver.js';
import { buildGraphRegistryForLocalMode, primeWorkspaceVerbatimResolver } from './bootSteps.js';

/** Minimal structural contract for the outbox wiring this module drives —
 *  kept loose so server.ts passes its existing `wireOutbox()` result without
 *  a new adapter type. */
export interface EmbeddedReplicationWiring {
    runBootRecovery(opts?: { onUnfinished?: (entries: readonly ReplayEntryRef[]) => void }): Promise<void>;
    replicator: { start(): void };
}

/** The outbox-row fields the replay guard reads. Structural, so this module
 *  does not depend on the outbox package's full entry type. */
export interface ReplayEntryRef {
    id: string;
    operation?: string;
    operationKind?: string;
    workspace?: string;
    createdAt?: string;
    /** Per-workspace outbox position; orders a save against a delete. */
    sequenceId?: number;
    /** Failed replay attempts so far. */
    attempts?: number;
}

/** Asks the outbox for the newest queued save of the node being replayed,
 *  recorded after the row in hand (`OutboxStore.newestNodeUpsertAfter`, bound
 *  by outbox/wiring.ts). Absent when the store cannot answer. */
export type NewerSaveLookup = () => Promise<(ReplayEntryRef & { payload?: unknown }) | null | undefined>;

/** What the guard knows about the newest delete of one node in this process
 *  lifetime (`LoreInstance.nodeDelete` / MCP `delete_node` applied inline, or a
 *  replayed `node.delete` row). */
export interface DeleteMark {
    /** Outbox position and record time of the newest `node.delete` row seen
     *  for the node. A `node.upsert` row recorded BEFORE it is superseded. */
    sequenceId?: number;
    createdAt?: string;
    /** Epoch ms at which a REPLAYED delete removed the node. Set until the
     *  node is back; a save recorded before that moment must restore it. */
    replayRemovedAt?: number;
}

/**
 * Per-instance state shared by the replay guard and boot recovery (3.26.0).
 *
 * `preBootNodeUpserts` is the set of `node.upsert` outbox rows that were
 * already unfinished when this process started — the only rows that can be
 * genuine crash recovery. It is captured from the same `listUnfinished()` scan
 * boot recovery runs, before the instance is handed to the host, so no row
 * written in this process lifetime can be in it. No clocks are involved. An id
 * leaves the set once its row has been replayed.
 *
 * `null` means the snapshot was never captured (boot recovery threw before
 * reading the outbox, or replication is not started in this mode); the guard
 * then keeps the pre-3.26 behaviour and re-creates a missing node.
 *
 * SINGLE OWNER: the snapshot reads "not unfinished at my boot" as "written,
 * and applied inline, by this process". That holds only while one process
 * writes and replays a data directory's outbox, which is the embedded
 * contract. All of this state is in memory: after a restart every surviving
 * row pre-dates the boot and is replayed in outbox order.
 */
export interface EmbeddedReplayScope {
    preBootNodeUpserts: Set<string> | null;
    /** Ids of `node.delete` rows whose graph delete this process already
     *  applied inline (`LoreInstance.nodeDelete`, MCP `delete_node`). Their
     *  replay is redundant — and harmful if the host has since re-created the
     *  node — so the guard skips it. Each id is removed when its row is
     *  replayed. */
    inlineAppliedDeletes: Set<string>;
    /** `workspace\0id` → the newest delete of that node (see {@link DeleteMark}).
     *  Bounded: the oldest entry is dropped past {@link MAX_TRACKED}; a dropped
     *  mark only returns that node to the snapshot rule. */
    lastDelete: Map<string, DeleteMark>;
    /** Replays skipped because the node was absent and the save was either
     *  superseded by a later delete or written in this process lifetime (the
     *  host deleted the node after saving it). */
    skippedDeleted: number;
}

/** Upper bound on each in-memory tracking collection of a replay scope. */
export const MAX_TRACKED = 20_000;

export function createEmbeddedReplayScope(): EmbeddedReplayScope {
    return { preBootNodeUpserts: null, inlineAppliedDeletes: new Set(), lastDelete: new Map(), skippedDeleted: 0 };
}

const replayKey = (entry: ReplayEntryRef | undefined, id: string): string => `${entry?.workspace ?? ''}\u0000${id}`;

/** Was `a` recorded before `b`? Outbox position when both carry one, record
 *  time otherwise. Unknown or equal → false ("not before": keep the data). */
function recordedBefore(
    a: Pick<ReplayEntryRef, 'sequenceId' | 'createdAt'>,
    b: Pick<DeleteMark, 'sequenceId' | 'createdAt'>,
): boolean {
    if (typeof a.sequenceId === 'number' && typeof b.sequenceId === 'number') return a.sequenceId < b.sequenceId;
    return Date.parse(a.createdAt ?? '') < Date.parse(b.createdAt ?? '');
}

/** Remember a delete of `nodeId`. `removed`: 'inline' — applied by this
 *  process outside the replay; `true`/`false` — a replayed row did / did not
 *  find a node to remove. The mark keeps the NEWEST delete's position. */
function markDelete(
    scope: EmbeddedReplayScope, entry: ReplayEntryRef | undefined, nodeId: string, removed: 'inline' | boolean,
): void {
    const key = replayKey(entry, nodeId);
    const prev = scope.lastDelete.get(key);
    const older = prev !== undefined && entry !== undefined && recordedBefore(entry, prev);
    const mark: DeleteMark = older
        ? { sequenceId: prev.sequenceId, createdAt: prev.createdAt }
        : { sequenceId: entry?.sequenceId ?? prev?.sequenceId, createdAt: entry?.createdAt ?? prev?.createdAt };
    const removedAt = removed === 'inline' ? undefined : removed ? Date.now() : prev?.replayRemovedAt;
    if (removedAt !== undefined) mark.replayRemovedAt = removedAt;
    scope.lastDelete.delete(key); // re-insert so the newest mark is evicted last
    scope.lastDelete.set(key, mark);
    if (scope.lastDelete.size > MAX_TRACKED) scope.lastDelete.delete(scope.lastDelete.keys().next().value as string);
}

/** Record that a `node.delete` row's graph delete was applied inline (called
 *  under the node lock, whether or not a node was there to remove). A no-op
 *  until replication has started (no replay will ever consume the entry). */
export function noteInlineAppliedDelete(scope: EmbeddedReplayScope, entry: ReplayEntryRef, nodeId: string): void {
    if (scope.preBootNodeUpserts === null) return;
    scope.inlineAppliedDeletes.add(entry.id);
    if (scope.inlineAppliedDeletes.size > MAX_TRACKED) {
        scope.inlineAppliedDeletes.delete(scope.inlineAppliedDeletes.values().next().value as string);
    }
    markDelete(scope, entry, nodeId, 'inline');
}

/** Inline-applying producers stamp this on their `node.upsert` rows
 *  (core/nodeService.ts, the bulk REST routes). */
const INLINE_APPLIED_OPERATION = 'graph.upsert';

/**
 * The snapshot rule: should a replayed `node.upsert` whose node is ABSENT
 * re-create it, when no delete of that node is known?
 *
 * Yes when the row may be the only copy of the write: no scope/snapshot, no
 * entry (a caller outside the replicator), a row from a producer that does not
 * apply inline, or a row that pre-dates this boot (crash between the outbox
 * record and the graph write). No for a row an inline-applying producer wrote
 * in this process lifetime: the graph write landed, so the node is absent
 * because something removed it afterwards — the host, through the raw graph
 * handle. (The rollback of a failed write is not such a case: since 3.26.0
 * `rollbackPartialWrite` restores an existing node and deletes only a node
 * the failed write itself created, retracting that write's row with it.)
 */
export function shouldRecreateMissingNode(
    scope: EmbeddedReplayScope | undefined,
    entry: ReplayEntryRef | undefined,
): boolean {
    if (!scope || scope.preBootNodeUpserts === null || !entry) return true;
    if (entry.operation !== INLINE_APPLIED_OPERATION) return true;
    return scope.preBootNodeUpserts.has(entry.id);
}

/**
 * The full decision for a replayed `node.upsert` whose node is ABSENT. A known
 * delete of the node comes first, and it is ordered against the save:
 *
 *   1. the save was recorded BEFORE the newest delete → superseded, never
 *      re-create (this also covers a row that pre-dates boot: crash recovery
 *      must not undo a delete the host made after start-up);
 *   2. a replayed delete removed the node AFTER the save was recorded → the
 *      save is the newer write, re-create;
 *   3. otherwise the snapshot rule, {@link shouldRecreateMissingNode}.
 */
export function shouldReplayRecreate(
    scope: EmbeddedReplayScope | undefined,
    entry: ReplayEntryRef | undefined,
    mark: DeleteMark | undefined,
): boolean {
    if (mark && entry) {
        if (recordedBefore(entry, mark)) return false;
        if (mark.replayRemovedAt !== undefined && !(Date.parse(entry.createdAt ?? '') > mark.replayRemovedAt)) return true;
    }
    return shouldRecreateMissingNode(scope, entry);
}

/** The newest queued save of `id` after the row in hand, or null. A lookup
 *  that throws, or answers with a row of another node, counts as "none": the
 *  caller then decides on the row it holds, as before 3.26.0. */
async function findNewerSave(
    lookup: NewerSaveLookup | undefined, id: string,
): Promise<(ReplayEntryRef & { payload?: unknown }) | null> {
    if (!lookup) return null;
    try {
        const newer = await lookup();
        return newer && (newer.payload as { id?: unknown } | undefined)?.id === id ? newer : null;
    } catch (err) {
        log.warn('[embedded replay] newest-save lookup failed; using the replayed row', { nodeId: id, error: (err as Error).message });
        return null;
    }
}

/** Structural contract for the graph the embedded outbox writes
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
 * re-applying the same `upsertNode` is pure redundancy — and, because the
 * former local graph engine permitted exactly one write transaction at a
 * time, that redundant write RACES any concurrent host write (e.g. a
 * long-held `withBulkConnection`) and tripped
 * "Only one write transaction at a time". The daemon never hit this because no
 * replicator ran in-process alongside arbitrary host graph writes.
 *
 * The wrapper preserves boot-RECOVERY correctness: a row left by a PRIOR run
 * whose inline graph write never landed (crash between outbox-record and graph
 * write) has NO existing node, so the wrapper applies it normally. Only the
 * already-applied steady-state rows are skipped — exactly the redundant,
 * racy ones. Verbatim/embedding rows (LanceDB) are unaffected (separate
 * substrate, no graph txn) and still drain so semantic recall works.
 *
 * 3.26.0 — the wrapper also exposes `replayNodeUpsert(payload, entry)` and
 * `replayNodeDelete(id, entry)`, which the outbox replicator calls instead of
 * `upsertNode` / `deleteNode` when they are present.
 *
 * `replayNodeUpsert` skips an existing node exactly as above, and re-creates a
 * MISSING node only when {@link shouldReplayRecreate} says so. Before this, a
 * host that saved a node and then hard-deleted it through the raw graph handle
 * saw it come back on the next replicator tick: the pending `node.upsert` row
 * found no node and was treated as crash recovery.
 *
 * `replayNodeDelete` skips a row whose delete was already applied inline (so a
 * save → nodeDelete → save of the same id is not undone by the replay), and
 * otherwise applies it and records the delete, so an older save's row is not
 * replayed over it and a newer save's row restores a node the replay removed.
 *
 * Newest save wins (3.26.0). Both take a third argument, a lookup for the
 * newest queued save of the node after the row in hand. When a missing node
 * is about to be re-created and a newer save is queued, the newer save's
 * payload is written (and the newer row decides whether to write at all), so
 * two saves queued behind a replayed delete leave the second save's content,
 * not the first's. There is no fall-back to the older payload: a newer payload
 * that fails to write makes the row throw and retry, and one that can never
 * be written dead-letters the row (and then the newer row, which retries with
 * the same payload). The node stays absent and `lore outbox requeue-dead`
 * re-drives both. Writing the older payload instead would make the newer row
 * find the node present and skip, losing the newest save for good.
 * A replayed delete that finds the node present with a save
 * of this lifetime queued behind it is skipped. Without the lookup (a custom
 * outbox store, a row with no position) the row's own payload is used.
 *
 * Both run under the node write lock (outbox/wiring.ts), as do the inline
 * writers, so the scope is never read mid-write for the same node.
 *
 * Every other graph member is delegated untouched via the prototype, so the
 * wrapper is transparent to the dispatcher's other call sites.
 */
export function embeddedGuardedGraph<T extends GuardableGraph>(graph: T, scope?: EmbeddedReplayScope): T {
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
            if (prop === 'replayNodeUpsert') {
                return async (payload: { id?: unknown }, entry?: ReplayEntryRef, newerSave?: NewerSaveLookup) => {
                    const id = payload?.id;
                    if (typeof id !== 'string') return target.upsertNode(payload);
                    const mark = scope?.lastDelete.get(replayKey(entry, id));
                    // The row's replay is final on every path that returns; a
                    // throw leaves the scope untouched so the retry decides the
                    // same way.
                    const settled = (): void => {
                        if (mark) delete mark.replayRemovedAt; // the node is back, or stays deleted
                        if (entry) scope?.preBootNodeUpserts?.delete(entry.id);
                    };
                    const existing = await target.getNode(id);
                    if (existing) { settled(); return existing; }
                    let recreate = shouldReplayRecreate(scope, entry, mark);
                    let toWrite: unknown = payload;
                    if (recreate) {
                        // The node is coming back. If a NEWER save of it is
                        // queued, that save is the node's content, and it
                        // decides: write its payload, or nothing when it is a
                        // save of this lifetime whose node was removed since.
                        // Its own row then finds the node present and skips.
                        const newer = await findNewerSave(newerSave, id);
                        if (newer) { recreate = shouldReplayRecreate(scope, newer, mark); toWrite = newer.payload; }
                    }
                    if (!recreate) {
                        if (scope) scope.skippedDeleted++;
                        // Superseded or host-deleted: do not resurrect. A node a
                        // replayed delete removed still waits for its newer save.
                        if (entry) scope?.preBootNodeUpserts?.delete(entry.id);
                        return null;
                    }
                    // A throw leaves the scope untouched and the row retries
                    // with the same decision; see "no fall-back" above.
                    const created = await target.upsertNode(toWrite);
                    settled();
                    return created;
                };
            }
            if (prop === 'replayNodeDelete') {
                return async (id: string, entry?: ReplayEntryRef, newerSave?: NewerSaveLookup) => {
                    if (scope && entry && scope.inlineAppliedDeletes.delete(entry.id)) return false;
                    // A delete that was not applied inline, replayed while the
                    // node is present: when a save of this lifetime is queued
                    // behind it, the node already holds that newer write, so
                    // removing it (and its relationships) only to re-create
                    // it would be a loss. Skip; the delete stays on record.
                    if (scope && scope.preBootNodeUpserts !== null && newerSave && await target.getNode(id)) {
                        const newer = await findNewerSave(newerSave, id);
                        if (newer && newer.operation === INLINE_APPLIED_OPERATION && !scope.preBootNodeUpserts.has(newer.id)) {
                            markDelete(scope, entry, id, false);
                            return false;
                        }
                    }
                    const deleted = await (target as unknown as { deleteNode(id: string): Promise<boolean> }).deleteNode(id);
                    if (scope) markDelete(scope, entry, id, deleted);
                    return deleted;
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
    verbatimStore: VerbatimStoreApi | { initialize(): Promise<void> };
    workspaceVerbatimResolver: WorkspaceVerbatimResolver | undefined;
    detectedWorkspace: string;
    dataHome: string;
    outboxWiring: EmbeddedReplicationWiring;
    /** 3.26.0 — the instance's replay scope (shared with the guarded graph);
     *  boot recovery fills in its pre-boot snapshot. */
    replayScope?: EmbeddedReplayScope;
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
 *
 * 3.26.0 — when a replay scope is passed, the unfinished rows boot recovery
 * reads are also recorded as the scope's pre-boot `node.upsert` snapshot (one
 * scan, taken before the instance is usable, so it cannot contain a row
 * written in this process lifetime).
 */
export async function startEmbeddedReplication(
    wiring: EmbeddedReplicationWiring,
    scope?: EmbeddedReplayScope,
): Promise<void> {
    try {
        await wiring.runBootRecovery(scope ? {
            onUnfinished: (entries) => {
                scope.preBootNodeUpserts = new Set(
                    entries.filter((e) => e.operationKind === 'node.upsert').map((e) => e.id),
                );
            },
        } : undefined);
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
                deps.verbatimStore as unknown as VerbatimStoreApi,
                deps.detectedWorkspace,
                deps.dataHome,
            );
            if (deps.deploymentMode === 'local') {
                await startEmbeddedReplication(deps.outboxWiring, deps.replayScope);
            }
        },
        (reason) => deps.buildDrain()(reason),
    );
}
