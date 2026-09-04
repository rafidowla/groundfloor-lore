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
import { recordHotWrite, recordHotWriteBatch, retractHotWriteOrCompensate } from '../../../outbox/hotLane.js';
import { withNodeLocks, chunkForLocking, BULK_LOCK_CHUNK_SIZE, withEdgeLocks, type EdgeLockTriple } from '../../../core/nodeWriteLock.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';
import type { OutboxEntry } from '../../../outbox/types.js';
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
    // Round-E X-edges finding (1) — this used to commit the WHOLE batch's
    // edge.upsert rows via recordHotWriteBatch BEFORE any lock was taken
    // (edges had no lock at all until this fix) or before the substrate
    // loop ran. A concurrent single edge write (MCP store_edge, POST
    // /api/edge, or another bulk call) for one of these triples could land
    // its own outbox row and graph write in between this batch's commit and
    // its substrate write for that triple, so the real substrate order came
    // out backwards from the outbox's commit order — the exact pre-lock
    // ordering race ef551757/de8367e7 fixed for nodes (see
    // core/nodeWriteLock.ts). Fix: chunk the batch into `withEdgeLocks`
    // calls of at most `BULK_LOCK_CHUNK_SIZE` PLANS each (a bidirectional
    // plan locks both its forward and reverse triple), acquired and
    // released one chunk at a time — same reasoning nodeWriteLock.ts's
    // `BULK_LOCK_CHUNK_SIZE` doc gives for nodes: bounds a concurrent
    // single-triple writer's worst-case wait to one chunk's substrate-write
    // time instead of the whole batch, without reopening the ordering race
    // (the outbox commit and substrate writes for a chunk's triples stay
    // atomic under that chunk's own lock).
    let succeeded = 0;
    const lockWorkspace = requestedWorkspace ?? deps.graphRegistry?.activeName() ?? '';
    for (const chunk of chunkForLocking(plans, BULK_LOCK_CHUNK_SIZE)) {
        const lockTriples: EdgeLockTriple[] = [];
        for (const { edge, bidirectional } of chunk) {
            lockTriples.push({ sourceId: edge.sourceId, targetId: edge.targetId, relation: edge.relation });
            if (bidirectional) lockTriples.push({ sourceId: edge.targetId, targetId: edge.sourceId, relation: edge.relation });
        }
        await withEdgeLocks(lockWorkspace, lockTriples, async () => {
            let chunkEntries: OutboxEntry[] | null = null;
            if (deps.outboxStore && chunk.length > 0) {
                try {
                    chunkEntries = await recordHotWriteBatch(deps.outboxStore, chunk.map(({ edge, bidirectional }) => ({
                        workspace: requestedWorkspace!,
                        operationKind: 'edge.upsert',
                        payload: { ...edge, bidirectional },
                        initiator: 'http:POST /api/edges/bulk',
                        operation: bidirectional ? 'graph.addBidirectionalEdge' : 'graph.addEdge',
                    })));
                } catch (err) {
                    const msg = `outbox commit failed: ${(err as Error).message}`;
                    for (const { idx } of chunk) results[idx] = { ok: false, error: msg };
                    return;
                }
            }
            for (let k = 0; k < chunk.length; k++) {
                const { idx, edge, bidirectional } = chunk[k]!;
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
                    // This chunk's edge.upsert outbox row for `edge` is already
                    // committed (above), but the substrate write just failed —
                    // retract it (mirroring bulkWrite.ts's node.upsert retraction)
                    // so a later replicator replay doesn't create the edge the
                    // caller was told ok:false for.
                    if (deps.outboxStore && chunkEntries) {
                        const entry = chunkEntries[k];
                        if (entry) {
                            try {
                                await retractHotWriteOrCompensate(deps.outboxStore, entry.id, {
                                    workspace: requestedWorkspace!,
                                    operationKind: 'edge.delete',
                                    payload: { sourceId: edge.sourceId, targetId: edge.targetId, relation: edge.relation },
                                    initiator: 'http:POST /api/edges/bulk',
                                    operation: 'edge.delete',
                                });
                            } catch (retractErr) {
                                console.error(`[Lore HTTP] bulk edges: edge.upsert outbox retraction failed for ${edge.sourceId}->${edge.targetId}:${edge.relation}: ${redactError(retractErr)} — replicator may create a ghost edge`);
                            }
                        }
                    }
                }
            }
        });
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
    // Lock key workspace — same resolution resolveGraph() just used, so the
    // key names the workspace the deletes actually land in (a bare
    // `requestedWorkspace!` would key on "undefined" when the param is absent
    // and silently stop contending with nodeUpsert).
    const lockWorkspace = requestedWorkspace ?? deps.graphRegistry?.activeName() ?? '';
    // Round-E X-edges — same active-only WAL guard nodeService.ts/
    // store_edge use: non-active workspace writes are out of WAL scope
    // until per-workspace WAL ships.
    const isActiveWorkspace = !deps.graphRegistry || lockWorkspace === deps.graphRegistry.activeName();

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
    let deletedCount = 0;
    let notFoundCount = 0;
    // QA A2 round-4 finding 1 (2026-09-03) — set when ANY chunk's outbox
    // commit fails (see the chunk loop below). Drives the response `ok`
    // flag the same way the round-3 `outboxCommitError` used to: an outbox
    // commit failure is the ONLY thing that flips `ok` false — a per-id
    // substrate delete failure inside the loop reports that item's `ok:false`
    // in `results` without changing the overall response `ok` (unchanged
    // from pre-round-4 behavior).
    let anyOutboxCommitFailure = false;
    if (delPlans.length > 0) {
        // QA A2 round-3 finding (2026-09-03) — this used to commit the WHOLE
        // batch's node.delete rows via recordHotWriteBatch BEFORE taking any
        // per-id lock. A concurrent nodeUpsert() on one of these ids records
        // its OWN node.upsert row inside ITS lock and can win that lock before
        // this loop's turn for the id arrives, so the real substrate order
        // (upsert-after-delete-released -> node present) came out backwards
        // from the outbox's commit order (delete row committed first) — a
        // replay then resurrected a node this call had actually deleted.
        // Fix: acquire every id's lock via `withNodeLocks` (sorted,
        // deadlock-free — nodeWriteLock.ts rule 3) and run the outbox commit
        // AND every id's delete + tombstone inside that ONE locked region, so
        // nothing touching any of these ids can land between the commit and
        // the deletes.
        //
        // QA A2 round-4 finding 1 (2026-09-03) — locking the WHOLE batch's ids
        // at once held all of them for the full duration of the delete loop,
        // so a concurrent single-key writer on any one id waited for nearly
        // the entire batch (865x+ amplification measured for N=1000). Fix:
        // run `withNodeLocks` per CHUNK of at most `BULK_LOCK_CHUNK_SIZE` ids
        // — see nodeWriteLock.ts for why this bounds the worst-case hold
        // without reopening the round-3 race (each id's own outbox commit and
        // delete stay atomic under that id's chunk lock; only OTHER ids'
        // turns release sooner). Per-id `withNodeLock` calls stay out of the
        // loop below: they would be a re-entrant acquisition of a key the
        // chunk's outer lock already holds (nodeWriteLock.ts rule 2) — every
        // call inside is a raw substrate primitive, same as the batched
        // upsert path.
        for (const chunk of chunkForLocking(delPlans, BULK_LOCK_CHUNK_SIZE)) {
            await withNodeLocks(lockWorkspace, chunk.map(({ stripped }) => stripped), async () => {
                let chunkEntries: OutboxEntry[] | null = null;
                if (deps.outboxStore) {
                    try {
                        chunkEntries = await recordHotWriteBatch(deps.outboxStore, chunk.map(({ stripped }) => ({
                            workspace: requestedWorkspace!,
                            operationKind: 'node.delete',
                            payload: { id: stripped },
                            initiator: 'http:POST /api/nodes/bulk-delete',
                            operation: 'graph.deleteNode',
                        })));
                    } catch (err) {
                        anyOutboxCommitFailure = true;
                        const msg = `outbox commit failed: ${(err as Error).message}`;
                        for (const { idx, raw } of chunk) results[idx] = { id: raw, ok: false, error: msg };
                        return;
                    }
                }
                for (let k = 0; k < chunk.length; k++) {
                    const { idx, raw, stripped } = chunk[k]!;
                    try {
                        const wasDeleted = await withTransactionConflictRetry(() => target.deleteNode(stripped));
                        if (!wasDeleted) {
                            notFoundCount++;
                            // 404 is non-fatal — the operator's cleanup script may
                            // re-issue IDs that are already gone (idempotent).
                            results[idx] = { id: raw, ok: true, deleted: false };
                            continue;
                        }
                        // L-042 — tombstone the REQUESTED workspace's verbatim store
                        // (resolved above), not the boot singleton.
                        const verbatim = targetVerbatim as unknown as {
                            tombstone?: (id: string, reason: string) => Promise<void>;
                            delete: (id: string) => Promise<void>;
                        };
                        try {
                            const reason = 'graph node deleted via /api/nodes/bulk-delete';
                            if (typeof verbatim.tombstone === 'function') {
                                await verbatim.tombstone(`lore:${stripped}`, reason);
                            } else {
                                await verbatim.delete(`lore:${stripped}`);
                            }
                            // QA A2 finding 2 (2026-09-03) — record a verbatim.tombstone
                            // outbox row, sequenced AFTER this id's batched node.delete
                            // row committed above, so a stale pending verbatim.upsert
                            // from an earlier create can't later replay and resurrect
                            // the content this call just tombstoned (outbox/types.ts).
                            // Non-fatal: the synchronous tombstone above already ran.
                            if (deps.outboxStore) {
                                await recordHotWrite(deps.outboxStore, {
                                    workspace: lockWorkspace,
                                    operationKind: 'verbatim.tombstone',
                                    payload: { id: `lore:${stripped}`, reason },
                                    initiator: 'http:POST /api/nodes/bulk-delete',
                                    operation: 'verbatim.tombstone',
                                });
                            }
                        } catch (err) {
                            console.error(`[Lore HTTP] bulk-delete verbatim op failed for ${stripped}: ${redactError(err)}`);
                        }
                        // Round-E X-edges — buffer the delete to the WAL for
                        // async sync, mirroring store_edge/nodeService's
                        // 'upsert_node'/'add_edge' appends (same active-only
                        // guard). `handleBulkDelete` previously appended
                        // nothing at all, so a locally bulk-deleted node was
                        // never buffered for a sync push to remove remotely.
                        if (isActiveWorkspace && deps.getWal) {
                            deps.getWal().append('delete_node', { id: stripped });
                        }
                        deletedCount++;
                        results[idx] = { id: raw, ok: true, deleted: true };
                    } catch (err) {
                        results[idx] = { id: raw, ok: false, error: (err as Error).message };
                        // QA A2 round-4 finding 2 (2026-09-03) — this id's node.delete
                        // outbox row (committed above, inside this SAME chunk lock) is
                        // now pending for a delete that never durably happened at the
                        // substrate. Left alone, a later replicator replay could delete
                        // the graph node WITHOUT the verbatim tombstone — this
                        // synchronous path is the only place that runs it — leaving a
                        // graph/verbatim split-brain, the exact class nodeWriteLock.ts
                        // exists to prevent. Retract it, mirroring nodeService.ts's
                        // node.upsert retraction. If the row was already claimed by the
                        // replicator (the delete happened for real despite our own call
                        // throwing), compensate with a verbatim.tombstone row so the
                        // verbatim mirror still converges to match — there is no
                        // separate pending verbatim.tombstone row to retract alongside
                        // it: that row is only ever committed AFTER a successful
                        // synchronous delete (above), which this catch means never
                        // happened.
                        if (deps.outboxStore && chunkEntries) {
                            const entry = chunkEntries[k];
                            if (entry) {
                                try {
                                    await retractHotWriteOrCompensate(deps.outboxStore, entry.id, {
                                        workspace: lockWorkspace,
                                        operationKind: 'verbatim.tombstone',
                                        payload: { id: `lore:${stripped}`, reason: 'graph node deleted via /api/nodes/bulk-delete (replicator raced a foreground delete failure)' },
                                        initiator: 'http:POST /api/nodes/bulk-delete',
                                        operation: 'verbatim.tombstone',
                                    });
                                } catch (retractErr) {
                                    console.error(`[Lore HTTP] bulk-delete: node.delete outbox retraction failed for ${stripped}: ${redactError(retractErr)} — replicator may delete the node later without a verbatim tombstone`);
                                }
                            }
                        }
                    }
                }
            });
        }
    }
    deps.auditLog.log({
        toolName: 'bulk_delete_nodes',
        args: { count: parsed.ids.length, workspace: requestedWorkspace ?? null, surface: 'http' },
        result: anyOutboxCommitFailure ? 'error' : 'success',
        resultDetail: anyOutboxCommitFailure
            ? 'one or more chunks failed to commit their outbox rows'
            : `${deletedCount} deleted · ${notFoundCount} not-found`,
        durationMs: 0,
    });
    writeJson(res, 200, {
        ok: !anyOutboxCommitFailure,
        count: parsed.ids.length,
        deleted: deletedCount,
        notFound: notFoundCount,
        results,
    });
    return true;
}
