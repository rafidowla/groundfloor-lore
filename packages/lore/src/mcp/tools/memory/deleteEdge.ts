/**
 * deleteEdge.ts — the delete_edge MCP tool (Sprint V). Symmetric MCP
 * counterpart to DELETE /api/edge: removes edges by (sourceId, targetId,
 * relation) and returns the count removed. Local-mode only — DataplaneGraph
 * does not expose deleteEdge yet (clear not_supported error in cloud mode).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from '../workspaceResolve.js';
import { assertMcpScope } from '../mcpScope.js';
import { recordHotWrite } from '../../../outbox/hotLane.js';
import type { MemoryToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';

export function registerDeleteEdgeTool(mcpServer: McpServer, deps: MemoryToolsDeps): void {
    mcpServer.tool(
        'delete_edge',
        'Remove an edge from the knowledge graph by (sourceId, targetId, relation). Returns the count of edges removed (0 if the triple did not match).',
        {
            source_id: z.string().describe('ID of the edge source node'),
            target_id: z.string().describe('ID of the edge target node'),
            relation: z.string().describe('Relation label (e.g., "depends_on", "supersedes")'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1b: no silent fallback).'),
        },
        async ({ source_id, target_id, relation, workspace }) => {
            const startedAt = Date.now();
            try {
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                const resolved = await resolveTargetGraph(
                    deps.store, deps.graphRegistry, deps.detectedScope.workspace, workspace,
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
                const delGraph = resolved.graph as unknown as { deleteEdge?: (s: string, t: string, r: string) => Promise<number> };
                if (typeof delGraph.deleteEdge !== 'function') {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'not_supported',
                                message: 'delete_edge is local-mode only (DataplaneGraph.deleteEdge not yet implemented)',
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                // 2.3 (2026-08-17) — outbox-first edge.delete, mirroring
                // DELETE /api/edge (http/routes/edges.ts). edge.upsert and
                // edge.delete are ONE cross-superseding family
                // (outbox/supersession.ts) precisely so this row supersedes a
                // still-pending edge.upsert from a recent store_edge. Without
                // it the replicator replayed that pending upsert a few hundred
                // ms later and silently RESURRECTED the edge this tool had
                // just reported deleted.
                if (deps.outboxStore) {
                    await recordHotWrite(deps.outboxStore, {
                        workspace: resolved.resolvedWorkspace,
                        operationKind: 'edge.delete',
                        payload: { sourceId: source_id, targetId: target_id, relation },
                        initiator: 'mcp:delete_edge',
                        operation: 'edge.delete',
                    });
                }
                // Capture the narrowed function bound to its receiver — a
                // bare `delGraph.deleteEdge` reference loses `this` when
                // invoked through the retry closure below (deleteEdge's own
                // implementation calls `this.initialize()`), throwing
                // "Cannot read properties of undefined" on every retry.
                const doDeleteEdge = delGraph.deleteEdge.bind(delGraph);
                const deleted = await withTransactionConflictRetry(() => doDeleteEdge(source_id, target_id, relation));
                deps.auditLog.log({
                    toolName: 'delete_edge',
                    args: { source_id, target_id, relation, workspace: workspace ?? null },
                    result: deleted > 0 ? 'success' : 'error',
                    resultDetail: deleted > 0 ? undefined : 'no_match',
                    durationMs: Date.now() - startedAt,
                });
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: deleted > 0,
                            deleted,
                            message: deleted > 0
                                ? `Removed ${deleted} edge(s) ${source_id} -[${relation}]-> ${target_id}.`
                                : `No edge matched (${source_id} -[${relation}]-> ${target_id}).`,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('delete_edge', error, log);
            }
        },
    );
}
