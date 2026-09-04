/**
 * corpus.ts — HTTP mirror for the corpus_health MCP tool (Feature 7).
 *
 *   GET /api/workspaces/:name/health
 *     — per-workspace health overview: node counts, stale flags,
 *       confirmation score distribution, outcome totals, edge count.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { AuxStore } from '../../../outbox/auxStore.js';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import { resolveTargetGraph } from '../../tools/workspaceResolve.js';
import { gateRoute } from '../../../security/routeGate.js';
// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { computeCorpusHealth } from '../../corpusHealthCompute.js';
import { redactError } from '../../../security/logRedact.js';
import { writeError } from '../helpers.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';

export interface CorpusRouteDeps {
    store: StorageBundle;
    auxStore: AuxStore;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    /** Postgres-model isolation — resolves the :name path workspace's graph so
     *  health reflects THAT workspace, not the boot/active store. Absent
     *  (cloud/tests) → boot fallback. */
    graphRegistry?: LocalGraphRegistry;
}

const HEALTH_RE = /^\/api\/workspaces\/([^/]+)\/health$/;

export async function tryCorpusRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: CorpusRouteDeps,
): Promise<boolean> {

    /* ─── GET /api/workspaces/:name/health ──────────────────────── */
    const match = HEALTH_RE.exec(pathname);
    if (!match || req.method !== 'GET') return false;

    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

    try {
        const workspace = match[1];

        // SP-04 — token-scoped read gate. gateRoute('read') in local mode does
        // NOT check the requested workspace against the principal, so a token
        // bound to workspace A calling /api/workspaces/B/health would otherwise
        // leak B's corpus counts. A principal bound to A requesting B needs
        // cross-workspace-read. Null principal = legacy/local bypass (matches
        // inspect.ts / versioning.ts read routes).
        if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;

        // Postgres-model isolation — compute health on the :name path
        // workspace's own graph, not the boot/active store. Unknown workspace
        // → 404 (was: silently computed on the boot graph).
        let graph = deps.store.loreGraph as LoreGraph;
        if (deps.graphRegistry) {
            const gres = await resolveTargetGraph(deps.store, deps.graphRegistry, workspace, workspace);
            if (!gres.ok) {
                if ('requested' in gres) {
                    writeError(res, 404, 'workspace_not_found',
                        `workspace '${gres.requested}' not found`, { requested: gres.requested, known: gres.known });
                } else {
                    writeError(res, 400, 'workspace_required', 'a workspace must be specified to route this request');
                }
                return true;
            }
            graph = gres.graph as LoreGraph;
        }
        const report = await computeCorpusHealth(graph, deps.auxStore, workspace);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
    } catch (err) {
        writeError(res, 500, 'corpus_health_failed', redactError(err));
    }
    return true;
}
