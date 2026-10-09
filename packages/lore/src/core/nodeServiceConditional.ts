/**
 * nodeServiceConditional.ts — the conditional-write pieces of the shared node
 * write core (conditional writes, phase 1), kept out of nodeService.ts (800-line
 * cap).
 *
 *   - {@link guardNodeWrite}: runs UNDER the node locks, before the write's
 *     first side effect. Re-checks the `supersedes` targets (another writer may
 *     have claimed one since step 0d ran outside the lock) and enforces the
 *     `ifAbsent` directive against the node as it is now.
 *   - {@link retractNodeUpsertRow}: takes back a `node.upsert` outbox row whose
 *     graph write was refused (the unique index said the id was taken), so a
 *     replay cannot write a node the caller was told was not created.
 */
import type { LoreNode } from '../providers/types.js';
import type { OutboxStore } from '../outbox/types.js';
import { recordHotWrite } from '../outbox/hotLane.js';
import { NodeAlreadyExistsError } from '../engines/graphShared/conditionalInsert.js';
import { restorePayload, withLandedRevision } from './nodeServiceVerbatim.js';
import type { PriorNode } from './nodeServiceVerbatim.js';
import { validateSupersedesIds } from './supersessionPolicy.js';
import { MAX_REVISION_ATTEMPTS, hasRevisionSupport, isRevisionConflict, revisionOf } from '../engines/graphShared/revision.js';
import type { NodeWriteGraph } from './nodeServiceTypes.js';
import { REVISION_UNSUPPORTED, checkItemConditions, type FailedPrecondition, type ItemConditions } from './conditionalChecks.js';

export type NodeGuardFailure =
    | { ok: false; code: 'already_exists' | 'already_superseded' | 'supersedes_apply_failed' | 'write_failed'; error: Error }
    // Phase 2b — `ifRevision` / `preconditions` did not hold (or the engine keeps no revision).
    | { ok: false; code: 'revision_mismatch' | 'precondition_failed' | 'revision_unsupported'; error: Error; currentRevision?: number | null; failedPreconditions?: FailedPrecondition[] };

/**
 * In-lock guard. `priorNode` is the node as read under the lock. Returns null
 * when the write may proceed. `isVisible` is the bound-actor row-scope hook.
 */
export async function guardNodeWrite(input: {
    id: string;
    supersedes: string[] | undefined;
    ifAbsent: boolean | undefined;
    priorNode: PriorNode;
    targetGraph: { getNode?(id: string): Promise<LoreNode | null> };
    isVisible?: (id: string) => Promise<boolean>;
    /** Phase 2b — `ifRevision` / `preconditions`, judged against the node as it is now (under the locks). */
    conditions?: ItemConditions;
}): Promise<NodeGuardFailure | null> {
    const { id, supersedes, ifAbsent, priorNode, targetGraph, isVisible, conditions } = input;
    if (conditions && (conditions.ifRevision !== undefined || conditions.preconditions)) {
        if (!hasRevisionSupport(targetGraph) || typeof targetGraph.getNode !== 'function' || priorNode === undefined) {
            return { ok: false, code: 'revision_unsupported', error: new Error(REVISION_UNSUPPORTED) };
        }
        const failed = await checkItemConditions(targetGraph, id, conditions);
        if (failed) {
            return failed.failedPreconditions
                ? { ok: false, code: 'precondition_failed', error: new Error(failed.error), failedPreconditions: failed.failedPreconditions }
                : { ok: false, code: 'revision_mismatch', error: new Error(failed.error), currentRevision: failed.currentRevision ?? null };
        }
    }
    if (ifAbsent === true && priorNode) {
        return { ok: false, code: 'already_exists', error: new NodeAlreadyExistsError(id) };
    }
    if (supersedes && supersedes.length > 0) {
        const verdict = await validateSupersedesIds({ id, supersedes, targetGraph, isVisible });
        if (!verdict.ok && (verdict.code === 'already_superseded' || verdict.code === 'supersedes_apply_failed')) {
            return { ok: false, code: verdict.code, error: verdict.error };
        }
    }
    return null;
}

/**
 * Retract the `node.upsert` row of a write that was refused. Still pending: it
 * is removed. Already claimed by the replicator: a compensating row describing
 * what the graph holds now (the winner's node, or a delete when it is gone). The
 * compensating upsert carries the revision and `updatedAt` it read, so its replay
 * is revision-gated (skipped while the stored revision is >= it) instead of a
 * legacy replay that would bump again.
 * Throws when the row could be neither removed nor compensated.
 */
