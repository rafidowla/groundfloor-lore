/**
 * readGate.ts — SP-04 shared read gate for the single-node read routes
 * (/api/node, /api/subgraph, /api/node/lineage, /api/node-full).
 *
 * Before SP-04 these handlers read directly from the boot-bound active
 * graph (`deps.store.storageClient.getNode` / `deps.store.loreGraph`)
 * with NO workspace argument and NO principal check — so an app token
 * bound to workspace A could read any node from whatever workspace
 * happened to be active. This mirrors the write-side gate that
 * postNode.ts / nodes-delete.ts already run:
 *
 *   1. `workspace` is REQUIRED (query param). Omitted → 400
 *      workspace_required. No silent fallback to graphRegistry.activeName().
 *   2. token-scoped read gate via requireReadFromWorkspace — a principal
 *      bound to A requesting B (or "*") is refused unless it holds
 *      cross-workspace-read. Null principal keeps the legacy / local
 *      single-workspace happy path (same null-principal bypass the write
 *      routes use).
 *   3. workspace-aware graph resolution via graphRegistry.getOrOpen so
 *      the read actually hits the requested workspace's graph (falls
 *      back to the boot-bound graph when no registry is wired — cloud /
 *      tests).
 *
 * Returns the resolved graph on success, or `null` after having written
 * the 4xx response (the caller must `return` immediately on null).
 */

import type { ServerResponse } from 'node:http';
import { WorkspaceNotFoundError } from '../../../../engines/localGraphRegistry.js';
import { bindRouteTarget } from '../../../../security/routeWorkspaceBinding.js';
import { writeWorkspaceRequired, writeError } from '../../helpers.js';
import type { LoreGraph, NodesDeps } from './types.js';

export async function resolveReadGraph(
    res: ServerResponse,
    url: string,
    deps: NodesDeps,
): Promise<LoreGraph | null> {
    const requestedWorkspace = new URL(url, 'http://localhost').searchParams.get('workspace') ?? undefined;
    // (1) workspace required — no silent active-workspace fallback.
    if (!requestedWorkspace) {
        writeWorkspaceRequired(res);
        return null;
    }
    // (2) token-scoped read gate (D-021: bindRouteTarget, not the raw scope
    // guard). Null principal = legacy bypass.
    if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'read' }) === null) return null;
    // (3) workspace-aware graph resolution. getGraphHandle, not getOrOpen:
    // the latter is the KÙZU substrate accessor and hands back a LocalGraph
    // for every workspace, so every read gated here against a Surreal-backed
    // workspace hit that workspace's real-but-EMPTY Kùzu table and returned
    // "no such node" with a 200. getOrOpen still runs underneath, so the
    // confinement gate is unchanged.
    let graph: LoreGraph = deps.store.loreGraph;
    if (deps.graphRegistry) {
        try {
            graph = await deps.graphRegistry.getGraphHandle(requestedWorkspace);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${err.requested}`, {
                    requested: err.requested,
                    known: err.known,
                });
                return null;
            }
            throw err;
        }
    }
    return graph;
}
