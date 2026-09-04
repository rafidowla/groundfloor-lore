/**
 * anchors.ts — HTTP mirror for the anchor MCP tool (Feature 6 Phase 1).
 *
 *   GET /api/nodes/:id/anchors?workspace=X&mark_stale=false
 *     — inspect anchor references; optionally flag the node as anchor-stale
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../security/routeGate.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { parseAnchors } from '../../anchorParse.js';
import { redactError } from '../../../security/logRedact.js';
import { writeError } from '../helpers.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;

export interface AnchorsRouteDeps {
    store: StorageBundle;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    /**
     * Sprint L1 (local Postgres-model isolation) — per-workspace graph
     * registry. When present, the route routes its read/write to the
     * REQUESTED workspace's graph instead of the boot/active store.
     * Absent (cloud / tests) → falls back to deps.store.loreGraph, so
     * behavior is unchanged when the registry isn't wired.
     */
    graphRegistry?: LocalGraphRegistry;
}

const ANCHORS_RE = /^\/api\/nodes\/([^/]+)\/anchors$/;

export async function tryAnchorsRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: AnchorsRouteDeps,
): Promise<boolean> {

    /* ─── GET /api/nodes/:id/anchors ────────────────────────────── */
    const match = ANCHORS_RE.exec(pathname);
    if (!match || req.method !== 'GET') return false;

    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

    try {
        const nodeId = match[1];
        const params = new URL(url, 'http://localhost').searchParams;
        const workspace = params.get('workspace') ?? '';
        const markStale = params.get('mark_stale') === 'true';

        if (!workspace) {
            writeError(res, 400, 'invalid_request', '`workspace` query param is required');
            return true;
        }

        // R5 #1 — token-scoped READ gate for the requested workspace. This route
        // returns the node's anchors (source URLs/refs), label, and existence,
        // but gateRoute('read') is a no-op for the workspace boundary in local
        // mode, so without this a workspace-A token could read workspace B's
        // anchors via ?workspace=B. Aligns the HTTP route with its own mark_stale
        // write gate (below) and its MCP twin check_anchors (assertMcpScope
        // read). Null principal = legacy/local bypass.
        if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;

        // L-068 — this route is read-gated (gateRoute permission:'read'), but
        // `mark_stale=true` MUTATES (upsertNode sets anchor_stale below). Require
        // write scope for that path only; the pure read stays read-only. Null
        // principal = local/legacy bypass (preserved).
        if (markStale) {
            if (bindRouteTarget(res, { requested: workspace, intent: 'write' }) === null) return true;
        }

        // Sprint L1 (local Postgres-model isolation) — route the read/write
        // to the REQUESTED workspace's graph, not the boot/active store. The
        // existing scope check above stays; this adds correct routing after
        // it. Registry absent (cloud / tests) → boot store (unchanged).
        let graph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                graph = await deps.graphRegistry.getGraphHandle(workspace);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace not found: ${err.requested}`, {
                        requested: err.requested,
                        known: err.known,
                    });
                    return true;
                }
                throw err;
            }
        }
        await graph.initialize();

        const node = await graph.getNode(nodeId);
        if (!node) {
            writeError(res, 404, 'node_not_found', `node not found: ${nodeId}`, { id: nodeId });
            return true;
        }

        const anchors = parseAnchors(node.anchors);
        let staleMarked = false;

        if (markStale && !node.anchor_stale) {
            await withTransactionConflictRetry(() => graph.upsertNode({
                ...node,
                anchor_stale: true,
                anchor_stale_since: new Date().toISOString(),
            }));
            staleMarked = true;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: nodeId,
            workspace,
            anchor_count: anchors.length,
            anchor_stale: staleMarked ? true : (node.anchor_stale ?? false),
            anchor_stale_since: staleMarked
                ? new Date().toISOString()
                : (node.anchor_stale_since ?? null),
            anchors,
            stale_marked: staleMarked,
            hint: anchors.length === 0
                ? 'This node has no anchors. Add anchors via store_node with anchors: \'[{"type":"url","ref":"https://..."}]\'.'
                : 'Phase 1: anchor freshness is not automatically verified. Use mark_stale=true when you detect a stale reference.',
        }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
    return true;
}
