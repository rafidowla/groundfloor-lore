/**
 * search.ts — Read-only knowledge-graph queries.
 *
 *   GET /api/recall   — compact recall, mirrors the MCP `recall` tool's
 *                       summary mode (used by `lore recall` CLI + the
 *                       UserPromptSubmit hook to avoid graph engine lock
 *                       fights)
 *   GET /api/search   — full-text content search for the UI dashboard
 *   GET /api/nodes    — type-filtered LoreNode list for inspector renderers
 *
 * The recall route reads `detectedScope` so a no-arg call falls back to
 * the daemon's auto-detected project/ecosystem scope; pass
 * `?crossProject=true` to widen it to '*' / '*'.
 */

import { randomUUID } from 'node:crypto';
import { ecosystemMatches } from '../../../core/ecosystemMatch.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { LoreNode } from '../../../providers/types.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeWorkspaceRequired, writeError, extractWorkspace } from '../helpers.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { parseSearchMode, parseTags, parseQueries, parseCsvParam, parseAbstainParam, parseRerankParam, denyCrossWorkspaceRead, validateTypesParam } from './searchRouteParams.js';
import { retrieve, type RetrieveContext } from '../../../recall/retrieve.js';
import { hydrateApiQueryHits } from './apiQueryHydration.js';
import { projectResults, projectKeywordNodes } from '../../../recall/retrievalProjection.js';
import { buildRecallResult, buildCompactCandidates, buildRelatedCandidates } from '../../../recall/recallPreset.js';
import { buildRelevanceMeta, notApplicableRelevanceMeta } from '../../../recall/abstention.js';
import { toSnakeRerankMeta } from '../../../recall/rerankStage.js';
import { expandCandidates, MAX_EXPAND_IDS } from '../../../recall/recallExpand.js';
import { runCrossWorkspaceRecall } from '../../tools/recallCrossWorkspace.js';
import { redactError } from '../../../security/logRedact.js';
import { filterNodesByActorScope } from '../../../security/scopeFilter.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';

/**
 * Read + JSON.parse, with the same error-swallowing semantics the old
 * inline `readBody` had: malformed JSON resolves to `{}` so the route
 * still 400s downstream on missing `query`. Oversize requests rethrow
 * the payload-too-large marker so the caller can map to HTTP 413.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
    const data = await readBoundedBody(req);
    try { return JSON.parse(data); } catch { return {}; }
}

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;

export interface SearchDeps {
    store: StorageBundle;
    detectedScope: { workspace: string; ecosystem: string };
    /** Allows the route to call `gateRoute` for ReBAC checks. */
    deploymentMode: 'local' | 'cloud';
    /** Dataplane handle used by ReBAC checks. Null in local mode. */
    dataplane: GroundfloorClient | null;
    /**
     * Phase 6 P1.C — multi-workspace LocalGraph registry. When wired,
     * GET /api/recall accepts `?workspace=<name>` (route to that
     * workspace's graph) and `?workspace=*` (iterate workspaces.json
     * and merge by score). When omitted on the request, behavior
     * matches pre-P1.C (active-only). Optional so cloud-mode + tests
     * fall back to the legacy boot-bound graph.
     */
    graphRegistry?: LocalGraphRegistry;
    /**
     * P2 (scalability) — per-workspace verbatim (LanceDB) resolver. Threaded
     * into the shared retrieve() core so GET /api/recall + /api/search against a
     * NON-active workspace seed semantic + BM25 against that workspace's OWN
     * verbatim store instead of a keyword-only scan. Optional — cloud mode /
     * tests omit it and non-active recall degrades to keyword (prior behavior).
     */
    workspaceVerbatimResolver?: {
        getOrOpen(ws: string): Promise<import('../../../engines/verbatimStoreApi.js').VerbatimStoreApi>;
    };
}

