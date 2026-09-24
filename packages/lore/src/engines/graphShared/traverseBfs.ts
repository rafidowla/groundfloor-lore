/**
 * graphShared/traverseBfs.ts — engine-agnostic per-hop BFS core, shared by
 * every local graph engine's `traverse()` / `traverseDirected()`.
 *
 * 3.21 step 1a extraction: this logic previously lived twice — once in
 * `surreal/surrealGraphReads.ts` (`traverseUncached`) and once in
 * `surreal/surrealGraphDirected.ts` (`traverseDirected`) — and was about to
 * be copied a third time for `sqliteGraph.ts`. Copies drift; the design doc
 * for the SQLite engine (`321-STEP1-SQLITE-GRAPH-DESIGN.md`) is explicit
 * that parity has to come from shared code, not a second hand-written BFS.
 *
 * The ONLY thing that differs between engines is how one frontier level's
 * edges are fetched (one query per hop, ideally on an indexed adjacency).
 * That is injected as `fetchFrontierEdges` / `fetchDirectedFrontier` —
 * everything else (visited-set bookkeeping, node-cap enforcement, discovery
 * sub-order, depth bookkeeping) is identical across backends BY
 * CONSTRUCTION, because it is the same function.
 *
 * Discovery sub-order: the frontier is iterated in FRONTIER order (not
 * fetch-result order); within a frontier node, outgoing edges sort before
 * incoming ones, and WITHIN each direction, edges sort by (relation, other
 * node id). That full ordering is enforced HERE, once, by {@link
 * sortFrontierEdges} — not left to whatever order each engine's query
 * happens to return. Before this existed, `fetchFrontierEdges` on
 * SurrealGraph returned SurrealDB's own graph-projection order and
 * SqliteGraph's returned SQLite's own index-scan order, and the two could
 * genuinely disagree on which of several outgoing edges from the SAME node
 * came "first" — a real, observable difference, not a cosmetic one. Sorting
 * centrally means every engine's `fetchFrontierEdges` can return edges in
 * WHATEVER order is cheapest for it to produce; determinism is this
 * module's job, not each engine's.
 */

/** One directed edge as a frontier-fetch returns it, before sub-order sorting. */
export interface FrontierEdgeCandidate {
    to: string;
    relation: string;
    direction: 'out' | 'in';
}

/**
 * sortFrontierEdges — the ONE place same-node sub-order is decided:
 * outgoing before incoming, then (relation, other node id) ascending within
 * each direction. Every engine's `fetchFrontierEdges` / `fetchDirectedFrontier`
 * may return a frontier node's edges in ANY order; this always produces the
 * same result from the same edge SET, so two engines with the same graph
 * data always expand a node identically.
 */
export function sortFrontierEdges<T extends FrontierEdgeCandidate>(edges: readonly T[]): T[] {
    return [...edges].sort((a, b) =>
        (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1)
        || a.relation.localeCompare(b.relation)
        || a.to.localeCompare(b.to));
}

/** One BFS step for the undirected `traverse()` walk. */
export interface TraverseBfsStep {
    /** The node reached by this step. */
    id: string;
    depth: number;
    relation: string;
}

export interface TraverseBfsResult {
    steps: TraverseBfsStep[];
    /** True when the walk stopped early because it hit `nodeCap`. */
    capped: boolean;
}

/**
 * runTraverseBfs — the depth-limited, per-hop BFS behind `traverse()`.
 *
 * `fetchFrontierEdges` resolves ONE frontier level: given the current
 * frontier (a list of node ids), it returns every edge touching those nodes
 * in EITHER direction, keyed by the frontier node it was reached from —
 * outgoing before incoming, per node with no edges present as an empty
 * array or simply absent (`?? []` on read covers both). One query per hop,
 * not one per frontier node, is the engine's job; this function's job is
 * the walk itself.
 */
