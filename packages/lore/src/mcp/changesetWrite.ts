/**
 * changesetWrite.ts — 1.M7 (2026-08-17 audit) shared write helpers for
 * changeset commit/rollback.
 *
 * commit_changeset / rollback_changeset (MCP tools/versioning.ts and the
 * REST twin http/routes/versioning.ts) used to write STRAIGHT to the
 * graph: no verbatim row, no embed enqueue, no outbox row, no autolink.
 * Nodes stored inside a changeset never became searchable, and a rollback
 * left the reverted-away text live in the search index. These helpers
 * route changeset writes through the SAME orchestration the single-write
 * surfaces use (core/nodeService.nodeUpsert: outbox-first when wired,
 * inline verbatim otherwise, async embed queue) plus a verbatim tombstone
 * for deletes — so a changeset write is indistinguishable from a direct
 * store_node / POST /api/node write in every substrate.
 */

import { nodeUpsert as nodeServiceUpsert, type VerbatimWriter } from '../core/nodeService.js';
import { withNodeLock } from '../core/nodeWriteLock.js';
import type { NodeWriteGraph } from '../core/nodeService.js';
import type { OutboxStore } from '../outbox/types.js';
import { recordHotWrite } from '../outbox/hotLane.js';
import type { VerbatimStore } from '../engines/verbatimStore.js';
import type { WriteAheadLog } from '../engines/syncEngine.js';

export interface ChangesetWriteDeps {
    /** Outbox hot-lane store (durability + replication), as wired for the
     *  single-write surfaces. Absent → inline verbatim write. */
    outboxStore?: OutboxStore;
    /** Async embed queue. */
    embedQueue?: { enqueue: (nodeId: string, text: string, workspace?: string) => void };
    /** Inline verbatim writer (storage-client facade) for the no-outbox path. */
    verbatim: VerbatimWriter;
    /** Per-workspace verbatim resolver for delete tombstones (L-056).
     *  Structural (not the class) so the MCP/HTTP dep shapes both fit. */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<VerbatimStore> };
    /** Boot verbatim store — fallback when no resolver is wired (cloud/tests). */
    bootVerbatim: unknown;
    /** Boot/active workspace name — drives isActiveWorkspace gating. */
    activeWorkspace: string;
    /** Initiator string stamped on outbox/audit rows, e.g.
     *  'mcp:commit_changeset' / 'http:POST /api/changesets/:id/commit'. */
    initiator: string;
    /**
     * ITEM X-walnode (2026-09-03) — WAL handle. When wired, a changeset
     * delete appends a `delete_node` entry the same way `nodeUpsert`
     * (core/nodeService.ts) appends `upsert_node` — gated on the SAME
     * `isActiveWorkspace` condition applyChangesetUpsert already computes
     * (`workspace === activeWorkspace`). Optional so cloud mode / test
     * fixtures that don't wire a WAL keep prior behavior.
     */
    getWal?: () => WriteAheadLog;
}

/**
 * Apply a buffered changeset upsert through the shared write orchestration
 * (outbox node.upsert + verbatim.upsert / inline verbatim + embed), so the
 * node becomes searchable exactly like a direct write. Throws on failure —
 * callers count it in their per-write error tally.
 */
export async function applyChangesetUpsert(
    deps: ChangesetWriteDeps,
    targetGraph: NodeWriteGraph,
    workspace: string,
    nodeData: Record<string, unknown>,
): Promise<void> {
    const res = await nodeServiceUpsert(
        {
            id: String(nodeData['id'] ?? ''),
            workspace,
            ecosystem: typeof nodeData['ecosystem'] === 'string' ? nodeData['ecosystem'] : '*',
            nodeData,
            targetGraph,
            initiator: deps.initiator,
            isActiveWorkspace: workspace === deps.activeWorkspace,
        },
        {
            outboxStore: deps.outboxStore,
            embedQueue: deps.embedQueue,
            verbatim: deps.verbatim,
            // versionStore deliberately NOT passed: changeset commit/rollback
            // records its own version rows (principal 'changeset' +
            // changesetId) — passing it here would double-record.
        },
    );
    if (!res.ok) throw res.error;
}

/**
 * Apply a buffered changeset delete: graph delete + verbatim tombstone in
 * the SAME workspace (L-056 routing), so the deleted content leaves the
 * search index too. Throws on failure.
 */
export async function applyChangesetDelete(
    deps: ChangesetWriteDeps,
    targetGraph: NodeWriteGraph,
    workspace: string,
    nodeId: string,
    reason: string,
): Promise<void> {
    // Graph delete + verbatim tombstone under the SAME per-(workspace,id)
    // lock `nodeUpsert` holds (core/nodeWriteLock.ts) — unlocked, a
    // concurrent same-id write interleaved between the two and left the
    // substrates disagreeing. The upsert sibling above is NOT wrapped: it
    // delegates to `nodeUpsert`, which takes this very lock itself, and
    // wrapping it would deadlock the key (nodeWriteLock.ts rule 1).
    await withNodeLock(workspace, nodeId, async () => {
        // QA A2 round-2 finding 2 (2026-09-03) — record node.delete BEFORE
        // the substrate delete, same outbox-first pattern as delete_node /
        // DELETE /api/node / prune_nodes hard_delete. Without this, a still-
        // pending node.upsert from the changeset's own (or an earlier)
        // create on this id has nothing in the 'node' outbox family to
        // supersede it, and a crash-recovery replay resurrects the node in
        // the GRAPH after this changeset delete.
        if (deps.outboxStore) {
            await recordHotWrite(deps.outboxStore, {
                workspace,
                operationKind: 'node.delete',
                payload: { id: nodeId },
                initiator: deps.initiator,
                operation: 'node.delete',
            });
        }
        await targetGraph.deleteNode(nodeId);
        const store = deps.workspaceVerbatimResolver
            ? await deps.workspaceVerbatimResolver.getOrOpen(workspace)
            : deps.bootVerbatim;
        const s = store as {
            tombstone?: (id: string, reason: string) => Promise<void>;
            delete?: (id: string) => Promise<void>;
        };
        if (typeof s.tombstone === 'function') {
            await s.tombstone(`lore:${nodeId}`, reason);
        } else if (typeof s.delete === 'function') {
            await s.delete(`lore:${nodeId}`);
        }
        // QA A2 finding 2 (2026-09-03) — record a verbatim.tombstone outbox
        // row so a stale pending verbatim.upsert from the changeset's own
        // (or an earlier) create on this id can't later replay and
        // resurrect the content this call just tombstoned (outbox/types.ts).
        // Non-fatal: the synchronous tombstone above already ran.
        if (deps.outboxStore) {
            try {
                await recordHotWrite(deps.outboxStore, {
                    workspace,
                    operationKind: 'verbatim.tombstone',
                    payload: { id: `lore:${nodeId}`, reason },
                    initiator: deps.initiator,
                    operation: 'verbatim.tombstone',
                });
            } catch { /* non-fatal, mirrors the tombstone call above */ }
        }
        // ITEM X-walnode (2026-09-03) — append a `delete_node` WAL entry,
        // same gating as applyChangesetUpsert's `isActiveWorkspace` above,
        // still inside the SAME lock the graph delete + tombstone ran under.
        if (deps.getWal && workspace === deps.activeWorkspace) {
            deps.getWal().append('delete_node', { id: nodeId, workspace });
        }
    });
}
