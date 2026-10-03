/**
 * syncPullEdge.ts — how SyncEngine.pullRemote() applies one pulled edge
 * (extracted from syncEngine.ts for size).
 *
 * 3.26.0: a pulled edge is written under that triple's edge lock
 * (core/nodeWriteLock.ts `withEdgeLock`), the same lock the request-path edge
 * writers hold. Without it, an edge pulled between a failed edge call's
 * pre-read and its undo (mcp/edgeWriteRollback.ts) was removed by that undo.
 *
 * The lock is a leaf lock: only the graph write runs inside it.
 */

import type { LoreEdge } from '../providers/types.js';
import { withEdgeLock } from '../core/nodeWriteLock.js';

/**
 * The workspace name the request-path edge writers lock on FOR THE GRAPH THIS
 * ENGINE WRITES: the name that graph is registered under, not the live active
 * workspace (an engine's graph is fixed at construction and does not follow a
 * later switch). A getter is accepted for a caller whose graph does follow
 * the name. Null (CLI commands, which run in their own process, and tests):
 * the edge is written unlocked.
 */
export type PullEdgeLockWorkspace = string | (() => string) | null;

/** Write one pulled edge, under its edge lock when a lock workspace is known.
 *  A getter is read per edge, so a workspace switch mid-pull is followed. */
export async function applyPulledEdge(
    graph: { addEdge(edge: LoreEdge): Promise<unknown> },
    lockWorkspace: PullEdgeLockWorkspace,
    edge: LoreEdge,
): Promise<void> {
    const ws = typeof lockWorkspace === 'function' ? lockWorkspace() : lockWorkspace;
    if (!ws) {
        await graph.addEdge(edge);
        return;
    }
    await withEdgeLock(ws, edge.sourceId, edge.targetId, edge.relation, () => graph.addEdge(edge));
}

/** `LoreEdge` declares no timestamp, but adapters may attach `updatedAt` /
 *  `createdAt`; pullRemote() reads them to move its page cursor (TW-4b). */
export function pulledEdgeTimestamp(edge: LoreEdge): string | undefined {
    const stamped = edge as { updatedAt?: string; createdAt?: string };
    return stamped.updatedAt ?? stamped.createdAt;
}