export async function runTraverseBfs(
    seedId: string,
    clampedDepth: number,
    nodeCap: number,
    fetchFrontierEdges: (
        frontier: string[],
    ) => Promise<Map<string, FrontierEdgeCandidate[]>>,
): Promise<TraverseBfsResult> {
    const visited = new Set<string>([seedId]);
    const steps: TraverseBfsStep[] = [];
    let frontier: string[] = [seedId];
    let capped = false;

    bfs:
    for (let depth = 1; depth <= clampedDepth; depth++) {
        const byFrontier = await fetchFrontierEdges(frontier);
        const nextFrontier: string[] = [];
        // Iterate in FRONTIER order (not result order) so the same-depth
        // sub-order is deterministic and matches every engine's discovery
        // order. Within a frontier node, `sortFrontierEdges` fixes the
        // rest of the order — see this file's header.
        for (const currentId of frontier) {
            for (const edge of sortFrontierEdges(byFrontier.get(currentId) ?? [])) {
                if (visited.has(edge.to)) continue;
                visited.add(edge.to);
                nextFrontier.push(edge.to);
                steps.push({ id: edge.to, depth, relation: edge.relation });
                if (steps.length >= nodeCap) { capped = true; break bfs; }
            }
        }
        if (nextFrontier.length === 0) break;
        frontier = nextFrontier;
    }
    return { steps, capped };
}

/** One BFS step for the direction-preserving `traverseDirected()` walk. */
export interface DirectedBfsStep {
    /** The node reached by this step. */
    to: string;
    depth: number;
    relation: string;
    /** Which way the edge points, relative to `via`. */
    direction: 'out' | 'in';
    /** The node this step was expanded from. */
    via: string;
}

export interface DirectedBfsResult {
    steps: DirectedBfsStep[];
    capped: boolean;
}

/**
 * runDirectedTraverseBfs — the directed counterpart of {@link
 * runTraverseBfs}, behind `traverseDirected()`.
 *
 * Two things this walk does that the undirected one does not:
 *   - `visited` gates EXPANSION only (a node is expanded once); `emitted`
 *     separately dedupes exact (via, direction, relation, to) quadruples, so
 *     every distinct directed edge into an already-visited node is still
 *     reported — the documented contract is "rebuild a directed subgraph",
 *     which needs all of them, not just the first edge that reached a node.
 *   - the seed itself is never re-emitted as a step, even if an edge points
 *     back to it.
 */
export async function runDirectedTraverseBfs(
    seedId: string,
    clampedDepth: number,
    nodeCap: number,
    fetchDirectedFrontier: (
        frontier: string[],
    ) => Promise<Map<string, FrontierEdgeCandidate[]>>,
): Promise<DirectedBfsResult> {
    const visited = new Set<string>([seedId]);
    const steps: DirectedBfsStep[] = [];
    const emitted = new Set<string>();
    let frontier: string[] = [seedId];
    let capped = false;

    bfs:
    for (let depth = 1; depth <= clampedDepth; depth++) {
        const byFrontier = await fetchDirectedFrontier(frontier);
        const nextFrontier: string[] = [];
        for (const currentId of frontier) {
            for (const edge of sortFrontierEdges(byFrontier.get(currentId) ?? [])) {
                // Contract: the seed itself is never returned.
                if (edge.to === seedId) continue;
                const edgeKey = `${currentId}|${edge.direction}|${edge.relation}|${edge.to}`;
                if (!emitted.has(edgeKey)) {
                    emitted.add(edgeKey);
                    steps.push({ to: edge.to, depth, relation: edge.relation, direction: edge.direction, via: currentId });
                    if (steps.length >= nodeCap) { capped = true; break bfs; }
                }
                if (!visited.has(edge.to)) {
                    visited.add(edge.to);
                    nextFrontier.push(edge.to);
                }
            }
        }
        if (nextFrontier.length === 0) break;
        frontier = nextFrontier;
    }
    return { steps, capped };
}
