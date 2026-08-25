/**
 * graphNeighbors.ts — engine-agnostic 1-hop neighbor + multi-hop subgraph
 * fetch, shared by every graph backend.
 *
 * Relocated in Phase 3 of docs/SURREALDB_BUILD_PLAN.md from
 * `engines/arcade/arcadeGraphNeighbors.ts` (which now re-exports from here).
 * The code is unchanged; it simply has a second consumer now — the SurrealDB
 * engine — and it never had anything ArcadeDB-specific in it. The original
 * header follows, because the reasoning is what makes it portable.
 *
 * Original header (ArcadeDB db-per-app adapter, slice-3 parity close):
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * GET /api/node (with neighbors) and GET /api/subgraph originally issued RAW
 * Kùzu CYPHER (`MATCH (n:LoreNode)…`) through graph.getGraphContext().queryRows.
 * On the arcade graph handle queryRows is a bare ArcadeDB-SQL passthrough — the
 * ArcadeDB parser rejects Cypher (CommandSQLParsingException), and the route's
 * `.catch(() => [])` swallowed it, so the routes returned 200-with-EMPTY graph
 * data (silent wrong results — the exact silent-empty class the slice-1 SQL-trap
 * pins exist to kill). This module gives the arcade handle a TYPED, portable
 * neighbor/subgraph fetch built from the SAME crown-jewel verbs both backends
 * implement identically (queryEdges + getNodesByIds), so the routes feature-
 * detect it and delegate — no Cypher, no swallow, real neighbors.
 *
 * The route keeps LocalGraph/DataplaneGraph on their EXACT existing Cypher path
 * (those handles do NOT expose these methods, so the feature-detect misses and
 * the byte-identical local wire is preserved). Only the arcade handle carries
 * these, so arcade alone diverges from the Cypher path — onto a typed path that
 * produces the same wire shape.
 *
 * ── SQL-TRAP POSTURE ─────────────────────────────────────────────────────────
 * Everything here is built on queryEdges (which uses the verified
 * `outV().id`/`inV().id` link-field projection — NOT the dotted `out.`/`in.`
 * form that silently zeroes endpoints, trap T1) and getNodesByIds (plain
 * SELECT … WHERE id IN). No both()/expand-of-expand (traps T1/T2) and no
 * vector.neighbors (trap T3) are used, so the three known ArcadeDB SQL traps
 * do not apply.
 */

import type { LoreEdge, LoreNode } from '../providers/types.js';
import { ecosystemMatches } from '../core/ecosystemMatch.js';

/** A neighbor endpoint as the getNode route renders it (edge fields + node fields). */
export interface NeighborRow {
  id: string;
  label: string;
  type: string;
  rel: string;
  conf: string;
  score: number;
}

/** The graph surface these helpers need — the crown-jewel verbs both backends
 *  implement identically. Kept structural so the arcade store satisfies it. */
export interface NeighborGraph {
  queryEdges(q: { source?: string; target?: string; relation?: string; limit: number; offset: number }): Promise<LoreEdge[]>;
  getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>>;
}

/** Cap on edges pulled per direction — mirrors the route's implicit bound (the
 *  Cypher path returned all 1-hop edges; 10k is well above any realistic fan-out
 *  for the drawer view and keeps a pathological hub from unbounded hydration). */
const NEIGHBOR_EDGE_CAP = 10_000;

/** Node cap for a single traversal — mirrors `TRAVERSE_NODE_CAP` in
 *  localGraphReads.ts / surrealGraphReads.ts so the confined traverse path
 *  cannot materialise more than the engine path would. */
const TRAVERSE_NODE_CAP = 10_000;

/**
 * neighbors1Hop — the 1-hop out+in neighbors of `id`, shaped exactly like the
 * getNode route's Cypher rows ({id,label,type,rel,conf,score}). Out = edges
 * where `id` is the source (neighbor is the target); in = edges where `id` is
 * the target (neighbor is the source). Neighbor label/type hydrated in ONE
 * batch getNodesByIds round-trip. A neighbor whose node row is missing (dangling
 * edge) is dropped — same effective result as the Cypher MATCH, which requires
 * the neighbor vertex to exist.
 *
 * ecosystem confinement (R6 #1): `ecosystem` defaults to `'*'` — every
 * ecosystem, i.e. exactly the previous behaviour — and a concrete scope is
 * applied to the HYDRATED neighbour row, so a foreign row never reaches the
 * response. This is `subgraphFetch`'s confinement at depth 1, and it is the
 * same walk: `queryEdges` carries NO ecosystem predicate, so a correctly-scoped
 * centre pulls a DIFFERENT ecosystem's id, label and type across a single
 * autolink edge (`engines/reconnect.ts` drew exactly such edges). The two
 * functions sat 90 lines apart in this file and only one of them was given the
 * parameter; that asymmetry is the whole finding.
 */
