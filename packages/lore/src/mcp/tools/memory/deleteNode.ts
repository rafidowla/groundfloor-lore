/**
 * deleteNode.ts — the delete_node MCP tool. Hard-deletes the graph node and
 * all its relationships, then tombstones the canonical `lore:<id>` verbatim
 * row (append-only memory; cloud mode falls back to legacy delete).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { redactId, redactError } from '../../../security/logRedact.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from '../workspaceResolve.js';
import { assertMcpScope } from '../mcpScope.js';
import { recordHotWrite } from '../../../outbox/hotLane.js';
import { withNodeLock } from '../../../core/nodeWriteLock.js';
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
                // The whole outbox → graph → verbatim sequence runs under the
                // SHARED per-(workspace,id) write lock `nodeUpsert` holds
                // (core/nodeWriteLock.ts). Unlocked, a concurrent store_node /
                // POST /api/node for the same id interleaved with these three
                // steps and left the graph holding the node while the verbatim
                // mirror held this tombstone (or the reverse), both callers
                // told ok — and the outbox carrying node.upsert AFTER
                // node.delete, so replay contradicted execution. Nothing inside
                // this callback may re-enter the lock: every call below is a
                // RAW substrate primitive (see nodeWriteLock.ts rule 1).
                const outcome = await withNodeLock(
                    resolvedDel.resolvedWorkspace,
                    id,
                    async (): Promise<{ deleted: boolean; verbatimWarning?: string }> => {
                        // SP-F3 — outbox-first hot write, mirroring REST nodes-delete.ts.
                        // Record node.delete BEFORE the substrate delete so the MCP
                        // surface gets the same durability + crash-recovery-replay +
                        // per-workspace replication as REST DELETE /api/node. Only when
                        // an outbox is wired; otherwise keep prior direct-delete.
                        if (deps.outboxStore) {
                            await recordHotWrite(deps.outboxStore, {
                                workspace: resolvedDel.resolvedWorkspace,
                                operationKind: 'node.delete',
                                payload: { id },
                                initiator: 'mcp:delete_node',
                                operation: 'node.delete',
                            });
                        }
                        const deleted = await delGraph.deleteNode(id);
                        // F2a (Phase 7a): also drop the LanceDB vector. reconnect
                        // stores LoreNode verbatim records under the 'lore:'
                        // prefix (see reconnect.ts PREFIX_LORE) — the pre-fix
                        // version of this tool passed the raw id, which silently
                        // missed every single vector. That's the root of the
                        // orphan-embedding bug noted in commit 5849140.
                        if (!deleted) return { deleted };
                        // Verbatim is append-only memory: tombstone (kept +
                        // marked superseded) rather than erase, so prior
                        // content stays recallable for history / audit /
                        // undo. Cloud-mode (DataplaneVectorStore) doesn't
                        // support tombstone yet — fall back to legacy delete.
                        // L-056 — resolve the RESOLVED workspace's verbatim store
                        // so the tombstone lands in the same workspace as the graph
                        // delete above (the resolver is what bulk-store/verbatim.ts
                        // use). Without this the tombstone hit the boot store,
                        // splitting the delete across two workspaces. Fall back to
                        // the boot singleton when no resolver (cloud / test fixtures).
                        const targetVerbatim = deps.workspaceVerbatimResolver
                            ? await deps.workspaceVerbatimResolver.getOrOpen(resolvedDel.resolvedWorkspace)
                            : deps.store.loreVerbatim;
                        const store = targetVerbatim as unknown as { tombstone?: (id: string, reason: string) => Promise<void> };
                        // 1.M10 (2026-08-17 audit) — tombstone() now THROWS on
                        // real failure (was a bare catch swallow), so await it
                        // here and surface a verbatim_warning in the response
                        // instead of fire-and-forget success.
                        let verbatimWarning: string | undefined;
                        try {
                            const reason = 'graph node deleted via MCP delete_node';
                            if (typeof store.tombstone === 'function') {
                                await store.tombstone(`lore:${id}`, reason);
                            } else {
                                await deps.store.storageClient.verbatimDelete(`lore:${id}`);
                            }
                            // QA A2 finding 2 (2026-09-03) — record a
                            // verbatim.tombstone outbox row AFTER the node.delete
                            // row above, so a stale pending `verbatim.upsert` from
                            // an earlier store_node on this id can't later replay
                            // and resurrect the content this call just tombstoned
                            // (outbox/types.ts). Non-fatal: the synchronous
                            // tombstone above already ran.
                            if (deps.outboxStore) {
                                await recordHotWrite(deps.outboxStore, {
                                    workspace: resolvedDel.resolvedWorkspace,
                                    operationKind: 'verbatim.tombstone',
                                    payload: { id: `lore:${id}`, reason },
                                    initiator: 'mcp:delete_node',
                                    operation: 'verbatim.tombstone',
                                });
                            }
                        } catch (tombErr) {
                            verbatimWarning = `verbatim tombstone failed: ${redactError(tombErr)}`;
                            console.error(`[Lore MCP] Verbatim tombstone failed for ${redactId(id)}: ${redactError(tombErr)}`);
                        }
                        // ITEM X-walnode (2026-09-03) — store_node / store_edge
                        // both append to the sync WAL (core/nodeService.ts,
                        // storeEdge.ts) but delete_node never did, so a
                        // hard-deleted node had no `delete_node` WAL entry for
                        // the sync engine to push. When WAL push is wired
                        // (walPushBridge.ts is dormant today), the delete would
                        // never propagate and the node would resurrect on the
                        // remote's next full sync. Mirror the upsert append's
                        // exact gating (active-workspace only, P1.C scope) and
                        // stay inside the same lock the delete + tombstone ran
                        // under.
                        if (resolvedDel.isActive) {
                            deps.getWal().append('delete_node', { id, workspace: resolvedDel.resolvedWorkspace });
                        }
                        return { deleted, verbatimWarning };
                    },
                );
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