export async function retractNodeUpsertRow(input: {
    store: OutboxStore;
    entryId: string;
    workspace: string;
    graph: { getNode?(id: string): Promise<LoreNode | null> };
    id: string;
    written: Record<string, unknown>;
    initiator: string;
    /** The revision the claimed row carries (its predicted `expected + 1`), when it has one. */
    claimedRevision?: number;
}): Promise<void> {
    const { store, entryId, workspace, graph, id, written, initiator, claimedRevision } = input;
    if (!store.removeIfPending) { await store.remove(entryId); return; }
    if (await store.removeIfPending(entryId)) return;
    const current = typeof graph.getNode === 'function' ? await graph.getNode(id) : null;
    // The claimed row still lands when the graph is below its revision (the refused write never moved the
    // node): the compensating row must then sort AFTER it, or its replay is skipped and the failed content wins.
    const stale = current !== null && claimedRevision !== undefined && revisionOf(current) < claimedRevision;
    await recordHotWrite(store, current
        ? { workspace, operationKind: 'node.upsert', initiator, operation: 'graph.upsert',
            payload: stale
                ? { ...restorePayload(current, written), revision: claimedRevision + 1, updatedAt: new Date().toISOString() }
                : withLandedRevision(restorePayload(current, written), current) }
        : { workspace, operationKind: 'node.delete', payload: { id }, initiator, operation: 'graph.delete' });
}

/**
 * Conditional writes phase 2a — the recorded-then-written node upsert for a
 * graph that keeps a per-node `revision`. Runs UNDER the node locks.
 *
 * The outbox row is recorded BEFORE the graph write, so the revision the write
 * will land is not yet known. It is predicted: `r` = the revision read under
 * the lock, payload `revision: r + 1`, `updatedAt` = one stamp taken here.
 * The graph write is then conditional (`WHERE ifnull(revision, 0) = r`). Inside
 * one process the lock makes the prediction exact; across daemons on one
 * database a loser gets {@link RevisionConflictError}, takes its row back,
 * re-reads, re-records with the new prediction and retries (bounded). On
 * return the payload revision equals the stored revision unless a later bump
 * by the same request (write-time `supersedes`) moved it — replay then skips
 * the row, because stored >= payload.
 *
 * `record` makes the outbox row (null when no outbox is wired); `write` is the
 * conditional graph write (the caller wraps it in its version-intent scope).
 * `onEntry` reports the live outbox row id so the caller's failure paths can
 * retract the right one. Exhausted retries re-throw the conflict after taking
 * the row back.
 */
export async function writeNodeAtRevision(input: {
    graph: NodeWriteGraph;
    id: string;
    nodeData: Record<string, unknown>;
    priorNode: PriorNode;
    store: OutboxStore | undefined;
    workspace: string;
    initiator: string;
    write: (expectedRevision: number, updatedAt: string) => Promise<LoreNode>;
    onEntry: (entryId: string | null) => void;
    /** Phase 2b — `ifRevision`: a conflict is the caller's answer, not something to retry. */
    noRetry?: boolean;
}): Promise<{ node: LoreNode; priorNode: PriorNode }> {
    const { graph, id, nodeData, store, workspace, initiator } = input;
    let priorNode = input.priorNode;
    const updatedAt = new Date().toISOString();
    for (let attempt = 1; ; attempt++) {
        const expected = revisionOf(priorNode);
        let entryId: string | null = null;
        if (store) {
            const entry = await recordHotWrite(store, {
                workspace, operationKind: 'node.upsert', initiator, operation: 'graph.upsert',
                payload: { ...nodeData, updatedAt, revision: expected + 1 },
            });
            entryId = entry.id;
        }
        input.onEntry(entryId);
        try {
            return { node: await input.write(expected, updatedAt), priorNode };
        } catch (err) {
            if (!isRevisionConflict(err)) throw err;
            // Another daemon moved the node: take our row back whatever happens next.
            if (store && entryId) {
                await retractNodeUpsertRow({ store, entryId, workspace, graph, id, written: nodeData, initiator });
                input.onEntry(null);
            }
            if (input.noRetry || attempt >= MAX_REVISION_ATTEMPTS) throw err;
            priorNode = await graph.getNode!(id);
        }
    }
}

/** True when the node write can run through {@link writeNodeAtRevision}: a revision-aware graph that can read the node back. */
export const canWriteAtRevision = (graph: NodeWriteGraph, priorNode: PriorNode): boolean =>
    hasRevisionSupport(graph) && typeof graph.getNode === 'function' && priorNode !== undefined;