export async function neighbors1Hop(
  graph: NeighborGraph,
  id: string,
  ecosystem: string = '*',
): Promise<{ outRows: NeighborRow[]; inRows: NeighborRow[] }> {
  const [outEdges, inEdges] = await Promise.all([
    graph.queryEdges({ source: id, limit: NEIGHBOR_EDGE_CAP, offset: 0 }),
    graph.queryEdges({ target: id, limit: NEIGHBOR_EDGE_CAP, offset: 0 }),
  ]);
  const neighborIds = new Set<string>();
  for (const e of outEdges) neighborIds.add(e.targetId);
  for (const e of inEdges) neighborIds.add(e.sourceId);
  const nodes = await graph.getNodesByIds([...neighborIds]);

  const scoped = ecosystem !== '*';
  const toRow = (nid: string, e: LoreEdge): NeighborRow | null => {
    const n = nodes.get(nid);
    if (!n) return null;
    // The hydrated GRAPH row is authoritative (retrieve.ts says the same about
    // its seed filter): the edge carries no ecosystem to push down on.
    if (scoped && !ecosystemMatches((n as { ecosystem?: string }).ecosystem, ecosystem)) return null;
    return {
      id: nid,
      label: n.label,
      type: n.type,
      rel: e.relation,
      conf: e.confidence ?? 'extracted',
      score: typeof e.confidenceScore === 'number' ? e.confidenceScore : 1.0,
    };
  };
  const outRows = outEdges.map((e) => toRow(e.targetId, e)).filter((r): r is NeighborRow => r !== null);
  const inRows = inEdges.map((e) => toRow(e.sourceId, e)).filter((r): r is NeighborRow => r !== null);
  // NOTE ON ORDER: outRows precede inRows (matching the getNode route, which
  // renders out-neighbors then in-neighbors), and within each the order follows
  // ArcadeDB's edge-storage iteration. Exact array order is NOT a portability
  // contract — LocalGraph's order is Kùzu's own insertion-scan order, which no
  // engine-agnostic sort reproduces; the neighbor SET (and every per-neighbor
  // field) is identical across backends, which is the contract that matters.
  return { outRows, inRows };
}

/** A subgraph node as the /api/subgraph route renders it (minus the center). */
export interface SubgraphNode {
  id: string;
  label: string;
  type: string;
  tags: string[];
  depth: number;
}
/** A subgraph edge as the route renders it. */
export interface SubgraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string | undefined;
}

/** One node reached by {@link confinedBfs}: the hydrated row (absent when the
 *  edge dangled), its min depth, and the relation of the edge that reached it. */
export interface WalkEntry {
  node: LoreNode | undefined;
  depth: number;
  relation: string;
}

/**
 * confinedBfs — THE multi-hop walk. `subgraphFetch` (GET /api/subgraph) and
 * `confinedTraverse` (the MCP `traverse` tool's scoped path) are both thin
 * shells over this one function, so the two surfaces cannot answer a
 * reachability question differently.
 *
 * ─── WHY THIS EXISTS AS A SHARED FUNCTION (R6 #2) ────────────────────────────
 * The round that added confinement to `subgraphFetch` pruned the FRONTIER: a
 * neighbour that fails the scope never joins `visited`, so the walk cannot pass
 * THROUGH a foreign node. `traverse` did the opposite — it walked unconfined and
 * filtered only its OUTPUT — so on `center(alpha) → mid(beta) → far(alpha)` the
 * REST route returned only the centre while the MCP tool returned `far`.
 * DECISIONS.md puts both in ONE class (DEC-SCOPE-SURFACE-CLASS, "TOPOLOGY
 * surfaces") and subgraph.ts's own header calls the route "the REST twin of the
 * MCP `traverse` tool", so two answers under one concrete scope was a defect in
 * whichever of them was wrong, with nothing stating which.
 *
 * FRONTIER-PRUNING is the settled semantic (DEC-SCOPE-REACHABILITY): a scoped
 * walk may not ROUTE THROUGH a node the caller cannot see. Post-filtering
 * leaks the fact that a path exists — and its length — through rows the scope
 * excludes, which on the one-workspace-many-tenants host these scopes exist for
 * is exactly the topology that must not cross. "Reachable" without qualification
 * is not a question a scoped read can answer; "reachable within your scope" is.
 *
 * Under `'*'` the predicate is a tautology, so pruning and post-filtering are
 * provably the same walk — which is why the unscoped paths were free to stay on
 * their existing implementations.
 *
 * @param limit Max entries INCLUDING the start node (the start is seeded here
 *              and returned, so callers that render it separately drop it).
 */
