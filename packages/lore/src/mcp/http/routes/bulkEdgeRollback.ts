/**
 * bulkEdgeRollback.ts — undo of one failed item of POST /api/edges/bulk.
 *
 * Split from bulkWriteEdgesDelete.ts (file-size cap). 3.26.0: a failed write
 * of a triple that ALREADY existed no longer deletes it. The edge twin of
 * bulkWriteRollback.ts (nodes):
 *
 *   - graph side: a failed item can leave the graph half-written
 *     (`addBidirectionalEdge` is two writes, forward then reverse; a cloud
 *     `addEdge` writes the row and then the graph edge). Each direction the item
 *     touched is put back as it was before the item: a direction that existed is
 *     re-written with its prior confidence, a direction the item created is
 *     deleted.
 *   - outbox side: when the item's `edge.upsert` row was already claimed by the
 *     replicator, the compensating rows are, per direction, an `edge.upsert` of
 *     the prior edge (`bidirectional: false`: replay treats a missing flag as
 *     true and would also write the reverse) when it existed, an `edge.delete`
 *     when it did not. Before, it was always a forward `edge.delete`, whose
 *     replay removed a relationship that existed before the request.
 *
 * The prior state is read per triple under the chunk's edge locks, BEFORE the
 * chunk's outbox rows are recorded. A graph with no single-edge read (a minimal
 * fake) yields `undefined` priors and keeps the pre-3.26 compensation: no inline
 * undo, a forward `edge.delete`.
 */
import type { EdgeQuery, LoreEdge } from '../../../providers/types.js';
import type { OutboxStore } from '../../../outbox/types.js';
import { recordHotWriteBatch, type HotWriteSpec } from '../../../outbox/hotLane.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';

const INITIATOR = 'http:POST /api/edges/bulk';
const SEP = '\u0000';

/**
 * What a triple held before the item: the edge (confidence fields included),
 * `null` when absent, `undefined` when the graph cannot be asked.
 */
export type PriorEdge = LoreEdge | null | undefined;
/** Prior state per triple (key = {@link edgeKey}); updated as the chunk's items succeed. */
export type EdgePriors = Map<string, PriorEdge>;

/** `getEdge` is the keyed read (SQLite, SurrealDB); `queryEdges` is on every graph handle. */
interface EdgeReadGraph {
    getEdge?(sourceId: string, targetId: string, relation: string): Promise<LoreEdge | null>;
    queryEdges?(q: EdgeQuery): Promise<LoreEdge[]>;
}
interface EdgeWriteGraph extends EdgeReadGraph {
    addEdge(edge: LoreEdge): Promise<void>;
    deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number>;
}
interface EdgePlan { idx: number; edge: LoreEdge; bidirectional: boolean }

export const edgeKey = (s: string, t: string, r: string): string => `${s}${SEP}${t}${SEP}${r}`;

/** The triples an item writes: forward, plus the reverse when bidirectional (a self-loop is one). */
function triplesOf(edge: LoreEdge, bidirectional: boolean): Array<{ sourceId: string; targetId: string; relation: string }> {
    const forward = { sourceId: edge.sourceId, targetId: edge.targetId, relation: edge.relation };
    if (!bidirectional || edge.sourceId === edge.targetId) return [forward];
    return [forward, { sourceId: edge.targetId, targetId: edge.sourceId, relation: edge.relation }];
}

/**
 * Read one edge. Throws when the read fails. Returns `undefined` when the
 * graph has no usable read: neither method, or a triple with an empty part
 * (`queryEdges` ignores an empty filter, so it could not be read exactly).
 * The returned edge carries the REQUESTED ids, whatever form the engine stores.
 */
export async function readEdge(graph: EdgeReadGraph, sourceId: string, targetId: string, relation: string): Promise<PriorEdge> {
    let found: LoreEdge | null | undefined;
    if (typeof graph.getEdge === 'function') {
        found = await graph.getEdge(sourceId, targetId, relation);
    } else if (typeof graph.queryEdges === 'function' && sourceId && targetId && relation) {
        found = (await graph.queryEdges({ source: sourceId, target: targetId, relation, limit: 1, offset: 0 }))[0] ?? null;
    } else {
        return undefined;
    }
    if (!found) return null;
    return {
        sourceId, targetId, relation,
        confidence: found.confidence ?? 'extracted',
        confidenceScore: typeof found.confidenceScore === 'number' ? found.confidenceScore : 1.0,
    };
}

/**
 * The prior state of every triple a chunk writes. Call it under the chunk's
 * edge locks, before the outbox commit. A plan whose triple cannot be read is
 * failed here and left out of the returned chunk: nothing is written for it,
 * since its write could not be undone.
 */
export async function readEdgePriors<P extends EdgePlan>(
    graph: EdgeReadGraph,
    plans: readonly P[],
    fail: (plan: P, error: string) => void,
): Promise<{ chunk: P[]; priors: EdgePriors }> {
    const priors: EdgePriors = new Map();
    const chunk: P[] = [];
    for (const plan of plans) {
        const triples = triplesOf(plan.edge, plan.bidirectional);
        const read = new Map<string, PriorEdge>();
        try {
            for (const t of triples) {
                const key = edgeKey(t.sourceId, t.targetId, t.relation);
                read.set(key, priors.has(key) ? priors.get(key) : await readEdge(graph, t.sourceId, t.targetId, t.relation));
            }
        } catch (err) {
            fail(plan, `could not read the edge before writing: ${(err as Error).message}; nothing was written`);
            continue;
        }
        for (const [key, value] of read) priors.set(key, value);
        chunk.push(plan);
    }
    return { chunk, priors };
}

