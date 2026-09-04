/**
 * corpusHealth.ts — Corpus health metrics (Feature 7, 2026-05-26).
 *
 * Tools:
 *   corpus_health  — per-workspace health overview combining live graph
 *                    aggregates with pre-aggregated AuxStore counters.
 *   check_freshness — data-freshness report: how many nodes have a recent
 *                     syncedAt vs how many are past the TTL threshold.
 *
 * All graph counts are derived from listNodes + in-JS aggregation so
 * no new graph query methods are needed. The call is non-blocking and
 * returns in <500ms for graphs up to ~100k nodes.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import type { AuxStore } from '../../outbox/auxStore.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { sweepFreshness, type IFreshnessGraph } from '../../engines/freshnessEngine.js';
import { computeCorpusHealth } from '../corpusHealthCompute.js';
import { assertMcpScope } from './mcpScope.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from './workspaceResolve.js';
import { log } from '../../logger.js';
import { mcpToolError } from './mcpToolError.js';

export interface CorpusHealthDeps {
    store: StorageBundle;
    auxStore: AuxStore;
    // Phase 6 P1 — per-workspace graph routing (Postgres model: each app's
    // workspace is its own graph). OPTIONAL: when absent (cloud / tests) the
    // resolver returns the boot store, so behavior is unchanged.
    graphRegistry?: LocalGraphRegistry;
    detectedScope?: { workspace: string; ecosystem: string };
}

export function registerCorpusHealthTools(server: McpServer, deps: CorpusHealthDeps): void {

    /* ─── corpus_health ─────────────────────────────────────────── */
    server.tool(
        'corpus_health',
        'Return a health overview of a workspace\'s knowledge corpus: node counts by status and classification tier, stale counts, confirmation score distribution, and pre-aggregated outcome counters.',
        {
            workspace: z.string().min(1).describe('Workspace to inspect.'),
        },
        async ({ workspace }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // Phase 6 P1.C — route the read to the REQUESTED workspace's
                // graph (Postgres model). Registry absent → resolver returns
                // the boot store, so cloud/test behavior is unchanged.
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope?.workspace ?? workspace,
                    workspace,
                );
                if (!resolved.ok) {
                    if ('missing' in resolved) return workspaceRequiredEnvelope();
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'workspace_not_found',
                                requested: resolved.requested,
                                known: resolved.known,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                const graph = resolved.graph;
                const report = await computeCorpusHealth(graph, deps.auxStore, workspace);

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(report, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('corpus_health', error, log);
            }
        },
    );

    /* ─── check_freshness ───────────────────────────────────────── */
    server.tool(
        'check_freshness',
        'Return a data-freshness report for a workspace: how many nodes have been synced within the TTL window (fresh) vs how many are overdue (stale) or have never been synced. Useful for detecting when a workspace\'s knowledge graph has gone cold.',
        {
            workspace: z.string().min(1).describe('Workspace to inspect.'),
            ttl_hours: z.number().positive().optional().describe(
                'Staleness threshold in hours. Omit to use LORE_FRESHNESS_TTL_HOURS env var (default 24).',
            ),
        },
        async ({ workspace, ttl_hours }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // Phase 6 P1.C — route the freshness sweep to the REQUESTED
                // workspace's graph (Postgres model). Registry absent →
                // resolver returns the boot store (unchanged behavior).
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope?.workspace ?? workspace,
                    workspace,
                );
                if (!resolved.ok) {
                    if ('missing' in resolved) return workspaceRequiredEnvelope();
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'workspace_not_found',
                                requested: resolved.requested,
                                known: resolved.known,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                const graph = resolved.graph;
                await graph.initialize();
                const report = await sweepFreshness(
                    graph as unknown as IFreshnessGraph,
                    workspace,
                    ttl_hours,
                );
                return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
            } catch (error) {
                return mcpToolError('corpus_health', error, log);
            }
        },
    );
}
