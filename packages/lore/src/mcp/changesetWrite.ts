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
import type { NodeWriteGraph } from '../core/nodeService.js';
import type { OutboxStore } from '../outbox/types.js';
import type { VerbatimStore } from '../engines/verbatimStore.js';

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
}
