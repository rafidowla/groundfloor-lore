/**
 * edges.ts — Edge CRUD REST routes (Sprint W W2).
 *
 *   POST   /api/edge   — create an edge. Body matches the MCP store_edge
 *                        tool: {sourceId, targetId, relation, workspace?,
 *                        bidirectional?, confidence?, confidenceScore?}.
 *   GET    /api/edges  — paginated edge query with filters:
 *                        ?source=<id>&target=<id>&relation=<r>
 *                        &workspace=<ws>&limit=<n>&offset=<n>
 *                        &ecosystem=<eco>   (optional; omitted = every
 *                        ecosystem, unchanged. See the GET branch.)
 *
 * Why this exists: before W2, edges could only be written via MCP
 * store_edge. Sprint X closures fell back to encoding depends_on
 * relationships in node CONTENT (prose) because the REST surface had
 * /api/node but no /api/edge — every closure script that wanted to
 * stamp graph edges had to drag in the MCP SDK + bootstrap a session.
 *
 * Route shape mirrors `routes/nodes.ts` exactly so the ReBAC gate +
 * workspace registry + payload size limits behave identically.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeWorkspaceRequired, checkOutboxBackpressure, writeJson, writeError } from '../helpers.js';
import type { OutboxLagCache } from '../../../outbox/lagCache.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import type { OutboxStore } from '../../../outbox/types.js';
import { recordHotWrite } from '../../../outbox/hotLane.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import type { LoreEdge } from '../../../providers/types.js';
import { ecosystemMatches } from '../../../core/ecosystemMatch.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';
import type { AuditLog } from '../../../security/audit.js';
import { withEdgeLocks, withEdgeLock, type EdgeLockTriple } from '../../../core/nodeWriteLock.js';

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;

export interface EdgesDeps {
    store: StorageBundle;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    graphRegistry?: LocalGraphRegistry;
    /**
     * Allowed relation strings. Same source the MCP store_edge tool
     * uses (merged from core + active plugins). Empty/undefined means
     * skip the relation enum check — callers fall through to
     * LocalGraph.addEdge whose Cypher MATCH will surface a clear
     * "node not found" error if the relation slips into the schema
     * incorrectly.
     */
    edgeRelations?: ReadonlyArray<string>;
    /** Sprint O2 — outbox for hot-lane writes. Records edge.upsert /
     *  edge.delete before substrate writes; optional. */
    outboxStore?: OutboxStore;
    /** Sprint O4 — backpressure lag cache (optional; absent = skip). */
    outboxLagCache?: OutboxLagCache;
    /** Round-E X-edges — audit-coverage. POST/DELETE /api/edge had no audit
     *  row, unlike the MCP store_edge/delete_edge tools and POST /api/node.
     *  Optional so existing test fixtures that don't care about auditing
     *  keep working; production wiring (dispatcher.ts / arcadeData.ts)
     *  always supplies it. */
    auditLog?: AuditLog;
}

interface PostEdgeBody {
    sourceId?: unknown;
    targetId?: unknown;
    relation?: unknown;
    workspace?: unknown;
    bidirectional?: unknown;
    confidence?: unknown;
    confidenceScore?: unknown;
}

interface ResolvedTarget {
    graph: LoreGraph;
    resolvedWorkspace: string;
}

async function resolveTargetGraph(
    deps: EdgesDeps,
    requestedWorkspace: string | undefined,
): Promise<ResolvedTarget | { error: 'workspace_not_found'; requested: string; known: string[] }> {
    let targetGraph: LoreGraph = deps.store.loreGraph;
    let resolvedWorkspace = requestedWorkspace ?? '';
    if (deps.graphRegistry) {
        resolvedWorkspace = requestedWorkspace ?? deps.graphRegistry.activeName();
        try {
            targetGraph = await deps.graphRegistry.getGraphHandle(resolvedWorkspace);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                return { error: 'workspace_not_found', requested: err.requested, known: err.known };
            }
            throw err;
        }
    }
    return { graph: targetGraph, resolvedWorkspace };
}

/**
 * confineEdgesToEcosystem — keep only edges whose BOTH endpoints are visible
 * from `ecosystem`. See the call site for why the hydrated endpoint rows, not a
 * pushdown, decide this.
 */
