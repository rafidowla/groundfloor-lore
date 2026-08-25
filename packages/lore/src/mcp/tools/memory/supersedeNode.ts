/**
 * supersedeNode.ts — the supersede_node MCP tool. Soft-supersedes old_id
 * with new_id: the old node stays (edges preserved) but is hidden from
 * default recall. Also writes a `supersedes` graph edge (non-fatal) so the
 * relationship is queryable via traverse and visible in the network view.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from '../workspaceResolve.js';
import { assertMcpScope } from '../mcpScope.js';
import type { MemoryToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';
import { recordHotWrite } from '../../../outbox/hotLane.js';
import { redactError } from '../../../security/logRedact.js';

export function registerSupersedeNodeTool(mcpServer: McpServer, deps: MemoryToolsDeps): void {
    mcpServer.tool(
        'supersede_node',
        'Soft-supersede an old knowledge node with a newer one. The old node stays in the graph (all edges preserved) but is hidden from default recall and faded in the network view. Use when a new decision/architecture/convention replaces an older one and you want a clear record of "this was the call before, this is the call now". Reversible via clearing the supersededAt field.',
        {
            old_id: z.string().describe('ID of the node being superseded (no longer authoritative)'),
            new_id: z.string().describe('ID of the new node that replaces it'),
            reason: z.string().optional().describe('Optional free-form note explaining why the supersession happened'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1b: no silent fallback).'),
        },
        async ({ old_id, new_id, reason, workspace: _ws }) => {
            const startedAt = Date.now();
            try {
                if (!_ws || typeof _ws !== 'string' || _ws.length === 0) {
                    return workspaceRequiredEnvelope();
                }
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(_ws, 'write');
                if (scopeDenied) return scopeDenied;
                // NW-3a (api-001) — resolve the target graph for the
                // requested workspace via the registry, mirroring
                // store_node. Pre-fix, this tool accepted `workspace`
                // but ignored it: the storage-client write always
                // landed in the boot-bound graph. Reuse
                // `resolveTargetGraph` for parity with the other
                // multi-workspace writers.
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope.workspace,
                    _ws,
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
                const targetGraph = resolved.graph;
                const result = await targetGraph.supersedeNode(old_id, new_id, reason);
                if (result.ok) {
                    // Fix #3 — also write the semantic graph edge so the
                    // supersession is queryable via traverse() and visible
                    // as a real edge in the network view. Non-fatal: the
                    // denormalized supersededAt field is the authoritative
                    // recall filter; the edge is for history + traversal.
                    // Lands in the SAME target workspace as the supersede
                    // write (NW-3a — both used to leak to the default graph).
                    //
                    // C-R3-02 — route the edge through the outbox first (durable +
                    // crash-replay + per-workspace replication), mirroring
                    // store_edge / REST edges; it previously wrote straight to the
                    // graph and SWALLOWED any failure with `.catch(() => {})`. Still
                    // non-fatal to the supersede, but a failure is now LOGGED, not
                    // silently dropped.
                    const supersedeEdge = {
                        sourceId: new_id,
                        targetId: old_id,
                        relation: 'supersedes',
                        confidence: 'extracted' as const,
                        confidenceScore: 1.0,
                    };
                    try {
                        if (deps.outboxStore) {
                            await recordHotWrite(deps.outboxStore, {
                                workspace: _ws,
                                operationKind: 'edge.upsert',
                                payload: supersedeEdge,
                                initiator: 'mcp:supersede_node',
                                operation: 'edge.upsert',
                            });
                        }
                        await withTransactionConflictRetry(() => targetGraph.addEdge(supersedeEdge));
                    } catch (edgeErr) {
                        log.warn(`[Lore] supersede_node: supersedes edge ${new_id}->${old_id} failed (non-fatal; supersededAt is authoritative): ${redactError(edgeErr)}`);
                    }
                }
                deps.auditLog.log({
                    toolName: 'supersede_node',
                    args: { old_id, new_id, reason: reason ?? null },
                    result: result.ok ? 'success' : 'error',
                    resultDetail: result.ok ? undefined : `${result.reason}`,
                    durationMs: Date.now() - startedAt,
                });
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(
                            result.ok
                                ? { success: true, oldId: old_id, newId: new_id, message: `Marked '${old_id}' as superseded by '${new_id}'.` }
                                : { success: false, reason: result.reason, message: `Could not supersede: ${result.reason}` },
                            null,
                            2,
                        ),
                    }],
                    isError: !result.ok,
                };
            } catch (error) {
                return mcpToolError('supersede_node', error, log);
            }
        },
    );
}
