/**
 * searchTool.ts — the `search` MCP tool. A flat, ranked list of knowledge
 * nodes (no traversal / summaries — that's `recall`). Retrieval Unification P2:
 * named workspaces route through the shared retrieve() core (real hybrid:
 * semantic + BM25 → RRF), so search and recall can no longer disagree. Each
 * result carries `matchedBy` + `score` (the unified contract, D4).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureAccessTracker } from '../../../engines/accessTracker.js';
import { buildLanguageHint, hasLanguageBreakdown, type LanguageHint } from './helpers.js';
import { assertMcpScope } from '../mcpScope.js';
import { filterNodesByActorScope } from '../../../security/scopeFilter.js';
import { ecosystemMatches } from '../../../core/ecosystemMatch.js';
import { retrieve, type RetrieveContext, type MatchKind } from '../../../recall/retrieve.js';
import { projectScored } from '../../../recall/retrievalProjection.js';
import { rrfFuse } from '../../../recall/rrf.js';
import { buildRelevanceMeta, notApplicableRelevanceMeta } from '../../../recall/abstention.js';
import { replaceSupersededInResults } from '../../../recall/supersessionRecall.js';
import type { RetrievalResult } from '../../../recall/retrieve.js';
import type { LoreGraph, SearchToolsDeps } from './types.js';
import type { LoreNode } from '../../../providers/types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';

type Scored = { node: LoreNode; matchedBy: MatchKind[]; score: number; similarity?: number | null; relevance?: number | null };

export function registerSearchTool(mcpServer: McpServer, deps: SearchToolsDeps): void {
    mcpServer.tool(
        'search',
        'Full-text search across all knowledge nodes',
        {
            query: z.string().max(2000).describe('Search query'), // RA2-reaudit2 — cap input length (DoS)
            limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 20, max 200)'), // RA2-reaudit2 — cap (uncapped limit → LanceDB DoS)
            queryLanguage: z.string().optional().describe('ISO 639-1 code for the query language (e.g., "es"). When provided and the corpus is mostly in a different language, the response includes a cross-language hint. Core does not auto-detect — callers tag explicitly if they want the hint.'),
            tags: z.array(z.string()).optional().describe('Gap #2: when provided, filter results to only nodes where ALL specified tags are present in the node\'s tags field. Useful for scoping results to a known tag set (e.g. ["orientation-pack"]).'),
            queries: z.array(z.string().max(2000)).max(5).optional().describe('3.21 step 3(f): up to 5 extra phrasings of `query`, run alongside it and fused into ONE ranked list via the shared reciprocal-rank-fusion. Omitted/empty is exactly today\'s single-phrasing behaviour. Only applies to a NAMED workspace (ignored on workspace="*").'),
            entities: z.array(z.string().max(100)).max(20).optional().describe('3.21 step 3(f): keep only nodes whose stored `entities` (set via store_node, 3.21 step 3(e)) contain ALL of these values. Only applies to a NAMED workspace.'),
            topics: z.array(z.string().max(100)).max(20).optional().describe('3.21 step 3(f): keep only nodes whose stored `topics` (set via store_node, 3.21 step 3(e)) contain ALL of these values. Only applies to a NAMED workspace.'),
            project: z.string().optional().describe('3.21 step 3(f): keep only nodes whose `project` field equals this value exactly. Only applies to a NAMED workspace.'),
            types: z.array(z.string().max(100)).max(20).optional().describe('D2: keep only nodes whose `type` is one of these values (ANY match). PREFILTER applied inside the vector + BM25 query itself, not after ranking. Only applies to a NAMED workspace.'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
            ecosystem: z.string().min(1).optional().describe('Ecosystem scope. Defaults to the daemon-detected scope. Pass "*" to search every ecosystem in the workspace. A host serving several tenants out of ONE workspace must pass the caller\'s ecosystem here — the detected default is derived once at boot from process.cwd() and is identical for every request.'),
            search_mode: z.enum(['semantic', 'keyword', 'hybrid']).default('hybrid').describe('Retrieval mode. For a NAMED workspace, "hybrid" (default) = semantic + BM25 fused via reciprocal-rank-fusion (keyword fallback when the vector index is empty / non-active workspace). For workspace="*" (the legacy cross-project boot graph, not yet folded into the shared core) "hybrid" also fuses via the same shared reciprocal-rank-fusion (recall/rrf.ts) as of 3.21. "semantic" = vector-only (embeds the query). "keyword" = standalone lexical recall — the store\'s BM25 index + the graph\'s own text search, NEVER the embedding provider.'),
            abstain: z.boolean().optional().describe('D1: when true, a query whose calibrated relevance falls below `relevance_floor` returns zero results with `_meta.abstained: true` instead of low-relevance filler. Default false (off) — calibration/relevance `_meta` fields are always reported regardless of this flag. Only applies to a NAMED workspace.'),
            relevance_floor: z.number().optional().describe('D1: the z-score floor abstention gates on (default 2.0). Only meaningful when `abstain: true`.'),
        },
        async ({ query, limit, queryLanguage, tags, queries, entities, topics, project, types, workspace, search_mode, ecosystem, abstain, relevance_floor }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;

                const effectiveLimit = limit ?? 20;
                const mode = search_mode ?? 'hybrid';
                // Caller-supplied scope wins over the boot-detected default.
                const effectiveEcosystem = ecosystem ?? deps.detectedScope.ecosystem;
                let scored: Scored[] = [];
                let sourcesConsulted = 1;
                let vectorConsulted = false; // P14 freshness signal
                let scanCapHit = false; // P16 incomplete-results signal
                let bm25Ranked = true; // 3.21 step 3(a) — bm25Search() ranked signal (see retrieve.ts)
                let vectorLegSkipped = false; // 3.21 step 3(c) — embeddings-disabled degrade signal
                let relevanceMeta = notApplicableRelevanceMeta('search:*'); // D1 — overwritten below on the named-workspace path

                if (workspace !== '*') {
                    // ── Shared core path (named workspace) ─────────────────────
                    // depth=0 = flat list (the `search` preset). retrieve() does
                    // the hybrid (semantic + BM25 → RRF), tag filter, re-rank,
                    // and warms the access/session caches internally.
                    // P2: thread the per-workspace verbatim resolver so a search
                    // against a non-active workspace uses its OWN verbatim store.
                    const ctx: RetrieveContext = { store: deps.store, graphRegistry: deps.graphRegistry, workspaceVerbatimResolver: deps.workspaceVerbatimResolver };
                    let outcome;
                    try {
                        // `ecosystem` is REQUIRED here, not optional polish.
                        // retrieve() resolves `ecosystemScope = ecosystem ?? '*'`,
                        // so omitting it silently selects search-EVERYTHING and
                        // turns BOTH the seed filter and the per-hop filter into
                        // no-ops — while recallTool.ts, http/routes/search.ts's
                        // /api/recall and recall/inProcessRecall.ts all pass it.
                        // `search` returns FULL node content, and the response
                        // already REPORTED a `scope.ecosystem` it was not
                        // enforcing.
                        //
                        // What this does and does not deliver, stated honestly:
                        // it makes `search` agree with `recall` on the same
                        // fixture, which is worth doing on its own. It does NOT
                        // by itself deliver the "multiple isolated tenants in
                        // one workspace" story, because the DEFAULT source —
                        // `deps.detectedScope.ecosystem` — is resolved ONCE at
                        // boot by substring-matching process.cwd() against
                        // workspace-paths.json (bootSteps.ts
                        // `resolveWorkspaceScope`, returning '*' on no match).
                        // It is process-global: not per-request, not per-token,
                        // it does not vary with the requested `workspace`, and
                        // in an embedded host it depends on where the host
                        // process happened to be started. The codebase already
                        // outlawed exactly this pattern for the WORKSPACE axis
                        // (security/routeWorkspaceBinding.ts: "NEVER consults
                        // detectedScope / getActiveWorkspaceName / any boot
                        // value"). The `ecosystem` PARAMETER above is the
                        // per-request scope a multi-tenant host must supply;
                        // detectedScope is only the fallback when it doesn't.
                        outcome = await retrieve(ctx, query, { workspace, ecosystem: effectiveEcosystem, mode, depth: 0, limit: effectiveLimit, tags, queries, entities, topics, project, types, abstain, relevanceFloor: relevance_floor });
                    } catch (err) {
                        if ((err as { code?: string }).code === 'workspace_not_found') {
                            const e = err as { requested?: string; known?: string[] };
                            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', requested: e.requested, known: e.known }, null, 2) }], isError: true };
                        }
                        throw err;
                    }
                    scored = outcome.results.map((r) => ({ node: r.node as unknown as LoreNode, matchedBy: r.matchedBy, score: r.score, similarity: r.similarity, relevance: r.relevance }));
                    sourcesConsulted = outcome.meta.sourcesConsulted;
                    vectorConsulted = outcome.meta.verbatimConsulted;
                    scanCapHit = outcome.meta.scanCapHit;
                    bm25Ranked = outcome.meta.bm25Ranked;
                    vectorLegSkipped = outcome.meta.vectorLegSkipped;
                    relevanceMeta = buildRelevanceMeta(outcome.meta);
                } else {
                    // ── Legacy "*" path (boot graph, all projects) ─────────────
                    // TODO(P2 #9): fold into the core once cross-workspace lands.
                    // "*" here is NOT cross-workspace aggregation — it scans the
                    // boot/active graph across projects. Kept inline + degenerate
                    // until the cross-workspace fold replaces it.
                    const graphForSearch: LoreGraph = deps.store.loreGraph;
                    const nodeById = new Map<string, LoreNode>();
                    let kwIds: string[] = [];
                    let semanticIds: string[] = [];
                    if (mode !== 'semantic') {
                        const kwSignals = { scanCapHit: false };
                        // Push the scope down (optimisation only — the JS filter
                        // below is what actually decides). This used to be a
                        // hardcoded '*'.
                        const kw = await graphForSearch.search(query, effectiveLimit, '*', effectiveEcosystem, false, kwSignals);
                        scanCapHit = kwSignals.scanCapHit;
                        kwIds = kw.map((n) => n.id);
                        kw.forEach((n) => nodeById.set(n.id, n));
                    }
                    if (mode !== 'keyword') {
                        const verbatimHits = await deps.store.storageClient.verbatimSearch(query, effectiveLimit);
                        sourcesConsulted = 2;
                        vectorConsulted = true;
                        const stripped = verbatimHits.map((h) => (h.id.startsWith('lore:') ? h.id.slice(5) : h.id));
                        const semanticNodes = (await Promise.all(stripped.map((id) => graphForSearch.getNode(id).catch(() => null)))).filter((n): n is LoreNode => n !== null);
                        semanticIds = semanticNodes.map((n) => n.id);
                        semanticNodes.forEach((n) => { if (!nodeById.has(n.id)) nodeById.set(n.id, n); });
                    }
                    // 3.21 step 3(b) — fuse via the ONE shared RRF (recall/rrf.ts),
                    // not a "first list registered wins" Map.set skip-if-present —
                    // that WAS the bug this branch's own doc comment used to call
                    // out ("hybrid" here is a simpler keyword + semantic
                    // dedupe-merge — NOT reciprocal-rank-fusion): a node found by
                    // BOTH lists kept whichever score got written first and
                    // dropped the other list's rank information entirely.
                    const kwSet = new Set(kwIds);
                    const semSet = new Set(semanticIds);
                    scored = rrfFuse([kwIds, semanticIds])
                        .map((f): Scored | null => {
                            const node = nodeById.get(f.id);
                            if (!node) return null;
                            const matchedBy: MatchKind[] = [];
                            if (kwSet.has(f.id)) matchedBy.push('keyword');
                            if (semSet.has(f.id)) matchedBy.push('semantic');
                            return { node, matchedBy, score: f.score };
                        })
                        .filter((s): s is Scored => s !== null);
                    // R4 #1 — the ecosystem filter belongs on BOTH branches.
                    // This one merges a keyword scan with an UNFILTERED
                    // verbatimSearch (the vector store's `filter` argument was
                    // never passed here), so the pushdown above cannot be the
                    // decision point: the semantic half arrives unscoped and is
                    // hydrated straight out of the graph by id. Nothing between
                    // here and the response touched `scored`, so `search` on
                    // workspace:"*" returned every tenant's full `content`
                    // while line ~177 REPORTED `scope.ecosystem` as the value
                    // the caller had just supplied. `workspace:"*"` clears
                    // assertMcpScope freely on the null-principal
                    // local/embedded path (mcpScope.ts), which is exactly the
                    // embedded multi-tenant host this scope exists for.
                    // ecosystemMatches keeps '*' search-everything and keeps
                    // unscoped ('*'/'') NODES visible (DEC-ECOSYSTEM-WILDCARD).
                    scored = scored.filter((s) =>
                        ecosystemMatches((s.node as { ecosystem?: string }).ecosystem, effectiveEcosystem));

                    // D5 #5 — the legacy workspace="*" fallback (this whole
                    // `else` branch) had NO supersession handling at all
                    // (unlike the shared retrieve() core above, and unlike
                    // this tool's own doc comment claiming parity with
                    // `recall`) — a superseded node's stale content was
                    // returned unchanged. Route through the SAME
                    // `replaceSupersededInResults` helper retrieve() uses,
                    // via a throwaway RetrievalResult wrapper (depth/source
                    // are retrieve()-internal bookkeeping this tool doesn't
                    // otherwise use), so a superseded hit's slot is replaced
                    // by its live successor — same behaviour, one shared
                    // implementation, instead of a second copy of the walk.
                    {
                        const admitD5 = (n: LoreNode): boolean =>
                            ecosystemMatches((n as { ecosystem?: string }).ecosystem, effectiveEcosystem) && n.status !== 'archived';
                        const wrapped = new Map<string, RetrievalResult>(
                            scored.map((s) => [s.node.id, { node: s.node, score: s.score, matchedBy: s.matchedBy, depth: 0, source: 'seed' }]),
                        );
                        const resolved = await replaceSupersededInResults(wrapped, graphForSearch, admitD5);
                        scored = [...resolved.values()].map((r) => ({ node: r.node, score: r.score, matchedBy: r.matchedBy }));
                    }

                    if (tags && tags.length > 0) {
                        const lowerTags = tags.map((t) => t.toLowerCase().trim());
                        scored = scored.filter((s) => lowerTags.every((t) => s.node.tags.includes(t)));
                    }
                    ensureAccessTracker(graphForSearch)?.touch(scored.map((s) => s.node.id), 'retrieval');
                }

                // 3.1 (2026-08-17) — row-level security_scopes confinement on
                // the search results: hide nodes whose security_scopes don't
                // intersect the bound actor's scopes before the result is
                // serialized. Applies to BOTH branches above; undefined actor
                // scopes (local/embedded, no actor bound) ⇒ no filtering.
                const visibleNodeIds = new Set(
                    filterNodesByActorScope(scored.map((s) => s.node)).map((n) => n.id),
                );
                scored = scored.filter((s) => visibleNodeIds.has(s.node.id));

                // Cross-language hint (rare — only when queryLanguage is set).
                // getLanguageBreakdown is implemented by LocalGraph, SurrealGraph
                // AND DataplaneGraph, but isn't on LoreGraphHandle — probe the
                // method directly rather than gating on requireWorkspaceGraph,
                // which would wrongly 501 DataplaneGraph here. The hint has
                // always been best-effort (buildLanguageHint's own try/catch
                // treats any failure as "no hint"); a missing method degrades
                // the same way instead of failing the whole search.
                const graphForHint: LoreGraph = (workspace !== '*' && deps.graphRegistry)
                    ? await deps.graphRegistry.getGraphHandle(workspace)
                    : deps.store.loreGraph;
                let hint: LanguageHint | null = null;
                if (queryLanguage) {
                    try {
                        if (hasLanguageBreakdown(graphForHint)) {
                            hint = await buildLanguageHint(graphForHint, queryLanguage);
                        }
                    } catch {
                        hint = null;
                    }
                }

                // v1.1.1 P2 — negative-evidence envelope when zero results.
                const meta = scored.length === 0
                    ? {
                        confidence: 0,
                        // R5 #3 — name the workspace the search actually RAN
                        // against, not the boot-detected one. A zero-result
                        // search against a non-active workspace used to tell
                        // the agent that a DIFFERENT workspace was empty.
                        negative_evidence: `No nodes match query "${query}" in workspace=${workspace}, ecosystem=${effectiveEcosystem}. Absence is informative — the topic has no stored memory in this scope. Either store a node, or proceed without prior context. Do NOT retry search with rephrasings.`,
                        sources_consulted: sourcesConsulted,
                        vector_index_consulted: vectorConsulted,
                        ...(scanCapHit ? { scan_cap_hit: true } : {}),
                        ...(bm25Ranked === false ? { bm25_ranked: false } : {}),
                        ...(vectorLegSkipped ? { vector_leg_skipped: true } : {}),
                        ...relevanceMeta,
                    }
                    : { confidence: 1, sources_consulted: sourcesConsulted, vector_index_consulted: vectorConsulted, ...(scanCapHit ? { scan_cap_hit: true } : {}), ...(bm25Ranked === false ? { bm25_ranked: false } : {}), ...(vectorLegSkipped ? { vector_leg_skipped: true } : {}), ...relevanceMeta };

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            query,
                            // R5 #3 — BOTH axes of the reported scope must be
                            // the ENFORCED scope (DEC-SCOPE-HONESTY r1 + r3).
                            // The round that fixed the `ecosystem` half left
                            // the workspace half reporting
                            // `deps.detectedScope.workspace` — the value
                            // bootSteps.ts resolveWorkspaceScope substring-
                            // matched out of process.cwd() ONCE at boot — on a
                            // search that ran against the REQUESTED workspace.
                            // `structured_query` and `list_nodes` both report
                            // the requested one; `search` was the odd one out.
                            //
                            // R6 #3 — the KEY is `workspace`, not `project`.
                            // It has always held a workspace name, and the
                            // round that stopped `search` filtering on
                            // `project` at all (retrieve.ts runs with
                            // `workspaceScope = '*'` — "search all projects
                            // inside that graph") left a response advertising
                            // a project filter nothing enforces:
                            // DEC-SCOPE-HONESTY rule 1, on the axis that round
                            // changed. The other five members of this family
                            // (`structured_query`, POST /api/nodes/bulk-list,
                            // GET /api/node-list, GET /api/nodes, `recall`'s
                            // cross-workspace envelope) all report `workspace`.
                            scope: { workspace, ecosystem: effectiveEcosystem },
                            ...(tags && tags.length > 0 ? { tag_filter: tags } : {}),
                            resultCount: scored.length,
                            results: projectScored(scored),
                            ...(hint ? { hint } : {}),
                            _meta: meta,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('search', error, log);
            }
        },
    );
}
