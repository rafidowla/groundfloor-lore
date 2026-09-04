/**
 * topology.ts — UI graph-rendering endpoints.
 *
 *   GET /api/topology            — full topology slice (cap 20k, default 10k)
 *   GET /api/topology/overview   — semantic-zoom blobs + cross-project edges
 *
 * ─── R6 #4 — `?ecosystem=` on both branches ──────────────────────────────────
 * Both answer "what EXISTS", so they are ENUMERATION/TOPOLOGY surfaces under
 * DEC-SCOPE-SURFACE-CLASS, whose rule is: default `'*'`, caller states the
 * scope, response states what was ENFORCED. Neither had the parameter, while
 * the entry claimed "every read surface MUST expose the override" and listed
 * six surfaces — the fourth consecutive round in which the enumeration, not
 * the code, was the thing that was wrong.
 *
 * They enforce it differently, deliberately:
 *   - `/api/topology` filters the HYDRATED rows (`getTopology` has no
 *     ecosystem parameter on any engine, and the projection omits the column),
 *     then drops every edge with an endpoint outside the kept set — the same
 *     closed-edge rule `subgraphFetch` uses, so no cross-boundary topology
 *     survives. The row cap is applied by the engine BEFORE this filter, so a
 *     scoped page can be short; `truncated` already reports the cap.
 *   - `/api/topology/overview` REFUSES a concrete scope with 501. Its
 *     aggregates (per-project counts, cross-project bundle counts) are computed
 *     engine-side with no ecosystem predicate and no per-node output to filter,
 *     so it cannot enforce one. Refusing is the only honest option: silently
 *     ignoring a parsed scope parameter is DEC-SCOPE-HONESTY rule 2, which is
 *     what this route did before.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { writeWorkspaceRequired, writeError } from '../helpers.js';
import { ecosystemMatches } from '../../../core/ecosystemMatch.js';
import { redactError } from '../../../security/logRedact.js';
import { filterNodesByActorScope } from '../../../security/scopeFilter.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;

/**
 * getTopologyOverview[ByType] are implemented by LocalGraph, SurrealGraph
 * AND DataplaneGraph, but are not on LoreGraphHandle — the Arcade scoped
 * handle lacks them, which is why they can't simply be promoted onto the
 * shared interface the way queryEdges/deleteEdge/bulkList were. Probe the
 * METHOD, never the engine family, same as hasLanguageBreakdown
 * (mcp/tools/search/helpers.ts).
 */
interface TopologyOverviewGraph {
    getTopologyOverview(): Promise<Record<string, unknown>>;
    getTopologyOverviewByType(): Promise<Record<string, unknown>>;
}

/** True when this graph can produce the topology-overview aggregates. */
function hasTopologyOverview(graph: unknown): graph is TopologyOverviewGraph {
    return !!graph
        && typeof graph === 'object'
        && typeof (graph as TopologyOverviewGraph).getTopologyOverview === 'function'
        && typeof (graph as TopologyOverviewGraph).getTopologyOverviewByType === 'function';
}

export interface TopologyDeps {
    store: StorageBundle;
    /** Allows the route to call `gateRoute` for ReBAC checks. */
    deploymentMode: 'local' | 'cloud';
    /** Dataplane handle used by ReBAC checks. Null in local mode. */
    dataplane: GroundfloorClient | null;
    /** SP-04 — multi-workspace registry so topology reads resolve to the
     *  requested workspace's graph instead of the boot-bound active one.
     *  Optional; absent → legacy boot-bound `deps.store.loreGraph`. */
    graphRegistry?: LocalGraphRegistry;
}

/**
 * resolveTopologyGraph — SP-04. Both /api/topology branches dumped the
 * boot-bound active-workspace graph (up to 20k nodes) regardless of the
 * caller's principal scope. This gate mirrors the other read routes:
 * workspace is required (no silent active fallback), the principal must
 * be allowed to read it (cross-workspace / "*" needs cross-workspace-read),
 * and the graph is resolved per workspace. Returns null after writing the
 * 4xx; caller must `return true` on null.
 */
async function resolveTopologyGraph(
    res: ServerResponse,
    searchParams: URLSearchParams,
    deps: TopologyDeps,
): Promise<LoreGraph | null> {
    const requestedWorkspace = searchParams.get('workspace') ?? undefined;
    if (!requestedWorkspace) { writeWorkspaceRequired(res); return null; }
    if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'read' }) === null) return null;
    let graph: LoreGraph = deps.store.loreGraph;
    if (deps.graphRegistry) {
        try {
            graph = await deps.graphRegistry.getGraphHandle(requestedWorkspace);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                writeError(res, 404, 'workspace_not_found', `workspace "${err.requested}" not found`, { requested: err.requested, known: err.known });
                return null;
            }
            throw err;
        }
    }
    return graph;
}

