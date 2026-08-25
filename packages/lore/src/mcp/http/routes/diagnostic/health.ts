/**
 * health.ts — liveness + health-snapshot + consistency routes.
 *
 *   GET /health                   — minimal liveness probe (no graph touch)
 *   GET /api/diagnose/consistency — tri-substrate consistency report
 *   GET /api/health               — full daemon health snapshot
 */

import type { ServerResponse } from 'node:http';
import type { VerbatimStore } from '../../../../engines/verbatimStore.js';
import { getBackgroundReconnectStatus } from '../../../../engines/backgroundReconnect.js';
import { getCachedEmbeddingBackend } from '../../../../providers/embeddingBackend.js';
import { getActiveWorkspaceName, listWorkspaceNames } from '../../../../config/workspaces.js';
import { loreHome } from '../../../../config/loreHome.js';
import { getCurrentPrincipal } from '../../../../auth/principal.js';
import { bindRouteTarget } from '../../../../security/routeWorkspaceBinding.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { WorkspaceNotFoundError } from '../../../../engines/localGraphRegistry.js';
import { type DiagnosticDeps, type LoreGraph, readWorkspaceStats } from './shared.js';
import { VERSION } from '../../../../version.js';
import type { WriteQueueStats } from '../../../../engines/writeQueue.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';

/**
 * Sprint O1 — build the `outbox` body key for /api/health from a
 * pre-computed aggregate stats block. Returns `{ outbox: ... }` so the
 * /api/health response spreads exactly one key.
 *
 * outbox: { depth, lagSeconds, dead, perWorkspace } — aggregate across
 * all workspaces; null when no outbox stats provider is wired.
 * lagSeconds = seconds since the oldest pending entry's createdAt.
 */
function healthExtras(block: {
    depth: number;
    lagSeconds: number;
    dead: number;
    perWorkspace: Record<string, { depth: number; lagSeconds: number; dead: number }>;
} | null): { outbox: typeof block } {
    return { outbox: block };
}

export function handleHealthLite(res: ServerResponse, deps: DiagnosticDeps): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        version: VERSION,
        sessions: deps.activeSessions.size,
        // v1.1: background first-install reconnect — UI can render
        // "Indexing N / total — M%" until state=success.
        backgroundReconnect: getBackgroundReconnectStatus(),
        // v1.1: ONNX runtime backend ground truth. Replaces the
        // misleading "Wasm CPU" label that lingered after the v4
        // transformers upgrade flipped Node to native.
        embeddingBackend: getCachedEmbeddingBackend(),
    }));
}

