/**
 * daemonTimers.ts — construct the daemon-only background sweepers
 * (retention auto-sweep, auth-registry sweep, consistency reconciliation,
 * scheduled storage compaction).
 *
 * Extracted from server.ts's `createLore()` to keep that file inside the
 * file-size baseline (see CLAUDE.md "File Size Budget"). Pure wiring: each
 * helper here just calls the real scheduler with `createLore()`'s live
 * locals, gated the SAME way they were inline — behind `startsDaemonTimers`
 * (api-timers-started-in-all-modes) so NONE of these start in embedded mode,
 * where a timer firing after `dispose()` would violate the "no side effects
 * in the library path" contract. Embedded gets inert handles with the same
 * shape (no live timer; stop()/clear() are no-ops).
 */

import { scheduleRetentionSweep } from './retentionScheduler.js';
import { startTokenSweeper, type TokenSweeperHandle } from '../auth/tokens.js';
import { runConsistencySweep, scheduleConsistencySweep, type SweepResult } from '../diagnostics/sweeper.js';
import { runCompactionSweep, scheduleCompactionSweep } from './compactionScheduler.js';
import { runVersionPruneSweep, scheduleVersionPruneSweep, type PrunableVersionStore } from './versionPruneScheduler.js';
import { listWorkspaceNames } from '../config/workspaces.js';
import { runRetentionSweep } from './services.js';
import type { WorkspaceVerbatimResolver } from '../outbox/workspaceVerbatimResolver.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import type { LoreGraph, LoreVectorStore } from './services.js';
import type { ITableStorage } from '../contracts/tables.js';

export interface DaemonTimersDeps {
    startsDaemonTimers: boolean;
    isLocal: boolean;
    runRetentionSweep: (dryRun: boolean) => Promise<unknown>;
    graph: LoreGraph;
    verbatimStore: LoreVectorStore;
    tableStorage: ITableStorage | null;
    embedQueue: { enqueue: (nodeId: string, text: string, workspace?: string) => void };
    workspace: string;
    workspaceVerbatimResolver: WorkspaceVerbatimResolver | undefined;
    /** RC-round4 — per-workspace graph resolver. When present alongside
     *  workspaceVerbatimResolver (local mode), the consistency + retention
     *  sweeps FAN OUT over every registered workspace instead of running
     *  once against the boot substrate, so non-active workspaces B/C get
     *  the same periodic reconciliation + retention tombstoning as A.
     *  Absent in cloud mode → boot-only single-workspace path (unchanged).
     *  Kùzu-removal step2 commit 8 — the fan-out below resolves each
     *  workspace's graph via `getGraphHandle`, not `getOrOpen`: `getOrOpen`
     *  is the Kùzu substrate accessor and would silently sweep a
     *  Surreal-backed workspace against its own empty Kùzu store.
     *  `getGraphHandle` still opens Kùzu first internally (inheriting the
     *  workspace-confinement gate), so only it — not `getOrOpen` — needs to
     *  be exposed here. */
    graphRegistry?: Pick<LocalGraphRegistry, 'getGraphHandle' | 'tableStorageFor'>;
    /** RC-round4 — audit log for the per-workspace retention fan-out (the
     *  boot closure captured it internally; the fan-out re-derives the
     *  per-workspace graph/verbatim so it needs the shared log directly). */
    auditLog: import('../security/audit.js').AuditLog;
    /** Lists every registered workspace name for the fan-out. Defaults to
     *  config/workspaces.ts#listWorkspaceNames; injectable for tests. */
    listWorkspaces?: () => string[];
    /** The boot-bound VersionStore (or undefined if it failed to open at
     *  boot). Boot-scoped, NOT fanned out per workspace — see
     *  versionPruneScheduler.ts's header for why. */
    versionStore?: PrunableVersionStore;
}

export interface DaemonTimersHandles {
    retentionScheduler: { bootstrapTimer?: NodeJS.Timeout };
    authTokenSweeper: TokenSweeperHandle;
    consistencySweeper: { stop(): Promise<void> };
    compactionSweeper: { stop(): Promise<void> };
    versionPruneSweeper: { stop(): Promise<void> };
}

