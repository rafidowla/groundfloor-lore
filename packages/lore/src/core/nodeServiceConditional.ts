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
import { restorePayload } from './nodeServiceVerbatim.js';
import type { PriorNode } from './nodeServiceVerbatim.js';
import { validateSupersedesIds } from './supersessionPolicy.js';

export type NodeGuardFailure =
    | { ok: false; code: 'already_exists' | 'already_superseded' | 'supersedes_apply_failed'; error: Error };

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
}): Promise<NodeGuardFailure | null> {
    const { id, supersedes, ifAbsent, priorNode, targetGraph, isVisible } = input;
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
 * what the graph holds now (the winner's node, or a delete when it is gone).
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
}): Promise<void> {
    const { store, entryId, workspace, graph, id, written, initiator } = input;
    if (!store.removeIfPending) { await store.remove(entryId); return; }
    if (await store.removeIfPending(entryId)) return;
    const current = typeof graph.getNode === 'function' ? await graph.getNode(id) : null;
    await recordHotWrite(store, current
        ? { workspace, operationKind: 'node.upsert', payload: restorePayload(current, written), initiator, operation: 'graph.upsert' }
        : { workspace, operationKind: 'node.delete', payload: { id }, initiator, operation: 'graph.delete' });
}
