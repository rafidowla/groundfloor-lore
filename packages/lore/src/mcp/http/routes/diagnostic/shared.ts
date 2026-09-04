/**
 * shared.ts — types + the cross-handler stats helper for the diagnostic
 * route family. DiagnosticDeps is the bundle every diagnostic handler
 * receives; readWorkspaceStats is used by the stats and health handlers.
 */

import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { StorageBundle } from '../../../services.js';
import type { ConfigManager } from '../../../../config/configManager.js';
import type { LocalGraphRegistry } from '../../../../engines/localGraphRegistry.js';
import type { RateLimiter } from '../../../../security/rateLimit.js';
import type { OutboxAggregateStats } from '../../../../outbox/types.js';
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
}

/**
 * Sprint L2 / L5b-final — narrow stats helper. Reads counts off the
 * workspace-specific LocalGraph. Pre-L5b, each workspace had its own
 * graph file so graph.getStats() WAS the per-workspace count. After
 * L5b-final, alias workspaces (`atlas`) share an on-disk path with
 * another workspace (`default`); within that shared graph the rows are
 * separated by their `n.project` tag, so we pass `workspaceName` as a
 * project filter. LocalGraph.getStats ignores the filter when called
 * without it (back-compat for callers that still want per-DB totals).
 */
export async function readWorkspaceStats(graph: LoreGraph, workspaceName?: string): Promise<{ nodeCount: number; edgeCount: number; typeBreakdown: Record<string, number> }> {
    const s = workspaceName
        ? await (graph as { getStats: (p?: string) => ReturnType<typeof graph.getStats> }).getStats(workspaceName)
        : await graph.getStats();
    return {
        nodeCount: s.nodeCount ?? 0,
        edgeCount: s.edgeCount ?? 0,
        typeBreakdown: s.typeBreakdown ?? {},
    };
}
