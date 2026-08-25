/**
 * structuredQueryTool.ts — the `structured_query` MCP tool. Fast retrieval
 * path (no LLM): vector semantic search + graph keyword fallback, returning
 * raw node JSON for the caller to reshape. Honors an optional schema_hint
 * (passed through, not enforced).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type LoreNode } from '../../../providers/types.js';
import { WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { ensureAccessTracker } from '../../../engines/accessTracker.js';
import { assertMcpScope } from '../mcpScope.js';
import { ecosystemMatches } from '../../../core/ecosystemMatch.js';
import { resolveQuerySeedStore } from '../../../recall/querySeedStore.js';
import type { LoreGraph, SearchToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';

export function registerStructuredQueryTool(mcpServer: McpServer, deps: SearchToolsDeps): void {
    mcpServer.tool(
        'structured_query',
        'Retrieve knowledge nodes and return them as structured JSON. Fast retrieval path — no LLM call. Use when you need raw node data to reshape yourself, or when the caller needs sub-100ms graph data without AI synthesis.',
        {
            query: z.string().describe('Natural language query to search the knowledge graph'),
            limit: z.number().optional().describe('Max results (default: 10, max: 50)'),
            mode: z.enum(['recall', 'search']).optional().describe(
                'recall (default): vector semantic search + graph keyword fallback; ' +
                'search: graph keyword only (faster, no embeddings)',
            ),
            schema_hint: z.string().optional().describe(
                'Optional JSON Schema string describing the shape you want. Not enforced — included in the response so you can reshape the results yourself.',
            ),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
            ecosystem: z.string().min(1).optional().describe('Ecosystem scope. Defaults to the daemon-detected scope. Pass "*" to search every ecosystem in the workspace. A host serving several tenants out of ONE workspace must pass the caller\'s ecosystem here — the detected default is derived once at boot from process.cwd() and is the same for every request.'),
        },
        async ({ query, limit: rawLimit, mode, schema_hint, workspace, ecosystem }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // L-024 — resolve the REQUESTED workspace's graph (mirrors
                // recallTool.ts:91-111). Hydrating + the keyword fallback
                // through this graph filters results to nodes physically in
                // the target workspace. No registry (cloud/tests) → boot graph.
                // (Verbatim seeds are resolved per-workspace too now — see the
                // resolveQuerySeedStore call below; they used to stay
                // boot-global, which was the confinement bug.)
                let graphForQuery: LoreGraph = deps.store.loreGraph;
                if (workspace && workspace !== '*' && deps.graphRegistry) {
                    try {
                        graphForQuery = await deps.graphRegistry.getGraphHandle(workspace);
                    } catch (err) {
                        if (err instanceof WorkspaceNotFoundError) {
                            return {
                                content: [{
                                    type: 'text' as const,
                                    text: JSON.stringify({
                                        error: 'workspace_not_found',
                                        requested: err.requested,
                                        known: err.known,
                                    }, null, 2),
                                }],
                                isError: true,
                            };
                        }
                        throw err;
                    }
                }
                const limit = Math.min(typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : 10, 50);
                const useVerbatim = mode !== 'search';
                const seenIds = new Set<string>();
                const hits: LoreNode[] = [];

                // Ecosystem confinement — `structured_query` is registered
                // beside `search` by the SAME registerSearchTools(mcpServer,
                // deps) call, off the SAME SearchToolsDeps (which carries
                // detectedScope), returns FULL node `content`, and had none of
                // it: an unfiltered verbatim seed plus a keyword search with a
                // hardcoded '*'. On a workspace serving two tenants by
                // ecosystem, `search` returned ['mine-1'] while this tool
                // returned ['theirs-1','mine-1'] with the foreign tenant's
                // body text. It does not go through retrieve(), so fixing
                // retrieve()'s call sites never touched it.
                //
                // Caller-supplied `ecosystem` wins over the boot-detected
                // default; see the schema note on why that distinction matters.
                const queryEcosystem = ecosystem ?? deps.detectedScope.ecosystem;
                const outsideEcosystem = (n: { ecosystem?: string }): boolean =>
                    !ecosystemMatches(n.ecosystem, queryEcosystem);

                if (useVerbatim) {
                    // Seed from the REQUESTED workspace's own verbatim store.
                    // This used to be `deps.store.storageClient` — the BOOT
                    // handle, which only ever sees the ACTIVE workspace's
                    // LanceDB — so a structured_query against any non-active
                    // workspace count-gated on and seeded from a different
                    // workspace's vectors. retrieve.ts:243-248 calls that "the
                    // exact confinement bug"; /api/query was fixed for it and
                    // this sibling was not. Shared resolver so they cannot
                    // drift again.
                    const seedStore = await resolveQuerySeedStore(deps, graphForQuery, workspace);
                    // null → no per-workspace store (non-active ws with no
                    // resolver, or the open failed). SKIP the vector seed and
                    // fall through to the target workspace's OWN keyword scan;
                    // never fall back to the boot store.
                    const verbatimCount = seedStore ? await seedStore.count() : 0;
                    if (seedStore && verbatimCount > 0) {
                        const seeds = await seedStore.search(query, limit);
                        for (const seed of seeds) {
                            const stripped = seed.id.startsWith('lore:') ? seed.id.slice(5) : seed.id;
                            if (seenIds.has(stripped)) continue;
                            const n = await graphForQuery.getNode(stripped).catch(() => null);
                            // Decided POST-HYDRATION on the graph node, which
                            // is the authoritative copy of `ecosystem` (the
                            // verbatim row's metadata copy can be stale — see
                            // core/bulkNodeScope.ts).
                            if (n && !n.supersededAt && !outsideEcosystem(n)) { hits.push(n); seenIds.add(n.id); }
                        }
                    }
                }
                const querySignals = { scanCapHit: false };
                if (hits.length < limit) {
                    const remaining = limit - hits.length;
                    // project stays '*' deliberately: the workspace boundary is
                    // already enforced by graph resolution above, and `project`
                    // is a caller-owned node field that is NOT guaranteed to
                    // equal the workspace name (retrieve.ts:314-321).
                    const fallback = await graphForQuery.search(
                        query, remaining + seenIds.size, '*', queryEcosystem, false, querySignals,
                    );
                    for (const n of fallback) {
                        if (hits.length >= limit) break;
                        if (seenIds.has(n.id) || n.supersededAt || outsideEcosystem(n)) continue;
                        hits.push(n);
                        seenIds.add(n.id);
                    }
                }

                const result = {
                    query,
                    mode: useVerbatim ? 'recall' : 'search',
                    count: hits.length,
                    scope: { workspace, ecosystem: queryEcosystem },
                    ...(querySignals.scanCapHit ? { scan_cap_hit: true } : {}),
                    ...(schema_hint ? { schema_hint } : {}),
                    results: hits.map(n => ({
                        id: n.id,
                        type: n.type,
                        label: n.label,
                        project: n.project,
                        tags: n.tags,
                        content: n.content,
                        createdAt: n.createdAt,
                        updatedAt: n.updatedAt,
                    })),
                };
                ensureAccessTracker(graphForQuery)?.touch(hits.map((n) => n.id), 'retrieval');
                return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return mcpToolError('structured_query', error, log);
            }
        },
    );
}
