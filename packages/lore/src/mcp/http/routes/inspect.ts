/**
 * inspect.ts — Lightweight REST mirrors for diagnostic MCP tools.
 *
 *   GET /api/lore-status   — lore_status: one-shot health + capability snapshot
 *   GET /api/node-list     — list_nodes: cursor-paginated node listing
 *
 * These complement the existing /api/health and /api/stats routes.
 * lore_status bundles everything a new agent session needs in a
 * single call; node-list exposes cursor-paginated listing without
 * requiring a POST body (unlike POST /api/nodes/bulk-list).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import { resolveWorkspaceGraphEngine } from '../../../engines/graphEngineSelector.js';
import type { BulkListQuery } from '../../../providers/types.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { ecosystemMatches } from '../../../core/ecosystemMatch.js';
import { redactError } from '../../../security/logRedact.js';
import { filterNodesByActorScope } from '../../../security/scopeFilter.js';
import { writeError } from '../helpers.js';

export interface InspectRouteDeps {
    store: StorageBundle;
    detectedScope: { workspace: string; ecosystem: string };
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    graphRegistry?: LocalGraphRegistry;
}

export async function tryInspectRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: InspectRouteDeps,
): Promise<boolean> {

    // lore_status REST sibling.
    //   GET /api/lore-status
    if (pathname === '/api/lore-status' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const stats = await deps.store.storageClient.getStats();
            // INTENTIONALLY boot/active-scoped: /api/lore-status is a snapshot of
            // THIS daemon's active workspace (scope.workspace below is the
            // detected-active name), not a per-request workspace read. The
            // verbatim count here is meant to describe the active workspace's
            // LanceDB, so it stays on the boot storageClient — not a P2
            // per-workspace routing site.
            const verbatimCount = await deps.store.storageClient.verbatimCount();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                daemon: 'ok',
                deploymentMode: deps.deploymentMode,
                scope: { workspace: deps.detectedScope.workspace, ecosystem: deps.detectedScope.ecosystem },
                graph: {
                    nodes: stats.nodeCount,
                    edges: stats.edgeCount,
                    verbatimDocs: verbatimCount,
                    // BUGFIX (Kùzu removal step 2): this used to read
                    // `deps.store.loreGraph instanceof LocalGraph`, which is
                    // the BOOT handle — it printed "kùzu + lancedb (local)"
                    // even when `detectedScope.workspace` declares
                    // `graphEngine: 'surreal'` in workspaces.json, because a
                    // Surreal-backed workspace's Kùzu database still exists
                    // (just empty). Ask the registry which engine actually
                    // backs THIS workspace instead of instanceof-sniffing
                    // the wrong handle.
                    engine: (() => {
                        if (deps.deploymentMode === 'cloud') return 'dataplane (cloud)';
                        // Ask the declared engine, never instanceof-sniff the
                        // boot handle: a Kùzu `instanceof` was true even on a
                        // Surreal-declared workspace (the boot Kùzu store
                        // existed and was empty). With the registry present
                        // this uses its home-scoped lookup; without it (legacy
                        // single-workspace boot) the global selector resolves
                        // the same declaration.
                        const kind = deps.graphRegistry
                            ? deps.graphRegistry.graphEngineFor(deps.detectedScope.workspace)
                            : resolveWorkspaceGraphEngine(deps.detectedScope.workspace);
                        return kind === 'surreal' ? 'surrealdb + lancedb (local)' : 'kùzu + lancedb (local)';
                    })(),
                },
                capabilities: {
                    compactRecall: true,
                    crossWorkspaceRecall: true,
                    getFull: true,
                    versioning: true,
                    changesets: true,
                    httpRecallEndpoint: '/api/recall',
                    httpGetFullEndpoint: '/api/node-full',
                },
            }));
        } catch (err) {
            writeError(res, 500, 'lore_status_failed', redactError(err));
        }
        return true;
    }

    // list_nodes REST sibling (GET convenience form).
    //   GET /api/node-list?workspace=X&type=Y&tag=Z&ecosystem=E&limit=N&cursor=<base64url>
    // For bulk POST form use POST /api/nodes/bulk-list (same cursor format).
    //
    // R5 #2 — this is the THIRD member of the list_nodes / node-list /
    // bulk-list triple: one primitive (`bulkList`), one cursor format, one
    // documented purpose. The other two were corrected by DEC-SCOPE-HONESTY
    // and this one was missed on BOTH axes, so the triple briefly had three
    // different scoping behaviours while its cursors still composed across
    // all three. Both axes are fixed below; keep the three in step.
    if (pathname === '/api/node-list' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const qp = new URL(url, 'http://localhost').searchParams;
            const workspace = qp.get('workspace') ?? '';
            const type = qp.get('type') ?? undefined;
            const tag = qp.get('tag') ?? undefined;
            // `?ecosystem=` — optional; omitted/'*' = every ecosystem, so
            // existing callers are unchanged (this route never had an
            // ecosystem scope, and a boot-global default must not become one:
            // DEC-SCOPE-HONESTY rule 3). Same default and same wire field as
            // its POST sibling.
            const ecoParam = qp.get('ecosystem');
            const ecosystem = ecoParam && ecoParam.length > 0 ? ecoParam : '*';
            const limitRaw = parseInt(qp.get('limit') ?? '100', 10);
            const limit = Math.min(isNaN(limitRaw) ? 100 : Math.max(1, limitRaw), 1000);
            const cursorParam = qp.get('cursor') ?? undefined;

            if (!workspace) {
                writeError(res, 400, 'workspace_required', 'workspace query param required');
                return true;
            }

            // SP-04 — token-scoped read gate (was missed in the original
            // sprint). node-list enumerates up to 1k nodes/page from the
            // requested workspace's graph, so a workspace-A token calling
            // ?workspace=B (or "*") was a cross-workspace exfil. A principal
            // bound to A requesting B/"*" needs cross-workspace-read. Null
            // principal = legacy/local bypass (same as the other read routes).
            if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;

            let cursorPayload: { updatedAt: string; id: string } | null = null;
            if (cursorParam) {
                try {
                    const json = Buffer.from(cursorParam, 'base64url').toString('utf8');
                    const parsed = JSON.parse(json) as { updatedAt?: unknown; id?: unknown };
                    if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') {
                        writeError(res, 400, 'invalid_cursor', 'payload missing updatedAt or id');
                        return true;
                    }
                    cursorPayload = { updatedAt: parsed.updatedAt, id: parsed.id };
                } catch {
                    writeError(res, 400, 'invalid_cursor', 'not valid base64url JSON');
                    return true;
                }
            }

            // Use graphRegistry when available for accurate per-workspace listing.
            let targetGraph = deps.store.loreGraph;
            if (deps.graphRegistry) {
                try {
                    targetGraph = await deps.graphRegistry.getGraphHandle(workspace);
                } catch {
                    writeError(res, 404, 'workspace_not_found', `workspace '${workspace}' not found`, { workspace });
                    return true;
                }
            }

            // RA2-reaudit2 — delegate to the DB-side cursor-paginated bulkList
            // instead of an unbounded listNodes + JS filter/sort/slice, which
            // loaded the entire workspace node table into memory per page
            // (defeating the SW-18 guard). bulkList does (updatedAt DESC, id ASC)
            // ordering + the strict-after cursor + limit+1 hasMore in one query.
            // bulkList is declared on LoreGraphHandle — every graph substrate
            // implements it directly, no capability probe needed.
            const query: BulkListQuery = {
                types: type ? [type] : undefined,
                tags: tag ? [tag] : undefined,
                // R5 #2 — `project` is NOT the workspace. Every engine turns
                // it into a strict `n.project = $project`, so the workspace
                // name here only ever DROPPED this workspace's own rows (any
                // node carrying an explicit project, e.g. Atlas's
                // project='v3' inside workspace='default'). The physical
                // boundary is the resolved graph above — each workspace is
                // its own database. Same correction as its two siblings.
                project: undefined,
                ecosystem: ecosystem !== '*' ? ecosystem : undefined,
                cursor: cursorPayload ?? undefined,
                limit,
            };
            const bl = await targetGraph.bulkList(query);
            // The pushdown is an optimisation; this is the decision point
            // (core/ecosystemMatch.ts) — the response states `ecosystem`, so
            // every row in it must satisfy that scope (DEC-SCOPE-HONESTY r1).
            const scopedRows = ecosystem === '*'
                ? bl.nodes
                : bl.nodes.filter((n) => ecosystemMatches((n as { ecosystem?: unknown }).ecosystem as string | undefined, ecosystem));
            // 3.1 (2026-08-17) — row-level security_scopes confinement on the
            // RAW rows before they are projected and serialized (the wire
            // projection below drops security_scopes). Undefined actor
            // scopes ⇒ no filtering.
            const confinedRows = filterNodesByActorScope(scopedRows);
            const nextCursor = bl.nextCursor
                ? Buffer.from(JSON.stringify(bl.nextCursor)).toString('base64url')
                : null;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                workspace, ecosystem, count: confinedRows.length, hasMore: bl.hasMore, nextCursor,
                nodes: confinedRows.map((n) => ({ id: n.id, type: n.type, label: n.label, tags: n.tags, updatedAt: n.updatedAt })),
            }));
        } catch (err) {
            writeError(res, 500, 'node_list_failed', redactError(err));
        }
        return true;
    }

    return false;
}
