/**
 * safeEphemeralPrune.ts — shared safe-delete discipline for expired
 * ephemeral scratchpad nodes.
 *
 * ITEM X-pruneeph (2026-09-03) gave `POST /api/prune-ephemeral`
 * (mcp/http/routes/retention/policy.ts) and the `prune_ephemeral` MCP tool
 * (mcp/tools/governance.ts) the same discipline `prune_nodes` hard_delete
 * already had: per-id `nodeWriteLock`, a re-check that the node is STILL
 * ephemeral and STILL expired inside the lock (a concurrent upsert may have
 * renewed its TTL), an outbox `node.delete` row recorded BEFORE the
 * substrate delete, and a verbatim tombstone + outbox `verbatim.tombstone`
 * row AFTER. That fix landed the loop twice — once in each route/tool —
 * leaving a third caller, the daemon's boot-time prune (mcp/server.ts),
 * still calling `graph.pruneEphemeralNodes()` directly: no lock, no outbox
 * rows, no verbatim tombstone (see `SurrealGraph.pruneEphemeralNodes`,
 * engines/surrealGraph.ts).
 *
 * This module extracts the loop ONE more level so all three callers share
 * it instead of maintaining three copies. Verbatim resolution differs
 * slightly per caller (workspace-scoped resolver vs. the boot verbatim
 * store, plus a couple of legacy fallback shapes) so that step stays a
 * caller-supplied `tombstoneVerbatim` callback rather than being folded in
 * here.
 */

import { withNodeLock } from '../core/nodeWriteLock.js';
import { withTransactionConflictRetry } from './transactionConflictRetry.js';
import { recordHotWrite } from '../outbox/hotLane.js';
import type { OutboxStore } from '../outbox/types.js';
import type { LoreNode } from '../providers/types.js';

/** Structural subset of `LoreGraphHandle` this loop needs. `deleteNode` and
 *  `getNode` are part of the base `GraphProvider` contract every graph
 *  implements; `listExpiredEphemeralNodeIds` is SurrealGraph-only (duck-typed,
 *  same as the two pre-existing callers) and `pruneEphemeralNodes` is the
 *  pre-fix fallback for engines that don't expose the safe query method
 *  (DataplaneGraph, ArcadeGraphStore) — out of scope for this item, same as
 *  it was for the route/tool fix. */
export interface SafeEphemeralPruneGraph {
    listExpiredEphemeralNodeIds?(defaultTtlMs: number): Promise<string[]>;
    pruneEphemeralNodes(defaultTtlMs: number): Promise<number>;
    getNode(id: string): Promise<LoreNode | null>;
    deleteNode(id: string): Promise<boolean>;
}

export interface SafeEphemeralPruneOptions {
    graph: SafeEphemeralPruneGraph;
    /** Workspace the pruned nodes belong to — used for the node lock key and
     *  every outbox row's `workspace` field. */
    workspace: string;
    /** TTL (ms) applied to nodes whose own `ttl_ms` is unset/zero. */
    ttl: number;
    /** Outbox store to record `node.delete` / `verbatim.tombstone` rows
     *  against. Omitted entirely (not just falsy) skips outbox recording —
     *  mirrors the pre-existing `if (deps.outboxStore)` guards. */
    outboxStore?: OutboxStore;
    /** `kind:id` label recorded on outbox rows and used to build the
     *  verbatim tombstone reason string (e.g. `boot:prune-ephemeral`,
     *  `http:prune-ephemeral`, `mcp:prune_ephemeral`). */
    initiator: string;
    /** Tombstones (or deletes) the verbatim row for `lore:<id>`. Caller
     *  supplies this because verbatim-store resolution and its legacy
     *  tombstone/delete fallback chain differ slightly between the boot
     *  path, the HTTP route and the MCP tool. Thrown errors are caught and
     *  logged via `onLog` — a tombstone failure must not prevent the graph
     *  delete already committed from counting as pruned, matching the
     *  pre-existing per-call-site behavior. */
    tombstoneVerbatim: (verbatimId: string, reason: string) => Promise<void>;
    /** Non-fatal failure logger. Defaults to a no-op. */
    onLog?: (message: string) => void;
}

/**
 * safePruneEphemeralNodes — delete expired ephemeral nodes through the same
 * lock/outbox/tombstone discipline `prune_nodes` hard_delete uses.
 *
 * Falls back to the graph's own (unsafe, pre-fix) `pruneEphemeralNodes` when
 * it doesn't expose `listExpiredEphemeralNodeIds` — same fallback the route
 * and tool already had, kept here so a caller doesn't need to duplicate it.
 */
export async function safePruneEphemeralNodes(opts: SafeEphemeralPruneOptions): Promise<number> {
    const { graph, workspace, ttl, outboxStore, initiator, tombstoneVerbatim } = opts;
    const onLog = opts.onLog ?? (() => undefined);

    if (typeof graph.listExpiredEphemeralNodeIds !== 'function') {
        return graph.pruneEphemeralNodes(ttl);
    }

    const expiredIds = await graph.listExpiredEphemeralNodeIds(ttl);
    let deleted = 0;
    for (const id of expiredIds) {
        try {
            const applied = await withNodeLock(workspace, id, async (): Promise<boolean> => {
                // Re-read the node FRESH inside the lock and re-verify it is
                // still ephemeral AND still past its TTL — a concurrent
                // upsert between the query above and this id's turn in the
                // loop may have refreshed createdAt (TTL renewal) or cleared
                // `ephemeral` entirely.
                const fresh = await graph.getNode(id);
                if (!fresh || !fresh.ephemeral) return false;
                const createdMs = new Date(fresh.createdAt).getTime();
                if (!Number.isFinite(createdMs)) return false;
                const nodeTtl = typeof fresh.ttl_ms === 'number' && fresh.ttl_ms > 0 ? fresh.ttl_ms : ttl;
                if (Date.now() - createdMs <= nodeTtl) return false;

                // Outbox-first — record node.delete BEFORE the substrate
                // delete, same pattern as delete_node / prune_nodes
                // hard_delete.
                if (outboxStore) {
                    await recordHotWrite(outboxStore, {
                        workspace,
                        operationKind: 'node.delete',
                        payload: { id },
                        initiator,
                        operation: 'node.delete',
                    });
                }
                await withTransactionConflictRetry(() => graph.deleteNode(id));

                // Tombstone the verbatim row so pruned content doesn't stay
                // semantically recallable. Non-fatal.
                try {
                    const reason = `ephemeral node pruned via ${initiator}`;
                    await tombstoneVerbatim(`lore:${id}`, reason);
                    // Record verbatim.tombstone AFTER the node.delete row
                    // above, so a stale pending verbatim.upsert from an
                    // earlier upsert on this id can't replay after this
                    // tombstone and resurrect the content.
                    if (outboxStore) {
                        await recordHotWrite(outboxStore, {
                            workspace,
                            operationKind: 'verbatim.tombstone',
                            payload: { id: `lore:${id}`, reason },
                            initiator,
                            operation: 'verbatim.tombstone',
                        });
                    }
                } catch (vErr) {
                    onLog(`prune-ephemeral verbatim tombstone failed for ${id}: ${(vErr as Error).message}`);
                }
                return true;
            });
            if (applied) deleted++;
        } catch (idErr) {
            onLog(`prune-ephemeral failed for node ${id} (non-fatal): ${(idErr as Error).message}`);
        }
    }
    return deleted;
}