/**
 * confineTopology — R6 #4. Keep only the rows the requested ecosystem may see,
 * then only the edges whose BOTH endpoints survived.
 *
 * The HYDRATED graph row is authoritative: the topology projection carries
 * `id/label/type/project` but not `ecosystem`, and no engine's `getTopology`
 * takes an ecosystem argument, so the scope is decided here on a batch
 * `getNodesByIds` of the (already capped) page rather than pushed down. Same
 * reasoning `recall/retrieve.ts` gives for its seed filter — the pushdown is
 * the optimisation, the hydrated row is the boundary.
 *
 * A row that does not hydrate (an externally-contributed `file:`/`symbol:`
 * node, or a deleted one) cannot be shown to be in scope, so under a concrete
 * scope it is dropped — the rule `subgraphFetch` applies to dangling edges.
 * Under `'*'` this is a no-op and costs nothing: the default path issues no
 * extra query at all.
 *
 * Returns the replacement fields, or `{}` when unscoped.
 */
async function confineTopology(
    graph: LoreGraph,
    topology: { nodes: unknown[]; edges: unknown[] },
    ecosystem: string,
): Promise<{ nodes?: unknown[]; edges?: unknown[] }> {
    if (ecosystem === '*') return {};
    const ids = topology.nodes
        .map((n) => String((n as { id?: unknown }).id ?? ''))
        .filter((id) => id.length > 0);
    const hydrated = await graph.getNodesByIds(ids);
    const kept = new Set<string>();
    const nodes = topology.nodes.filter((n) => {
        const id = String((n as { id?: unknown }).id ?? '');
        const row = hydrated.get(id);
        if (!row) return false;
        if (!ecosystemMatches((row as { ecosystem?: string }).ecosystem, ecosystem)) return false;
        kept.add(id);
        return true;
    });
    const endpoint = (e: unknown, a: string, b: string): string =>
        String((e as Record<string, unknown>)[a] ?? (e as Record<string, unknown>)[b] ?? '');
    const edges = topology.edges.filter((e) =>
        kept.has(endpoint(e, 'from', 'source')) && kept.has(endpoint(e, 'to', 'target')));
    return { nodes, edges };
}

