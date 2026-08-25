/**
 * static.ts — HTML data-export surface.
 *
 *   GET /api/export/html  — offline-viewable graph snapshot (vis-network)
 *
 * The response is `text/html`. The export route reads the live graph and
 * returns a self-contained snapshot for data portability — it is NOT a
 * served management dashboard. (The `/explore` served dashboard was removed
 * in TW-6b: Lore Core is API + MCP only, no served UI. See DECISIONS.md.)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { writeWorkspaceRequired, writeError } from '../helpers.js';
import { exportGraphAsHtml } from '../../../engines/htmlExport.js';
import { redactError } from '../../../security/logRedact.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';

// Widened for the Kùzu removal: naming the two CONCRETE classes silently
// excluded SurrealGraph (see engines/htmlExport.ts). Need more than the
// shared handle? Feature-detect and refuse — do not re-narrow to a class.
type LoreGraph = LoreGraphHandle;

export interface StaticDeps {
    store: StorageBundle;
    /** L-007 — multi-workspace registry. When wired, the export resolves +
     *  scopes to the REQUESTED workspace's graph (instead of leaking the
     *  boot-active graph). Optional so cloud / test boots fall back to the
     *  boot-bound graph. */
    graphRegistry?: LocalGraphRegistry;
    deploymentMode: 'local' | 'cloud';
}

export async function tryStaticRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    _pathname: string,
    deps: StaticDeps,
): Promise<boolean> {
    // C8 — Static HTML export. Offline-viewable graph snapshot via
    // vis-network (CDN-loaded). Share the file; no Lore daemon required
    // on the viewer's machine. This is a data-portability API, not a
    // served UI dashboard.
    if (url.startsWith('/api/export/html') && req.method === 'GET') {
        const parsed = new URL(url, 'http://localhost');
        // L-007 — mirror readGate.ts (SP-04 read-scope). The export dumps a
        // workspace's full node/edge graph; previously it leaked whatever
        // workspace happened to be boot-active to ANY authenticated caller.
        // (1) workspace REQUIRED — no silent active-workspace fallback.
        const requestedWorkspace = parsed.searchParams.get('workspace') ?? undefined;
        if (!requestedWorkspace) {
            writeWorkspaceRequired(res);
            return true;
        }
        // (2) token-scoped read gate. Null principal = legacy/local bypass.
        if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'read' }) === null) return true;
        // (3) workspace-aware graph resolution — scope the export to the
        // requested workspace's graph. Falls back to the boot-bound graph
        // when no registry is wired (cloud / tests).
        let graph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                graph = await deps.graphRegistry.getGraphHandle(requestedWorkspace);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace "${err.requested}" not found`, { requested: err.requested, known: err.known });
                    return true;
                }
                throw err;
            }
        }
        try {
            const project = parsed.searchParams.get('project') ?? undefined;
            const maxNodes = parseInt(parsed.searchParams.get('maxNodes') ?? '500', 10);
            const title = parsed.searchParams.get('title') ?? undefined;
            // Q2.2 — HTML export reads the local graph directly;
            // cloud-mode export is a slice-3 follow-up (needs
            // Dataplane-native dump).
            const html = await exportGraphAsHtml(graph, {
                project,
                maxNodes: Number.isFinite(maxNodes) ? maxNodes : 500,
                title,
            });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}
