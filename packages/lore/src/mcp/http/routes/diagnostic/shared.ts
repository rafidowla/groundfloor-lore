/**
 * shared.ts — types + the cross-handler stats helper for the diagnostic
 * route family. DiagnosticDeps is the bundle every diagnostic handler
 * receives; readWorkspaceStats / workspaceStatsProjectFilter are used by
 * the stats, health and metrics handlers.
 */

import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { StorageBundle } from '../../../services.js';
import type { ConfigManager } from '../../../../config/configManager.js';
import type { LocalGraphRegistry } from '../../../../engines/localGraphRegistry.js';
import type { RateLimiter } from '../../../../security/rateLimit.js';
import type { OutboxAggregateStats, OutboxStore } from '../../../../outbox/types.js';
import type { LoreGraphHandle } from '../../../../storage/loreStorageClient.js';

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
export type LoreGraph = LoreGraphHandle;
export type DataplaneState = 'unknown' | 'offline' | 'opted-out' | 'bound' | 'error';

export interface DiagnosticDeps {
    store: StorageBundle;
    configManager: ConfigManager;
    activeSessions: Map<string, StreamableHTTPServerTransport>;
    deploymentMode: 'local' | 'cloud';
    getDataplaneState: () => DataplaneState;
    /** W9: live rate-limiter snapshot for /api/health. Optional so
     *  existing tests / cloud-mode wiring without a limiter still type. */
    rateLimiter?: RateLimiter;
    /** Sprint L2 — multi-workspace registry. When present, /api/stats
     *  narrows to the requested workspace; /api/admin/stats iterates all
     *  known workspaces; /api/health surfaces a per-workspace counts block.
     *  Optional so older test-harness wiring still types. */
    graphRegistry?: LocalGraphRegistry;
    /** RC-round4 — per-workspace verbatim (LanceDB) resolver. Same resolver
     *  the outbox replicator + embed queue + lifecycle/prune routes use. The
     *  consistency-cleanup handler resolves the REQUESTED workspace's LanceDB
     *  through this so its destructive orphan-delete + compaction run against
     *  that workspace's store, never the boot/active default. Absent in cloud
     *  mode (no per-workspace resolver) — cleanup then refuses for a
     *  non-active workspace rather than defaulting to the boot store. */
    workspaceVerbatimResolver?: import('../../../../outbox/workspaceVerbatimResolver.js').WorkspaceVerbatimResolver;
    /** Sprint L2 — Dataplane handle for ReBAC gate on /api/admin/stats.
     *  Null in local mode (gateRoute short-circuits there). */
    dataplane?: GroundfloorClient | null;
    /** Sprint O1 — outbox stats provider. Returns per-workspace +
     *  aggregate outbox depth + lagSeconds. Optional so cloud-mode /
     *  bare-test wiring without an outbox still types. /api/health
     *  emits `outbox: null` when the provider is absent. */
    getOutboxStats?: () => Promise<OutboxAggregateStats>;
    /** Sprint O4 — per-workspace lag cache. /api/health renders its
     *  contents under the `perWorkspaceOutbox` key so operators can see
     *  which workspace is over its backpressure threshold without
     *  poking outbox.sqlite directly. Optional. */
    outboxLagCache?: import('../../../../outbox/lagCache.js').OutboxLagCache;
    /** 3.35.0 (a)/(p) - outbox store, for `deadLettered` in /api/stats and GET /api/outbox/dead.
     *  In arcade mode this is the lane-pinned store (it only ever sees the caller's cell). */
    outboxStore?: OutboxStore;
    /** 3.35.0 (e) - readiness override for /ready (tests inject a probe-backed one). Absent: the shared per-store readiness. */
    readiness?: import('../../../readiness.js').Readiness;
}

/**
 * 3.35.2 — the ONE rule for whether a per-workspace count filters on
 * `project`. Sprint L5b-final added the `project = <workspace>` filter for
 * ALIAS workspaces (`registerWorkspaceAlias`): several names share one
 * on-disk graph and their rows are told apart only by the `project` tag. It
 * was applied to every workspace, so a workspace with a store of its own
 * reported only the rows whose `project` happened to equal its name — a host
 * that tags rows per repo (Atlas: project='v3' in 'default') saw a fraction
 * of its corpus in /api/stats, /api/health, /api/admin/stats and /metrics.
 *
 * Returns the filter to pass to `getStats` / `visibleGraphStats`:
 *   - local registry, store shared with another registered workspace → the
 *     workspace name (alias semantics, unchanged);
 *   - local registry, store of its own → `undefined` (whole-store counts);
 *   - no `sharesGraphStore` on the registry (cloud: no registry; arcade: the
 *     cell shim in arcadeData.ts, which already maps the workspace filter to
 *     "the whole cell") → the workspace name, i.e. behaviour unchanged;
 *   - the registry lookup throws → the workspace name (fail to the old,
 *     narrower count rather than widen on an unreadable registry).
 */
export function workspaceStatsProjectFilter(registry: unknown, workspace: string | undefined): string | undefined {
    if (!workspace) return undefined;
    const shares = (registry as { sharesGraphStore?: (ws: string) => boolean } | null | undefined)?.sharesGraphStore;
    if (typeof shares !== 'function') return workspace;
    try {
        return shares.call(registry, workspace) ? workspace : undefined;
    } catch {
        return workspace;
    }
}

/**
 * Sprint L2 — narrow stats helper: node/edge counts + type breakdown for one
 * workspace's graph, scoped by workspaceStatsProjectFilter. Nodes, types and
 * edges share the one filter (an edge counts under a filter when both
 * endpoints carry it — the engines' getStats rule). Called without a
 * workspace it returns the graph's whole-store totals.
 */
export async function readWorkspaceStats(
    graph: LoreGraph,
    workspaceName?: string,
    registry?: unknown,
): Promise<{ nodeCount: number; edgeCount: number; typeBreakdown: Record<string, number> }> {
    const filter = workspaceStatsProjectFilter(registry, workspaceName);
    const s = filter !== undefined
        ? await (graph as { getStats: (p?: string) => ReturnType<typeof graph.getStats> }).getStats(filter)
        : await graph.getStats();
    return {
        nodeCount: s.nodeCount ?? 0,
        edgeCount: s.edgeCount ?? 0,
        typeBreakdown: s.typeBreakdown ?? {},
    };
}