/** Record that an item's write landed: later items of the chunk on the same triples restore to THIS state. */
export function markEdgeWritten(priors: EdgePriors, edge: LoreEdge, bidirectional: boolean): void {
    for (const t of triplesOf(edge, bidirectional)) {
        if (priors.get(edgeKey(t.sourceId, t.targetId, t.relation)) === undefined) continue; // graph cannot be read: stays unknown
        priors.set(edgeKey(t.sourceId, t.targetId, t.relation), {
            ...t, confidence: edge.confidence ?? 'extracted', confidenceScore: edge.confidenceScore ?? 1.0,
        });
    }
}

const sameEdge = (a: LoreEdge, b: LoreEdge): boolean => a.confidence === b.confidence && a.confidenceScore === b.confidenceScore;

/**
 * Put every direction a failed item touched back as it was: re-write a
 * direction that existed (when its confidence changed), delete a direction the
 * item created, leave a direction that was removed meanwhile alone. A current
 * state that cannot be read is treated as "differs". Every direction is tried;
 * the first failure is thrown afterwards. Callers hold the chunk's edge locks.
 */
export async function undoBulkEdgeWrite(graph: EdgeWriteGraph, edge: LoreEdge, bidirectional: boolean, priors: EdgePriors): Promise<void> {
    let firstError: unknown;
    for (const t of triplesOf(edge, bidirectional)) {
        const prior = priors.get(edgeKey(t.sourceId, t.targetId, t.relation));
        if (prior === undefined) continue;
        try {
            let current: PriorEdge;
            try { current = await readEdge(graph, t.sourceId, t.targetId, t.relation); } catch { current = undefined; }
            if (prior) {
                if (current === null || (current && sameEdge(current, prior))) continue;
                await withTransactionConflictRetry(() => graph.addEdge(prior));
            } else if (current !== null) {
                await withTransactionConflictRetry(() => graph.deleteEdge(t.sourceId, t.targetId, t.relation));
            }
        } catch (err) {
            firstError ??= err;
        }
    }
    if (firstError !== undefined) throw firstError;
}

/** The row that makes a replay end on `prior` for one triple. */
export function compensatingSpec(workspace: string, t: { sourceId: string; targetId: string; relation: string }, prior: PriorEdge, initiator: string = INITIATOR): HotWriteSpec {
    if (prior) {
        return {
            workspace, operationKind: 'edge.upsert', initiator, operation: 'graph.addEdge',
            payload: { sourceId: t.sourceId, targetId: t.targetId, relation: t.relation, confidence: prior.confidence, confidenceScore: prior.confidenceScore, bidirectional: false },
        };
    }
    return { workspace, operationKind: 'edge.delete', initiator, operation: 'edge.delete', payload: { sourceId: t.sourceId, targetId: t.targetId, relation: t.relation } };
}

/**
 * Retract the `edge.upsert` outbox row of a failed item. Still pending: it is
 * removed. Already claimed: its replay has written (or will write) both
 * directions of a bidirectional item, so compensating rows are recorded, one
 * per direction, ending on the prior state. A graph whose prior is unknown gets
 * the pre-3.26 forward `edge.delete`. Throws when the row could be neither
 * removed nor compensated; callers log and carry on. Returns the keys of the
 * triples that got a compensating row (see `reassertBulkEdgeUpsert`).
 */
export async function retractBulkEdgeUpsert(input: {
    store: OutboxStore;
    entryId: string;
    workspace: string;
    edge: LoreEdge;
    bidirectional: boolean;
    priors: EdgePriors;
    /** Initiator of the compensating rows; the bulk route's by default. */
    initiator?: string;
}): Promise<string[]> {
    const { store, entryId, workspace, edge, bidirectional, priors, initiator } = input;
    if (!store.removeIfPending) { await store.remove(entryId); return []; }
    if (await store.removeIfPending(entryId)) return [];
    const specs: HotWriteSpec[] = [];
    const keys: string[] = [];
    for (const t of triplesOf(edge, bidirectional)) {
        const key = edgeKey(t.sourceId, t.targetId, t.relation);
        const prior = priors.get(key);
        if (prior === undefined && specs.length > 0) continue; // unknown graph: forward delete only, as before
        specs.push(compensatingSpec(workspace, t, prior, initiator));
        keys.push(key);
    }
    await recordHotWriteBatch(store, specs);
    return keys;
}

/**
 * A chunk's `edge.upsert` rows are all recorded before its first write, so a
 * compensating row recorded for a failed item sorts AFTER the row of a later
 * item of the same chunk. When that later item then succeeds on a compensated
 * triple, replay would end on the compensation and undo an acknowledged write.
 * Record the written state again, behind the compensation, for each such
 * triple. `compensated` is the chunk's set of keys `retractBulkEdgeUpsert`
 * returned; a re-asserted key leaves it. Call under the chunk's edge locks.
 */
export async function reassertBulkEdgeUpsert(input: {
    store: OutboxStore;
    workspace: string;
    edge: LoreEdge;
    bidirectional: boolean;
    compensated: Set<string>;
}): Promise<void> {
    const { store, workspace, edge, bidirectional, compensated } = input;
    if (compensated.size === 0) return;
    const hit = triplesOf(edge, bidirectional).filter((t) => compensated.has(edgeKey(t.sourceId, t.targetId, t.relation)));
    if (hit.length === 0) return;
    await recordHotWriteBatch(store, hit.map((t) => ({
        workspace, operationKind: 'edge.upsert' as const, initiator: INITIATOR, operation: 'graph.addEdge',
        payload: { ...t, confidence: edge.confidence ?? 'extracted', confidenceScore: edge.confidenceScore ?? 1.0, bidirectional: false },
    })));
    for (const t of hit) compensated.delete(edgeKey(t.sourceId, t.targetId, t.relation));
}