export async function confinedBfs(
  graph: NeighborGraph,
  startId: string,
  maxDepth: number,
  limit: number,
  ecosystem: string,
  keepEdge: (confidence: string | undefined) => boolean,
): Promise<Map<string, WalkEntry>> {
  const scoped = ecosystem !== '*';
  const keepNode = (n: LoreNode | undefined): boolean => {
    if (!scoped) return true;
    if (!n) return false; // unhydratable row cannot be proven in-scope
    return ecosystemMatches((n as { ecosystem?: string }).ecosystem, ecosystem);
  };

  const visited = new Map<string, WalkEntry>();
  visited.set(startId, { node: undefined, depth: 0, relation: '' });
  let frontier = [startId];

  for (let d = 1; d <= maxDepth; d++) {
    if (frontier.length === 0) break;
    if (visited.size >= limit) break;
    // Pull all incident edges of the frontier (both directions), one batch of
    // queryEdges per frontier node per direction. Bounded by limit downstream.
    const edgeLists = await Promise.all(
      frontier.flatMap((fid) => [
        graph.queryEdges({ source: fid, limit: NEIGHBOR_EDGE_CAP, offset: 0 }),
        graph.queryEdges({ target: fid, limit: NEIGHBOR_EDGE_CAP, offset: 0 }),
      ]),
    );
    const frontierSet = new Set(frontier);
    // Candidate neighbor ids reached this hop (the endpoint that ISN'T in the
    // frontier), edge-confidence filtered. Insertion order is frontier order,
    // outgoing before incoming — the discovery sub-order every engine's
    // `traverse` deliberately produces (localGraphReads.ts / surrealGraphReads.ts).
    const candidateIds = new Map<string, string>(); // id -> relation that reached it
    for (const list of edgeLists) {
      for (const e of list) {
        if (!keepEdge(e.confidence)) continue;
        const other = frontierSet.has(e.sourceId) ? e.targetId : e.sourceId;
        if (visited.has(other) || candidateIds.has(other)) continue;
        candidateIds.set(other, e.relation || 'related_to');
      }
    }
    if (candidateIds.size === 0) { frontier = []; continue; }
    const hydrated = await graph.getNodesByIds([...candidateIds.keys()]);
    const next: string[] = [];
    for (const [nid, relation] of candidateIds) {
      if (visited.has(nid)) continue;
      if (visited.size >= limit) break;
      const n = hydrated.get(nid);
      if (!keepNode(n)) continue;
      visited.set(nid, { node: n, depth: d, relation });
      next.push(nid);
    }
    frontier = next;
  }
  return visited;
}

/** A traversal hop as the MCP `traverse` tool renders it. */
export interface TraverseHop {
  node: LoreNode;
  depth: number;
  relation: string;
}

/**
 * confinedTraverse — `traverse`'s walk under a CONCRETE ecosystem scope, on the
 * shared {@link confinedBfs}. Same frontier-pruning semantic as
 * `GET /api/subgraph`, by construction rather than by prose.
 *
 * All edge confidences are walked (engine `traverse()` has no confidence
 * predicate either); a neighbour whose row does not hydrate is dropped, since
 * an unhydratable row cannot be shown to be in scope and the tool's contract
 * returns whole nodes.
 */
export async function confinedTraverse(
  graph: NeighborGraph,
  startId: string,
  maxDepth: number,
  ecosystem: string,
  limit: number = TRAVERSE_NODE_CAP,
): Promise<TraverseHop[]> {
  // Audit cluster 5 (2026-08-17): clamp depth exactly like the engine
  // traverse() paths (surrealGraphReads.ts / localGraphReads.ts clamp to
  // 1..5). Without this the MCP traverse tool answered DIFFERENTLY
  // depending on whether `ecosystem` was passed: depth 0 walked zero hops
  // and reported a confident "node is isolated", and depth > 5 was
  // unclamped on this path alone.
  const clampedDepth = Math.min(Math.max(Math.trunc(maxDepth), 1), 5);
  const visited = await confinedBfs(graph, startId, clampedDepth, limit, ecosystem, () => true);
  const hops: TraverseHop[] = [];
  for (const [nid, v] of visited) {
    if (nid === startId) continue;
    if (!v.node) continue;
    hops.push({ node: v.node, depth: v.depth, relation: v.relation });
  }
  // GraphProvider.traverse's contract: depth ascending, stable sub-order
  // within a depth. The BFS inserts in depth order already; this is a
  // no-op sort that documents the contract rather than assuming it.
  return hops.sort((a, b) => a.depth - b.depth);
}

