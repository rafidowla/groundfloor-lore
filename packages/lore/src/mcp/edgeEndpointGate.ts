/**
 * edgeEndpointGate.ts — row-level security_scopes gate for the SINGLE-edge
 * write doors (POST/DELETE /api/edge, MCP store_edge / delete_edge).
 *
 * An edge whose endpoint is hidden from the BOUND actor must answer exactly as
 * if that endpoint did not exist, and write nothing (no graph row, no outbox
 * row). Create: the engine's own `edge_endpoint_missing` error is rebuilt by
 * assertEdgeEndpoints (the helper the Dataplane graph already shares with the
 * local engines, same wording) from the endpoints that exist AND are visible,
 * so a hidden endpoint is named in the message exactly like a missing one — and
 * a hidden source next to a truly missing target still names both. Delete: a
 * hidden endpoint counts as "no edge matched" (deleted = 0), the same answer
 * the routes give for a triple that does not exist.
 *
 * Unbound callers short-circuit before any lookup.
 */

import type { LoreEdge } from '../providers/types.js';
import { assertEdgeEndpoints } from '../engines/dataplaneEdgeShape.js';
import { getCurrentActorScopes } from '../security/actorContext.js';
import type { ItemScopeDeps } from '../security/itemScopes.js';
import { mutateTargetVisible } from '../security/writeTargetGate.js';

/** Graph handle surface the gate reads; the SAME graph the write goes to. */
export interface EdgeGateGraph {
    getNode(id: string): Promise<{ security_scopes?: unknown } | null | undefined>;
}

/** ItemScopeDeps reading from the graph the edge is written to. */
export function edgeGateDeps(workspace: string, graph: EdgeGateGraph): ItemScopeDeps {
    return { workspace, getGraphNode: (id) => graph.getNode(id) };
}

/**
 * Classify the endpoints for a bound actor. Returns null for an unbound caller
 * (no lookups). `usable` = exists in the graph AND visible; `anyHidden` = at
 * least one endpoint exists but is not visible.
 */
async function classify(ids: string[], deps: ItemScopeDeps): Promise<{ usable: Set<string>; anyHidden: boolean } | null> {
    if (getCurrentActorScopes() === undefined) return null;
    const usable = new Set<string>();
    let anyHidden = false;
    for (const id of new Set(ids)) {
        const node = await deps.getGraphNode!(id);
        if (!node) continue; // truly missing: the engine reports it
        if (await mutateTargetVisible({ nodeId: id, verbatimId: `lore:${id}` }, deps)) usable.add(id);
        else anyHidden = true;
    }
    return { usable, anyHidden };
}

/**
 * Create path: throws the engine's `edge_endpoint_missing` error when an
 * endpoint is hidden from the bound actor. Does nothing otherwise (a truly
 * missing endpoint is left to the engine, which already refuses it).
 */
export async function assertEdgeEndpointsVisible(edge: Pick<LoreEdge, 'sourceId' | 'targetId'>, deps: ItemScopeDeps): Promise<void> {
    const c = await classify([edge.sourceId, edge.targetId], deps);
    if (!c || !c.anyHidden) return;
    assertEdgeEndpoints(edge as LoreEdge, c.usable);
}

/** Delete path: true when an endpoint is hidden from the bound actor (answer as "no such edge"). */
export async function edgeEndpointHidden(sourceId: string, targetId: string, deps: ItemScopeDeps): Promise<boolean> {
    const c = await classify([sourceId, targetId], deps);
    return !!c && c.anyHidden;
}
