/**
 * bulkWriteEdgesDelete.ts — POST /api/edges/bulk + POST /api/nodes/bulk-delete.
 *
 * Extracted from bulkWrite.ts (2026-08-18) when the 1.1 conflict-retry
 * wraps grew that file past its file-size baseline — the split follows the
 * repo rule (new route logic goes in a sibling module, not a growing
 * monolith). Behavior is unchanged; see bulkWrite.ts for the endpoint
 * contracts (caps, per-item results, workspace routing).
 */

import type { ServerResponse } from 'node:http';
import { WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import type { VerbatimStore } from '../../../engines/verbatimStore.js';
import { redactError } from '../../../security/logRedact.js';
import { writeJson, writeError } from '../helpers.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { recordHotWriteBatch } from '../../../outbox/hotLane.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';
import { resolveGraph, writeWorkspaceNotFound, ITEM_CAP, type BulkWriteDeps, type BulkResult, type EdgeInput } from './bulkWrite.js';

export async function handleBulkEdges(
    res: ServerResponse,
    parsed: { edges?: unknown; workspace?: unknown },
    deps: BulkWriteDeps,
): Promise<boolean> {
    if (!Array.isArray(parsed.edges)) {
        writeError(res, 400, 'bad_request', '`edges` must be an array');
        return true;
    }
    if (parsed.edges.length === 0) {
        writeError(res, 400, 'bad_request', '`edges` must be non-empty');
        return true;
    }
    if (parsed.edges.length > ITEM_CAP) {
        writeError(res, 400, 'bad_request', `at most ${ITEM_CAP} edges per call (got ${parsed.edges.length})`);
        return true;
    }
    const requestedWorkspace = typeof parsed.workspace === 'string' ? parsed.workspace : undefined;
    if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'write' }) === null) return true;
    // F-COL4 — per-workspace quota gate. Edges add no nodes; project nodes:0 so
    // a workspace already at its node/byte cap still refuses (429) before write.
    if (deps.quotaStore && deps.getWorkspaceEntryForQuota) {
        const { enforceQuotaOrReject } = await import('../../../security/workspaceQuota.js');
        const q = enforceQuotaOrReject({ store: deps.quotaStore, getWorkspaceEntry: deps.getWorkspaceEntryForQuota }, res, requestedWorkspace!, { nodes: 0, bytes: 0 });
        if (q.handled) return true;
    }
    const target = await resolveGraph(deps, requestedWorkspace);
    if ('error' in target) { writeWorkspaceNotFound(res, target); return true; }

    // O3: outbox-batch — pre-validate, then batch-commit outbox rows
    // for valid items, then run substrate writes in-line (idempotent).
    interface EdgePlan {
        idx: number;
        edge: {
            sourceId: string;
            targetId: string;
            relation: string;
            confidence: 'extracted' | 'inferred' | 'ambiguous';
            confidenceScore: number;
        };
        bidirectional: boolean;
    }
    const edgeItems = parsed.edges as EdgeInput[];
    const results: BulkResult[] = new Array(edgeItems.length);
    const plans: EdgePlan[] = [];
    for (let i = 0; i < edgeItems.length; i++) {
        const raw = edgeItems[i];
        if (!raw || typeof raw !== 'object'
            || typeof raw.sourceId !== 'string'
            || typeof raw.targetId !== 'string'
            || typeof raw.relation !== 'string') {
            results[i] = { ok: false, error: 'sourceId, targetId, relation are required strings' };
            continue;
        }
        const conf = typeof raw.confidence === 'string' ? raw.confidence : 'extracted';
        const score = typeof raw.confidenceScore === 'number'
            ? Math.max(0, Math.min(1, raw.confidenceScore))
            : (conf === 'extracted' ? 1.0 : 0.5);
        plans.push({
            idx: i,
            edge: {
                sourceId: raw.sourceId,
                targetId: raw.targetId,
                relation: raw.relation,
                confidence: conf as 'extracted' | 'inferred' | 'ambiguous',
                confidenceScore: score,
            },
            bidirectional: raw.bidirectional === true,
        });
    }
    if (deps.outboxStore && plans.length > 0) {
        try {
            await recordHotWriteBatch(deps.outboxStore, plans.map(({ edge, bidirectional }) => ({
                workspace: requestedWorkspace!,
                operationKind: 'edge.upsert',
                payload: { ...edge, bidirectional },
                initiator: 'http:POST /api/edges/bulk',
                operation: bidirectional ? 'graph.addBidirectionalEdge' : 'graph.addEdge',
            })));
        } catch (err) {
            const msg = `outbox commit failed: ${(err as Error).message}`;
            for (const { idx } of plans) results[idx] = { ok: false, error: msg };
            deps.auditLog.log({
                toolName: 'bulk_store_edges',
                args: { count: edgeItems.length, workspace: requestedWorkspace ?? null, surface: 'http' },
                result: 'error', resultDetail: msg, durationMs: 0,
            });
            writeJson(res, 200, { ok: false, count: edgeItems.length, succeeded: 0, results });
            return true;
        }
    }
    let succeeded = 0;
    for (const { idx, edge, bidirectional } of plans) {
        try {
            // 1.1 — conflict retry, same wrapper as the node-bulk upsert path
            // (the facade's upsertNode/addEdge wraps cover routes that route
            // through it; this loop writes the raw handle directly).
            if (bidirectional) await withTransactionConflictRetry(() => target.addBidirectionalEdge(edge));
            else await withTransactionConflictRetry(() => target.addEdge(edge));
            results[idx] = { ok: true };
            succeeded++;
        } catch (err) {
            results[idx] = { ok: false, error: (err as Error).message };
        }
    }
    deps.auditLog.log({
        toolName: 'bulk_store_edges',
        args: { count: parsed.edges.length, workspace: requestedWorkspace ?? null, surface: 'http' },
        result: succeeded === parsed.edges.length ? 'success' : 'error',
        resultDetail: succeeded === parsed.edges.length ? undefined : `${parsed.edges.length - succeeded} item failure(s)`,
        durationMs: 0,
    });
    writeJson(res, 200, { ok: succeeded === parsed.edges.length, count: parsed.edges.length, succeeded, results });
    return true;
}

