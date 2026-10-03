/**
 * nodeDeleteService.ts — the one hard-delete sequence for a knowledge node.
 *
 * Extracted in 3.26.0 from the MCP `delete_node` tool so the embedded
 * `LoreInstance.nodeDelete()` runs the identical steps instead of a host
 * reaching for `storageClient.rawGraph().deleteNode()`, which bypasses the
 * outbox: a still-pending `node.upsert` row then found no node on replay and
 * re-created it.
 *
 * Under the shared per-(workspace,id) write lock (core/nodeWriteLock.ts):
 *   1. record `node.delete` in the outbox (when one is wired),
 *   2. delete the graph node and its relationships,
 *   3. tombstone the canonical `lore:<id>` verbatim row (legacy delete when
 *      the store has no tombstone), record `verbatim.tombstone`, tombstone the
 *      node's question aliases,
 *   4. append `delete_node` to the sync WAL (active workspace only).
 *
 * Nothing inside the lock may re-enter it: every call is a RAW substrate
 * primitive (nodeWriteLock.ts rule 1).
 */

import { redactId, redactError } from '../security/logRedact.js';
import { recordHotWrite } from '../outbox/hotLane.js';
import type { OutboxEntry, OutboxStore } from '../outbox/types.js';
import type { WriteAheadLog } from '../engines/writeAheadLog.js';
import { withNodeLock } from './nodeWriteLock.js';
import { tombstoneQuestionAliases } from './nodeServiceVerbatim.js';

export interface NodeDeleteInput {
    id: string;
    /** The RESOLVED workspace name (lock key, outbox rows, WAL entry). */
    workspace: string;
    /** WAL append is gated on the active workspace, as for upserts. */
    isActive: boolean;
    /** The workspace's own graph handle (raw, not the replay guard). */
    graph: { deleteNode(id: string): Promise<boolean> };
    outboxStore?: OutboxStore;
    /** The workspace's verbatim store; resolved only when a node was deleted. */
    resolveVerbatim: () => Promise<unknown>;
    /** Fallback for stores without `tombstone` (cloud mode). */
    verbatimDelete: (verbatimId: string) => Promise<unknown>;
    getWal: () => Pick<WriteAheadLog, 'append'>;
    /** e.g. `mcp:delete_node`, `lib:nodeDelete`. */
    initiator: string;
    /** Stored on the verbatim tombstone. */
    reason: string;
    logPrefix: string;
    /** Called with the `node.delete` row once the graph delete has run inline
     *  (whether or not a node was there), still under the node lock. The
     *  embedded replay guard uses it to skip the row's redundant replay and to
     *  supersede older saves of the node (mcp/embeddedLifecycle.ts). */
    onInlineDeleteApplied?: (entry: OutboxEntry) => void;
}

export interface NodeDeleteOutcome {
    /** False when no node with that id existed. */
    deleted: boolean;
    /** Set when the graph node was deleted but its verbatim tombstone failed. */
    verbatimWarning?: string;
}

export async function deleteNodeEverywhere(input: NodeDeleteInput): Promise<NodeDeleteOutcome> {
    const { id, workspace, initiator, logPrefix, outboxStore } = input;
    return withNodeLock(workspace, id, async (): Promise<NodeDeleteOutcome> => {
        // SP-F3 — outbox-first: record node.delete BEFORE the substrate delete
        // so the delete gets the same durability + crash-recovery replay +
        // per-workspace replication as REST DELETE /api/node.
        const entry = outboxStore
            ? await recordHotWrite(outboxStore, {
                workspace,
                operationKind: 'node.delete',
                payload: { id },
                initiator,
                operation: 'node.delete',
            })
            : null;
        const deleted = await input.graph.deleteNode(id);
        if (entry) input.onInlineDeleteApplied?.(entry);
        if (!deleted) return { deleted };
        // Verbatim is append-only memory: tombstone (kept + marked superseded)
        // rather than erase, so prior content stays recallable for history /
        // audit / undo. L-056 — the RESOLVED workspace's store, so the
        // tombstone lands where the graph delete did.
        const store = (await input.resolveVerbatim()) as { tombstone?: (id: string, reason: string) => Promise<void> };
        // 1.M10 — tombstone() THROWS on real failure; surface it as a warning
        // instead of fire-and-forget success.
        let verbatimWarning: string | undefined;
        try {
            if (typeof store.tombstone === 'function') {
                await store.tombstone(`lore:${id}`, input.reason);
            } else {
                await input.verbatimDelete(`lore:${id}`);
            }
            // QA A2 finding 2 — a verbatim.tombstone row AFTER the node.delete
            // row, so a stale pending `verbatim.upsert` for this id cannot
            // replay later and resurrect the content just tombstoned.
            if (outboxStore) {
                await recordHotWrite(outboxStore, {
                    workspace,
                    operationKind: 'verbatim.tombstone',
                    payload: { id: `lore:${id}`, reason: input.reason },
                    initiator,
                    operation: 'verbatim.tombstone',
                });
                // 3.21 step 3(e) — the node's question aliases too (best-effort).
                await tombstoneQuestionAliases({ id, workspace, initiator, logPrefix, outboxStore });
            }
        } catch (tombErr) {
            verbatimWarning = `verbatim tombstone failed: ${redactError(tombErr)}`;
            console.error(`${logPrefix} Verbatim tombstone failed for ${redactId(id)}: ${redactError(tombErr)}`);
        }
        // ITEM X-walnode — mirror the upsert's WAL append (active workspace
        // only), inside the same lock the delete + tombstone ran under.
        if (input.isActive) input.getWal().append('delete_node', { id, workspace });
        return { deleted, verbatimWarning };
    });
}
