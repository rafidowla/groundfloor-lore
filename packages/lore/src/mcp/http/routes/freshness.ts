/**
 * freshness.ts — HTTP surface for workspace data-freshness (Freshness Sprint).
 *
 *   GET /api/workspaces/:name/freshness
 *     — Returns a FreshnessReport for the workspace: total node count,
 *       fresh/stale/never-synced breakdown, freshness percentage, and
 *       IDs of stale nodes (up to 100).
 *
 * Query params:
 *   ttl_hours — override the LORE_FRESHNESS_TTL_HOURS env var (optional).
 *
 * Design note: read-only — no writes to the graph. Staleness is
 * computed on-demand by comparing node syncedAt timestamps against
 * the configured TTL. Suitable for polling-based freshness dashboards.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { sweepFreshness } from '../../../engines/freshnessEngine.js';
import { redactError } from '../../../security/logRedact.js';
import { writeError } from '../helpers.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;

export interface FreshnessRouteDeps {
    store: StorageBundle;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    /** Local-mode per-workspace routing (Postgres model). Absent in
     *  cloud/tests → falls back to the boot-bound store.loreGraph. */
    graphRegistry?: LocalGraphRegistry;
}

const FRESHNESS_RE = /^\/api\/workspaces\/([^/]+)\/freshness$/;

export async function tryFreshnessRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: FreshnessRouteDeps,
): Promise<boolean> {

    /* ─── GET /api/workspaces/:name/freshness ───────────────────── */
    const match = FRESHNESS_RE.exec(pathname);
    if (!match || req.method !== 'GET') return false;

    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

    try {
        const workspace = match[1];

        // SP-04 — token-scoped read gate (gateRoute('read') skips the workspace
        // match in local mode). Freshness returns per-node staleNodeIds for the
        // :name workspace, so a foreign-workspace token must be refused. Null
        // principal = legacy/local bypass.
        if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;

        const params = new URL(url, 'http://localhost').searchParams;
        const ttlRaw = params.get('ttl_hours');
        const ttlHours = ttlRaw !== null ? Number(ttlRaw) : undefined;

        // Validate ttl_hours if supplied.
        if (ttlHours !== undefined && (!Number.isFinite(ttlHours) || ttlHours <= 0)) {
            writeError(res, 400, 'invalid_ttl_hours', '`ttl_hours` must be a positive number');
            return true;
        }

        // Local mode (Postgres model): route the freshness read to the
        // REQUESTED workspace from the path, not the boot/active store.
        // No registry (cloud/tests) → boot store, unchanged behavior.
        let graph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                graph = await deps.graphRegistry.getGraphHandle(workspace);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found',
                        `workspace '${err.requested}' not found`,
                        { requested: err.requested, known: err.known });
                    return true;
                }
                throw err;
            }
        }
        await graph.initialize();

        // IFreshnessGraph.listNodes has the identical signature as
        // LoreGraphHandle.listNodes (same GraphProvider contract, same
        // LoreNode type — freshnessEngine.ts's IFreshnessGraph re-exports
        // it via localGraph.ts), so `graph` already structurally satisfies
        // IFreshnessGraph. The `as unknown as IFreshnessGraph` laundering
        // cast this used to need is gone now that both sides share the
        // widened LoreGraphHandle-shaped contract.
        const report = await sweepFreshness(
            graph,
            workspace,
            ttlHours,
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
    } catch (err) {
        writeError(res, 500, 'freshness_sweep_failed', redactError(err));
    }
    return true;
}
