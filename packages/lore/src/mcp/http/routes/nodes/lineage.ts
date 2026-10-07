/**
 * lineage.ts — GET /api/node/lineage?id=<nodeId>.
 *
 * Returns the full soft-supersession chain for a node: every prior version
 * (walk supersededBy backwards — a BRANCH walk, since a merge supersedes
 * several nodes with one successor) plus every successor (walk forward),
 * ordered oldest → newest. Capability-probed, not LocalGraph-only: it runs
 * on any backend whose graph handle implements the supersededBy back-walk
 * (`findSupersededByPredecessors`) — LocalGraph and SurrealGraph both
 * qualify. A backend that doesn't implement it gets a structured 501.
 */

import type { ServerResponse } from 'node:http';
import type { LoreNode } from '../../../../providers/types.js';
import { CloudModeUnsupportedError } from '../../../../engines/cloudModeUnsupportedError.js';
import { requireWorkspaceGraph } from '../../../../engines/requireWorkspaceGraph.js';
import type { WorkspaceGraph } from '../../../../engines/openWorkspaceGraph.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { filterNodesByActorScope } from '../../../../security/scopeFilter.js';
import { redactHiddenSuccessors } from '../../../../security/nodePointers.js';
import { resolveReadGraph } from './readGate.js';
import type { NodesDeps } from './types.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';

export async function handleLineage(res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    try {
        const lp = new URL(url, 'http://localhost').searchParams;
        const startId = lp.get('id') ?? '';
        if (!startId) {
            writeError(res, 400, 'bad_request', '`id` query param is required');
            return;
        }
        // SP-04 — workspace_required + token-scoped read gate +
        // workspace-aware graph resolution. Returns null after writing
        // the 4xx. The full supersession chain is sensitive (content of
        // every prior version), so gate before resolving the graph.
        const readGraph = await resolveReadGraph(res, url, deps);
        if (!readGraph) return;
        // Lineage walk uses LocalGraph-only forward/backward scans.
        // Cloud-mode equivalent (Bucket B/C parity follow-up) lands when
        // DataplaneGraph exposes the supersededBy index needed for the
        // back-walk. Until then, return a structured 501.
        //
        // Capability probe, NOT `requireLocalGraph`: `readGraph` now comes from
        // `getGraphHandle`, so on a Surreal-backed workspace it is a
        // SurrealGraph — which implements the back-walk
        // (`findSupersededByPredecessors`) perfectly well. The class check would
        // have 501'd a capable engine.
        let localGraph: WorkspaceGraph;
        try {
            localGraph = requireWorkspaceGraph(readGraph, 'node_lineage', 'requires the supersededBy back-walk');
        } catch (e) {
            if (e instanceof CloudModeUnsupportedError) {
                writeError(res, e.status, e.code, e.message, { operation: e.operation });
                return;
            }
            throw e;
        }
        const isHiddenFromActor = (n: LoreNode): boolean => filterNodesByActorScope([n]).length === 0;
        const visited = new Set<string>();
        const stripped = startId.startsWith('lore:') ? startId.slice(5) : startId;

        // Walk forward (this node's supersededBy chain).
        const forward: LoreNode[] = [];
        let cursor: string | null = stripped;
        while (cursor && !visited.has(cursor)) {
            visited.add(cursor);
            const n = await localGraph.getNode(cursor);
            // A node the bound actor may not see ends the walk exactly like a
            // missing one (Rafi 2026-10-06: stop at the gap). Unbound ⇒ no-op.
            if (!n || isHiddenFromActor(n)) break;
            forward.push(n);
            cursor = n.supersededBy ?? null;
        }

        // Walk backward (find nodes that point to this one). A merge —
        // several nodes superseded by the same successor — has MORE than one
        // predecessor, so this is a breadth-first branch walk over all of
        // them, not a single-chain chase. Goes through the pool-aware engine
        // method so we don't reach into LocalGraph internals from the route
        // layer.
        const backward: LoreNode[] = [];
        const depthById = new Map<string, number>();
        let frontier: string[] = [stripped];
        let depth = 0;
        while (frontier.length > 0) {
            depth += 1;
            const next: string[] = [];
            for (const id of frontier) {
                const predIds = await localGraph.findSupersededByPredecessors(id);
                for (const predId of predIds) {
                    if (visited.has(predId)) continue;
                    visited.add(predId);
                    const predNode = await localGraph.getNode(predId);
                    // Hidden predecessor ⇒ treated as missing: not returned and
                    // its own predecessors are not explored.
                    if (!predNode || isHiddenFromActor(predNode)) continue;
                    depthById.set(predId, depth);
                    backward.push(predNode);
                    next.push(predId);
                }
            }
            frontier = next;
        }
        // Oldest first: the deepest ancestors (furthest from the start node)
        // lead, and same-depth siblings — the branches of a merge — order by
        // id so the result is deterministic. On a plain linear chain this is
        // exactly the old oldest-first order.
        backward.sort((a, b) =>
            (depthById.get(b.id)! - depthById.get(a.id)!) || a.id.localeCompare(b.id));

        // Compose: backward (oldest predecessors first) → forward (this node + its successors).
        // Row-level security_scopes confinement (finding #20). Both walks stop
        // at a node the bound actor may not see, exactly as they stop at a
        // missing/deleted one — a hidden start, a hidden middle version and a
        // hidden predecessor all answer as if the node did not exist, so the
        // chain never proves a hidden node sits between two visible ones. A
        // visible node's `supersededBy` naming a hidden successor is nulled
        // (`supersededBy`/`supersededReason` — see security/nodePointers.ts).
        // The final filter is a defensive no-op. Unbound actor ⇒ unchanged.
        const chain = await redactHiddenSuccessors(
            filterNodesByActorScope([...backward, ...forward]),
            (ids) => localGraph.getNodesByIds(ids),
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            startId,
            chain: chain.map((n) => ({
                id: n.id,
                label: n.label,
                type: n.type,
                project: n.project,
                content: n.content,
                supersededBy: n.supersededBy ?? null,
                supersededAt: n.supersededAt ?? null,
                supersededReason: n.supersededReason ?? null,
                createdAt: n.createdAt,
                updatedAt: n.updatedAt,
            })),
        }));
    } catch (linErr) {
        writeError(res, 500, 'internal_error', redactError(linErr));
    }
}
