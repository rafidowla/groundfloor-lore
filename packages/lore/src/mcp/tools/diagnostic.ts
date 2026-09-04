/**
 * diagnostic.ts — Read-only introspection tools.
 *
 * Tools:
 *   - stats             corpus-wide node/edge breakdown
 *   - lore_status       one-shot reachability + capabilities snapshot
 *   - list_nodes        type/tag-filtered LoreNode list with negative-evidence meta
 *   - detect_language   ISO-639-1 detection on a text snippet
 *   - get_full          full body of one node by id (companion to recall)
 *
 * These are pure-read tools that touch graph + verbatim only — no
 * mutation, no consent gates, no audit trail. They share the same
 * deps shape as the diagnostic HTTP family (graph + verbatimStore +
 * pluginRegistry) plus boot-time scope/mode for `lore_status`.
 */

import { z } from 'zod';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tagsToArray } from '../../engines/normalizeTags.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../engines/localGraphRegistry.js';
import { listWorkspaceNames } from '../../config/workspaces.js';
import { assertMcpScope } from './mcpScope.js';
import { ecosystemMatches } from '../../core/ecosystemMatch.js';
import { getCurrentPrincipal } from '../../auth/principal.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from './workspaceResolve.js';
import { hasLanguageBreakdown } from './search/helpers.js';
import type { StorageBundle } from '../services.js';
import { log } from '../../logger.js';
import { mcpToolError } from './mcpToolError.js';

export interface DiagnosticToolsDeps {
    store: StorageBundle;
    detectedScope: { workspace: string; ecosystem: string };
    deploymentMode: 'local' | 'cloud';
    graphBasePath: string;
    /** Pre-merged node-types enum (core + workspace contributions). */
    nodeTypesEnum: ReturnType<typeof z.enum>;
    /** Sprint L2 — multi-workspace graph registry. When present, the
     *  `stats` and `admin_stats` tools route per-workspace lookups
     *  through it. Optional so older test wiring still types. */
    graphRegistry?: LocalGraphRegistry;
}

