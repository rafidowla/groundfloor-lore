/**
 * bulkLoader/selectGraphAdapter.ts — graph-adapter selection for the
 * bulk-load dispatcher.
 *
 * Which bulk adapter the load-jobs wiring builds is decided by what the LIVE
 * graph handle actually exposes (the mcp/bootSteps.ts buildGraphReaders
 * capability pattern), not by an assumed class: the local/embedded graph is
 * SurrealGraph, which carries `bulkUpsertNodes` (`addEdge` is on the shared
 * GraphProvider surface, so it discriminates nothing). Cloud's
 * DataplaneGraph carries neither, which yields NO graph adapter — graph
 * rows then fail closed per-row in the dispatcher instead of being miscast
 * into a graph adapter (the bug this module originally fixed:
 * `d.getGraph() as LocalGraph` used to hand a SurrealGraph, which has no
 * `withBulkConnection`, to a loader that assumed one — every
 * graph.node/graph.edge bulk load on a Surreal-backed workspace silently
 * broke). Same intersect-the-handle pattern as bootSteps.ts's
 * SchemaOpsCapableGraph: capability, not class.
 */

import { SurrealBulkLoaderAdapter, type SurrealBulkGraphSurface } from './surrealAdapter.js';
import type { LoreEdge, LoreNode } from '../providers/types.js';

/**
 * The narrow structural surface this module needs from a graph handle — not
 * the full `LoreGraph` union, so this file stays a leaf under bulkLoader/
 * rather than reaching up into mcp/services.js.
 */
export type GraphBulkLoadHandle = {
    addEdge(edge: LoreEdge): Promise<void>;
    bulkUpsertNodes?: SurrealBulkGraphSurface['bulkUpsertNodes'];
};

export interface GraphBulkLoaderAdapters {
    surreal?: SurrealBulkLoaderAdapter;
}

/** Node row shape the SurrealBulkLoaderAdapter constructor accepts, without
 *  pulling in the `GraphNodeRow` type here (structurally identical). */
type BulkUpsertNode = Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;

/**
 * Build the (at most one) graph bulk-load adapter this handle supports.
 *
 * Method calls (not detached refs) keep `this` bound to the handle; the
 * non-null asserts re-assert each typeof guard across the closure boundary.
 */
export function selectGraphBulkLoaderAdapter(handle: GraphBulkLoadHandle): GraphBulkLoaderAdapters {
    if (typeof handle.bulkUpsertNodes === 'function') {
        return {
            surreal: new SurrealBulkLoaderAdapter({
                graph: {
                    bulkUpsertNodes: (batch: BulkUpsertNode[]) => handle.bulkUpsertNodes!(batch),
                    addEdge: (edge) => handle.addEdge(edge),
                },
            }),
        };
    }
    return {};
}