export async function trySearchRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: SearchDeps,
): Promise<boolean> {
    // Compact recall over HTTP. Same shape as the MCP recall tool's
    // summary mode. Used by `lore recall` CLI and the UserPromptSubmit
    // hook so they don't have to open the graph engine (which would clash
    // with the daemon's exclusive lock). GET-style with query params for
    // trivial shell invocation.
    if (pathname === '/api/recall' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const recallParams = new URL(url, 'http://localhost').searchParams;
            const topic = recallParams.get('topic') ?? '';
            if (!topic) {
                writeError(res, 400, 'topic_required', '`topic` query param is required');
                return true;
            }
            const crossProject = recallParams.get('crossProject') === 'true';
            const includeSuperseded = recallParams.get('include_superseded') === 'true'
                || recallParams.get('includeSuperseded') === 'true';
            // RC2 audit (2026-05-17): clamp `max` to a sane range so an
            // adversarial caller can't request millions of rows (DoS
            // via vector + graph scans) or pass NaN / negative values
            // through to the verbatim store, which has surprising
            // semantics outside [1, 100].
            const RECALL_MAX_DEFAULT = 8;
            const RECALL_MAX_CAP = 100;
            const rawMax = parseInt(recallParams.get('max') ?? '', 10);
            const max = Number.isFinite(rawMax) && rawMax > 0
                ? Math.min(rawMax, RECALL_MAX_CAP)
                : RECALL_MAX_DEFAULT;
            // P7/P8 — REST recall now accepts search_mode + tags (parity with the
            // MCP recall tool). Absent → 'hybrid' / no filter (prior behaviour).
            // These apply to the single-workspace path below; the "*" cross-
            // workspace aggregator does not thread them (pending the P2 #9 fold).
            const recallModeParsed = parseSearchMode(recallParams);
            if (typeof recallModeParsed !== 'string') {
                writeError(res, 400, 'invalid_search_mode', recallModeParsed.error, { reason: recallModeParsed.error });
                return true;
            }
            const recallMode = recallModeParsed;
            const recallTags = parseTags(recallParams);
            // 3.21 step 3(f) — parity with the MCP recall tool: extra
            // phrasings fused via the shared RRF, plus entities/topics/project
            // filters over the 3.21 step 3(e) metadata. Absent → today's
            // single-phrasing, unfiltered behaviour (prior behaviour).
            const recallQueries = parseQueries(recallParams);
            const recallEntities = parseCsvParam(recallParams, 'entities');
            const recallTopics = parseCsvParam(recallParams, 'topics');
            const recallProject = recallParams.get('project') ?? undefined;
            // fix/3.22.1-d1-recall-option-parity — D2 type/kind prefilter,
            // parity with the MCP recall tool's `types` param (comma-
            // separated, same convention as `tags`/`entities`/`topics`
            // above). Absent → undefined (no filter, prior behaviour).
            const recallTypes = parseCsvParam(recallParams, 'types');
            // fix/3.22.1-recall-parity review fix (3) — bound `?types=`,
            // matching the MCP recall tool's zod schema (max 20 items, each
            // <=100 chars).
            if (recallTypes) {
                const typesErr = validateTypesParam(recallTypes);
                if (typesErr) {
                    writeError(res, 400, 'invalid_types', typesErr.error, { reason: typesErr.error });
                    return true;
                }
            }
            // D1 — ?abstain=true / ?relevance_floor=<n>, parity with the MCP
            // recall tool's abstain/relevance_floor params. Absent → abstain
            // off (calibration/relevance _meta fields always on regardless).
            const recallAbstain = parseAbstainParam(recallParams); // undefined when absent → LORE_RECALL_ABSTAIN applies
            // D8b — ?rerank=1|0, parity with the MCP recall tool's `rerank`
            // param. Absent → undefined (workspace/env precedence applies).
            const recallRerank = parseRerankParam(recallParams);
            const recallFloorRaw = recallParams.get('relevance_floor');
            const recallRelevanceFloor = recallFloorRaw !== null && Number.isFinite(Number(recallFloorRaw)) ? Number(recallFloorRaw) : undefined;
            // 3.21 step 3(g) — ?compact=true returns N compact candidates
            // instead of full nodes; pair with POST /api/recall/expand.
            const recallCompact = recallParams.get('compact') === 'true';
            // R4 #3 — `?ecosystem=` on /api/recall, the twin of the same
            // parameter 70 lines below on /api/search. Until now this route
            // hard-wired `deps.detectedScope.ecosystem`, so the sibling routes
            // over the SAME retrieve() core disagreed about whether a caller
            // may state its own scope. detectedScope is resolved once at boot
            // from process.cwd() and is identical for every request; it is a
            // default, never a tenant boundary. crossProject still widens
            // to '*' (retrieve() forces that itself).
            const recallEcoParam = recallParams.get('ecosystem');
            const recallEcosystem = crossProject
                ? '*'
                : (recallEcoParam && recallEcoParam.length > 0 ? recallEcoParam : deps.detectedScope.ecosystem);
            // Sprint L1d — workspace is required on every read. "*"
            // runs the cross-workspace aggregator; a single name routes
            // the recall through that workspace's LocalGraph via the
            // registry. Omitted = HTTP 400 workspace_required (no
            // silent active-workspace fallback).
            const requestedWorkspace = recallParams.get('workspace');
            if (!requestedWorkspace) {
                writeWorkspaceRequired(res);
                return true;
            }

            // SP-04 — the read scope this request actually exercises.
            // crossProject=true silently widens the search to '*' below
            // (line ~280: `workspaceScope = crossProject ? '*' : ...`),
            // so the scope check MUST be against that widened target —
            // not the literal `workspace` param. Without this an app
            // token bound to "developer" could call
            //   ?workspace=developer&crossProject=true
            // and pass the gate (developer === bound ws) while the
            // search itself ran over every workspace. Treat
            // crossProject=true as equivalent to workspace="*".
            const effectiveReadScope: string = crossProject ? '*' : requestedWorkspace;
            const isCrossWorkspace = effectiveReadScope === '*'
                || effectiveReadScope !== requestedWorkspace
                || requestedWorkspace === '*';

            // Phase 6 P3 / SP-04 — token-scoped read gate.
            //   - Principal bound (Bearer call): cross-workspace reads
            //     (including "*" and crossProject) require
            //     `cross-workspace-read`. A single-named read to the
            //     bound workspace is allowed.
            //   - No principal: /api/recall was removed from the public
            //     allowlist on 2026-06-19, so a missing principal on this
            //     path is now unreachable through the normal middleware.
            //     The defense-in-depth branch below stays — if /api/recall
            //     ever re-enters the public set, cross-workspace reads
            //     must still fail closed.
            const recallPrincipal = getCurrentPrincipal();
            if (recallPrincipal) {
                if (bindRouteTarget(res, { requested: effectiveReadScope, intent: 'read' }) === null) return true;
            } else if (isCrossWorkspace) {
                writeError(
                    res, 403, 'cross_workspace_no_principal',
                    'cross-workspace recall (workspace="*" or crossProject=true) requires an authenticated token; pass a Bearer scoped with cross-workspace-read',
                    { reason: 'cross-workspace recall (workspace="*" or crossProject=true) requires an authenticated token; pass a Bearer scoped with cross-workspace-read' },
                );
                return true;
            }

            if (requestedWorkspace === '*' && deps.graphRegistry) {
                // P2 #9 — REST cross-workspace recall now uses the ONE shared
                // runCrossWorkspaceRecall (was a separate HTTP-only duplicate),
                // so MCP / embedded / REST cross-workspace can't diverge. The
                // scale protections (workspace cap + bounded concurrency) now
                // live inside that shared impl, so nothing regresses.
                // D2-auth-1 — confine the "*" fan-out to the principal's allowed
                // workspaces (mirrors the MCP-side F-LOW-T14 fix, which this REST
                // twin had missed). A bound principal with an explicit
                // allowedWorkspaces list only sees those (∪ its own); a
                // cross-workspace-read principal without an explicit list, and the
                // null-principal local path, keep current behavior (undefined).
                const allowedWorkspaces = recallPrincipal && recallPrincipal.allowedWorkspaces && recallPrincipal.allowedWorkspaces.length > 0
                    ? Array.from(new Set([...recallPrincipal.allowedWorkspaces, recallPrincipal.workspace]))
                    : undefined;
                const xw = await runCrossWorkspaceRecall({
                    topic, depth: 1, includeSuperseded, includeArchived: false,
                    // R4 #3 — honour (and report) the caller's ecosystem here
                    // too, so the "*" branch can't silently ignore a scope the
                    // named-workspace branch enforces.
                    ecosystem: recallEcosystem,
                    tags: recallTags, types: recallTypes, // fix/3.22.1-d1-recall-option-parity — tags was already parsed above but never threaded into this branch; types is the new parity fix
                    rerank: recallRerank, // D8b
                    registry: deps.graphRegistry, verbatimStore: deps.store.loreVerbatim,
                    sessionCache: deps.store.sessionCache, responseMode: 'summary',
                    allowedWorkspaces,
                    workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // P2 — each workspace seeds its own verbatim store.
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end((xw as { content: Array<{ text: string }> }).content[0]!.text);
                return true;
            }
            // Single-workspace recall via the shared retrieve() core +
            // buildRecallResult preset (Retrieval Unification P2). Was a
            // semantic-first / keyword-fallback path with no traversal; now the
            // full hybrid (semantic + BM25 → RRF) + depth-1 traversal + the
            // RecallResult shape — identical to the MCP recall tool + embedded
            // recall, so the three can no longer diverge.
            // P2: thread the per-workspace verbatim resolver so a non-active
            // workspace recall seeds semantic + BM25 against its OWN LanceDB.
            const recallCtx: RetrieveContext = { store: deps.store, graphRegistry: deps.graphRegistry, workspaceVerbatimResolver: deps.workspaceVerbatimResolver };
            let recallOutcome;
            try {
                recallOutcome = await retrieve(recallCtx, topic, {
                    workspace: requestedWorkspace, ecosystem: recallEcosystem,
                    mode: recallMode, depth: 1, limit: max, tags: recallTags, types: recallTypes, includeSuperseded, includeArchived: false, crossProject,
                    queries: recallQueries, entities: recallEntities, topics: recallTopics, project: recallProject, // 3.21 step 3(f)
                    abstain: recallAbstain, relevanceFloor: recallRelevanceFloor, // D1
                    rerank: recallRerank, // D8b
                });
            } catch (wsErr) {
                if ((wsErr as { code?: string }).code === 'workspace_not_found') {
                    const e = wsErr as { requested?: string; known?: string[] };
                    writeError(res, 404, 'workspace_not_found', `workspace "${e.requested ?? ''}" not found`, { requested: e.requested, known: e.known });
                    return true;
                }
                throw wsErr;
            }
            // 3.21 step 3(g) — compact bypasses buildRecallResult entirely,
            // same short-circuit the MCP `recall` tool takes.
            if (recallCompact) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    topic, scope: { workspace: requestedWorkspace, ecosystem: recallEcosystem },
                    // 3.21 step 3(h) — echo back to POST /api/recall/outcome to
                    // tie an outcome to this specific recall call.
                    queryId: randomUUID(),
                    candidates: buildCompactCandidates(recallOutcome),
                    // D4 fix: graph-traversal neighbours, separate from
                    // `candidates`. Omitted (not []) when there are none.
                    ...(recallOutcome.related.length > 0 ? { related: buildRelatedCandidates(recallOutcome) } : {}),
                    tip: 'POST /api/recall/expand with {ids, workspace} for chosen candidate ids to fetch their full bodies.',
                    _meta: {
                        ...buildRelevanceMeta(recallOutcome.meta), // D1
                        // D8b — absent unless rerank actually ran for this call.
                        ...(recallOutcome.meta.rerank ? { rerank: toSnakeRerankMeta(recallOutcome.meta.rerank) } : {}),
                    },
                }));
                return true;
            }
            const recallGraph = deps.graphRegistry
                // getGraphHandle honours the workspace's declared engine,
                // so recall runs against that workspace's own graph rather
                // than an unrelated one. The `recallGraph as unknown as`
                // cast below stays load-bearing:
                // `RecallGraph` needs getLanguageBreakdown, which is on neither
                // LoreGraphHandle nor WorkspaceGraph (recallPreset.ts is out
                // of this batch's scope).
                ? await deps.graphRegistry.getGraphHandle(requestedWorkspace)
                : deps.store.loreGraph;
            const recallResult = await buildRecallResult(
                {
                    topic, responseMode: 'summary', searchMode: recallMode, workspaceScope: requestedWorkspace,
                    ecosystemScope: recallEcosystem, crossProject,
                    // D2 (3.22.1): same fix as the MCP recall tool — REST's own
                    // `max` (parsed above, default RECALL_MAX_DEFAULT=8, capped
                    // at RECALL_MAX_CAP=100) already sizes retrieve()'s `limit`,
                    // but buildRecallResult was separately hard-capping summary
                    // display at 10 regardless, so `?max=25` silently lost to
                    // that inner cap. Threading it through here fixes REST too.
                    maxHits: max,
                },
                recallOutcome,
                recallGraph as unknown as Parameters<typeof buildRecallResult>[2],
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(recallResult));
        } catch (recallErr) {
            writeError(res, 500, 'internal_error', redactError(recallErr));
        }
        return true;
    }

    // 3.21 step 3(g) — full node bodies for chosen `compact:true` candidate
    // ids. Same confinement recall itself enforces (see recallExpand.ts):
    // an id outside the caller's workspace/ecosystem/actor scope is
    // silently dropped, not an error.
    if (pathname === '/api/recall/expand' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        let parsedBody: unknown;
        try {
            parsedBody = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
            return true;
        }
        try {
            const { ids, ecosystem: rawEcosystem } = parsedBody as { ids?: unknown; ecosystem?: string };
            const queryParams = new URL(url, 'http://localhost').searchParams;
            const workspace = extractWorkspace(parsedBody as Record<string, unknown>, queryParams);
            if (!workspace) {
                writeWorkspaceRequired(res);
                return true;
            }
            if (workspace === '*') {
                writeError(res, 400, 'cross_workspace_not_supported', '/api/recall/expand requires a single named workspace, matching the workspace the originating recall ran against');
                return true;
            }
            // SP-04 — token-scoped read gate, same as GET /api/search.
            if (denyCrossWorkspaceRead(res, workspace)) return true;
            if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
                writeError(res, 400, 'ids_required', '`ids` must be a non-empty array of strings');
                return true;
            }
            if (ids.length > MAX_EXPAND_IDS) {
                writeError(res, 400, 'too_many_ids', `at most ${MAX_EXPAND_IDS} ids per call`, { max: MAX_EXPAND_IDS, requested: ids.length });
                return true;
            }
            const ecosystem = rawEcosystem && rawEcosystem.length > 0 ? rawEcosystem : deps.detectedScope.ecosystem;
            let expandGraph: LoreGraph = deps.store.loreGraph;
            if (deps.graphRegistry) {
                try {
                    expandGraph = await deps.graphRegistry.getGraphHandle(workspace);
                } catch (wsErr) {
                    if (wsErr instanceof WorkspaceNotFoundError) {
                        writeError(res, 404, 'workspace_not_found', `workspace "${wsErr.requested}" not found`, { requested: wsErr.requested, known: wsErr.known });
                        return true;
                    }
                    throw wsErr;
                }
            }
            const nodes = await expandCandidates(expandGraph, ids as string[], ecosystem);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ requested: ids.length, expanded: nodes.length, nodes }));
        } catch (expandErr) {
            writeError(res, 500, 'internal_error', redactError(expandErr));
        }
        return true;
    }

    // Full-text content search from the UI dashboard.
    if (url.startsWith('/api/search') && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const searchParams = new URL(url, 'http://localhost').searchParams;
            const query = searchParams.get('q') ?? '';
            if (!query.trim()) {
                writeError(res, 400, 'query_required', '`q` query param is required');
                return true;
            }
            // Sprint L1d — workspace is required on every read; no
            // silent fallback to the daemon's active workspace.
            const workspace = extractWorkspace(null, searchParams);
            if (!workspace) {
                writeWorkspaceRequired(res);
                return true;
            }
            // SP-04 — token-scoped read gate. A principal bound to
            // workspace A requesting workspace B (or "*") is refused
            // unless it holds cross-workspace-read. Null principal keeps
            // the legacy/local happy path (matches POST /api/node).
            if (denyCrossWorkspaceRead(res, workspace)) return true;
            // P7/P8 — REST search now accepts search_mode + tags (parity with the
            // MCP search tool). Absent → 'hybrid' / no filter (prior behaviour).
            const searchModeParsed = parseSearchMode(searchParams);
            if (typeof searchModeParsed !== 'string') {
                writeError(res, 400, 'invalid_search_mode', searchModeParsed.error, { reason: searchModeParsed.error });
                return true;
            }
            const searchMode = searchModeParsed;
            const searchTags = parseTags(searchParams);
            // fix/3.22.1-d1-recall-option-parity — the MCP `search` tool has
            // had a `types` D2 prefilter since D2; REST /api/search never
            // parsed it. Same comma-separated convention as `tags` above.
            const searchTypes = parseCsvParam(searchParams, 'types');
            // fix/3.22.1-recall-parity review fix (3) — bound `?types=`,
            // matching the MCP search tool's zod schema (max 20 items,
            // each <=100 chars).
            if (searchTypes) {
                const typesErr = validateTypesParam(searchTypes);
                if (typesErr) {
                    writeError(res, 400, 'invalid_types', typesErr.error, { reason: typesErr.error });
                    return true;
                }
            }
            // `?ecosystem=` wins over the boot-detected default — see the
            // POST /api/query note below for why the detected value is only a
            // default (process-global, derived once from process.cwd()).
            const ecoParam = searchParams.get('ecosystem');
            const searchEcosystem = ecoParam && ecoParam.length > 0 ? ecoParam : deps.detectedScope.ecosystem;
            // D1 — parity with GET /api/recall above.
            const searchAbstain = parseAbstainParam(searchParams); // undefined when absent → LORE_RECALL_ABSTAIN applies
            const searchFloorRaw = searchParams.get('relevance_floor');
            const searchRelevanceFloor = searchFloorRaw !== null && Number.isFinite(Number(searchFloorRaw)) ? Number(searchFloorRaw) : undefined;
            // Retrieval Unification P2 — named workspace routes through the shared
            // retrieve() core (hybrid; REST search was keyword-only before), depth=0
            // = flat ranked list, matchedBy+score per result (D4). "*" = legacy (#9).
            if (workspace === '*') {
                // Legacy boot-graph scan (all projects) — folds into the core at
                // P2 #9; NOT cross-workspace aggregation. search_mode applies only
                // to the named-workspace core path below (this legacy path is
                // keyword-only), but it now honours the tags filter for parity.
                const legacySignals = { scanCapHit: false };
                let legacy = await deps.store.loreGraph.search(query, 50, '*', searchEcosystem, false, legacySignals);
                // R4 #2 — `?ecosystem=` was PARSED for every request and then
                // dropped on this branch: the scan hardcoded '*' and nothing
                // post-filtered, while projectKeywordNodes returns full
                // `content`. A silently-ignored scope parameter on a
                // content-returning read is the same defect the comment 20
                // lines below is about. The pushdown is an optimisation; this
                // filter is the decision point, exactly as on the core path.
                legacy = legacy.filter((n) => ecosystemMatches((n as { ecosystem?: string }).ecosystem, searchEcosystem));
                if (searchTags) {
                    const lw = searchTags.map((t) => t.toLowerCase().trim());
                    legacy = legacy.filter((n) => lw.every((t) => (n.tags ?? []).includes(t)));
                }
                // 3.1 (2026-08-17) — row-level security_scopes confinement on
                // the graph-read results: hide nodes whose security_scopes
                // don't intersect the bound actor's scopes. Undefined actor
                // scopes (local/embedded, no actor bound) ⇒ no filtering.
                legacy = filterNodesByActorScope(legacy);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ query, workspace, resultCount: legacy.length, vector_index_consulted: false, ...(legacySignals.scanCapHit ? { scan_cap_hit: true } : {}), ...(searchTags ? { tag_filter: searchTags } : {}), results: projectKeywordNodes(legacy), _meta: notApplicableRelevanceMeta('search:*') }));
                return true;
            }
            const ctx: RetrieveContext = { store: deps.store, graphRegistry: deps.graphRegistry, workspaceVerbatimResolver: deps.workspaceVerbatimResolver };
            let outcome;
            try {
                // `ecosystem` is REQUIRED, exactly as on GET /api/recall above.
                // Without it retrieve() resolves ecosystemScope to '*'
                // (search-everything) and both its seed filter and its per-hop
                // filter become no-ops — on a route that returns full node
                // content. This makes /api/search agree with /api/recall about
                // the scope; it does NOT by itself deliver per-tenant
                // isolation, because the default source (detectedScope) is a
                // boot-global value. `?ecosystem=` is how a caller supplies a
                // real per-request scope.
                outcome = await retrieve(ctx, query, { workspace, ecosystem: searchEcosystem, mode: searchMode, depth: 0, limit: 50, tags: searchTags, types: searchTypes, abstain: searchAbstain, relevanceFloor: searchRelevanceFloor });
            } catch (wsErr) {
                if ((wsErr as { code?: string }).code === 'workspace_not_found') {
                    const e = wsErr as { requested?: string; known?: string[] };
                    writeError(res, 404, 'workspace_not_found', `workspace "${e.requested ?? ''}" not found`, { requested: e.requested, known: e.known });
                    return true;
                }
                throw wsErr;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ query, workspace, resultCount: outcome.results.length, vector_index_consulted: outcome.meta.verbatimConsulted, ...(outcome.meta.scanCapHit ? { scan_cap_hit: true } : {}), ...(outcome.meta.bm25Ranked === false ? { bm25_ranked: false } : {}), ...(outcome.meta.vectorLegSkipped ? { vector_leg_skipped: true } : {}), ...(searchTags ? { tag_filter: searchTags } : {}), results: projectResults(outcome.results), _meta: buildRelevanceMeta(outcome.meta) }));
        } catch (searchErr) {
            writeError(res, 500, 'internal_error', redactError(searchErr));
        }
        return true;
    }

    // GET /api/nodes — type-filtered list of LoreNode rows for the
    // shell's inspector renderers. Thin wrapper around
    // LocalGraph.listNodes; sliced client-side to the caller's limit
    // (engine has no server-side limit).
    //
    // Query params: type (required), tag (optional), limit (default 100, max 1000).
    if (pathname === '/api/nodes' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const urlObj = new URL(req.url ?? '/api/nodes', 'http://local');
            const type = urlObj.searchParams.get('type') ?? undefined;
            const tag = urlObj.searchParams.get('tag') ?? undefined;
            const limitParam = Number(urlObj.searchParams.get('limit'));
            const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100, 1000);
            // Sprint L1d — workspace required, no silent '*' fallback.
            const workspace = extractWorkspace(null, urlObj.searchParams);
            if (!workspace) {
                writeWorkspaceRequired(res);
                return true;
            }
            // SP-04 — token-scoped read gate (see denyCrossWorkspaceRead).
            if (denyCrossWorkspaceRead(res, workspace)) return true;
            if (!type) {
                writeError(res, 400, 'type_required', 'type is a required query parameter');
                return true;
            }
            let listGraph: LoreGraph = deps.store.loreGraph;
            if (deps.graphRegistry) {
                try {
                    listGraph = await deps.graphRegistry.getGraphHandle(workspace);
                } catch (wsErr) {
                    if (wsErr instanceof WorkspaceNotFoundError) {
                        writeError(res, 404, 'workspace_not_found', `workspace "${wsErr.requested}" not found`, { requested: wsErr.requested, known: wsErr.known });
                        return true;
                    }
                    throw wsErr;
                }
            }
            // PERF (Audit 2026-05-13): push the limit into the DB so we don't
            // materialize every matching row in JS just to slice. Fetch
            // limit+1 to detect hasMore without a separate count query.
            // R4 #7 — `'*'`, not the workspace name. The 3rd argument is
            // `project` (providers/types.ts:404), which every engine turns
            // into a strict `n.project = $project`. `project` is a
            // CALLER-OWNED node field and is not guaranteed to equal the
            // workspace name (Atlas stores project='v3' inside
            // workspace='default'); retrieve.ts:314-321 documents this exact
            // substitution as the mistake that "silently makes keyword
            // fallback empty while the vector path still appears healthy",
            // and /api/query was corrected to '*' for it while this sibling
            // 130 lines above was left alone. The physical workspace boundary
            // is already enforced by the graph resolution above.
            // R4 #6 — this route also returns RAW rows (full `content`) and had
            // no ecosystem scope at all, so it belonged in the "remaining
            // surfaces" set the last round enumerated. `?ecosystem=` is
            // optional; omitted/'*' = every ecosystem, so existing callers are
            // unaffected. Pushed down AND enforced in JS (the pushdown is an
            // optimisation — core/ecosystemMatch.ts).
            const nodesEcoParam = urlObj.searchParams.get('ecosystem');
            const nodesEcosystem = nodesEcoParam && nodesEcoParam.length > 0 ? nodesEcoParam : '*';
            const fetchedRaw = await listGraph.listNodes(type, tag, '*', nodesEcosystem, limit + 1);
            const fetched = nodesEcosystem === '*'
                ? fetchedRaw
                : fetchedRaw.filter((n) => ecosystemMatches((n as { ecosystem?: string }).ecosystem, nodesEcosystem));
            const hasMore = fetched.length > limit;
            const nodes = hasMore ? fetched.slice(0, limit) : fetched;
            // 3.1 (2026-08-17) — row-level security_scopes confinement on the
            // graph-read results: hide nodes whose security_scopes don't
            // intersect the bound actor's scopes before the rows are
            // serialized. Undefined actor scopes ⇒ no filtering.
            const visibleNodes = filterNodesByActorScope(nodes);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ count: visibleNodes.length, hasMore, ecosystem: nodesEcosystem, nodes: visibleNodes }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    // POST /api/query — retrieval-only (no LLM). Returns matching nodes from
    // graph + vector store. Used by the app for fast data calls (<100ms) that
    // don't need conversational AI (search-as-you-type, Today card data, etc.).
    //
    // Body: { query: string, limit?: number, mode?: 'recall' | 'search' }
    // mode='recall' → verbatim vector search + graph keyword fallback (default)
    // mode='search' → graph keyword search only (faster, no embeddings)
    if (pathname === '/api/query' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        let parsedBody: unknown;
        try {
            parsedBody = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
            return true;
        }
        try {
            const { query, limit: rawLimit, mode, ecosystem: rawEcosystem } = parsedBody as { query?: string; limit?: number; mode?: string; ecosystem?: string };
            // Sprint L1d — workspace required on every read (body or
            // ?workspace= query param). No silent fallback to the
            // daemon's detected-active workspace.
            const queryParams = new URL(url, 'http://localhost').searchParams;
            const workspace = extractWorkspace(parsedBody as Record<string, unknown>, queryParams);
            if (!workspace) {
                writeWorkspaceRequired(res);
                return true;
            }
            // SP-04 — token-scoped read gate (see denyCrossWorkspaceRead).
            if (denyCrossWorkspaceRead(res, workspace)) return true;
            if (!query || typeof query !== 'string' || !query.trim()) {
                writeError(res, 400, 'query_required', '`query` is required');
                return true;
            }
            let queryGraph: LoreGraph = deps.store.loreGraph;
            if (deps.graphRegistry) {
                try {
                    queryGraph = await deps.graphRegistry.getGraphHandle(workspace);
                } catch (wsErr) {
                    if (wsErr instanceof WorkspaceNotFoundError) {
                        writeError(res, 404, 'workspace_not_found', `workspace "${wsErr.requested}" not found`, { requested: wsErr.requested, known: wsErr.known });
                        return true;
                    }
                    throw wsErr;
                }
            }
            const limit = Math.min(typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : 10, 50);
            const useVerbatim = mode !== 'search';
            // Ecosystem confinement. /api/query is a THIRD read surface over the
            // same substrates and it had none: it seeded from verbatim with no
            // filter and then keyword-searched with a hardcoded '*', so a
            // workspace serving several isolated tenants by ecosystem returned
            // every tenant's nodes here while /api/recall confined them.
            //
            // Enforced POST-HYDRATION on the graph node, which is the
            // authoritative copy (retrieve.ts makes the same call for the same
            // reason: the verbatim row's metadata copy can be stale or wrong,
            // and a pushdown alone would DELETE such rows from the result
            // instead of degrading). '*' stays search-everything.
            //
            // `ecosystem` in the BODY wins over the boot-detected default.
            // `deps.detectedScope.ecosystem` is derived ONCE at boot by
            // substring-matching process.cwd() against workspace-paths.json
            // (bootSteps.ts resolveWorkspaceScope, '*' on no match): it is
            // process-global, does not vary with the requested workspace, and
            // cannot separate two tenants served by one daemon. It is a
            // reasonable DEFAULT and nothing more — a host doing real
            // per-principal isolation must send the scope with the request.
            const queryEcosystem = typeof rawEcosystem === 'string' && rawEcosystem.length > 0
                ? rawEcosystem
                : deps.detectedScope.ecosystem;
            const outsideEcosystem = (n: LoreNode): boolean =>
                !ecosystemMatches((n as { ecosystem?: string }).ecosystem, queryEcosystem);
            // D5 #5 — /api/query used to just HIDE a superseded hit
            // (`!n.supersededAt`), unlike /api/recall + /api/search which
            // replace it with its live successor via the shared
            // supersessionRecall helper. This is a raw exact-match surface
            // (structured_query's sibling — see that file's doc comment for
            // why it deliberately skips `corrects` adjacency), so only
            // successor REPLACEMENT applies here, not adjacency injection.
            const admitD5 = (n: LoreNode): boolean => !outsideEcosystem(n) && n.status !== 'archived';

            // D5 file-size extraction — the seed + keyword-fallback
            // hydration (verbatim search, batch getNodesByIds, D5
            // successor-replacement via resolveLiveNodes) lives in
            // apiQueryHydration.ts now; this route stayed a lift-and-shift
            // caller to stay under the 800-line file-size guardrail.
            const { hits, scanCapHit } = await hydrateApiQueryHits({
                deps, queryGraph, workspace, query, queryEcosystem, limit, useVerbatim,
                outsideEcosystem, admitD5,
            });
            const querySignals = { scanCapHit };

            // 3.1 (2026-08-17) — row-level security_scopes confinement on the
            // graph-read results: hide nodes whose security_scopes don't
            // intersect the bound actor's scopes before serialization.
            // Undefined actor scopes ⇒ no filtering.
            const visibleHits = filterNodesByActorScope(hits);
            const SNIPPET_LEN = 200;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                query,
                mode: useVerbatim ? 'recall' : 'search',
                count: visibleHits.length,
                ...(querySignals.scanCapHit ? { scan_cap_hit: true } : {}),
                results: visibleHits.map(n => ({
                    id: n.id,
                    type: n.type,
                    label: n.label,
                    project: n.project,
                    tags: n.tags,
                    snippet: typeof n.content === 'string'
                        ? n.content.slice(0, SNIPPET_LEN).replace(/\s+/g, ' ').trim()
                          + (n.content.length > SNIPPET_LEN ? '…' : '')
                        : null,
                    createdAt: n.createdAt,
                    updatedAt: n.updatedAt,
                })),
            }));
        } catch (queryErr) {
            writeError(res, 500, 'internal_error', redactError(queryErr));
        }
        return true;
    }

    return false;
}
