/**
 * preconditionedWrite.ts - 3.35.0 (S1): one node write whose `preconditions` are enforced ACROSS DAEMONS by
 * routing it through the atomic `commitNodeBatch` primitive (engines/graphShared/nodeBatch.ts), with the
 * D10 contention retry (engines/graphShared/nodeBatchRetry.ts).
 *
 * Used by the three write paths that carry preconditions - the embedded/HTTP `nodeUpsert`
 * (core/nodeService.ts), the bulk chunk writer (mcp/http/routes/bulkWriteConditional.ts) and the bulk
 * per-item writer (mcp/http/routes/bulkWrite.ts) - only when the graph has the primitive
 * (`hasNodeBatchSupport`: ArcadeDB, SQLite). Every other graph keeps its in-process, single-daemon path.
 *
 * Division of labour (the contract the callers rely on):
 *   - The caller holds the in-process node locks and has already judged the conditions once (a fast,
 *     read-only judge that also names the failure). THIS function re-judges on EVERY attempt, against the
 *     graph as it is now, because between attempts another daemon may have moved a precondition node.
 *   - The caller owns the stamp: `expected` (the revision it read) and `updatedAt`, and the outbox row
 *     recorded `pending_commit` from them BEFORE this call. This function never touches the outbox. A
 *     result of "committed" returns the node (the caller then flips its row ready); any thrown error means
 *     the batch did NOT commit, except {@link OutcomeUnknownError}, which means "may have committed" (the
 *     caller must leave its pending row for the sweep).
 *   - Thrown errors (all existing vocabulary, so callers need no new branches except contention):
 *       RevisionConflictError   the node moved off `expected` (caller re-reads, re-stamps, retries)
 *       ItemConditionError      a precondition did not hold (payload = the `precondition_failed` body)
 *       NodeAlreadyExistsError  `insert`: the id is taken
 *       NodeBatchContentionError  every retry lost to concurrent writers (retryable 503)
 *       OutcomeUnknownError     the commit's outcome could not be established
 *       SupersedeRefusedError   (q) a `supersedes` target is held by another successor or is gone: nothing written
 *
 * 3.35.0 (q): with a {@link SupersedeIntent} the write also carries its `supersedes` - the mark on each target
 * and the `supersedes` edges - in the SAME atomic commit (core/atomicSupersede.ts). A write with an intent and no
 * preconditions goes through the primitive too ({@link shouldBatchWrite}).
 */
import type { LoreNode } from '../providers/types.js';
import {
    hasNodeBatchSupport,
    type NodeBatchCapable, type NodeBatchNodeInput, type NodeBatchWrite,
} from '../engines/graphShared/nodeBatch.js';
import { commitNodeBatchWithRetry } from '../engines/graphShared/nodeBatchRetry.js';
import { NodeAlreadyExistsError } from '../engines/graphShared/conditionalInsert.js';
import { RevisionConflictError, revisionOf } from '../engines/graphShared/revision.js';
import { ItemConditionError, findFailedPreconditions, preconditionFailedMessage, type Precondition } from './conditionalChecks.js';
import {
    WRITE_TIME_SUPERSEDE_REASON, SupersedeRefusedError, planSupersedeLinks, withSupersedeEdges, type SupersedeIntent, type SupersedeEdgeRows,
} from './atomicSupersede.js';

type ReadableBatchGraph = NodeBatchCapable & { getNode(id: string): Promise<LoreNode | null> };

/** True when this write should go through the primitive: it has preconditions and the graph can commit a batch. */
export const shouldBatchPreconditions = (graph: unknown, preconditions: readonly Precondition[] | undefined): graph is ReadableBatchGraph =>
    !!preconditions && preconditions.length > 0 && hasNodeBatchSupport(graph) && typeof (graph as { getNode?: unknown }).getNode === 'function';

/** (q) True when the write must go through the primitive: preconditions, or an atomic supersede, on a capable graph. */
export const shouldBatchWrite = (graph: unknown, preconditions: readonly Precondition[] | undefined, intent: SupersedeIntent | undefined): graph is ReadableBatchGraph =>
    (!!intent || (!!preconditions && preconditions.length > 0)) && hasNodeBatchSupport(graph) && typeof (graph as { getNode?: unknown }).getNode === 'function';

