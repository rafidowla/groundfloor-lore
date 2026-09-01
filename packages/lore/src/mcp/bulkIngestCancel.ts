/**
 * Cooperative cancel helpers for bulkIngest (WP3a).
 * Hard-delete ids created in this call; restore pre-existing nodes.
 */

import { nodeUpsert as nodeServiceUpsert } from '../core/nodeService.js';
import type { LoreGraph, LoreVectorStore } from './services.js';
import type { LoreNode } from '../providers/types.js';
import { withTransactionConflictRetry } from '../engines/transactionConflictRetry.js';
import type { BulkIngestDeps, BulkIngestNodeArgs, BulkIngestResult } from './bulkIngest.js';

export const BULK_INGEST_CANCELLED = 'cancelled';
export const ABORT_EMBED_CHUNK_SIZE = 32;

export function markCancelled(
    resultSlots: BulkIngestResult['results'],
    idx: number,
    id: string,
): void {
    resultSlots[idx] = { ok: false, id, error: BULK_INGEST_CANCELLED };
}

export async function rollbackCancelledNode(args: {
    node: BulkIngestNodeArgs;
    previousState: LoreNode | null | undefined;
    graph: LoreGraph | null;
    deps: BulkIngestDeps;
}): Promise<void> {
    const { node, previousState, graph, deps } = args;
    if (!graph) return;
    try {
        if (previousState) {
            await withTransactionConflictRetry(() => nodeServiceUpsert(
                {
                    id: node.id,
                    workspace: node.workspace,
                    ecosystem: node.ecosystem,
                    nodeData: previousState as unknown as Record<string, unknown>,
                    skipEmbed: true,
                    targetGraph: graph,
                    initiator: 'lib:bulkIngest:cancel-restore',
                    isActiveWorkspace: false,
                },
                {
                    outboxStore: deps.outboxStore,
                    embedQueue: undefined,
                    verbatim: deps.storageClient,
                    getWal: deps.getWal,
                    versionStore: deps.versionStore,
                    previousState,
                    versionPrincipal: 'lib',
                },
            ));
            return;
        }
        await graph.deleteNode(node.id);
        const store = deps.workspaceVerbatimResolver
            ? await deps.workspaceVerbatimResolver.getOrOpen(node.workspace)
            : deps.verbatimStore;
        const tomb = store as LoreVectorStore & { tombstone?: (id: string, reason: string) => Promise<void> };
        if (typeof tomb.tombstone === 'function') {
            await tomb.tombstone(`lore:${node.id}`, 'bulk ingest cancelled');
        }
    } catch {
        // Rollback is best-effort; the result slot is already cancelled.
    }
}