export async function tryTopologyRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: TopologyDeps,
): Promise<boolean> {
    // UI Visualizer Data API Endpoint. Core returns LoreNode/LoreEdge;
    // external clients contribute their own slice (client-owned node and
    // edge tables + cross-pillar edges) via contributeTopology.
    //
    // Phase 3: hard 20k ceiling + truncation signal.
    //   - ?limit=N query param, clamped to [TOPOLOGY_MIN, TOPOLOGY_HARD_CAP]
    //   - response carries { truncated, limit, totalCoreNodes } so the
    //     UI can render the "graph too large — use filters" banner
    //   - getStats() gives us the authoritative core count; external
    //     contributions are flagged truncated via the heuristic
    //     "client returned exactly limit" since contributeTopology does
    //     not expose a count surface
    //   - ordering: the graph engine's natural order for now; most-recent ORDER BY
    //     would touch getTopology internals and the other 4 call sites.
    //     Deferred to a follow-up when a second pass on topology
    //     sampling is warranted.
    if (pathname === '/api/topology' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const TOPOLOGY_RENDER_HARD_CAP = 20000; // render-only — graph storage is uncapped
            const TOPOLOGY_RENDER_MIN = 1000;
            const TOPOLOGY_RENDER_DEFAULT = 10000;
            const urlObj = new URL(req.url ?? '/api/topology', 'http://local');
            // SP-04 — workspace_required + token-scoped read gate +
            // workspace-aware resolution. This endpoint returns up to 20k
            // node ids + labels in one call, so an unscoped read is a
            // bulk graph-metadata exfil.
            const topoGraph = await resolveTopologyGraph(res, urlObj.searchParams, deps);
            if (!topoGraph) return true;
            const rawLimit = Number(urlObj.searchParams.get('limit'));
            const requested = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : TOPOLOGY_RENDER_DEFAULT;
            const limit = Math.min(Math.max(requested, TOPOLOGY_RENDER_MIN), TOPOLOGY_RENDER_HARD_CAP);

            // 2026-04-27 multi-project: accept either
            //   ?project=foo            (single, back-compat)
            //   ?projects=foo,bar,baz   (multi)
            // Both flow through to getTopology + client contributions
            // as a string[].
            const singleProject = urlObj.searchParams.get('project');
            const multiProjects = urlObj.searchParams.get('projects');
            let projectFilter: string[] | undefined = undefined;
            if (multiProjects) {
                const parts = multiProjects.split(',').map((p) => p.trim()).filter(Boolean);
                if (parts.length > 0) projectFilter = parts;
            } else if (singleProject) {
                projectFilter = [singleProject];
            }

            const ecoParam = urlObj.searchParams.get('ecosystem');
            const ecosystem = ecoParam && ecoParam.length > 0 ? ecoParam : '*';

            const topology = await topoGraph.getTopology(limit, projectFilter);
            const stats = await topoGraph.getStats();
            const truncated = stats.nodeCount > limit;
            const scoped = await confineTopology(topoGraph, topology, ecosystem);
            // 3.1 (2026-08-17) — row-level security_scopes confinement on the
            // node list actually serialized (the confined set when a concrete
            // ecosystem was enforced, the raw page otherwise). The topology
            // projection carries no security_scopes on any engine today, so this
            // is a no-op until an engine projects them — the helper is already
            // in place for when it does.
            const confinedNodes = filterNodesByActorScope(scoped.nodes ?? topology.nodes);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...topology,
                ...scoped,
                nodes: confinedNodes,
                ecosystem,
                truncated,
                limit,
                totalCoreNodes: stats.nodeCount,
            }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    // Q1.9 — Semantic-zoom overview. Returns one aggregate blob per
    // project + cross-project edge bundle counts. Aggregation runs on
    // the local graph via graph.getTopologyOverview() — no network, no
    // external vocab leaked (grouping is on the opaque `project` string
    // that every LoreNode carries).
    //
    //   GET /api/topology/overview?groupBy=project
    //
    // `groupBy` is echoed back so future group-by axes (by-type,
    // by-ecosystem) can be added without breaking the frontend's
    // parse. Only `project` is supported today.
    if (pathname === '/api/topology/overview' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const urlObj = new URL(req.url ?? '/api/topology/overview', 'http://local');
            // SP-04 — same workspace_required + token-scoped read gate as
            // /api/topology. The overview leaks per-project node/edge
            // cardinality across the whole active graph; scope it.
            const overviewGraph = await resolveTopologyGraph(res, urlObj.searchParams, deps);
            if (!overviewGraph) return true;
            // R6 #4 — a concrete ecosystem is REFUSED, not ignored. The blob
            // and bundle counts are folded engine-side over every node in the
            // workspace with no ecosystem predicate and no per-node row in the
            // output, so there is nothing to filter here: any answer this route
            // returned under a scope would be an unscoped answer wearing a
            // scope label, which is DEC-SCOPE-HONESTY rule 1. Pushing the
            // predicate into `computeTopologyOverview` on every engine is the
            // real fix; until then, refuse.
            const overviewEco = urlObj.searchParams.get('ecosystem');
            if (overviewEco && overviewEco.length > 0 && overviewEco !== '*') {
                writeError(res, 501, 'ecosystem_scope_unsupported',
                    'GET /api/topology/overview cannot enforce an ecosystem scope: its counts are aggregated in the engine with no ecosystem predicate. Use GET /api/topology?ecosystem= for a scoped slice.',
                    { ecosystem: overviewEco });
                return true;
            }
            const groupBy = urlObj.searchParams.get('groupBy') ?? 'project';
            if (groupBy !== 'project' && groupBy !== 'type') {
                writeError(res, 400, 'unsupported_group_by', `Unsupported groupBy "${groupBy}". Supported values: "project", "type".`);
                return true;
            }
            const operation = groupBy === 'type' ? 'topology_overview_by_type' : 'topology_overview';
            if (!hasTopologyOverview(overviewGraph)) {
                writeError(res, 501, 'cloud_not_implemented', `${operation}: aggregation runs on the local paged node scan`, { operation });
                return true;
            }
            const overview = groupBy === 'type'
                ? await overviewGraph.getTopologyOverviewByType()
                : await overviewGraph.getTopologyOverview();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            // Report the scope that was enforced — here always '*', which is
            // the only scope this route can honestly claim.
            res.end(JSON.stringify({ ...overview, groupBy, ecosystem: '*' }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}