/** Wire every daemon-only background sweeper. Mirrors the inline
 *  construction this replaced byte-for-byte (same gating, same handle
 *  shapes) — see git history of mcp/server.ts for the pre-extraction form. */
export function wireDaemonTimers(deps: DaemonTimersDeps): DaemonTimersHandles {
    // Daily auto-sweep scheduled via the extracted retentionScheduler helper.
    // Idempotent; both timers unref'd inside. W2-CORE-SPLIT: timers now start
    // at createLore() call time, not module-eval — importing the library
    // schedules none of them.
    // TW-2a — capture the bootstrap-timer handle so the drain can clear it
    // (was discarded pre-TW-2a, leaking into a long-lived embedding host).
    // TW-7d — embedded never schedules the bootstrap sweep; the handle has no
    // live timer so the embedded drain has nothing to clear.
    // RC-round4 — fan the daily retention sweep out over every registered
    // workspace when the per-workspace resolvers are wired (local mode). The
    // boot closure (deps.runRetentionSweep) only ever swept the ACTIVE
    // workspace's policy + verbatim rows, so a non-active workspace B's
    // superseded rows past B's threshold were never auto-tombstoned by the
    // timer and B's LanceDB grew unbounded. Cloud mode (no resolver) keeps
    // the boot-only closure unchanged.
    const canFanOut = deps.isLocal && !!deps.graphRegistry && !!deps.workspaceVerbatimResolver;
    const listWs = deps.listWorkspaces ?? listWorkspaceNames;
    const retentionRunner: (dryRun: boolean) => Promise<unknown> = canFanOut
        ? (dryRun: boolean) => runRetentionSweepAllWorkspaces(deps, listWs, dryRun)
        : deps.runRetentionSweep;
    const retentionScheduler: { bootstrapTimer?: NodeJS.Timeout } =
        deps.startsDaemonTimers ? scheduleRetentionSweep(retentionRunner) : {};

    // Sprint 8 — periodic auth-registry sweep. No-op in test mode; the handle
    // is stopped from the HTTP lifecycle onShutdown hook / dispose() drain.
    // TW-7d — embedded gets an inert stop()-only handle (no interval armed).
    const authTokenSweeper: TokenSweeperHandle =
        deps.startsDaemonTimers ? startTokenSweeper() : { stop: () => undefined };

    // Architecture gap #9 — eventually-consistent reconciliation. Every 30min.
    // SP-02 — capture the handle so the shutdown drain can stop the timer.
    // TW-7d — embedded gets an inert async-stop()-only handle (no interval).
    // RC-round4 — fan the consistency sweep out over every registered
    // workspace (mirrors the compaction sweeper directly below). Pre-fix it
    // ran once against the boot substrate, so non-active workspaces B/C got
    // NO periodic missing-embedding reconciliation and any async-embed drift
    // in B was never healed. Each workspace's own graph + verbatim store is
    // resolved via graphRegistry / workspaceVerbatimResolver and the re-embed
    // is routed to THAT workspace (sweeper.ts:285 now carries opts.workspace).
    // One workspace at a time, fail-soft per workspace. Cloud mode (no
    // resolver) keeps the boot-only single-workspace path.
    const consistencySweeper: { stop(): Promise<void> } = deps.startsDaemonTimers
        ? scheduleConsistencySweep(
            canFanOut
                ? () => runConsistencySweepAllWorkspaces(deps, listWs)
                : () => runConsistencySweep(
                    { graph: deps.graph, vectorStore: deps.verbatimStore, tableStorage: deps.tableStorage, embedQueue: deps.embedQueue },
                    { workspace: deps.workspace },
                ),
        )
        : { stop: async () => undefined };

    // HOUSEKEEPING — scheduled LanceDB storage compaction (LOCAL/daemon mode
    // only; see mcp/compactionScheduler.ts). Without this, `verbatimStore.compact()`
    // only ever ran after the opt-in orphan-delete pass or the manual health
    // endpoint, so a long-running local daemon's `.lore/lancedb` grew
    // unbounded from ordinary write traffic alone. Iterates every REGISTERED
    // workspace (not just the boot one) via workspaceVerbatimResolver — cloud
    // mode has no per-workspace VerbatimStore resolver, so the timer is a
    // local-mode-only concern in addition to being daemon-only.
    // TW-7d — embedded gets an inert async-stop()-only handle (no interval).
    const compactionSweeper: { stop(): Promise<void> } = deps.startsDaemonTimers && deps.isLocal && deps.workspaceVerbatimResolver
        ? scheduleCompactionSweep(
            () => runCompactionSweep({ resolver: deps.workspaceVerbatimResolver as WorkspaceVerbatimResolver }),
        )
        : { stop: async () => undefined };

    // Scheduled version-history pruning. `versions.sqlite` records one
    // immutable row per node write with no built-in ceiling — pruneVersions()
    // existed since Feature 8 but nothing ever called it, so a long-running
    // local daemon's version history grew unbounded (found: 896MB against a
    // healthy sibling's ~130MB). Boot-scoped (not fanned out per workspace —
    // see versionPruneScheduler.ts). Same startsDaemonTimers gate as every
    // other sweeper here; never starts in embedded mode.
    const versionPruneSweeper: { stop(): Promise<void> } = deps.startsDaemonTimers
        ? scheduleVersionPruneSweep(() => runVersionPruneSweep({ store: deps.versionStore ?? null }))
        : { stop: async () => undefined };

    return { retentionScheduler, authTokenSweeper, consistencySweeper, compactionSweeper, versionPruneSweeper };
}