export function registerDiagnosticTools(mcpServer: McpServer, deps: DiagnosticToolsDeps): void {
    /* ─── stats ───────────────────────────────────────────────── */
    // Sprint L2 — workspace-scoped. Mirrors REST /api/stats: workspace
    // is required, no silent fallback. Use admin_stats for the
    // cross-workspace view.
    mcpServer.tool(
        'stats',
        'Get knowledge graph statistics for a workspace (node count, edge count, type breakdown). Sprint L2: workspace is required — no silent fallback.',
        {
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L2: no silent fallback).'),
        },
        async ({ workspace }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }],
                        isError: true,
                    };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                let targetGraph = deps.store.loreGraph;
                if (deps.graphRegistry) {
                    try {
                        targetGraph = await deps.graphRegistry.getGraphHandle(workspace);
                    } catch (err) {
                        if (err instanceof WorkspaceNotFoundError) {
                            return {
                                content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', requested: err.requested, known: err.known }, null, 2) }],
                                isError: true,
                            };
                        }
                        throw err;
                    }
                }
                const graphStats = await targetGraph.getStats();
                // getLanguageBreakdown is implemented by LocalGraph, SurrealGraph
                // AND DataplaneGraph, but isn't on LoreGraphHandle — probe the
                // method directly rather than gating on requireWorkspaceGraph,
                // which would wrongly 501 DataplaneGraph (a regression caught
                // during the daemon engine port; see hasLanguageBreakdown).
                const languageBreakdown = hasLanguageBreakdown(targetGraph)
                    ? await targetGraph.getLanguageBreakdown()
                    : {};
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            workspace,
                            scope: 'workspace',
                            ...graphStats,
                            verbatimDocuments_global: await deps.store.storageClient.verbatimCount(),
                            languageBreakdown,
                            graphPath: path.join(deps.graphBasePath, '.lore', 'graph'),
                            // Sprint-8/commit-8 — report the engine this WORKSPACE
                            // actually declares, not a hardcoded local-mode string.
                            // No registry (cloud/tests) → the boot-bound dataplane.
                            engine: !deps.graphRegistry
                                ? 'dataplane (cloud)'
                                : deps.graphRegistry.graphEngineFor(workspace) === 'surreal'
                                    ? 'surrealdb (local)'
                                    : 'legacy graph engine + lancedb (local)',
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('stats', error, log);
            }
        },
    );

    /* ─── admin_stats ─────────────────────────────────────────── */
    // Sprint L2 — admin-only cross-workspace view. Mirrors REST POST
    // /api/admin/stats. In local mode (single operator) the gate is
    // open; cloud mode adds ReBAC via the HTTP path. Returns
    // per-workspace breakdown + global totals so divergence is visible
    // in one call.
    mcpServer.tool(
        'admin_stats',
        'Admin-only: cross-workspace knowledge graph statistics. Returns per-workspace breakdown + global totals. Local-mode: open. Cloud-mode: gated via HTTP path.',
        {},
        async () => {
            try {
                // SP-01 — admin_stats aggregates EVERY workspace, so it is
                // a cross-workspace read. Require cross-workspace-read: a
                // workspace-scoped principal must not enumerate other
                // workspaces' stats. Modeled as workspace:"*".
                const scopeDenied = assertMcpScope('*', 'read');
                if (scopeDenied) return scopeDenied;
                const byWorkspace: Record<string, { nodeCount: number; edgeCount: number }> = {};
                let totalNodes = 0;
                let totalEdges = 0;
                let names: string[] = [];
                try { names = listWorkspaceNames(); } catch { names = []; }
                if (deps.graphRegistry) {
                    for (const name of names) {
                        try {
                            const g = await deps.graphRegistry.getGraphHandle(name);
                            const s = await g.getStats();
                            byWorkspace[name] = { nodeCount: s.nodeCount ?? 0, edgeCount: s.edgeCount ?? 0 };
                            totalNodes += s.nodeCount ?? 0;
                            totalEdges += s.edgeCount ?? 0;
                        } catch {
                            byWorkspace[name] = { nodeCount: 0, edgeCount: 0 };
                        }
                    }
                } else {
                    const s = await deps.store.storageClient.getStats();
                    byWorkspace[deps.detectedScope.workspace] = { nodeCount: s.nodeCount ?? 0, edgeCount: s.edgeCount ?? 0 };
                    totalNodes = s.nodeCount ?? 0;
                    totalEdges = s.edgeCount ?? 0;
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            scope: 'all-workspaces',
                            byWorkspace,
                            globalTotals: { nodeCount: totalNodes, edgeCount: totalEdges },
                            verbatimDocuments_global: await deps.store.storageClient.verbatimCount(),
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('stats', error, log);
            }
        },
    );

    /* ─── lore_status ─────────────────────────────────────────── */
    //
    // One-shot reachability check for AI agents and humans alike.
    // Returns daemon mode, detected scope, graph + verbatim counts,
    // and a feature-flag map confirming Phase-1-fixes are wired.
    mcpServer.tool(
        'lore_status',
        'One-shot health and capability check. Returns Lore daemon state, project scope detected for the current workspace, graph + verbatim counts, and a feature flag map confirming which Phase-1-fixes (compact recall, cross-project recall, get_full, auto-recall hook) are wired up. Call this once per session to confirm Lore is reachable.',
        {},
        async () => {
            try {
                // R5-002 — report the CALLER's own workspace + its counts, not the
                // boot/active workspace (which, in local mode's one-daemon-many-apps
                // model, often belongs to a DIFFERENT app than the calling token).
                // Resolve the caller's graph via the registry when wired; fall back
                // to the boot store for the local-bypass / no-registry case.
                const callerWs = getCurrentPrincipal()?.workspace ?? deps.detectedScope.workspace;
                let targetGraph = deps.store.loreGraph;
                if (deps.graphRegistry && callerWs) {
                    try { targetGraph = await deps.graphRegistry.getGraphHandle(callerWs); }
                    catch { /* unknown ws → fall back to boot store, liveness only */ }
                }
                const stats = await targetGraph.getStats();
                const verbatimCount = await deps.store.storageClient.verbatimCount();
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            daemon: 'ok',
                            deploymentMode: deps.deploymentMode,
                            // R6 #3 — `workspace`, not `project`: `callerWs` is
                            // a workspace name (the principal's, else the
                            // detected one). `lore_status` is not in the
                            // finding's list of two, which is the same
                            // incomplete-enumeration shape four rounds running;
                            // it is the same literal and it is fixed here.
                            scope: { workspace: callerWs, ecosystem: deps.detectedScope.ecosystem },
                            graph: {
                                nodes: stats.nodeCount,
                                edges: stats.edgeCount,
                                verbatimDocs: verbatimCount,
                                // Sprint-8/commit-8 — report the engine THIS
                                // workspace declares (per-workspace, via the
                                // registry) rather than a class check on a graph
                                // resolved from an accessor tied to a single
                                // local engine. No registry (cloud/tests) → the
                                // boot-bound dataplane; that path never reaches
                                // a workspace-declared engine at all.
                                engine: !deps.graphRegistry
                                    ? 'dataplane (cloud)'
                                    : deps.graphRegistry.graphEngineFor(callerWs) === 'surreal'
                                        ? 'surrealdb (local)'
                                        : 'legacy graph engine + lancedb (local)',
                            },
                            capabilities: {
                                compactRecall: true,
                                crossProjectRecall: true,
                                getFull: true,
                                httpRecallEndpoint: '/api/recall',
                                httpGetFullEndpoint: '/api/node-full',
                            },
                            tip: 'Call recall({topic}) (compact mode, default) or recall({topic, crossProject:true}) for cross-repo. Use get_full({id}) to fetch one body in detail.',
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('stats', error, log);
            }
        },
    );

    /* ─── get_full ────────────────────────────────────────────── */
    //
    // Two-tier companion to `recall`. Recall's default summary mode
    // emits short hits to keep the AI's context window cheap; when the
    // agent has narrowed in on one specific node it calls get_full.
    // One verb works for any node — lore notes, deferred items, and
    // any other node type.
    mcpServer.tool(
        'get_full',
        'Fetch the full body of a single Lore node by id. Use this after `recall` (summary mode) when you have narrowed in on the one or two hits whose full content you actually need. Lookup is cross-project — ids are globally unique.',
        {
            id: z.string().describe('Node id from a prior recall/search hit (e.g. "decision-storage-facade-2026-04")'),
            // Phase 6 P1 — workspace scoping. Schema in P1.A; cross-store
            // lookup arrives in P1.B (today get_full only inspects the
            // active workspace's graph).
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async ({ id, workspace }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }],
                        isError: true,
                    };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // Local mode (Postgres model): route the lookup to the
                // REQUESTED workspace's graph, not the boot/active store.
                // When no registry is wired (cloud/tests) the resolver
                // returns the boot store, so behavior is unchanged there.
                const res = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope.workspace,
                    workspace,
                );
                if (!res.ok) {
                    if ('missing' in res) return workspaceRequiredEnvelope();
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', requested: res.requested, known: res.known }, null, 2) }],
                        isError: true,
                    };
                }
                const stripped = id.startsWith('lore:') ? id.slice(5) : id;
                const node = await res.graph.getNode(stripped);
                if (!node) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                id,
                                found: false,
                                message: `No node found with id '${id}'. Check the id from a recall hit, or call recall again with crossProject:true if you think it lives in a sibling project.`,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            id: node.id,
                            found: true,
                            type: node.type,
                            label: node.label,
                            project: node.project,
                            tags: node.tags,
                            content: node.content,
                            language: node.language ?? null,
                            metadata: node.metadata ?? null,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('stats', error, log);
            }
        },
    );

    /* ─── list_nodes ──────────────────────────────────────────── */
    // Sprint 7 (2026-05-24) — cursor pagination (Option A from BACKLOG-
    // list-nodes-response-size.md). Pre-Sprint-7 the tool returned every
    // matching node in one shot; on the default workspace's 144 decision
    // nodes this came to 2.4 MB (38× the 64 KB byte-cap). Now: default
    // limit 100, max 1000, cursor-based pagination matching the W4
    // /api/nodes/bulk-list shape exactly (base64url JSON {updatedAt, id};
    // server orders by updatedAt DESC, id ASC). Default-limit responses
    // fit under the byte-cap so the L7 fixture is re-enabled in
    // scripts/tool-byte-caps.json.
    mcpServer.tool(
        'list_nodes',
        'List knowledge nodes, optionally filtered by type or tag. Cursor-paginated (default limit 100, max 1000). Pass `cursor` from a prior response to fetch the next page; check `hasMore` to know when to stop.',
        {
            type: deps.nodeTypesEnum.optional().describe('Filter by node type'),
            tag: z.string().optional().describe('Filter by tag'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
            ecosystem: z.string().min(1).optional().describe('Ecosystem scope. Omitted = every ecosystem in the workspace (the workspace is the isolation boundary), matching its two REST siblings GET /api/node-list and POST /api/nodes/bulk-list. A host serving several tenants out of ONE workspace passes the caller\'s ecosystem here.'),
            limit: z.number().int().min(1).max(1000).default(100).describe('Page size (1..1000). Default 100 keeps responses under the byte-cap.'),
            cursor: z.string().optional().describe('Opaque pagination cursor from a prior response. Omit for the first page.'),
        },
        async ({ type, tag, workspace, ecosystem, limit, cursor }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }],
                        isError: true,
                    };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;

                // Local mode (Postgres model): route the listing to the
                // REQUESTED workspace's graph, not the boot/active store.
                // No-registry path returns the boot store, so behavior is
                // unchanged in cloud/tests.
                const res = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope.workspace,
                    workspace,
                );
                if (!res.ok) {
                    if ('missing' in res) return workspaceRequiredEnvelope();
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', requested: res.requested, known: res.known }, null, 2) }],
                        isError: true,
                    };
                }
                const targetGraph = res.graph;

                // Decode + validate cursor up front so a bad cursor fails
                // the same way as bulk-list (HTTP 400 / isError true).
                let cursorPayload: { updatedAt: string; id: string } | null = null;
                if (cursor !== undefined && cursor !== null && cursor !== '') {
                    try {
                        const json = Buffer.from(cursor, 'base64url').toString('utf8');
                        const parsed = JSON.parse(json) as { updatedAt?: unknown; id?: unknown };
                        if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') {
                            return {
                                content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid_cursor', hint: 'cursor payload missing updatedAt or id' }, null, 2) }],
                                isError: true,
                            };
                        }
                        cursorPayload = { updatedAt: parsed.updatedAt, id: parsed.id };
                    } catch {
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid_cursor', hint: 'cursor not valid base64url JSON' }, null, 2) }],
                            isError: true,
                        };
                    }
                }

                const effectiveLimit = Math.min(Math.max(Math.floor(limit ?? 100), 1), 1000);
                const typeStr = type !== undefined ? String(type) : undefined;

                // Sprint 7 → engine-agnostic follow-up: route through
                // `bulkList()`, the same (updatedAt DESC, id ASC)
                // cursor-paginated primitive W4's /api/nodes/bulk-list uses,
                // so cursors compose across the two endpoints. Every graph
                // substrate this daemon hands out (SurrealGraph,
                // DataplaneGraph) implements `bulkList` on
                // `LoreGraphHandle` — unlike the old `getGraphContext()`
                // feature-detect, which DataplaneGraph also implements (as a
                // stub that always throws "raw Cypher routing is not
                // available in cloud mode yet"), so the "local fast path vs.
                // fallback" branch never actually reached the fallback in
                // cloud mode; it took the fast path and threw. `bulkList`
                // has no such trap — no feature-detect needed.
                //
                // R5 #1/#4 — the two scope axes of this call, both of which
                // were wrong, in opposite directions.
                //
                // `project` is NOT the workspace. It is a caller-owned node
                // field with no guarantee of equalling the workspace name
                // (Atlas stores project='v3' inside workspace='default'), and
                // every engine turns it into a strict `n.project = $project`
                // (engines/graphBulkList.ts). retrieve.ts:314-321 documents
                // this exact substitution as the mistake that "silently makes
                // keyword fallback empty while the vector path still appears
                // healthy"; DEC-SCOPE-HONESTY corrected six siblings for it
                // and missed THIS one — the tool that decision names by name
                // as the motivating consumer of the widened bulkList pushdown.
                // The physical workspace boundary is the resolved graph above
                // (each workspace is its own database), so passing the
                // workspace name here only ever DROPPED this workspace's own
                // rows.
                //
                // `ecosystem` defaults to '*', not `detectedScope.ecosystem`.
                // See DEC-SCOPE-HONESTY rule 3 and its enumeration: the
                // ENUMERATION surfaces built on the shared bulkList primitive
                // (this tool, GET /api/node-list, POST /api/nodes/bulk-list,
                // GET /api/nodes) all default to '*' and take the scope from
                // the request. They share one cursor format, so cursors
                // compose across them — and cursors composing across surfaces
                // with DIFFERENT default filters silently changes the row set
                // between page 1 and page 2. A boot-cwd-derived value cannot
                // separate two tenants anyway (bootSteps.ts
                // resolveWorkspaceScope runs ONCE at boot), so letting it
                // decide visibility buys no isolation and costs correctness.
                const effectiveEcosystem = ecosystem ?? '*';
                const page = await targetGraph.bulkList({
                    types: typeStr ? [typeStr] : undefined,
                    // Exact membership, case-insensitive (lowercase-on-store
                    // policy) — bulkList folds this itself per engine.
                    tags: tag ? [tag] : undefined,
                    project: undefined,
                    ecosystem: effectiveEcosystem !== '*' ? effectiveEcosystem : undefined,
                    limit: effectiveLimit,
                    cursor: cursorPayload,
                });
                const hasMore = page.hasMore;
                // The pushdown above is an OPTIMISATION; this is the decision
                // point (core/ecosystemMatch.ts). Without it the response
                // would report a `scope.ecosystem` it had only asked the
                // engine to honour — DEC-SCOPE-HONESTY rule 1.
                const scopedRows = effectiveEcosystem === '*'
                    ? page.nodes
                    : page.nodes.filter((r) => ecosystemMatches((r as { ecosystem?: unknown }).ecosystem as string | undefined, effectiveEcosystem));
                const pageNodes: Array<{ id: string; type: string; label: string; tags: string[]; project: string; updatedAt: string }> = scopedRows.map((r) => ({
                    id: String(r.id ?? ''),
                    type: String(r.type ?? ''),
                    label: String(r.label ?? ''),
                    tags: tagsToArray(r.tags),
                    project: String(r.project ?? ''),
                    updatedAt: String(r.updatedAt ?? ''),
                }));

                const nextCursor = hasMore && pageNodes.length > 0
                    ? Buffer.from(
                        JSON.stringify({ updatedAt: pageNodes[pageNodes.length - 1]!.updatedAt, id: pageNodes[pageNodes.length - 1]!.id }),
                        'utf8',
                    ).toString('base64url')
                    : undefined;

                // v1.1.1 P2 — _meta envelope. list_nodes is loop-prone:
                // agents try variations of the type/tag filter when
                // results are empty. Negative-evidence on empty tells
                // them absence is informative for THIS exact filter
                // combination.
                const filterDesc = `type=${type ?? 'any'}${tag ? ` + tag=${tag}` : ''}`;
                const meta = pageNodes.length === 0 && !cursorPayload
                    ? {
                        confidence: 0,
                        negative_evidence: `No nodes match filter (${filterDesc}) in workspace=${res.resolvedWorkspace}, ecosystem=${effectiveEcosystem}. Absence is informative — this filter combination has no nodes. Either store one, broaden the filter, or proceed without prior context. Do NOT retry list_nodes with the same scope.`,
                        sources_consulted: 1,
                    }
                    : { confidence: 1, sources_consulted: 1 };

                const body: Record<string, unknown> = {
                    count: pageNodes.length,
                    hasMore,
                    // R6 #3 — `workspace`, not `project`. This literal held a
                    // WORKSPACE name under a `project` key, and the bulkList
                    // call 45 lines above now passes `project: undefined` — so
                    // the response was reporting a project filter that no tool
                    // enforces (DEC-SCOPE-HONESTY rule 1, on the axis this
                    // family's previous round changed). Its four REST/MCP
                    // siblings all report `workspace`.
                    scope: { workspace: res.resolvedWorkspace, ecosystem: effectiveEcosystem },
                    filter: { type: type ?? 'all', tag: tag ?? 'all' },
                    nodes: pageNodes,
                    _meta: meta,
                };
                if (nextCursor !== undefined) body.nextCursor = nextCursor;

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(body, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('list_nodes', error, log);
            }
        },
    );

    /* ─── detect_language ─────────────────────────────────────── */
    mcpServer.tool(
        'detect_language',
        'Detect the language of a text snippet. Returns an ISO 639-1 code (e.g., "en", "es") or null when confidence is below threshold. See docs/LANGUAGE_DETECTION.md — this is an explicit capability; core never calls it automatically.',
        {
            text: z.string().describe('The text to analyze.'),
            threshold: z.number().optional().describe('Minimum confidence margin (top score minus runner-up). Default 0.03. Raise for stricter results.'),
            minLength: z.number().optional().describe('Minimum text length to attempt detection. Default 20. Shorter inputs return null.'),
        },
        async ({ text, threshold, minLength }) => {
            try {
                const { detectLanguage } = await import('../../engines/language.js');
                const result = detectLanguage(text, { threshold, minLength });
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('stats', error, log);
            }
        },
    );
}
