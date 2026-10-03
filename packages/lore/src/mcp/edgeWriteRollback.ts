/**
 * edgeWriteRollback.ts — one edge write or delete that is undone when it
 * fails (3.26.0).
 *
 * Shared by the four single-edge doors: POST /api/edge, DELETE /api/edge, MCP
 * `store_edge`, MCP `delete_edge`. Each records its outbox row before the
 * graph write. Before 3.26.0 a write that then failed kept that row (only
 * `store_edge` retracted it, and only for a missing endpoint), so the
 * replicator applied later an operation whose caller had been told it failed:
 * an edge appeared, or an edge that was still there was removed. A
 * bidirectional write that failed on the reverse direction also left the
 * forward edge in the graph.
 *
 * Same contract as the bulk route (http/routes/bulkEdgeRollback.ts), whose
 * primitives this file reuses:
 *   - the edge is read before the outbox row is recorded; a read that fails
 *     rejects the call with nothing written or queued;
 *   - on a failed write the graph is put back as it was, per direction;
 *   - the outbox row is removed while still pending. Already claimed by the
 *     replicator: compensating rows are recorded that replay to the prior
 *     state.
 *
 * Callers hold the edge lock(s) of every triple involved (`withEdgeLock` /
 * `withEdgeLocks`) around the call. The ORIGINAL write error is rethrown: a
 * failed undo or retraction is logged and never replaces it (the graph or the
 * outbox may then still hold part of the failed operation).
 *
 * The lock covers the writers that take it (in-process sync pull, reconnect
 * and the ArcadeDB replay lane included). The storage facade's `addEdge`, the
 * CLI (`lore supersede` / `reconnect` / `sync`), the admin import/migrate
 * paths, the bulk loader and the schema relation operations do not: an edge
 * one of them writes between this call's pre-read and its undo is removed by
 * it.
 */
import type { EdgeQuery, LoreEdge } from '../providers/types.js';
import type { OutboxStore } from '../outbox/types.js';
import { recordHotWrite } from '../outbox/hotLane.js';
import { withTransactionConflictRetry } from '../engines/transactionConflictRetry.js';
import { redactError } from '../security/logRedact.js';
import { log } from '../logger.js';
import {
    compensatingSpec, readEdge, readEdgePriors, retractBulkEdgeUpsert, undoBulkEdgeWrite, type PriorEdge,
} from './http/routes/bulkEdgeRollback.js';

/** The graph surface both functions need; a graph with neither read keeps the pre-3.26 behaviour (no undo). */
export interface SingleEdgeGraph {
    addEdge(edge: LoreEdge): Promise<void>;
    addBidirectionalEdge?(edge: LoreEdge): Promise<void>;
    deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number>;
    getEdge?(sourceId: string, targetId: string, relation: string): Promise<LoreEdge | null>;
    queryEdges?(q: EdgeQuery): Promise<LoreEdge[]>;
}

const describe = (s: string, t: string, r: string): string => `${s} -[${r}]-> ${t}`;

/**
 * Record the `edge.upsert` row (when a store is wired) and write the edge. On
 * a failed write: undo what landed in the graph, retract the row, rethrow.
 */