/**
 * RC-round4 — run one consistency-reconciliation pass across EVERY registered
 * workspace, resolving each workspace's own graph + verbatim store the same
 * way the compaction sweeper resolves per-workspace LanceDB handles. One
 * workspace at a time (sequential), fail-soft per workspace: a throw on
 * workspace A never stops the pass reaching B. Returns a merged aggregate
 * SweepResult purely so the scheduler's logging line has something to read;
 * the per-workspace healing side effects (re-embed enqueue into THAT
 * workspace's store) are the real output.
 *
 * Kùzu-removal step2 commit 8 — this fan-out is exactly why the graph MUST
 * be resolved through `getGraphHandle`, not `getOrOpen`: `getOrOpen` is the
 * Kùzu substrate accessor, so a Surreal-backed workspace swept through it
 * got the real-but-EMPTY Kùzu database that workspace still carries on
 * disk. The pass then diffed that empty graph against the workspace's real
 * LanceDB store, reported zero missing/orphan embeddings, and never touched
 * a single row of the workspace's actual (Surreal) data.
 */
async function runConsistencySweepAllWorkspaces(
    deps: DaemonTimersDeps,
    listWs: () => string[],
): Promise<SweepResult> {
    const registry = deps.graphRegistry!;
    const resolver = deps.workspaceVerbatimResolver!;
    const agg = emptySweepResult();
    for (const ws of listWs()) {
        try {
            // getGraphHandle resolves the workspace's DECLARED engine
            // (Kùzu or Surreal) instead of always opening Kùzu — see the
            // doc comment above for why that silently broke this sweep for
            // non-Kùzu workspaces. It still opens Kùzu first internally, so
            // the workspace-confinement gate (assertWorkspaceOpenAllowed)
            // is unchanged.
            const graph = await registry.getGraphHandle(ws);
            const vectorStore = await resolver.getOrOpen(ws);
            // From the registry, not the graph: table storage is a SQLite file
            // keyed on the workspace path, and casting a graph handle to reach
            // it silently required the workspace to be Kùzu-backed.
            const tableStorage = await registry.tableStorageFor(ws);
            const r = await runConsistencySweep(
                {
                    // WorkspaceGraph (Kùzu | Surreal) satisfies SweepDeps['graph']
                    // directly now — both engines implement listNodes/getNode/
                    // getNodesByIds/bulkListProjected, so no cast is needed here
                    // any more (the `as unknown as` this replaced was already
                    // redundant once the shared handle type widened).
                    graph,
                    vectorStore: vectorStore as unknown as Parameters<typeof runConsistencySweep>[0]['vectorStore'],
                    tableStorage,
                    embedQueue: deps.embedQueue,
                },
                { workspace: ws },
            );
            mergeSweepResult(agg, r);
        } catch (err) {
            console.error(`[consistency-sweep] workspace "${ws}" failed: ${(err as Error).message}`);
        }
    }
    return agg;
}

