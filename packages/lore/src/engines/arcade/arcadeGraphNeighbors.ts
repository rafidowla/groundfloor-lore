/**
 * arcadeGraphNeighbors.ts — re-export shim.
 *
 * The implementation moved to `engines/graphNeighbors.ts` in Phase 3 of
 * docs/SURREALDB_BUILD_PLAN.md. It was always engine-agnostic — built only on
 * `queryEdges` + `getNodesByIds`, the verbs every backend implements
 * identically (see that file's header) — and it now has a second consumer in
 * the SurrealDB engine.
 *
 * The move is a relocation, not a rewrite: the code is byte-identical and
 * ArcadeDB's behaviour is unchanged. This shim keeps arcade's existing import
 * path working so no cloud-side file had to be edited.
 */

export {
    neighbors1Hop,
    subgraphFetch,
    type NeighborGraph,
    type NeighborRow,
    type SubgraphNode,
    type SubgraphEdge,
} from '../graphNeighbors.js';