export async function handleBulkDelete(
    res: ServerResponse,
    parsed: { ids?: unknown; workspace?: unknown },
    deps: BulkWriteDeps,
): Promise<boolean> {
    if (!Array.isArray(parsed.ids)) {
        writeError(res, 400, 'bad_request', '`ids` must be an array of node ids');
        return true;
    }
    if (parsed.ids.length === 0) {
        writeError(res, 400, 'bad_request', '`ids` must be non-empty');
        return true;
    }
    if (parsed.ids.length > ITEM_CAP) {
        writeError(res, 400, 'bad_request', `at most ${ITEM_CAP} ids per call (got ${parsed.ids.length})`);
        return true;
    }
    const requestedWorkspace = typeof parsed.workspace === 'string' ? parsed.workspace : undefined;
    if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'write' }) === null) return true;
    const target = await resolveGraph(deps, requestedWorkspace);
    if ('error' in target) { writeWorkspaceNotFound(res, target); return true; }

    // L-042 — mirror handleBulkStore: tombstone the verbatim row in the
    // REQUESTED workspace's LanceDB, not the boot singleton (bulk-DELETE was
    // missed in the L-012 sweep). Falls back to deps.store.loreVerbatim when no
    // resolver / no requested workspace.
    let targetVerbatim: VerbatimStore | typeof deps.store.loreVerbatim = deps.store.loreVerbatim;
    if (deps.workspaceVerbatimResolver && requestedWorkspace) {
        try {
            targetVerbatim = await deps.workspaceVerbatimResolver.getOrOpen(requestedWorkspace);
        } catch (err) {
            // resolveGraph already validated the workspace (WorkspaceNotFoundError
            // → 400); reaching here means it vanished between the two calls.
            if (err instanceof WorkspaceNotFoundError) {
                writeWorkspaceNotFound(res, { error: 'workspace_not_found', requested: err.requested, known: err.known });
                return true;
            }
            if (err instanceof Error && err.message.startsWith('workspace_not_found')) {
                writeWorkspaceNotFound(res, { error: 'workspace_not_found', requested: requestedWorkspace!, known: [] });
                return true;
            }
            throw err;
        }
    }

    // O3: outbox-batch — pre-validate string ids, then batch-commit
    // outbox rows for valid ids, then run substrate deletes in-line.
    // Cypher DETACH DELETE (used by deleteNode under the hood) is
    // idempotent — re-deleting an already-gone id returns false and
    // is reported as `deleted:false` (non-fatal, matches W9 shape).
    const idItems = parsed.ids as unknown[];
    const results: Array<{ id: string; ok: boolean; deleted?: boolean; error?: string }> = new Array(idItems.length);
    interface DelPlan { idx: number; raw: string; stripped: string; }
    const delPlans: DelPlan[] = [];
    for (let i = 0; i < idItems.length; i++) {
        const raw = idItems[i];
        if (typeof raw !== 'string') {
            results[i] = { id: String(raw), ok: false, error: 'id must be a string' };
            continue;
        }
        const stripped = raw.startsWith('lore:') ? raw.slice(5) : raw;
        delPlans.push({ idx: i, raw, stripped });
    }
    if (deps.outboxStore && delPlans.length > 0) {
        try {
            await recordHotWriteBatch(deps.outboxStore, delPlans.map(({ stripped }) => ({
                workspace: requestedWorkspace!,
                operationKind: 'node.delete',
                payload: { id: stripped },
                initiator: 'http:POST /api/nodes/bulk-delete',
                operation: 'graph.deleteNode',
            })));
        } catch (err) {
            const msg = `outbox commit failed: ${(err as Error).message}`;
            for (const { idx, raw } of delPlans) {
                results[idx] = { id: raw, ok: false, error: msg };
            }
            deps.auditLog.log({
                toolName: 'bulk_delete_nodes',
                args: { count: idItems.length, workspace: requestedWorkspace ?? null, surface: 'http' },
                result: 'error', resultDetail: msg, durationMs: 0,
            });
            writeJson(res, 200, { ok: false, count: idItems.length, deleted: 0, notFound: 0, results });
            return true;
        }
    }
    let deletedCount = 0;
    let notFoundCount = 0;
    for (const { idx, raw, stripped } of delPlans) {
        try {
            const deleted = await withTransactionConflictRetry(() => target.deleteNode(stripped));
            if (deleted) {
                // Fire-and-forget verbatim tombstone — mirrors MCP delete_node.
                // L-042 — tombstone the REQUESTED workspace's verbatim store
                // (resolved above), not the boot singleton.
                const verbatim = targetVerbatim as unknown as {
                    tombstone?: (id: string, reason: string) => Promise<void>;
                    delete: (id: string) => Promise<void>;
                };
                const op = typeof verbatim.tombstone === 'function'
                    ? verbatim.tombstone(`lore:${stripped}`, 'graph node deleted via /api/nodes/bulk-delete')
                    : verbatim.delete(`lore:${stripped}`);
                op.catch((err) => console.error(`[Lore HTTP] bulk-delete verbatim op failed for ${stripped}: ${redactError(err)}`));
                deletedCount++;
                results[idx] = { id: raw, ok: true, deleted: true };
            } else {
                notFoundCount++;
                // 404 is non-fatal — the operator's cleanup script may
                // re-issue IDs that are already gone (idempotent).
                results[idx] = { id: raw, ok: true, deleted: false };
            }
        } catch (err) {
            results[idx] = { id: raw, ok: false, error: (err as Error).message };
        }
    }
    deps.auditLog.log({
        toolName: 'bulk_delete_nodes',
        args: { count: parsed.ids.length, workspace: requestedWorkspace ?? null, surface: 'http' },
        result: 'success',
        resultDetail: `${deletedCount} deleted · ${notFoundCount} not-found`,
        durationMs: 0,
    });
    writeJson(res, 200, {
        ok: true,
        count: parsed.ids.length,
        deleted: deletedCount,
        notFound: notFoundCount,
        results,
    });
    return true;
}