/**
 * RC-round4 — run the daily retention sweep across EVERY registered
 * workspace, resolving each workspace's own graph + verbatim store so its
 * OWN policy governs its OWN superseded-row tombstoning. Sequential,
 * fail-soft per workspace.
 *
 * Kùzu-removal step2 commit 8 — same silent-clean-sweep bug as the
 * consistency fan-out above: `getOrOpen` always opens Kùzu, so a
 * Surreal-backed workspace's retention pass ran against its own empty Kùzu
 * store and reported `eligible: 0` / `archived: 0` with `ok:true`, never
 * tombstoning a single superseded row in the workspace's real (Surreal)
 * graph. `getGraphHandle` resolves the workspace's declared engine so the
 * policy actually governs that workspace's own data.
 */
async function runRetentionSweepAllWorkspaces(
    deps: DaemonTimersDeps,
    listWs: () => string[],
    dryRun: boolean,
): Promise<unknown> {
    const registry = deps.graphRegistry!;
    const resolver = deps.workspaceVerbatimResolver!;
    const reports: Array<{ workspace: string; archived?: number; error?: string }> = [];
    for (const ws of listWs()) {
        try {
            const graph = await registry.getGraphHandle(ws);
            const verbatimStore = await resolver.getOrOpen(ws);
            const report = await runRetentionSweep(
                {
                    // WorkspaceGraph is a direct subtype of LoreGraph
                    // (LoreGraphHandle) — the `as unknown as LoreGraph` this
                    // replaced was already redundant once the shared handle
                    // type widened, so no cast is needed here.
                    graph,
                    verbatimStore: verbatimStore as unknown as LoreVectorStore,
                    auditLog: deps.auditLog,
                    workspace: ws,
                },
                dryRun,
            );
            reports.push({ workspace: ws, archived: report.archived });
        } catch (err) {
            reports.push({ workspace: ws, error: (err as Error).message });
            console.error(`[retention] workspace "${ws}" sweep failed: ${(err as Error).message}`);
        }
    }
    return { workspaces: reports };
}

/** Zero-valued SweepResult accumulator for the per-workspace fan-out merge. */
function emptySweepResult(): SweepResult {
    return {
        report: {
            workspace: '(all)',
            graphNodeCount: 0,
            vectorEmbeddingCount: 0,
            missingEmbeddings: [],
            orphanEmbeddings: [],
            sqliteOrphans: [],
            hasIssues: false,
        } as unknown as SweepResult['report'],
        enqueuedForReEmbed: 0,
        observedButSkipped: 0,
        skippedUnchanged: 0,
        skippedNonEmbeddable: 0,
        deletedOrphans: 0,
        failedOrphanDeletes: 0,
    };
}

/** Merge a per-workspace SweepResult into the running aggregate. */
function mergeSweepResult(agg: SweepResult, r: SweepResult): void {
    agg.enqueuedForReEmbed += r.enqueuedForReEmbed;
    agg.observedButSkipped += r.observedButSkipped;
    agg.skippedUnchanged += r.skippedUnchanged;
    agg.skippedNonEmbeddable += r.skippedNonEmbeddable;
    agg.deletedOrphans += r.deletedOrphans;
    agg.failedOrphanDeletes += r.failedOrphanDeletes;
    const rep = agg.report as unknown as { graphNodeCount: number; vectorEmbeddingCount: number; hasIssues: boolean };
    const rr = r.report as unknown as { graphNodeCount: number; vectorEmbeddingCount: number; hasIssues: boolean };
    rep.graphNodeCount += rr.graphNodeCount;
    rep.vectorEmbeddingCount += rr.vectorEmbeddingCount;
    rep.hasIssues = rep.hasIssues || rr.hasIssues;
}
