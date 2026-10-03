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
 * 3.27.0 — `purge: true` (embedded `nodeDelete` only): step 3 physically
 * deletes the node's verbatim rows (canonical, `#rev` history, alias rows and
 * theirs) instead of tombstoning, records ONE `verbatim.purge` outbox row
 * (before the physical delete, so a crash replays it), and embeds nothing.
 * Alias rows are only recorded/purged for aliases that exist or have a queued
 * `verbatim.upsert` (see existingAliasRowIds), not unconditionally for all
 * MAX_QUESTIONS slots.
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
import { aliasRowId, MAX_QUESTIONS } from './questionAliases.js';
import { purgeVerbatimRows, type PurgeCapableStore } from './verbatimPurge.js';

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
    /** 3.27.0 — physically delete the node's verbatim rows (history and alias
     *  rows included) instead of tombstoning them. Default false. */
    purge?: boolean;
}

export interface NodeDeleteOutcome {
    /** False when no node with that id existed. */
    deleted: boolean;
    /** Set when the graph node was deleted but its verbatim tombstone failed. */
    verbatimWarning?: string;
    /** 3.27.0 — true when `purge` was requested and the verbatim rows were
     *  physically removed. Absent on the default (tombstone) path, and when a
     *  store without any hard-delete primitive forced a tombstone fallback. */
    purged?: true;
}

/**
 * 3.27.0 — which of each node's alias row ids (`lore:<id>#q0..#q<MAX-1>`) need
 * a tombstone/purge: those present in the workspace's verbatim store, plus those
 * with a queued `verbatim.upsert` (the inline write failed or is not applied
 * yet — skipping it would let replay recreate the alias).
 *
 * BATCHED (nodeDeleteMany): one `getExistingIds` call (fallback: per-row
 * `getById`) and one `queuedVerbatimUpsertIds` call cover every id. A node maps
 * to null when existence cannot be determined (store has neither lookup, outbox
 * has no `queuedVerbatimUpsertIds`, or a lookup throws): the caller then keeps
 * the previous unconditional behaviour for all slots of that node.
 */
export async function existingAliasRowIdsMany(
    ids: readonly string[], workspace: string, store: unknown, outboxStore: OutboxStore | undefined,
): Promise<Map<string, string[] | null>> {
    const out = new Map<string, string[] | null>();
    const rowIdsOf = (id: string) => Array.from({ length: MAX_QUESTIONS }, (_, i) => aliasRowId(id, i));
    const s = store as { getById?: (rowId: string) => Promise<unknown>; getExistingIds?: (rowIds: string[]) => Promise<string[]> };
    const undeterminable = (): Map<string, string[] | null> => { for (const id of ids) out.set(id, null); return out; };
    if (typeof s.getExistingIds !== 'function' && typeof s.getById !== 'function') return undeterminable();
    if (outboxStore && typeof outboxStore.queuedVerbatimUpsertIds !== 'function') return undeterminable();
    const found = new Set<string>();
    const failed = new Set<string>();
    const allRowIds = ids.flatMap(rowIdsOf);
    try {
        if (typeof s.getExistingIds === 'function') {
            for (const r of await s.getExistingIds.call(store, allRowIds)) found.add(r);
        } else {
            for (const id of ids) {
                try {
                    for (const rowId of rowIdsOf(id)) if (await s.getById!.call(store, rowId)) found.add(rowId);
                } catch { failed.add(id); }
            }
        }
        if (outboxStore) for (const q of await outboxStore.queuedVerbatimUpsertIds!(workspace, allRowIds)) found.add(q);
    } catch {
        return undeterminable();
    }
    for (const id of ids) out.set(id, failed.has(id) ? null : rowIdsOf(id).filter((r) => found.has(r)));
    return out;
}

async function existingAliasRowIds(
    id: string, workspace: string, store: unknown, outboxStore: OutboxStore | undefined,
): Promise<string[] | null> {
    return (await existingAliasRowIdsMany([id], workspace, store, outboxStore)).get(id) ?? null;
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
        let purged: true | undefined;
        try {
            // 3.27.0 — null (undeterminable) = every slot, as before.
            const aliasIds = await existingAliasRowIds(id, workspace, store, outboxStore);
            if (input.purge) {
                const ids = [`lore:${id}`, ...(aliasIds ?? Array.from({ length: MAX_QUESTIONS }, (_, i) => aliasRowId(id, i)))];
                // Record BEFORE the physical delete: a crash in between leaves a
                // pending purge that replay completes, and a stale pending
                // verbatim.upsert (older sequence) cannot outlive it.
                if (outboxStore) {
                    await recordHotWrite(outboxStore, {
                        workspace,
                        operationKind: 'verbatim.purge',
                        payload: { id: `lore:${id}`, ids },
                        initiator,
                        operation: 'verbatim.purge',
                    });
                }
                const mode = await purgeVerbatimRows(store as PurgeCapableStore, ids, input.reason);
                if (mode === 'none') {
                    for (const vid of ids) await input.verbatimDelete(vid);
                }
                if (mode === 'tombstone') {
                    verbatimWarning = 'verbatim purge unsupported by this store; rows were tombstoned instead';
                } else if (mode === 'none') {
                    // verbatimDelete may itself tombstone (cloud), so a purge is not claimed.
                    verbatimWarning = 'verbatim purge unsupported by this store; rows went through the legacy delete instead';
                } else {
                    purged = true;
                }
            } else {
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
                    // 3.21 step 3(e) — the node's question aliases too (best-effort);
                    // 3.27.0 — only those that exist (or are queued) when known.
                    await tombstoneQuestionAliases({
                        id, workspace, initiator, logPrefix, outboxStore,
                        ...(aliasIds ? { onlyRowIds: aliasIds } : {}),
                    });
                }
            }
        } catch (tombErr) {
            const what = input.purge ? 'purge' : 'tombstone';
            verbatimWarning = `verbatim ${what} failed: ${redactError(tombErr)}`;
            console.error(`${logPrefix} Verbatim ${what} failed for ${redactId(id)}: ${redactError(tombErr)}`);
        }
        // ITEM X-walnode — mirror the upsert's WAL append (active workspace
        // only), inside the same lock the delete + tombstone ran under.
        if (input.isActive) input.getWal().append('delete_node', { id, workspace });
        return { deleted, verbatimWarning, ...(purged ? { purged } : {}) };
    });
}
