/**
 * storeEdge.ts — the store_edge MCP tool. Upsert a relationship between two
 * nodes with a confidence tier, optionally bidirectional, resolving the
 * target graph via the multi-workspace registry.
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
import { redactError } from '../../../security/logRedact.js';
import { checkWorkspaceQuota } from '../../../security/workspaceQuota.js';

export function registerStoreEdgeTool(mcpServer: McpServer, deps: MemoryToolsDeps): void {
    mcpServer.tool(
        'store_edge',
        'Create a relationship between two knowledge nodes',
        {
            sourceId: z.string().describe('Source node ID'),
            targetId: z.string().describe('Target node ID'),
            relation: deps.edgeRelationsEnum.describe(`Relationship type (options: ${deps.edgeRelations.join(', ')})`),
            bidirectional: z.boolean().optional().describe('Create edge in both directions (default: true)'),
            // C1 — confidence tier. Defaults to 'extracted'.
            confidence: z.enum(['extracted', 'inferred', 'ambiguous']).optional().describe(
                "Confidence tier. 'extracted' = user/rule-asserted fact (default). 'inferred' = LLM or similarity-inferred. 'ambiguous' = candidate needing human review.",
            ),
            confidenceScore: z.number().min(0).max(1).optional().describe(
                'Optional numeric confidence in [0,1]. Defaults to 1.0 for extracted, or the inference score for inferred/ambiguous.',
            ),
            // Phase 6 P1 — workspace scoping (schema in P1.A; physical
            // multi-store routing arrives with the LocalGraphRegistry in
            // P1.B). Today's behavior: when present and equal to the active
            // workspace, accepted silently; when present and different, a
            // warning is logged and the edge still lands in the active store.
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1b: no silent fallback).'),
        },
        async (args) => {
            // NW-5b — audit-coverage. store_edge had no audit row pre-fix.
            const __auditStartedAt = Date.now();
            const __auditCtx: { workspace: string | null; entityId: string | null; resultDetail?: string; errored: boolean } = {
                workspace: (typeof args.workspace === 'string' ? args.workspace : null),
                entityId: null,
                errored: false,
            };
            try {
                const sourceId = String(args.sourceId);
                const targetId = String(args.targetId);
                const relation = String(args.relation);
                const useBidirectional = (args.bidirectional as boolean | undefined) ?? true;
                const conf = (args.confidence as 'extracted' | 'inferred' | 'ambiguous' | undefined) ?? 'extracted';
                const score = (args.confidenceScore as number | undefined) ?? (conf === 'extracted' ? 1.0 : 0.5);
                const requestedWorkspace = args.workspace as string | undefined;
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(requestedWorkspace, 'write');
                if (scopeDenied) return scopeDenied;
                // Phase 6 P1.C — resolve target graph via the multi-
                // workspace registry. P1.A's warn-on-mismatch is now
                // replaced by physical routing; unknown workspace
                // surfaces as an MCP tool error.
                const resolvedEdge = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope.workspace,
                    requestedWorkspace,
                );
                if (!resolvedEdge.ok) {
                    if ('missing' in resolvedEdge) return workspaceRequiredEnvelope();
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'workspace_not_found',
                                requested: resolvedEdge.requested,
                                known: resolvedEdge.known,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                const edgeGraph = resolvedEdge.graph;
                const edge = {
                    sourceId, targetId, relation,
                    confidence: conf, confidenceScore: score,
                };
                // F-LOW-T12 — per-workspace write-quota gate. store_edge wrote
                // unconditionally while store_node enforces the SAME quota
                // (storeNode.ts L-033). An edge is a write that consumes
                // storage, so it must be subject to maxStorageBytes the same
                // way. We pass nodes:0 (an edge adds no node) and a bytes
                // estimate of the edge payload. No-op when quotaStore /
                // resolver unwired (cloud mode / test fixtures) — identical
                // guard convention to storeNode.
                if (deps.quotaStore && deps.getWorkspaceEntryForQuota) {
                    const bytes = Buffer.byteLength(`${sourceId}${targetId}${relation}`, 'utf8');
                    const q = checkWorkspaceQuota(
                        { store: deps.quotaStore, getWorkspaceEntry: deps.getWorkspaceEntryForQuota },
                        resolvedEdge.resolvedWorkspace,
                        { nodes: 0, bytes },
                    );
                    if (!q.allowed) {
                        __auditCtx.errored = true;
                        __auditCtx.resultDetail = `workspace_quota_exceeded:${q.dimension}`;
                        return {
                            content: [{
                                type: 'text' as const,
                                text: JSON.stringify({
                                    error: 'workspace_quota_exceeded',
                                    dimension: q.dimension,
                                    current: q.current,
                                    cap: q.cap,
                                    workspace: resolvedEdge.resolvedWorkspace,
                                }, null, 2),
                            }],
                            isError: true,
                        };
                    }
                }
                __auditCtx.workspace = resolvedEdge.resolvedWorkspace;
                __auditCtx.entityId = `${sourceId}->${targetId}:${relation}`;

                // SP-F3 — outbox-first hot write, mirroring REST edges.ts.
                // Record the edge.upsert row BEFORE the substrate write so
                // MCP-originated edges get the same durability +
                // crash-recovery-replay + per-workspace replication the REST
                // surface has. Only when an outbox is wired; otherwise keep
                // the prior direct-write behavior (tests / cloud mode).
                //
                // Capture the entry id so the endpoint-missing path below can
                // RETRACT the row (see the catch under the graph write).
                let edgeUpsertOutboxEntryId: string | null = null;
                if (deps.outboxStore) {
                    const edgeUpsertEntry = await recordHotWrite(deps.outboxStore, {
                        workspace: resolvedEdge.resolvedWorkspace,
                        operationKind: 'edge.upsert',
                        payload: { ...edge, bidirectional: useBidirectional },
                        initiator: 'mcp:store_edge',
                        operation: 'edge.upsert',
                    });
                    edgeUpsertOutboxEntryId = edgeUpsertEntry.id;
                }

                try {
                    // 1.1 — conflict retry for Surreal optimistic-concurrency
                    // errors under concurrent edge writes.
                    if (useBidirectional) {
                        await withTransactionConflictRetry(() => edgeGraph.addBidirectionalEdge(edge));
                    } else {
                        await withTransactionConflictRetry(() => edgeGraph.addEdge(edge));
                    }
                } catch (edgeErr) {
                    // Medium (2026-08-17 functional-correctness) — when the
                    // write fails with edge_endpoint_missing the caller gets
                    // isError, but the already-recorded edge.upsert row stayed
                    // pending and the replicator kept retrying it, so the
                    // 'failed' edge silently appeared later once the endpoint
                    // node happened to be created. Retract the row the same
                    // way nodeService's rollbackPartialWrite does (C-R2-03):
                    // conditional removeIfPending while the row is still
                    // pending; if the replicator already claimed it, record a
                    // compensating edge.delete (a LATER sequenceId in the same
                    // cross-superseding family) that lands after the replay
                    // and converges back to "no edge". A retraction failure
                    // must NOT mask the original endpoint error.
                    if (edgeUpsertOutboxEntryId && deps.outboxStore
                        && /edge_endpoint_missing/i.test((edgeErr as Error)?.message ?? '')) {
                        try {
                            let removed: boolean;
                            if (deps.outboxStore.removeIfPending) {
                                removed = await deps.outboxStore.removeIfPending(edgeUpsertOutboxEntryId);
                            } else {
                                await deps.outboxStore.remove(edgeUpsertOutboxEntryId);
                                removed = true;
                            }
                            if (!removed) {
                                await recordHotWrite(deps.outboxStore, {
                                    workspace: resolvedEdge.resolvedWorkspace,
                                    operationKind: 'edge.delete',
                                    payload: { sourceId, targetId, relation },
                                    initiator: 'mcp:store_edge',
                                    operation: 'edge.delete',
                                });
                                log.warn(`[Lore MCP] store_edge: edge.upsert row for ${sourceId}->${targetId}:${relation} was already claimed by the replicator; recorded a compensating edge.delete so the endpoint-missing edge cannot silently appear later`);
                            }
                        } catch (retractErr) {
                            log.error(`[Lore MCP] store_edge: failed to retract the edge.upsert outbox row after edge_endpoint_missing: ${redactError(retractErr)} — the replicator may apply the edge later even though this call failed`);
                        }
                    }
                    throw edgeErr;
                }

                // Buffer write to WAL for async sync. P1.C: same
                // active-only guard as store_node — non-active
                // workspace writes are out of WAL scope until per-
                // workspace WAL ships.
                if (resolvedEdge.isActive) {
                    deps.getWal().append('add_edge', { sourceId, targetId, relation, confidence: conf, confidenceScore: score });
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            edge: { sourceId, targetId, relation, bidirectional: useBidirectional, confidence: conf, confidenceScore: score },
                            message: `Edge '${sourceId}' ${useBidirectional ? '↔' : '→'} '${targetId}' (${relation}, ${conf}) created.`,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                __auditCtx.errored = true;
                // Audit fix #4: redact before landing in audit.jsonl (finding #13).
                __auditCtx.resultDetail = redactError(error);
                return mcpToolError('store_edge', error, log);
            } finally {
                try {
                    deps.auditLog.log({
                        toolName: 'store_edge',
                        args: { workspace: __auditCtx.workspace, entityId: __auditCtx.entityId },
                        result: __auditCtx.errored ? 'error' : 'success',
                        resultDetail: __auditCtx.resultDetail,
                        durationMs: Date.now() - __auditStartedAt,
                    });
                } catch (logErr) {
                    console.error(`[Lore MCP] audit emission failed for store_edge: ${(logErr as Error).message}`);
                }
            }
        },
    );
}
