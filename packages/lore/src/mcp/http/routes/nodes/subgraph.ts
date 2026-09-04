/**
 * subgraph.ts — GET /api/subgraph — multi-hop BFS for the "Look in" view.
 *
 * Returns BOTH the visited nodes AND the edges between them. Star/spoke
 * layouts are useless for a domain entity — users need cross-connections
 * (NodeA↔NodeB↔NodeC, ParentX↔ChildY, etc).
 *
 * BFS from id up to depth (default 2, max 4). Collect nodes, then issue a
 * second Cypher pass for all edges where both endpoints are in the visited
 * set. Cap at limit (default 60) to keep the render readable. By default
 * semantic-similarity edges (confidence='inferred') are dropped so the
 * subgraph is the user-asserted structure only.
 *
 * R5 #5 — `?ecosystem=` (optional; omitted/'*' = every ecosystem, so existing
 * callers are unchanged). This is the REST twin of the MCP `traverse` tool: it
 * runs the same multi-hop BFS over the same LoreEdge rows, which carry NO
 * ecosystem predicate, so a correctly-scoped centre node could pull a
 * DIFFERENT ecosystem's node — and its full edge topology — into the response
 * across a single autolink edge. `traverse` and retrieve()'s traversal hops
 * both gained a per-hop filter; this route was absent from that list.
 * Confinement is applied to the CENTRE here and per hop in `subgraphFetch`.
 */

import type { ServerResponse } from 'node:http';
import { subgraphFetch, type NeighborGraph } from '../../../../engines/graphNeighbors.js';
import { ecosystemMatches } from '../../../../core/ecosystemMatch.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { filterNodesByActorScope } from '../../../../security/scopeFilter.js';
import { resolveReadGraph } from './readGate.js';
import type { NodesDeps } from './types.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';

export async function handleSubgraph(res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    try {
        const u = new URL(url, 'http://localhost');
        const id = u.searchParams.get('id') ?? '';
        const depth = Math.min(Math.max(Number(u.searchParams.get('depth') ?? '2'), 1), 4);
        const limit = Math.min(Math.max(Number(u.searchParams.get('limit') ?? '60'), 5), 200);
        // Default: drop semantic-similarity edges (confidence='inferred')
        // so the subgraph is the user-asserted structure only — semantic
        // ghosts otherwise leak unrelated tenants/buildings.
        const includeInferred = u.searchParams.get('includeInferred') === 'true';
        const ecoParam = u.searchParams.get('ecosystem');
        const ecosystem = ecoParam && ecoParam.length > 0 ? ecoParam : '*';
        if (!id) {
            writeError(res, 400, 'bad_request', 'id query param required');
            return;
        }
        // SP-04 — workspace_required + token-scoped read gate +
        // workspace-aware graph resolution before any node read. Subgraph
        // BFS can walk hundreds of nodes per call; gate the entry point.
        const readGraph = await resolveReadGraph(res, url, deps);
        if (!readGraph) return;
        const stripped = id.startsWith('lore:') ? id.slice(5) : id;
        const center = await readGraph.getNode(stripped);
        if (!center) {
            writeError(res, 404, 'node_not_found', `Node "${id}" not found`);
            return;
        }
        // Entering the walk from a foreign node is the same boundary crossing
        // as ending on one. Reported as a SCOPE result, not "not found" — the
        // row exists and GET /api/node returns it (same distinction
        // `traverse` draws, DEC-SCOPE-HONESTY).
        if (!ecosystemMatches((center as { ecosystem?: string }).ecosystem, ecosystem)) {
            writeError(res, 404, 'node_outside_ecosystem',
                `Node "${id}" exists but is outside the requested ecosystem scope '${ecosystem}'`,
                { ecosystem });
            return;
        }
        // 3.1 (2026-08-17) — row-level scope confinement of the centre,
        // reported the same way as a missing node — the foreign row must not
        // seed the walk.
        if (filterNodesByActorScope([center]).length === 0) {
            writeError(res, 404, 'node_not_found', `Node "${id}" not found`);
            return;
        }

        let nodesOut: Array<{ id: string; label: string; type: string; tags?: string[]; depth: number }>;
        let edgesOut: Array<{ source: string; target: string; relation: string; confidence: string | undefined }>;
        let visitedSize: number;

        // ONE implementation for every backend — see getNode.ts for why the
        // raw-Cypher fallback that used to live here is gone rather than
        // guarded. On a Surreal-backed workspace it ran against the other
        // engine's instance, whose node table is EMPTY there, and rendered
        // an empty subgraph with a 200. `subgraphFetch` (engines/graphNeighbors.ts) is
        // built from the portable queryEdges + getNodesByIds verbs that every
        // backend implements, so all of them now walk the same BFS.
        const fetched = await subgraphFetch(
            readGraph as unknown as NeighborGraph,
            stripped,
            { label: center.label, type: center.type, tags: center.tags },
            depth,
            limit,
            includeInferred,
            ecosystem,
        );
        // Prepend the center at depth 0 — the typed fetch excludes it, matching
        // the old Cypher path's visited-set which seeded the center first.
        nodesOut = [
            { id: stripped, label: center.label, type: center.type, tags: center.tags, depth: 0 },
            ...fetched.nodes,
        ];
        edgesOut = fetched.edges;
        visitedSize = nodesOut.length;

        // 3.1 (2026-08-17) — row-level scope confinement of the visited node
        // set. SubgraphNode summaries carry no security_scopes, so re-hydrate
        // the (already capped ≤200) visited ids in ONE bounded batch — the
        // same pattern the edges/topology routes use — and filter on the
        // hydrated rows via the shared helper. Only the node LIST is confined;
        // edges and the centre's own summary keep their existing shape.
        const visitedById = await readGraph.getNodesByIds(nodesOut.map((n) => n.id));
        const confinedNodes = filterNodesByActorScope(
            nodesOut.map((n) => ({ ...n, security_scopes: visitedById.get(n.id)?.security_scopes })),
        );
        const visibleIds = new Set(confinedNodes.map((n) => n.id));
        nodesOut = nodesOut.filter((n) => visibleIds.has(n.id));
        // GAP 2 follow-up (2026-08-17) — trivial addition alongside the same
        // fix: an edge whose endpoint was just confined out of nodesOut must
        // not still reference that id. This edge shape carries no label/type
        // (id-only leak, lower severity than getNode.ts's neighbour rows —
        // see 2026-08-17 GAP 2 follow-up report), but there is no reason to
        // leave a dangling reference once visibleIds is already computed.
        edgesOut = edgesOut.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            center: { id: center.id, label: center.label, type: center.type, tags: center.tags },
            nodes: nodesOut,
            edges: edgesOut,
            ecosystem,
            depth,
            truncated: visitedSize >= limit,
        }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}