export type PreconditionedWrite =
    /** Land `expected + 1`; `mustExist` = ifRevision (never create). */
    | { kind: 'cas'; expected: number; updatedAt: string; mustExist: boolean }
    /** ifAbsent: create only. */
    | { kind: 'insert'; updatedAt?: string };

export async function writePreconditioned(
    graph: ReadableBatchGraph, node: NodeBatchNodeInput, preconditions: readonly Precondition[], how: PreconditionedWrite,
    intent?: SupersedeIntent,
): Promise<LoreNode> {
    return intent
        ? withSupersedeEdges(intent, (rows) => commitPreconditioned(graph, node, preconditions, how, intent, rows))
        : commitPreconditioned(graph, node, preconditions, how);
}

async function commitPreconditioned(
    graph: ReadableBatchGraph, node: NodeBatchNodeInput, preconditions: readonly Precondition[], how: PreconditionedWrite,
    intent?: SupersedeIntent, rows?: SupersedeEdgeRows,
): Promise<LoreNode> {
    const id = node.id;
    const updatedAt = how.updatedAt ?? new Date().toISOString();
    let repaired: string[] = [];
    let marks = 0;
    const result = await commitNodeBatchWithRetry(graph, async () => {
        // Re-read and re-judge on every attempt (D10): the primitive is the atomic authority, this keeps a
        // retry from re-submitting a plan that the data has already outgrown.
        const row = await graph.getNode(id);
        if (how.kind === 'insert') {
            if (row) throw new NodeAlreadyExistsError(id);
        } else {
            const actual = revisionOf(row);
            if ((!row && how.mustExist) || actual !== how.expected) throw new RevisionConflictError(id, how.expected, actual);
        }
        const failed = await findFailedPreconditions(graph, preconditions);
        if (failed.length > 0) throw new ItemConditionError({ error: preconditionFailedMessage(failed), failedPreconditions: failed });
        const write: NodeBatchWrite = how.kind === 'insert'
            ? { kind: 'insert', node, updatedAt }
            : { kind: 'cas', node, expectedRevision: how.expected, mustExist: how.mustExist, updatedAt };
        const checks = preconditions.map((p) => ({ id: p.id, revision: p.revision }));
        if (!intent) return { checks, writes: [write] };
        // (q) Judged afresh each attempt from what is stored: a half-done supersede writes only its missing half.
        const plan = await planSupersedeLinks(graph, intent);
        repaired = plan.repaired;
        marks = plan.links.filter((l) => l.mark).length;
        await rows!.record(plan.links);
        return { checks, writes: [write], supersedes: { successorId: id, reason: WRITE_TIME_SUPERSEDE_REASON, supersededAt: updatedAt, links: plan.links } };
    });
    if (!result.ok && result.code === 'supersede') {
        // A mark's claim guard failed between our read and the commit: name the real reason from the graph as it is now.
        const again = await planSupersedeLinks(graph, intent!);
        throw new SupersedeRefusedError('supersedes_apply_failed', `supersedes target '${result.id}' changed while the write was committing (${again.links.length} target(s) re-judged); retry`);
    }
    if (!result.ok) {
        if (result.code === 'exists') throw new NodeAlreadyExistsError(id);
        if (result.code === 'revision') throw new RevisionConflictError(id, how.kind === 'cas' ? how.expected : 0, result.actual ?? 0);
        // A precondition failed between our read and the commit: name every entry that fails now.
        const failed = await findFailedPreconditions(graph, preconditions);
        const fallback = preconditions.find((p) => p.id === result.id);
        const list = failed.length > 0 ? failed : fallback ? [{ id: fallback.id, expected: fallback.revision, found: result.actual ?? null }] : [];
        throw new ItemConditionError({ error: preconditionFailedMessage(list), failedPreconditions: list });
    }
    if (intent) { intent.applied = true; intent.repaired = repaired; intent.marks = marks; }
    const landed = result.revisions[id]!;
    const stored = await graph.getNode(id).catch(() => null);
    return stored
        ? { ...stored, revision: landed }
        : { ...(node as LoreNode), tags: node.tags, createdAt: updatedAt, updatedAt, syncedAt: null, revision: landed };
}
