/**
 * recallTool.ts — the `recall` MCP tool. High-level hybrid retrieval via the
 * shared retrieve() core (semantic + BM25 → RRF → graph traversal → re-rank →
 * token budget) plus the shared buildRecallResult preset (summary | full,
 * auto-escalation, deferred-Lore sidecar, language-mismatch hint). Cross-
 * workspace (workspace:"*") delegates to the one runCrossWorkspaceRecall.
 *
 * Retrieval Unification P2 — search and recall, MCP / embedded / REST, all share
 * the same retrieval + the same recall shaping, so they can no longer drift.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runCrossWorkspaceRecall } from '../recallCrossWorkspace.js';
import { retrieve, type RetrieveContext } from '../../../recall/retrieve.js';
import { buildRecallResult, buildCompactCandidates, buildRelatedCandidates } from '../../../recall/recallPreset.js';
import { buildRelevanceMeta } from '../../../recall/abstention.js';
import { assertMcpScope } from '../mcpScope.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import type { LoreGraph, SearchToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';

const SEED_LIMIT = 10;

export function registerRecallTool(mcpServer: McpServer, deps: SearchToolsDeps): void {
    mcpServer.tool(
        'recall',
        'High-level knowledge recall: searches for a topic and traverses related nodes. Defaults to a compact summary (top hits, label + 1-line snippet) capped at 10 results so the response stays under ~2KB and AI agents do not blow their context window. Pass `max` (up to 100) to raise that cap — a larger `max` can exceed the ~2KB budget by design. Pass mode="full" for the rich JSON, or use the get_full tool to fetch one node\'s body by id.',
        {
            topic: z.string().max(2000).describe('Topic to recall (e.g., "BaaSClient", "auth conventions")'), // RA2-reaudit2 — cap input length (unbounded embed DoS)
            depth: z.number().int().min(0).max(10).optional().describe('Graph-traversal depth from each direct match (default: 1, max 10). D4 fix (fix/d4-traversal-separate-field): traversal neighbours are NEVER part of the ranked hits/knowledge — they return in a separate `related` field (via/relation/depth), and are never counted in shown/totalRecalled/directMatches. Set depth:0 to skip traversal and get related:[] entirely.'), // RA2-reaudit2 — bound traversal depth
            queryLanguage: z.string().optional().describe('ISO 639-1 code for the query language. Same semantics as `search` — optional; adds a cross-language hint to the response when the corpus is mostly in a different language.'),
            filePaths: z.array(z.string()).optional().describe('Q1.7: file paths from the current work context (e.g. from a PostToolUse edit hook). Any deferred-* node whose stored file list overlaps these paths is auto-surfaced in the `deferred` sidecar field, even if it doesn\'t match the topic text.'),
            mode: z.enum(['summary', 'full']).optional().describe('Response shape. "summary" (default) returns top hits with label + 1-line snippet only — meant for AI agents. "full" returns the rich JSON with full node bodies — meant for the human-facing CLI.'),
            crossProject: z.boolean().optional().describe('When true, ignores the current project scope and searches every project. Each hit is tagged with its project. Use this when looking for prior work that may have happened in a sibling repo (e.g. DEF, dataplane, managrid).'),
            includeSuperseded: z.boolean().optional().describe('When true, also returns nodes that have been soft-superseded by a newer version. Default false — the typical recall flow wants the current state of knowledge, not the history. Pass true when reviewing how a decision evolved.'),
            tags: z.array(z.string()).optional().describe('Gap #2: when provided, filter results to only nodes where ALL specified tags are present in the node\'s tags field. Applied after hybrid retrieval + traversal. Use to scope recall to a known tag set (e.g. ["orientation-pack"]).'),
            queries: z.array(z.string().max(2000)).max(5).optional().describe('3.21 step 3(f): up to 5 extra phrasings of `topic`, run alongside it and fused into ONE ranked list via the shared reciprocal-rank-fusion. Use when the caller has several ways to say the same thing (a question, a keyword, a paraphrase) and wants recall to consider all of them together rather than picking one. Omitted/empty is exactly today\'s single-phrasing behaviour.'),
            entities: z.array(z.string().max(100)).max(20).optional().describe('3.21 step 3(f): keep only nodes whose stored `entities` (set via store_node, 3.21 step 3(e)) contain ALL of these values. Applied alongside `tags`.'),
            topics: z.array(z.string().max(100)).max(20).optional().describe('3.21 step 3(f): keep only nodes whose stored `topics` (set via store_node, 3.21 step 3(e)) contain ALL of these values. Applied alongside `tags`.'),
            project: z.string().optional().describe('3.21 step 3(f): keep only nodes whose `project` field equals this value exactly. An empty string means no project filter.'),
            types: z.array(z.string().max(100)).max(20).optional().describe('D2: keep only nodes whose `type` is one of these values (ANY match). A PREFILTER applied inside the vector + BM25 query itself, not after ranking — safe even when other node types crowd the candidate window. On workspace="*" (cross-workspace), the same prefilter is pushed into EACH workspace\'s own semantic + keyword seed queries, with an identical post-merge filter kept as a backstop over the fused set. (E2: `project` is also pushed into the vector/BM25 and keyword queries; `entities`/`topics` into the keyword query only. `tags` is post-ranking only.)'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback). Use "*" for explicit cross-workspace read.'),
            ecosystem: z.string().min(1).optional().describe('Ecosystem scope. Defaults to the daemon-detected scope. Pass "*" to recall across every ecosystem in the workspace. A host serving several tenants out of ONE workspace must pass the caller\'s ecosystem here — the detected default is derived once at boot from process.cwd() and is identical for every request.'),
            max_tokens: z.number().int().min(100).max(32000).optional().describe('Feature 3: cap the total estimated tokens in the response. When set, results are filled top-ranked-first until the budget is exhausted. Response includes truncated/dropped_count/total_matched.'),
            include_archived: z.boolean().default(false).describe('Feature 1/3: when true, include archived nodes (status="archived") in recall results. Default false hides them.'),
            search_mode: z.enum(['semantic', 'keyword', 'hybrid']).default('hybrid').describe('Feature 5: retrieval mode. "hybrid" (default) = BM25 + semantic RRF. "semantic" = vector-only (embeds the query). "keyword" = standalone lexical recall (the store\'s BM25 index + the graph\'s own text search) — never calls the embedding provider; use when embeddings are disabled/unavailable or a raw lexical match is wanted.'),
            compact: z.boolean().optional().describe('3.21 step 3(g): when true, return N compact candidates ({id, label, snippet<=240 chars, score, matchedBy, updatedAt}) instead of full nodes — cheaper than "summary" for a caller that just wants to pick which ids to inspect next. Pair with the `recall_expand` tool to fetch full bodies for the chosen ids. Overrides `mode` when set; ignored on the workspace="*" cross-workspace path (still full/summary there).'),
            abstain: z.boolean().optional().describe('D1: when true, a topic whose calibrated relevance falls below `relevance_floor` returns zero results with `_meta.abstained: true` instead of low-relevance filler. Default false (off) — calibration/relevance `_meta` fields are always reported regardless of this flag. Ignored on the workspace="*" cross-workspace path.'),
            relevance_floor: z.number().optional().describe('D1: the z-score floor abstention gates on (default 2.0). Only meaningful when `abstain: true`.'),
            max: z.number().int().min(1).max(100).optional().describe('D2 (3.22.1): cap on the number of ranked hits returned (default 10, max 100). Raises the seed/retrieval limit AND the summary-mode display cap together — full, summary and compact modes all honour it. A value above 10 can push the response past the ~2KB summary budget; still governed by `max_tokens` if that is also set. Ignored on the workspace="*" cross-workspace path, which always returns its own fixed cap of 10 summary hits (full mode there is unbounded) regardless of `max`.'),
        },
        async ({ topic, depth, queryLanguage, filePaths, mode, crossProject, includeSuperseded, tags, queries, entities, topics, project, types, workspace, ecosystem, max_tokens, include_archived, search_mode, compact, abstain, relevance_floor, max }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — bound-principal workspace scope (read); "*" needs cross-workspace-read.
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                const responseMode = mode ?? 'summary';
                // R4 #3 — `recall` was the ONE primary read surface the
                // per-request-scope work skipped: it hard-wired
                // deps.detectedScope.ecosystem into retrieve() AND into the
                // reported scope, so a multi-tenant host could scope `search`
                // per request but not `recall` — the same nodes, through the
                // same retrieve() core. detectedScope is resolved once at boot
                // from process.cwd() (bootSteps.ts resolveWorkspaceScope) and
                // is identical for every request, so it can only ever be a
                // DEFAULT. `crossProject` still wins (retrieve() itself forces
                // '*' for it) — keep the reported scope agreeing with that.
                const effectiveEcosystem = crossProject ? '*' : (ecosystem ?? deps.detectedScope.ecosystem);

                // Cross-workspace aggregation (workspace:"*") — the one shared
                // implementation. Without a wired registry, fall through to the
                // active-workspace path with a warning (cloud-mode / fixtures).
                if (workspace === '*') {
                    if (!deps.graphRegistry) {
                        console.warn(`[Lore MCP] recall workspace="*" requested but no graphRegistry wired — falling back to active workspace.`);
                    } else {
                        // F-LOW-T14: when a principal is bound and carries an
                        // explicit allowedWorkspaces list, restrict the "*"
                        // fan-out to that set (∪ its own bound workspace) so a
                        // scoped principal cannot read workspaces outside its
                        // allow-list. A principal with cross-workspace-read but
                        // NO explicit allowedWorkspaces (and the null-principal
                        // local path) keeps current behavior — allowedWorkspaces
                        // stays undefined.
                        const principal = getCurrentPrincipal();
                        const allowedWorkspaces = principal && principal.allowedWorkspaces && principal.allowedWorkspaces.length > 0
                            ? Array.from(new Set([...principal.allowedWorkspaces, principal.workspace]))
                            : undefined;
                        return await runCrossWorkspaceRecall({
                            topic, depth: depth ?? 1, includeSuperseded: includeSuperseded ?? false,
                            includeArchived: include_archived ?? false, tags, types, // fix/3.22.1-d1-recall-option-parity
                            // R4 #3 — the "*" fan-out must honour (and report)
                            // the caller's scope too, or `recall` repeats the
                            // exact search-tool defect on its own legacy branch.
                            ecosystem: effectiveEcosystem,
                            registry: deps.graphRegistry, verbatimStore: deps.store.loreVerbatim,
                            sessionCache: deps.store.sessionCache, responseMode, queryLanguage, maxTokens: max_tokens,
                            allowedWorkspaces,
                            workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // P2 — each workspace seeds its own verbatim store.
                        });
                    }
                }

                // Single-workspace — shared retrieve() core + buildRecallResult preset.
                // P2: thread the per-workspace verbatim resolver so a non-active
                // workspace recall runs semantic + BM25 against its OWN LanceDB.
                const ctx: RetrieveContext = { store: deps.store, graphRegistry: deps.graphRegistry, workspaceVerbatimResolver: deps.workspaceVerbatimResolver };
                let outcome;
                try {
                    outcome = await retrieve(ctx, topic, {
                        workspace, ecosystem: effectiveEcosystem, mode: search_mode ?? 'hybrid',
                        depth: depth ?? 1, limit: max ?? SEED_LIMIT, tags, includeArchived: include_archived ?? false,
                        includeSuperseded: includeSuperseded ?? false, maxTokens: max_tokens, crossProject: crossProject ?? false,
                        queries, entities, topics, project, // 3.21 step 3(f)
                        types, // D2 — vector/BM25-level type prefilter
                        abstain, relevanceFloor: relevance_floor, // D1
                    });
                } catch (err) {
                    if ((err as { code?: string }).code === 'workspace_not_found') {
                        const e = err as { requested?: string; known?: string[] };
                        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', requested: e.requested, known: e.known }, null, 2) }], isError: true };
                    }
                    throw err;
                }

                // 3.21 step 3(g) — compact bypasses buildRecallResult's
                // summary/full shaping entirely (no traversal-source labels,
                // no deferred sidecar, no language hint, no auto-escalation);
                // it is the thinnest possible pointer into this result set.
                if (compact) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                topic, scope: { workspace, ecosystem: effectiveEcosystem },
                                // 3.21 step 3(h) — echo back to recall_outcome to
                                // tie an outcome to this specific recall call.
                                queryId: randomUUID(),
                                candidates: buildCompactCandidates(outcome),
                                // D4 fix: graph-traversal neighbours, separate from
                                // `candidates` (which stays "things that matched the
                                // query"). Omitted (not []) when there are none.
                                ...(outcome.related.length > 0 ? { related: buildRelatedCandidates(outcome) } : {}),
                                tip: 'Call recall_expand({ids, workspace}) with chosen candidate ids to fetch their full bodies.',
                                _meta: buildRelevanceMeta(outcome.meta), // D1
                            }, null, 2),
                        }],
                    };
                }

                const graph: LoreGraph = (workspace !== '*' && deps.graphRegistry)
                    ? await deps.graphRegistry.getGraphHandle(workspace)
                    : deps.store.loreGraph;
                const result = await buildRecallResult(
                    {
                        topic, responseMode, searchMode: search_mode ?? 'hybrid', workspaceScope: workspace,
                        ecosystemScope: effectiveEcosystem,
                        crossProject: crossProject ?? false, queryLanguage, filePaths, maxTokens: max_tokens,
                        maxHits: max,
                    },
                    outcome,
                    graph as unknown as Parameters<typeof buildRecallResult>[2],
                );

                const payload = result.mode === 'summary'
                    ? { ...result, tip: 'Call get_full({id}) to fetch the full body of any hit. Pass mode:"full" to recall for the rich JSON.' }
                    : result;

                return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
            } catch (error) {
                return mcpToolError('recall', error, log);
            }
        },
    );
}
