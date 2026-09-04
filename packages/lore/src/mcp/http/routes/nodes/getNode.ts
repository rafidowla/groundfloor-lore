/**
 * getNode.ts — GET /api/node — node detail for the UI drawer.
 *
 * Returns the node itself plus its immediate (1-hop) neighbors and the
 * edges connecting them. Consumed by the node-click drawer + the
 * "Ask about this" chat flow.
 *
 * R6 #1 — `?ecosystem=` (optional; omitted/'*' = every ecosystem, so existing
 * callers are unchanged). This is a TOPOLOGY surface by
 * DEC-SCOPE-SURFACE-CLASS's definition — it answers "what is connected to
 * this" — and it was the LAST one with no override at all. `neighbors1Hop` is
 * `subgraphFetch`'s walk at depth 1 over the same LoreEdge rows, which carry
 * no ecosystem predicate, so a correctly-scoped centre returned a foreign
 * tenant's id, label and type across one autolink edge, and the query param was
 * silently ignored rather than refused. Scope is applied to the CENTRE here and
 * to each hydrated neighbour in `neighbors1Hop`.
 */

import type { ServerResponse } from 'node:http';
import { neighbors1Hop, type NeighborGraph } from '../../../../engines/graphNeighbors.js';
import { ecosystemMatches } from '../../../../core/ecosystemMatch.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { filterNodesByActorScope } from '../../../../security/scopeFilter.js';
import { resolveReadGraph } from './readGate.js';
import type { NodesDeps } from './types.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';

export async function handleGetNode(res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    try {
        const u = new URL(url, 'http://localhost');
        const id = u.searchParams.get('id') ?? '';
        const ecoParam = u.searchParams.get('ecosystem');
        const ecosystem = ecoParam && ecoParam.length > 0 ? ecoParam : '*';
        if (!id) {
            writeError(res, 400, 'bad_request', 'id query param required');
            return;
        }
        // SP-04 — workspace_required + token-scoped read gate +
        // workspace-aware graph resolution. Returns null after writing
        // the 4xx (missing workspace, cross-workspace forbidden,
        // unknown workspace).
        const readGraph = await resolveReadGraph(res, url, deps);
        if (!readGraph) return;
        // Core only knows about LoreNodes. Externally-contributed nodes
        // (file:, symbol:) are in topology but not individually
        // addressable here — V1 limitation.
        const stripped = id.startsWith('lore:') ? id.slice(5) : id;
        const node = await readGraph.getNode(stripped);
        if (!node) {
            writeError(res, 404, 'node_not_found', `Node "${id}" not found`);
            return;
        }
        // A centre outside the requested scope is reported as a SCOPE result,
        // not "not found" — the row exists, and the same request with
        // ecosystem='*' returns it. Byte-identical to the distinction
        // GET /api/subgraph and MCP `traverse` draw (DEC-SCOPE-HONESTY).
        if (!ecosystemMatches((node as { ecosystem?: string }).ecosystem, ecosystem)) {
            writeError(res, 404, 'node_outside_ecosystem',
                `Node "${id}" exists but is outside the requested ecosystem scope '${ecosystem}'`,
                { ecosystem });
            return;
        }
        // 3.1 (2026-08-17) — row-level scope confinement of the centre. The
        // row exists, but the bound actor lacks its security_scopes, so it is
        // reported the same way as a missing node — a foreign row must not be
        // echoed back to the drawer (or used to seed the neighbour walk).
        if (filterNodesByActorScope([node]).length === 0) {
            writeError(res, 404, 'node_not_found', `Node "${id}" not found`);
            return;
        }
        // Pull immediate neighbors in both directions.
        //
        // ONE implementation for every backend. `neighbors1Hop`
        // (engines/graphNeighbors.ts) is built from the portable `queryEdges` +
        // `getNodesByIds` verbs, which SurrealDB and Arcade all have.
        //
        // This used to feature-detect a typed `neighbors1Hop` method and fall
        // back to raw Cypher when it was absent. The fallback was the bug: on a
        // Surreal-backed workspace it ran against another engine's instance,
        // whose node table is EMPTY there, and returned 200-with-no-neighbours. A route
        // that answers "no neighbours" for a node that has them is worse than
        // one that fails, so the fallback is gone rather than guarded.
        //
        // NO SILENT SWALLOW: a backend failure throws → the outer catch writes a
        // loud 500, never a 200-with-empty.
        const { outRows, inRows } = await neighbors1Hop(
            readGraph as unknown as NeighborGraph, stripped, ecosystem,
        );
        // GAP 2 (2026-08-17) — the neighbour list must be row-level scope
        // confined like the centre. A node the actor can't see must not leak its
        // id/label/type/relation/confidence as another node's neighbour. Hydrate
        // each neighbour's security_scopes once (getNodesByIds is on every
        // NeighborGraph) and filter the same way the centre is filtered.
        const neighborIds = [...new Set([...outRows, ...inRows].map((r) => r.id))];
        let scopeById: Map<string, string[]> = new Map(neighborIds.map((id) => [id, []]));
        try {
            const hydrated = await (readGraph as unknown as NeighborGraph).getNodesByIds(neighborIds);
            for (const [id, n] of hydrated) scopeById.set(id, n.security_scopes ?? []);
        } catch {
            // Hydration failure → empty scopes (public); a transient read error
            // must not hide the whole neighbour list.
        }
        const visibleIds = new Set(
            filterNodesByActorScope(neighborIds.map((id) => ({ id, security_scopes: scopeById.get(id) ?? [] }))).map((x) => x.id),
        );
        const neighbors = [
            ...outRows.filter((r) => visibleIds.has(r.id)).map((r) => ({
                id: r.id as string,
                label: r.label as string,
                type: r.type as string,
                relation: (r.rel as string) || 'related_to',
                confidence: (r.conf as string) ?? 'extracted',
                confidenceScore: typeof r.score === 'number' ? r.score : 1.0,
                depth: 1,
            })),
            ...inRows.filter((r) => visibleIds.has(r.id)).map((r) => ({
                id: r.id as string,
                label: r.label as string,
                type: r.type as string,
                relation: `← ${(r.rel as string) || 'related_to'}`,
                confidence: (r.conf as string) ?? 'extracted',
                confidenceScore: typeof r.score === 'number' ? r.score : 1.0,
                depth: 1,
            })),
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // The reported scope is the ENFORCED scope (DEC-SCOPE-HONESTY rule 1).
        res.end(JSON.stringify({ node, neighbors, ecosystem }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}