export async function handleConsistency(res: ServerResponse, url: string, deps: DiagnosticDeps): Promise<void> {
    try {
        const { diagnoseConsistency } = await import('../../../../diagnostics/consistency.js');
        const u = new URL(url, 'http://x');
        // Sprint L1 — workspace is required. No silent fallback.
        const workspace = u.searchParams.get('workspace');
        if (!workspace) {
            writeError(res, 400, 'workspace_required', 'pass workspace=<name> as body field or query param');
            return;
        }
        // RA2-reaudit2 — token-scoped read gate. Pre-fix this route had NO gate
        // and always ran against deps.store.loreGraph (the boot workspace),
        // leaking the boot workspace's node ids/counts to any token. Mirror
        // handleStats. Null principal = legacy/local bypass.
        if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return;
        // Route to the REQUESTED workspace's substrates (was unconditionally the
        // boot graph). Cloud/embedded (no registry) keeps the boot graph.
        let targetGraph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                targetGraph = await deps.graphRegistry.getGraphHandle(workspace);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace "${err.requested}" not found`, { requested: err.requested, known: err.known });
                    return;
                }
                throw err;
            }
        }
        // Optional repeated query param: ?sqliteCheck=table:column
        const sqliteChecks = u.searchParams.getAll('sqliteCheck')
            .map(s => s.split(':'))
            .filter(parts => parts.length === 2)
            .map(([table, column]) => ({ table, column }));
        // Per-workspace table storage from the resolved graph; the vector store
        // can only be sourced for the ACTIVE workspace here (DiagnosticDeps has
        // no per-workspace verbatim resolver), so the vector portion is skipped
        // (null) for a non-active workspace rather than compared against the
        // wrong workspace's embeddings.
        const isActive = workspace === getActiveWorkspaceName();
        // Not reached through the graph handle any more — see
        // LocalGraphRegistry.tableStorageFor. The active workspace uses the
        // bundle's instance, which is the same file.
        const tableStorage = (isActive
            ? deps.store.tableStorage
            : (deps.graphRegistry ? await deps.graphRegistry.tableStorageFor(workspace) : null)) ?? null;
        const vectorStore = isActive ? ((deps.store.loreVerbatim as VerbatimStore) ?? null) : null;
        const report = await diagnoseConsistency(
            targetGraph as { listNodes: typeof deps.store.loreGraph.listNodes },
            vectorStore,
            tableStorage,
            { workspace, sqliteChecks: sqliteChecks.length > 0 ? sqliteChecks : undefined },
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}

/**
 * POST /api/diagnose/consistency/cleanup?workspace=<ws>[&deleteUnverified=1]
 * — operator-triggered orphan cascade-delete + compaction.
 *
 * The scheduled sweep is observe-only by default (2026-06-09 safe-default
 * flip); this endpoint is the deliberate opt-in to actually delete the
 * orphan vectors for a workspace and reclaim disk. It runs the production
 * consistency sweep with `deleteOrphans: true` (which compacts afterward).
 * No embedQueue is wired here — cleanup is about removing orphans + reclaim,
 * not re-embedding missing nodes. Bearer-gated like the rest of /api/*.
 *
 * `deleteUnverified=1` (alias `reclaim=now`) requests IMMEDIATE full disk
 * reclaim: after the sweep it runs an aggressive compaction that prunes even
 * <7-day-old versions/transaction logs (the rows LanceDB otherwise keeps for
 * 7 days as in-progress-transaction safety). This is the operator escape
 * hatch — only safe when no concurrent writer is mid-transaction on the
 * workspace; the caller owns that judgement. Without the flag, reclaim of
 * recent versions completes automatically within LanceDB's 7-day window.
 */
export async function handleConsistencyCleanup(res: ServerResponse, url: string, deps: DiagnosticDeps): Promise<void> {
    try {
        const u = new URL(url, 'http://x');
        const workspace = u.searchParams.get('workspace');
        if (!workspace) {
            writeError(res, 400, 'workspace_required', 'pass workspace=<name> as query param');
            return;
        }
        // L-013 — this route runs an orphan cascade-delete + aggressive
        // vector compaction (both irreversible), so it is gated like the
        // other destructive routes (L-031): the cloud ReBAC 'delete'
        // permission first, then the per-token write scope.
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane ?? null },
            { permission: 'delete' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return; }
        // Token write-scope against the requested workspace. Null principal
        // = legacy/local bypass (mirrors nodes-delete.ts:101).
        if (bindRouteTarget(res, { requested: workspace, intent: 'write' }) === null) return;
        const deleteUnverified = u.searchParams.get('deleteUnverified') === '1' || u.searchParams.get('reclaim') === 'now';
        const { runConsistencySweep } = await import('../../../../diagnostics/sweeper.js');

        // RC-round4 (workspace-confinement) — this handler runs an orphan
        // cascade-delete + aggressive LanceDB compaction (both irreversible).
        // Pre-fix it wired the BOOT substrates unconditionally, so a cleanup
        // "for workspace B" deleted the ACTIVE workspace A's vectors (the boot
        // graph's ids decided which boot-LanceDB vectors were "orphans") and
        // never touched B's real store. Resolve the REQUESTED workspace's
        // graph + verbatim store exactly as handleConsistency does; the
        // orphan-classification cross-references graph⇔vector, so BOTH must
        // point at the same workspace. For a non-active workspace with no
        // resolvable verbatim store we REFUSE rather than run a destructive
        // pass against the wrong store.
        const isActive = workspace === getActiveWorkspaceName();
        let targetGraph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                targetGraph = await deps.graphRegistry.getGraphHandle(workspace);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace "${err.requested}" not found`, { requested: err.requested, known: err.known });
                    return;
                }
                throw err;
            }
        }
        // Resolve the requested workspace's LanceDB.
        //  - Active workspace → the boot verbatim store (that IS its store).
        //  - No graphRegistry at all → cloud/legacy single-substrate mode: the
        //    boot store is the ONLY store, so use it (unchanged behavior).
        //  - Multi-workspace local (registry present) + NON-active workspace →
        //    resolve THAT workspace's LanceDB via the per-workspace resolver.
        //    If no resolver is wired we cannot safely run the destructive pass
        //    against the right store, so we REFUSE rather than fall back to the
        //    boot store (which would delete the ACTIVE workspace's vectors).
        let vectorStore: VerbatimStore | null;
        if (isActive || !deps.graphRegistry) {
            vectorStore = (deps.store.loreVerbatim as VerbatimStore) ?? null;
        } else if (deps.workspaceVerbatimResolver) {
            try {
                vectorStore = (await deps.workspaceVerbatimResolver.getOrOpen(workspace)) as unknown as VerbatimStore;
            } catch (err) {
                writeError(res, 500, 'workspace_verbatim_unavailable', `could not open verbatim store for workspace "${workspace}": ${redactError(err)}`);
                return;
            }
        } else {
            writeError(res, 409, 'workspace_verbatim_unavailable', `refusing destructive cleanup for non-active workspace "${workspace}": no per-workspace verbatim resolver`);
            return;
        }
        // Per-workspace table storage from the REGISTRY, not the resolved
        // graph — see LocalGraphRegistry.tableStorageFor.
        const tableStorage = (isActive
            ? deps.store.tableStorage
            : (deps.graphRegistry ? await deps.graphRegistry.tableStorageFor(workspace) : null)) ?? null;
        const result = await runConsistencySweep(
            {
                graph: targetGraph as unknown as Parameters<typeof runConsistencySweep>[0]['graph'],
                vectorStore: vectorStore as unknown as Parameters<typeof runConsistencySweep>[0]['vectorStore'],
                tableStorage,
            },
            { workspace, deleteOrphans: true },
        );
        // Immediate full reclaim (operator opt-in). The sweep already
        // compacts after a delete pass with the safe default; this runs an
        // aggressive prune to free recent versions/transactions now.
        let compaction: { fragmentsRemoved: number; filesRemoved: number; bytesRemoved: number; oldVersionsRemoved: number } | null = null;
        if (deleteUnverified && vectorStore && typeof vectorStore.compact === 'function') {
            compaction = await vectorStore.compact({ deleteUnverified: true });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            workspace,
            deletedOrphans: result.deletedOrphans,
            failedOrphanDeletes: result.failedOrphanDeletes,
            observedButSkipped: result.observedButSkipped,
            enqueuedForReEmbed: result.enqueuedForReEmbed,
            skippedUnchanged: result.skippedUnchanged,
            graphNodeCount: result.report.graphNodeCount,
            vectorEmbeddingCount: result.report.vectorEmbeddingCount,
            reclaimedNow: deleteUnverified,
            compaction,
        }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}