async function confineEdgesToEcosystem(
    graph: LoreGraph,
    edges: LoreEdge[],
    ecosystem: string,
): Promise<LoreEdge[]> {
    const ids = new Set<string>();
    for (const e of edges) { ids.add(e.sourceId); ids.add(e.targetId); }
    const hydrated = await graph.getNodesByIds([...ids]);
    const visible = (id: string): boolean => {
        const n = hydrated.get(id);
        if (!n) return false;
        return ecosystemMatches((n as { ecosystem?: string }).ecosystem, ecosystem);
    };
    return edges.filter((e) => visible(e.sourceId) && visible(e.targetId));
}

export async function tryEdgesRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: EdgesDeps,
): Promise<boolean> {
    // ── POST /api/edge — create an edge ─────────────────────────────
    if (pathname === '/api/edge' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }

        // Round-E X-edges finding (4) — a malformed JSON body used to fall
        // through into the big try block below and get caught by the
        // generic catch, whose status logic only recognizes "Failed to add
        // edge"/"not found" messages as 400 — a SyntaxError from JSON.parse
        // matched neither, so it surfaced as a 500 (implying a server
        // fault) for what is really a client mistake. Parse in its own
        // try/catch, same invalid_json_body shape import.ts/bulkList.ts use.
        let parsed: PostEdgeBody;
        try {
            parsed = JSON.parse(body || '{}') as PostEdgeBody;
        } catch {
            writeError(res, 400, 'invalid_json_body', 'invalid JSON body');
            return true;
        }

        const __auditStartedAt = Date.now();
        const __auditCtx: { workspace: string | null; entityId: string | null; errored: boolean; resultDetail?: string } = {
            workspace: null, entityId: null, errored: false,
        };
        try {
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                writeError(res, 400, 'bad_request', 'body must be a JSON object');
                return true;
            }
            if (typeof parsed.sourceId !== 'string' || typeof parsed.targetId !== 'string'
                || typeof parsed.relation !== 'string') {
                writeError(res, 400, 'bad_request', 'sourceId, targetId, and relation are required strings');
                return true;
            }
            __auditCtx.entityId = `${parsed.sourceId}->${parsed.targetId}:${parsed.relation}`;
            const requestedWorkspace = typeof parsed.workspace === 'string' && parsed.workspace.length > 0
                ? parsed.workspace
                : (typeof (parsed as { project?: unknown }).project === 'string' && ((parsed as { project?: string }).project as string).length > 0
                    ? (parsed as { project: string }).project
                    : undefined);
            // Sprint L1c — workspace required (writer). Token's bound
            // workspace counts as explicit; no token + no body field → 400.
            const principalEarly = getCurrentPrincipal();
            const effectivePostWorkspace = requestedWorkspace ?? principalEarly?.workspace;
            if (!effectivePostWorkspace) { writeWorkspaceRequired(res); return true; }
            __auditCtx.workspace = effectivePostWorkspace;
            const bidirectional = parsed.bidirectional === undefined ? true : Boolean(parsed.bidirectional);
            const rawConf = typeof parsed.confidence === 'string' ? parsed.confidence : 'extracted';
            if (rawConf !== 'extracted' && rawConf !== 'inferred' && rawConf !== 'ambiguous') {
                writeError(res, 400, 'bad_request', `confidence must be one of: extracted, inferred, ambiguous (got ${JSON.stringify(rawConf)})`);
                return true;
            }
            const score = typeof parsed.confidenceScore === 'number'
                ? Math.max(0, Math.min(1, parsed.confidenceScore))
                : (rawConf === 'extracted' ? 1.0 : 0.5);

            // Relation enum check (cheap pre-filter so the user gets a
            // clear 400 instead of falling through to the addEdge
            // Cypher and getting a generic 500). Skipped when caller
            // didn't wire edgeRelations — addEdge still runs.
            if (deps.edgeRelations && deps.edgeRelations.length > 0
                && !deps.edgeRelations.includes(parsed.relation)) {
                writeError(res, 400, 'unknown_relation', `unknown relation: ${parsed.relation}`, {
                    allowed: deps.edgeRelations,
                });
                return true;
            }

            // Token-scoped write gate — same shape as POST /api/node.
            if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'write' }) === null) return true;

            const resolved = await resolveTargetGraph(deps, effectivePostWorkspace);
            if ('error' in resolved) {
                writeError(res, 404, resolved.error, `workspace not found: ${resolved.requested}`, {
                    requested: resolved.requested,
                    known: resolved.known,
                });
                return true;
            }
            const edgeGraph = resolved.graph;

            // Sprint O4 — backpressure gate.
            if (checkOutboxBackpressure(res, effectivePostWorkspace, deps.outboxLagCache)) return true;

            const edge = {
                sourceId: parsed.sourceId,
                targetId: parsed.targetId,
                relation: parsed.relation,
                confidence: rawConf as 'extracted' | 'inferred' | 'ambiguous',
                confidenceScore: score,
            };

            // Round-E X-edges — outbox record + substrate write now run
            // under ONE per-triple lock (core/nodeWriteLock.ts
            // `withEdgeLocks`), mirroring MCP store_edge. Unlocked, a
            // concurrent write for the same (sourceId, targetId, relation)
            // — via MCP store_edge, this route again, or a bulk edge call —
            // could record its outbox row and land its graph write in the
            // opposite relative order (outbox replay then contradicts the
            // executed order). Bidirectional writes lock BOTH the forward
            // and reverse triple together.
            const lockTriples: EdgeLockTriple[] = bidirectional
                ? [{ sourceId: parsed.sourceId, targetId: parsed.targetId, relation: parsed.relation },
                    { sourceId: parsed.targetId, targetId: parsed.sourceId, relation: parsed.relation }]
                : [{ sourceId: parsed.sourceId, targetId: parsed.targetId, relation: parsed.relation }];
            await withEdgeLocks(effectivePostWorkspace, lockTriples, async () => {
                // O2: outbox-first — record edge.upsert before substrate.
                if (deps.outboxStore) {
                    await recordHotWrite(deps.outboxStore, {
                        workspace: effectivePostWorkspace,
                        operationKind: 'edge.upsert',
                        payload: { ...edge, bidirectional },
                        initiator: 'http:POST /api/edge',
                        operation: 'edge.upsert',
                    });
                }
                if (bidirectional) {
                    await withTransactionConflictRetry(() => edgeGraph.addBidirectionalEdge(edge));
                } else {
                    await withTransactionConflictRetry(() => edgeGraph.addEdge(edge));
                }
            });
            writeJson(res, 200, {
                ok: true,
                edge: { ...edge, bidirectional },
                workspace: resolved.resolvedWorkspace || null,
            });
            // Round-E X-edges finding (2) — POST /api/edge wrote no audit
            // row, unlike MCP store_edge and POST /api/node (NW-5b).
            deps.auditLog?.log({
                toolName: 'http:post_edge',
                args: { workspace: __auditCtx.workspace, entityId: __auditCtx.entityId },
                result: 'success',
                durationMs: Date.now() - __auditStartedAt,
            });
        } catch (err) {
            // addEdge throws when source/target node missing; surface as
            // 400 (caller asked for an edge against a node that doesn't
            // exist) rather than 500 (which implies a server fault).
            const msg = (err as Error).message;
            const status = /Failed to add edge|not found/i.test(msg) ? 400 : 500;
            console.error(`[Lore HTTP] POST /api/edge failed: ${redactError(err)}`);
            // F-COL5: 400 is an author-controlled validation message
            // (missing node) — keep it raw. 500 echoes raw engine text,
            // so redact it.
            writeError(res, status, status === 500 ? 'internal_error' : 'bad_request', status === 500 ? redactError(err) : msg);
            deps.auditLog?.log({
                toolName: 'http:post_edge',
                args: { workspace: __auditCtx.workspace, entityId: __auditCtx.entityId },
                result: 'error',
                resultDetail: redactError(err),
                durationMs: Date.now() - __auditStartedAt,
            });
        }
        return true;
    }

    // ── DELETE /api/edge — remove an edge by (source, target, relation) ─
    // W8 (Sprint W) — REST sibling of the MCP delete pattern. Query
    // params instead of a body so it stays idempotent / cacheable and
    // mirrors the GET /api/edges filter shape.
    //   DELETE /api/edge?sourceId=A&targetId=B&relation=R&workspace=ws
    if (pathname === '/api/edge' && req.method === 'DELETE') {
        // L-031 — edge hard-delete is destructive; gate on the finer
        // 'delete' permission (mirrors config.ts drop), not 'write'.
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'delete' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

        const __auditStartedAt = Date.now();
        const __auditCtx: { workspace: string | null; entityId: string | null; errored: boolean; resultDetail?: string } = {
            workspace: null, entityId: null, errored: false,
        };
        try {
            const u = new URL(url, 'http://localhost');
            const sourceId = u.searchParams.get('sourceId');
            const targetId = u.searchParams.get('targetId');
            const relation = u.searchParams.get('relation');
            const requestedWorkspace = u.searchParams.get('workspace') ?? u.searchParams.get('project') ?? undefined;
            if (!sourceId || !targetId || !relation) {
                writeError(res, 400, 'bad_request', 'sourceId, targetId, and relation query params are required');
                return true;
            }
            __auditCtx.entityId = `${sourceId}->${targetId}:${relation}`;

            const principal = getCurrentPrincipal();
            // Sprint L1c — workspace required (writer). Token's bound
            // workspace counts as explicit; no token + no query param → 400.
            const effectiveDeleteWorkspace = requestedWorkspace ?? principal?.workspace;
            if (!effectiveDeleteWorkspace) { writeWorkspaceRequired(res); return true; }
            __auditCtx.workspace = effectiveDeleteWorkspace;
            if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'write' }) === null) return true;

            const resolved = await resolveTargetGraph(deps, effectiveDeleteWorkspace);
            if ('error' in resolved) {
                writeError(res, 404, resolved.error, `workspace not found: ${resolved.requested}`, {
                    requested: resolved.requested,
                    known: resolved.known,
                });
                return true;
            }
            const edgeGraph = resolved.graph;
            // Sprint O4 — backpressure gate.
            if (checkOutboxBackpressure(res, effectiveDeleteWorkspace, deps.outboxLagCache)) return true;
            // Round-E X-edges — outbox record + substrate delete now run
            // under the SAME per-triple lock POST /api/edge and MCP
            // store_edge/delete_edge take (core/nodeWriteLock.ts
            // `withEdgeLock`). Unlocked, a concurrent write for this triple
            // could land its outbox row and graph write between this call's
            // own outbox record and its graph delete.
            const deleted = await withEdgeLock(effectiveDeleteWorkspace, sourceId, targetId, relation, async () => {
                // O2: outbox-first — record edge.delete before substrate.
                if (deps.outboxStore) {
                    await recordHotWrite(deps.outboxStore, {
                        workspace: effectiveDeleteWorkspace,
                        operationKind: 'edge.delete',
                        payload: { sourceId, targetId, relation },
                        initiator: 'http:DELETE /api/edge',
                        operation: 'edge.delete',
                    });
                }
                // deleteEdge is declared on LoreGraphHandle — every graph
                // substrate implements it directly, no capability probe needed.
                return withTransactionConflictRetry(() => edgeGraph.deleteEdge(sourceId, targetId, relation));
            });
            if (deleted === 0) {
                writeError(res, 404, 'edge_not_found', `edge not found: ${sourceId} -${relation}-> ${targetId}`, {
                    sourceId, targetId, relation,
                });
                // Round-E X-edges finding (2) — DELETE /api/edge wrote no
                // audit row, unlike MCP delete_edge and DELETE /api/node.
                deps.auditLog?.log({
                    toolName: 'http:delete_edge',
                    args: { workspace: __auditCtx.workspace, entityId: __auditCtx.entityId },
                    result: 'error',
                    resultDetail: 'edge_not_found',
                    durationMs: Date.now() - __auditStartedAt,
                });
                return true;
            }
            writeJson(res, 200, {
                ok: true,
                deleted,
                workspace: resolved.resolvedWorkspace || null,
            });
            deps.auditLog?.log({
                toolName: 'http:delete_edge',
                args: { workspace: __auditCtx.workspace, entityId: __auditCtx.entityId },
                result: 'success',
                durationMs: Date.now() - __auditStartedAt,
            });
        } catch (err) {
            console.error(`[Lore HTTP] DELETE /api/edge failed: ${redactError(err)}`);
            writeError(res, 500, 'internal_error', redactError(err)); // F-COL5
            __auditCtx.errored = true;
            __auditCtx.resultDetail = redactError(err);
            deps.auditLog?.log({
                toolName: 'http:delete_edge',
                args: { workspace: __auditCtx.workspace, entityId: __auditCtx.entityId },
                result: 'error',
                resultDetail: __auditCtx.resultDetail,
                durationMs: Date.now() - __auditStartedAt,
            });
        }
        return true;
    }

    // ── GET /api/edges — paginated query ────────────────────────────
    if (pathname === '/api/edges' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

        try {
            const u = new URL(url, 'http://localhost');
            const source = u.searchParams.get('source');
            const target = u.searchParams.get('target');
            const relation = u.searchParams.get('relation');
            const requestedWorkspace = u.searchParams.get('workspace') ?? undefined;
            const limit = Math.min(Math.max(Number(u.searchParams.get('limit') ?? '500'), 1), 1000);
            const offset = Math.max(Number(u.searchParams.get('offset') ?? '0'), 0);
            // R6 #4 — `?ecosystem=` (optional; omitted/'*' = every ecosystem,
            // so existing callers are unchanged). This route paginates raw
            // LoreEdge rows — source, target, relation — across every tenant in
            // the workspace, which is TOPOLOGY by DEC-SCOPE-SURFACE-CLASS's own
            // definition; it had no ecosystem scope and no override, and the
            // decision entry claimed every read surface had one.
            const edgeEcoParam = u.searchParams.get('ecosystem');
            const edgeEcosystem = edgeEcoParam && edgeEcoParam.length > 0 ? edgeEcoParam : '*';

            // SP-04 — workspace_required + token-scoped read gate, mirror
            // of the DELETE /api/edge branch above. Before this, GET
            // /api/edges silently fell back to graphRegistry.activeName()
            // (see resolveTargetGraph) and never consulted the principal —
            // so a token bound to A could read whatever workspace happened
            // to be active. No silent fallback now: omitting workspace is a
            // 400, and a principal reading another workspace (or "*")
            // needs cross-workspace-read.
            const principal = getCurrentPrincipal();
            const effectiveWorkspace = requestedWorkspace ?? principal?.workspace;
            if (!effectiveWorkspace) { writeWorkspaceRequired(res); return true; }
            if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'read' }) === null) return true;

            const resolved = await resolveTargetGraph(deps, effectiveWorkspace);
            if ('error' in resolved) {
                writeError(res, 404, resolved.error, `workspace not found: ${resolved.requested}`, {
                    requested: resolved.requested,
                    known: resolved.known,
                });
                return true;
            }
            // queryEdges is declared on LoreGraphHandle — every graph
            // substrate implements it directly, no capability probe needed.
            const edges = await resolved.graph.queryEdges({
                source: source ?? undefined,
                target: target ?? undefined,
                relation: relation ?? undefined,
                limit,
                offset,
            });
            // An edge carries no ecosystem of its own, so the scope is decided
            // on both HYDRATED endpoints — one batch getNodesByIds over the
            // (already ≤1000-row) page. An edge is kept only when BOTH ends are
            // in scope: the closed-edge rule `subgraphFetch` uses, so a scoped
            // caller never learns that one of its nodes touches a foreign one.
            // An endpoint that does not hydrate cannot be shown to be in scope
            // and drops the edge. Unscoped ('*') issues no extra query and is
            // byte-identical to before.
            //
            // `hasMore` stays keyed on the RAW page size: it describes whether
            // the engine had more rows at this offset, which is what the caller
            // needs to page correctly. A scoped page can therefore be shorter
            // than `limit` while `hasMore` is true.
            const scopedEdges = edgeEcosystem === '*'
                ? edges
                : await confineEdgesToEcosystem(resolved.graph, edges, edgeEcosystem);
            writeJson(res, 200, {
                count: scopedEdges.length,
                hasMore: edges.length === limit,
                workspace: resolved.resolvedWorkspace || null,
                ecosystem: edgeEcosystem,
                edges: scopedEdges,
            });
        } catch (err) {
            console.error(`[Lore HTTP] GET /api/edges failed: ${redactError(err)}`);
            writeError(res, 500, 'internal_error', redactError(err)); // F-COL5
        }
        return true;
    }

    return false;
}
