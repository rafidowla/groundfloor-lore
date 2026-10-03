/**
 * deleteNode.ts — the delete_node MCP tool. Hard-deletes the graph node and
 * all its relationships, then tombstones the canonical `lore:<id>` verbatim
 * row (append-only memory; cloud mode falls back to legacy delete).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { redactError } from '../../../security/logRedact.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from '../workspaceResolve.js';
import { assertMcpScope } from '../mcpScope.js';
import { deleteNodeEverywhere } from '../../../core/nodeDeleteService.js';
import type { MemoryToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';

export function registerDeleteNodeTool(mcpServer: McpServer, deps: MemoryToolsDeps): void {
    mcpServer.tool(
        'delete_node',
        'Remove a knowledge node and all its relationships',
        {
            id: z.string().describe('Node ID to delete'),
            // Phase 6 P1 — workspace scoping (schema in P1.A; physical
            // routing in P1.B).
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1b: no silent fallback).'),
        },
        async ({ id, workspace }) => {
            // NW-5b — audit-coverage for delete_node MCP tool.
            const __auditStartedAt = Date.now();
            const __auditCtx: { workspace: string | null; nodeId: string | null; resultDetail?: string; errored: boolean } = {
                workspace: workspace ?? null, nodeId: id ?? null, errored: false,
            };
            try {
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                // Phase 6 P1.C — resolve target graph via the multi-
                // workspace registry; physical delete now lands in the
                // requested workspace's store.
                const resolvedDel = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope.workspace,
                    workspace,
                );
                if (!resolvedDel.ok) {
                    if ('missing' in resolvedDel) return workspaceRequiredEnvelope();
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'workspace_not_found',
                                requested: resolvedDel.requested,
                                known: resolvedDel.known,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                const delGraph = resolvedDel.graph;
                __auditCtx.workspace = resolvedDel.resolvedWorkspace;
                // The whole outbox → graph → verbatim → WAL sequence runs under
                // the SHARED per-(workspace,id) write lock `nodeUpsert` holds;
                // it lives in core/nodeDeleteService.ts (3.26.0), shared with
                // the embedded `LoreInstance.nodeDelete()`.
                const outcome = await deleteNodeEverywhere({
                    id,
                    workspace: resolvedDel.resolvedWorkspace,
                    isActive: resolvedDel.isActive,
                    graph: delGraph,
                    outboxStore: deps.outboxStore,
                    // L-056 — the RESOLVED workspace's verbatim store; the boot
                    // singleton when no resolver (cloud / test fixtures).
                    resolveVerbatim: async () => (deps.workspaceVerbatimResolver
                        ? deps.workspaceVerbatimResolver.getOrOpen(resolvedDel.resolvedWorkspace)
                        : deps.store.loreVerbatim),
                    verbatimDelete: (verbatimId) => deps.store.storageClient.verbatimDelete(verbatimId),
                    getWal: deps.getWal,
                    initiator: 'mcp:delete_node',
                    reason: 'graph node deleted via MCP delete_node',
                    logPrefix: '[Lore MCP]',
                    onInlineDeleteApplied: (entry) => deps.noteInlineNodeDelete?.(entry, id),
                });
                const { deleted, verbatimWarning } = outcome;
                if (deleted) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                success: true,
                                deleted,
                                ...(verbatimWarning ? { verbatim_warning: verbatimWarning } : {}),
                                message: `Node '${id}' deleted.${verbatimWarning ? ' WARNING: ' + verbatimWarning : ''}`,
                            }, null, 2),
                        }],
                    };
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            deleted,
                            message: deleted ? `Node '${id}' deleted.` : `Node '${id}' not found.`,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                __auditCtx.errored = true;
                // Audit fix #4: redact before landing in audit.jsonl (finding #13) —
                // engine errors can echo node ids/paths/content fragments.
                __auditCtx.resultDetail = redactError(error);
                return mcpToolError('delete_node', error, log);
            } finally {
                try {
                    deps.auditLog.log({
                        toolName: 'delete_node',
                        args: { workspace: __auditCtx.workspace, nodeId: __auditCtx.nodeId },
                        result: __auditCtx.errored ? 'error' : 'success',
                        resultDetail: __auditCtx.resultDetail,
                        durationMs: Date.now() - __auditStartedAt,
                    });
                } catch (logErr) {
                    console.error(`[Lore MCP] audit emission failed for delete_node: ${(logErr as Error).message}`);
                }
            }
        },
    );
}
