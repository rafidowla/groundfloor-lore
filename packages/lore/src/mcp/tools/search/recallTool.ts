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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runCrossWorkspaceRecall } from '../recallCrossWorkspace.js';
import { retrieve, type RetrieveContext } from '../../../recall/retrieve.js';
import { buildRecallResult } from '../../../recall/recallPreset.js';
import { assertMcpScope } from '../mcpScope.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import type { LoreGraph, SearchToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';

const SEED_LIMIT = 10;

export function registerRecallTool(mcpServer: McpServer, deps: SearchToolsDeps): void {
    mcpServer.tool(
        'recall',
        'High-level knowledge recall: searches for a topic and traverses related nodes. Defaults to a compact summary (top hits, label + 1-line snippet) so the response stays under ~2KB and AI agents do not blow their context window. Pass mode="full" for the rich JSON, or use the get_full tool to fetch one node\'s body by id.',
        {
            topic: z.string().max(2000).describe('Topic to recall (e.g., "BaaSClient", "auth conventions")'), // RA2-reaudit2 — cap input length (unbounded embed DoS)
            depth: z.number().int().min(0).max(10).optional().describe('Traversal depth from each search result (default: 1, max 10)'), // RA2-reaudit2 — bound traversal depth
            queryLanguage: z.string().optional().describe('ISO 639-1 code for the query language. Same semantics as `search` — optional; adds a cross-language hint to the response when the corpus is mostly in a different language.'),
            filePaths: z.array(z.string()).optional().describe('Q1.7: file paths from the current work context (e.g. from a PostToolUse edit hook). Any deferred-* node whose stored file list overlaps these paths is auto-surfaced in the `deferred` sidecar field, even if it doesn\'t match the topic text.'),
            mode: z.enum(['summary', 'full']).optional().describe('Response shape. "summary" (default) returns top hits with label + 1-line snippet only — meant for AI agents. "full" returns the rich JSON with full node bodies — meant for the human-facing CLI.'),
            crossProject: z.boolean().optional().describe('When true, ignores the current project scope and searches every project. Each hit is tagged with its project. Use this when looking for prior work that may have happened in a sibling repo (e.g. DEF, dataplane, managrid).'),
            includeSuperseded: z.boolean().optional().describe('When true, also returns nodes that have been soft-superseded by a newer version. Default false — the typical recall flow wants the current state of knowledge, not the history. Pass true when reviewing how a decision evolved.'),
            tags: z.array(z.string()).optional().describe('Gap #2: when provided, filter results to only nodes where ALL specified tags are present in the node\'s tags field. Applied after hybrid retrieval + traversal. Use to scope recall to a known tag set (e.g. ["orientation-pack"]).'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback). Use "*" for explicit cross-workspace read.'),
            ecosystem: z.string().min(1).optional().describe('Ecosystem scope. Defaults to the daemon-detected scope. Pass "*" to recall across every ecosystem in the workspace. A host serving several tenants out of ONE workspace must pass the caller\'s ecosystem here — the detected default is derived once at boot from process.cwd() and is identical for every request.'),
            max_tokens: z.number().int().min(100).max(32000).optional().describe('Feature 3: cap the total estimated tokens in the response. When set, results are filled top-ranked-first until the budget is exhausted. Response includes truncated/dropped_count/total_matched.'),
            include_archived: z.boolean().default(false).describe('Feature 1/3: when true, include archived nodes (status="archived") in recall results. Default false hides them.'),
            search_mode: z.enum(['semantic', 'keyword', 'hybrid']).default('hybrid').describe('Feature 5: retrieval mode. "hybrid" (default) = BM25 + semantic RRF. "semantic" = vector-only. "keyword" = graph text search only.'),
        },
        async ({ topic, depth, queryLanguage, filePaths, mode, crossProject, includeSuperseded, tags, workspace, ecosystem, max_tokens, include_archived, search_mode }) => {
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
                            includeArchived: include_archived ?? false, tags,
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
                        depth: depth ?? 1, limit: SEED_LIMIT, tags, includeArchived: include_archived ?? false,
                        includeSuperseded: includeSuperseded ?? false, maxTokens: max_tokens, crossProject: crossProject ?? false,
                    });
                } catch (err) {
                    if ((err as { code?: string }).code === 'workspace_not_found') {
                        const e = err as { requested?: string; known?: string[] };
                        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', requested: e.requested, known: e.known }, null, 2) }], isError: true };
                    }
                    throw err;
                }

                const graph: LoreGraph = (workspace !== '*' && deps.graphRegistry)
                    ? await deps.graphRegistry.getGraphHandle(workspace)
                    : deps.store.loreGraph;
                const result = await buildRecallResult(
                    {
                        topic, responseMode, searchMode: search_mode ?? 'hybrid', workspaceScope: workspace,
                        ecosystemScope: effectiveEcosystem,
                        crossProject: crossProject ?? false, queryLanguage, filePaths, maxTokens: max_tokens,
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