export async function writeEdgeOrRestore(input: {
    graph: SingleEdgeGraph;
    store?: OutboxStore | null;
    workspace: string;
    edge: LoreEdge;
    bidirectional: boolean;
    /** Outbox initiator of the row and of any compensating row, e.g. `mcp:store_edge`. */
    initiator: string;
}): Promise<void> {
    const { graph, store, workspace, edge, bidirectional, initiator } = input;
    // Writing the forward edge alone would report success while the queued
    // row, which carries the flag, replayed the reverse direction later.
    if (bidirectional && typeof graph.addBidirectionalEdge !== 'function') {
        throw new Error('this graph cannot write a bidirectional edge; nothing was written');
    }
    let unreadable: string | undefined;
    const { priors } = await readEdgePriors(graph, [{ idx: 0, edge, bidirectional }], (_plan, error) => { unreadable = error; });
    if (unreadable !== undefined) throw new Error(unreadable);

    let entryId: string | null = null;
    if (store) {
        entryId = (await recordHotWrite(store, {
            workspace, operationKind: 'edge.upsert', payload: { ...edge, bidirectional }, initiator, operation: 'edge.upsert',
        })).id;
    }
    try {
        if (bidirectional) {
            await withTransactionConflictRetry(() => graph.addBidirectionalEdge!(edge));
        } else {
            await withTransactionConflictRetry(() => graph.addEdge(edge));
        }
    } catch (writeErr) {
        const what = describe(edge.sourceId, edge.targetId, edge.relation);
        try {
            await undoBulkEdgeWrite(graph, edge, bidirectional, priors);
        } catch (undoErr) {
            log.error(`[Lore] ${initiator}: could not undo the failed write of edge ${what}: ${redactError(undoErr)}; the graph may hold part of it`);
        }
        if (store && entryId) {
            try {
                const compensated = await retractBulkEdgeUpsert({ store, entryId, workspace, edge, bidirectional, priors, initiator });
                if (compensated.length > 0) {
                    log.warn(`[Lore] ${initiator}: the edge.upsert row of the failed write of ${what} was already claimed by the replicator; recorded ${compensated.length} compensating row(s) so replay ends on the prior state`);
                }
            } catch (retractErr) {
                log.error(`[Lore] ${initiator}: could not retract the edge.upsert outbox row of the failed write of ${what}: ${redactError(retractErr)}; the replicator may apply the edge later even though this call failed`);
            }
        }
        throw writeErr;
    }
}

/**
 * Record the `edge.delete` row (when a store is wired) and delete the edge.
 * Returns the count removed. On a failed delete: write back an edge that
 * existed and is no longer there as it was, retract the row, rethrow. A
 * claimed row is compensated with an `edge.upsert` of the prior edge
 * (`bidirectional: false`); when the edge did not exist, the claimed delete
 * replays as a no-op and nothing is recorded.
 */
export async function deleteEdgeOrRestore(input: {
    graph: SingleEdgeGraph;
    store?: OutboxStore | null;
    workspace: string;
    sourceId: string;
    targetId: string;
    relation: string;
    /** Outbox initiator of the row and of any compensating row, e.g. `mcp:delete_edge`. */
    initiator: string;
}): Promise<number> {
    const { graph, store, workspace, sourceId, targetId, relation, initiator } = input;
    let prior: PriorEdge;
    try {
        prior = await readEdge(graph, sourceId, targetId, relation);
    } catch (err) {
        throw new Error(`could not read the edge before deleting: ${(err as Error).message}; nothing was deleted`);
    }

    let entryId: string | null = null;
    if (store) {
        entryId = (await recordHotWrite(store, {
            workspace, operationKind: 'edge.delete', payload: { sourceId, targetId, relation }, initiator, operation: 'edge.delete',
        })).id;
    }
    try {
        return await withTransactionConflictRetry(() => graph.deleteEdge(sourceId, targetId, relation));
    } catch (deleteErr) {
        const what = describe(sourceId, targetId, relation);
        if (prior) {
            const before = prior;
            try {
                let current: PriorEdge;
                try { current = await readEdge(graph, sourceId, targetId, relation); } catch { current = undefined; }
                const intact = !!current && current.confidence === before.confidence && current.confidenceScore === before.confidenceScore;
                if (!intact) await withTransactionConflictRetry(() => graph.addEdge(before));
            } catch (undoErr) {
                log.error(`[Lore] ${initiator}: could not restore edge ${what} after its failed delete: ${redactError(undoErr)}; the graph may no longer hold it`);
            }
        }
        if (store && entryId) {
            try {
                if (!store.removeIfPending) {
                    await store.remove(entryId);
                } else if (!(await store.removeIfPending(entryId))) {
                    if (prior) {
                        await recordHotWrite(store, compensatingSpec(workspace, { sourceId, targetId, relation }, prior, initiator));
                        log.warn(`[Lore] ${initiator}: the edge.delete row of the failed delete of ${what} was already claimed by the replicator; recorded a compensating edge.upsert so replay ends with the edge in place`);
                    } else if (prior === undefined) {
                        log.warn(`[Lore] ${initiator}: the edge.delete row of the failed delete of ${what} was already claimed by the replicator and this graph cannot be read; the delete may still be applied`);
                    }
                }
            } catch (retractErr) {
                log.error(`[Lore] ${initiator}: could not retract the edge.delete outbox row of the failed delete of ${what}: ${redactError(retractErr)}; the replicator may apply the delete later even though this call failed`);
            }
        }
        throw deleteErr;
    }
}