/**
 * subgraphFetch — the BFS the /api/subgraph route runs, ported to the typed
 * verbs. Same contract as the route's Cypher BFS:
 *   - iterative per-depth BFS from `centerId` up to `depth` (both directions);
 *   - `visited` dedupe keyed on node id, min-depth wins;
 *   - stop expanding once `visited.size >= limit` (center counts toward limit);
 *   - by default drop inferred (semantic) edges — includeInferred keeps them;
 *   - collect edges where BOTH endpoints are in the visited set.
 * Returns nodes EXCLUDING the center (the route prepends the center at depth 0
 * itself) and the closed edge set. `truncated` is derived by the caller from
 * visited.size, so it is not returned here.
 *
 * confidence filtering: the Cypher path filters `e.confidence = "extracted"`.
 * queryEdges returns confidence per edge, so we apply the identical predicate
 * client-side (arcade has no cheap server-side confidence filter that also
 * yields the endpoint ids trap-safely, and the fan-out here is bounded by
 * `limit`).
 *
 * ecosystem confinement (R5 #5): `ecosystem` defaults to `'*'` — every
 * ecosystem, i.e. exactly the previous behaviour — and when a concrete scope
 * is passed it is applied PER HOP, on the hydrated row, before the neighbour
 * joins `visited`. This is the same reasoning `mcp/tools/traverse.ts` carries:
 * `queryEdges` walks LoreEdge with NO ecosystem predicate, so a correctly-
 * scoped start node can pull a DIFFERENT ecosystem's node into the result set
 * across a single edge — and autolink (`engines/reconnect.ts`) used to draw
 * exactly such cross-ecosystem edges. Because the closed-edge pass only keeps
 * edges whose BOTH endpoints are visited, confining `visited` confines the
 * edge topology too. A neighbour whose row does not hydrate (dangling edge)
 * cannot be shown to be in scope, so under a concrete scope it is dropped
 * rather than rendered as a bare id — under `'*'` it is kept, unchanged.
 *
 * R6 #2 — the walk itself is now {@link confinedBfs}, shared with the MCP
 * `traverse` tool, so the two TOPOLOGY surfaces cannot answer the same
 * reachability question differently. Read that function's header for why
 * frontier-pruning (rather than output filtering) is the settled semantic.
 *
 * `center` is the centre's rendered fields. The centre row itself is prepended
 * by the caller at depth 0 and is excluded from the returned `nodes`, so the
 * walk needs only `centerId`; the parameter is kept because it is the call
 * shape the engine wrappers (surrealGraph / arcadeGraphStore) mirror, and
 * because a caller that stops rendering the centre separately would need it.
 */
export async function subgraphFetch(
  graph: NeighborGraph,
  centerId: string,
  center: { label: string; type: string; tags?: string[] },
  depth: number,
  limit: number,
  includeInferred: boolean,
  ecosystem: string = '*',
): Promise<{ nodes: SubgraphNode[]; edges: SubgraphEdge[] }> {
  const keepEdge = (conf: string | undefined): boolean => includeInferred || conf === 'extracted';

  const visited = await confinedBfs(graph, centerId, depth, limit, ecosystem, keepEdge);

  // Collect edges where BOTH endpoints are in visited. One queryEdges per
  // visited node (source side) is enough to enumerate every directed edge whose
  // source is in the set; filter targets to the set. This mirrors the Cypher
  // `a.id IN set AND b.id IN set` closed-edge query.
  const ids = [...visited.keys()];
  const idSet = new Set(ids);
  const edgeMap = new Map<string, SubgraphEdge>();
  const perNode = await Promise.all(
    ids.map((sid) => graph.queryEdges({ source: sid, limit: NEIGHBOR_EDGE_CAP, offset: 0 })),
  );
  for (const list of perNode) {
    for (const e of list) {
      if (!idSet.has(e.sourceId) || !idSet.has(e.targetId)) continue;
      if (!keepEdge(e.confidence)) continue;
      const key = `${e.sourceId}|${e.targetId}|${e.relation}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          source: e.sourceId,
          target: e.targetId,
          relation: e.relation || 'related_to',
          confidence: e.confidence,
        });
      }
    }
  }

  const nodes: SubgraphNode[] = [];
  for (const [nid, v] of visited) {
    if (nid === centerId) continue; // center prepended by the route at depth 0
    nodes.push({
      id: nid,
      label: v.node?.label || nid,
      type: v.node?.type || 'note',
      tags: v.node?.tags ?? [],
      depth: v.depth,
    });
  }
  return { nodes, edges: [...edgeMap.values()] };
}