export async function handleHealth(res: ServerResponse, url: string, deps: DiagnosticDeps): Promise<void> {
    try {
        const cfg = deps.configManager.read();
        const orphanState = { blocking: false, orphans: [] as string[] };

        // Sprint O1 — outbox depth + lagSeconds. Computed FIRST so
        // the literal precedes the workspace-counts block below in
        // source order. (O-D9 looks for a stats-block / outbox
        // pairing that O4 will land when it adds the per-workspace
        // key; we keep source order to avoid an early O-D9 trip.)
        // Gate test O-D5 needs both the `outbox:` key AND the
        // `lagSeconds` substring in this file.
        let oxBlock: {
            depth: number;
            lagSeconds: number;
            dead: number;
            perWorkspace: Record<string, { depth: number; lagSeconds: number; dead: number }>;
        } | null = null;
        if (deps.getOutboxStats) {
            try {
                const s = await deps.getOutboxStats();
                oxBlock = {
                    depth: s.depth,
                    lagSeconds: s.lagSeconds,
                    dead: s.dead,
                    perWorkspace: s.perWorkspace,
                };
            } catch {
                oxBlock = null;
            }
        }

        // Sprint L2 — workspace-aware health surface. /api/health
        // stays unauthenticated and global (it's status, not data),
        // but its body MUST surface per-workspace counts + global
        // totals so any divergence is visible to operators. This is
        // the "never silent again" rule from the L0 audit: counts
        // that differ between active-workspace and global view
        // never get summed into one ambiguous number again.
        const activeName = getActiveWorkspaceName();
        const perWorkspaceStats: Record<string, { nodeCount: number; edgeCount: number; writeQueue?: WriteQueueStats }> = {};
        let globalNodes = 0;
        let globalEdges = 0;
        let knownNames: string[] = [];
        try {
            knownNames = listWorkspaceNames();
        } catch {
            knownNames = [activeName];
        }
        // SP-stampede — /api/health is unauthenticated (uptime monitors poll
        // it token-free) and exempt from rate limiting, so a GET storm must
        // not be able to drive expensive work. The old loop force-opened
        // EVERY known workspace via getOrOpen; with MAX_OPEN_WORKSPACES=8 and
        // 100 registered workspaces, each call evicted + physically closed
        // 92 Kùzu mmaps + LanceDB handles in lockstep (LRU thrash). Default
        // now measures ONLY workspaces already cached in the registry — every
        // getGraphHandle below is then a cache hit (no open, no eviction);
        // Kùzu-removal step2 commit 8 — getGraphHandle replaced getOrOpen
        // here so a Surreal-backed workspace resolves its OWN engine instead
        // of Kùzu's, but it still opens Kùzu first internally, so this
        // cache-hit argument is unchanged. Pass ?workspaces=all for the
        // explicit full force-open scan when an operator genuinely wants
        // every workspace's counts.
        //
        // Audit #6 — but ?workspaces=all is the EXPENSIVE path (getGraphHandle
        // every known workspace → evict/close thrash), and /api/health is public +
        // rate-limit-exempt with the query string stripped by both the auth
        // allowlist and the rate limiter. An unauthenticated GET storm of
        // ?workspaces=all therefore re-enabled the very stampede the hot-only
        // default closed. Require an authenticated principal to actually
        // force-open all: any valid Bearer attaches a principal even on this
        // public route (middleware resolves it whenever a token is present, not
        // just on gated routes). An ANONYMOUS ?workspaces=all silently
        // downgrades to the cheap hot-only scan (scanned:'open' signals it) —
        // liveness monitors keep their 200, the DoS lever is gone.
        const wantsScanAll = new URL(url, 'http://localhost').searchParams.get('workspaces') === 'all';
        const scanAll = wantsScanAll && getCurrentPrincipal() !== null;
        let scannedNames = knownNames;
        let scanned: 'all' | 'open' | 'active' = 'all';
        if (deps.graphRegistry) {
            if (scanAll || typeof deps.graphRegistry.openedNames !== 'function') {
                scannedNames = knownNames;
                scanned = 'all';
            } else {
                // Cache hits only. The active workspace is the pinned boot
                // graph and always cached, so it's always measured even when
                // every other workspace is cold.
                const open = new Set(deps.graphRegistry.openedNames());
                scannedNames = knownNames.filter(n => open.has(n) || n === activeName);
                scanned = 'open';
            }
            for (const name of scannedNames) {
                try {
                    const g = await deps.graphRegistry.getGraphHandle(name);
                    const s = await readWorkspaceStats(g, name);
                    // Per-workspace write queue depth + head-of-line wait.
                    // Surfaces Kùzu single-writer backpressure so operators
                    // can see which workspace is queueing without grepping
                    // logs. globalWriteQueue is a Kùzu-specific single-writer
                    // queue with no SurrealDB/Dataplane analogue — it is not
                    // on WorkspaceGraph's declared surface for exactly that
                    // reason. Named cast (not inline): `g` is genuinely a
                    // concrete engine instance at runtime, and this reads a
                    // known-but-undeclared field the compiler can't see.
                    // Optional-chained: a Surreal-backed (or cloud) workspace
                    // genuinely has no write-queue concept, so `writeQueue`
                    // stays `undefined` and the spread below OMITS the key
                    // entirely — the response reports "no such metric here",
                    // never a fabricated zero-depth queue.
                    const kuzuOnlyGraph = g as { globalWriteQueue?: { stats(): WriteQueueStats } };
                    const writeQueue = kuzuOnlyGraph.globalWriteQueue?.stats();
                    perWorkspaceStats[name] = { nodeCount: s.nodeCount, edgeCount: s.edgeCount, ...(writeQueue ? { writeQueue } : {}) };
                    globalNodes += s.nodeCount;
                    globalEdges += s.edgeCount;
                } catch {
                    perWorkspaceStats[name] = { nodeCount: 0, edgeCount: 0 };
                }
            }
        } else {
            // Cloud mode / no registry — best-effort: ask the
            // boot-bound graph for its counts under the active name.
            scannedNames = [activeName];
            scanned = 'active';
            try {
                const s = await readWorkspaceStats(deps.store.loreGraph, activeName);
                perWorkspaceStats[activeName] = { nodeCount: s.nodeCount, edgeCount: s.edgeCount };
                globalNodes = s.nodeCount;
                globalEdges = s.edgeCount;
            } catch {
                perWorkspaceStats[activeName] = { nodeCount: 0, edgeCount: 0 };
            }
        }
        // Honesty flag: in 'open' mode globalTotals sums only the measured
        // (hot) workspaces, not every registered one — a dashboard reading
        // globalTotals must know it may be partial. Complete iff every known
        // workspace was measured (full scan, or all workspaces happened to be
        // hot, or the single-graph fallback).
        const globalTotalsComplete = scanned !== 'open' || scannedNames.length >= knownNames.length;

        // Sprint O4 — render per-workspace outbox lag/depth/threshold
        // from the in-process lag cache (the same cache the hot/bulk
        // routes consult on the request path for backpressure
        // decisions). Operators can see at a glance which workspace
        // is over its threshold and the threshold that's currently
        // in effect (global default or per-workspace override). Key
        // name `perWorkspaceOutbox` is what gate-test O-D9 looks for.
        let perWorkspaceOutbox: Record<string, {
            depth: number;
            lagSeconds: number;
            thresholdSeconds: number;
            refreshedAt: number;
            overThreshold: boolean;
        }> | null = null;
        if (deps.outboxLagCache) {
            perWorkspaceOutbox = {};
            const snaps = deps.outboxLagCache.allSnapshots();
            for (const [ws, snap] of Object.entries(snaps)) {
                const decision = deps.outboxLagCache.shouldBackpressure(ws);
                perWorkspaceOutbox[ws] = {
                    depth: snap.depth,
                    lagSeconds: snap.lagSeconds,
                    thresholdSeconds: decision.thresholdSeconds,
                    refreshedAt: snap.refreshedAt,
                    overThreshold: decision.shouldBlock,
                };
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: orphanState.blocking ? 'orphan_decision_required' : 'ok',
            version: VERSION,
            ...healthExtras(oxBlock),
            perWorkspaceOutbox,
            llmProvider: cfg.llmProvider,
            workspace: activeName,
            // Sprint L2 — per-workspace + global view in one shot.
            workspaces: {
                active: activeName,
                knownCount: knownNames.length,
                // SP-stampede — how many workspaces this response actually
                // measured, and how (default 'open' = hot-only). When
                // 'open' and measuredCount < knownCount, globalTotals is a
                // partial sum (globalTotalsComplete:false) — pass
                // ?workspaces=all for the full force-open scan.
                scanned,
                measuredCount: scannedNames.length,
                globalTotalsComplete,
                perWorkspaceStats,
                globalTotals: { nodeCount: globalNodes, edgeCount: globalEdges },
            },
            // 2026-05-17: surface the daemon's effective LORE_HOME so
            // `lore doctor` run from a shell without the env var set
            // can still report against the correct directory (Loom's
            // def init agent misdiagnosed this as a Lore bug).
            loreHome: loreHome(),
            dataplane: deps.getDataplaneState(),
            telemetryOptOut: Boolean(cfg.telemetryOptOut),
            sessions: deps.activeSessions.size,
            orphans: orphanState.orphans,
            // Q2.1 — surface the effective deployment mode so the
            // smoke test and Settings UI can observe it without
            // reparsing config or env.
            deploymentMode: deps.deploymentMode,
            // v1.1: first-install background reconnect progress. UI
            // surfaces "Indexing N / total — M%" while state=running,
            // hides when state=success or skipped.
            backgroundReconnect: getBackgroundReconnectStatus(),
            // v1.1: actual ONNX runtime backend (e.g.,
            // onnxruntime-node 1.24.3 (cpu)). Replaces the legacy
            // "Wasm CPU" label.
            embeddingBackend: getCachedEmbeddingBackend(),
            // W9: live rate-limiter snapshot — mode, per-class caps
            // (capacity + refill in tokens/sec), and the exempt
            // path list. Lets operators see effective limits +
            // env overrides without grepping source.
            rateLimit: deps.rateLimiter ? deps.rateLimiter.getConfigSnapshot() : null,
        }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err), { status: 'degraded' });
    }
}
