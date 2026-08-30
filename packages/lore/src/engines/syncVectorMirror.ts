/**
 * packages/lore/src/engines/syncVectorMirror.ts
 *
 * Extracted from syncEngine.ts to keep that file under the 800-line cap.
 *
 * Handles mirroring a pulled/synced node into the vector store so
 * semantic recall surfaces cloud-synced knowledge locally.
 *
 * Failure contract: errors are logged but never re-throw — the Kùzu
 * graph row is the source of truth. A missed embedding is backfilled
 * on next sync or by a manual re-store. We do NOT roll back the graph
 * write because pull is idempotent.
 *
 * Recovery entry point: `recoverVectorMirrors(vectorStore, localGraph, ids)`
 *   is called by `recoverOutbox` at boot for any 'sync.vector.mirror'
 *   step that didn't complete on the last run.
 */

import type { VerbatimStore } from './verbatimStore.js';
import { buildVerbatimText } from './verbatimSchema.js';
import { tagsToString } from './normalizeTags.js';
import type { DataplaneVectorStore } from './dataplaneVectorStore.js';
import type { LoreNode } from '../providers/types.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';

export type LoreVectorStore = VerbatimStore | DataplaneVectorStore;

/**
 * Result of a single vector-mirror attempt. NW-7b: previously this
 * helper threw nothing and returned void, so callers couldn't tell a
 * silent failure from a no-op. The outbox step was therefore marked
 * 'done' even when every mirror in the chunk failed (the
 * err-vector-mirror-outbox-step-marked-done-on-failure finding).
 * Returning a structured result lets the caller mark the step
 * 'done' / 'failed' based on actual per-node outcomes.
 */
export interface VectorMirrorResult {
    ok: boolean;
    error?: string;
}

/**
 * upsertVectorMirror — Mirror one node into the vector store.
 * No-op when vectorStore is null (unit tests or cloud-mode no-op).
 *
 * NW-7b: never throws. Returns `{ ok: true }` on success or when
 * vectorStore is null (treated as a no-op success, not a failure);
 * returns `{ ok: false, error }` when the underlying store throws.
 * The error is logged here too so a chunk-level summary log retains
 * the per-node detail.
 */
export async function upsertVectorMirror(
    vectorStore: LoreVectorStore | null,
    remoteNode: LoreNode,
): Promise<VectorMirrorResult> {
    if (!vectorStore) return { ok: true };
    try {
        await vectorStore.store({
            id: `lore:${remoteNode.id}`,
            text: buildVerbatimText(
                remoteNode.label ?? '',
                remoteNode.content ?? '',
                remoteNode.tags ?? '',
            ),
            metadata: {
                type: remoteNode.type,
                label: remoteNode.label,
                tags: tagsToString(remoteNode.tags),
                project: remoteNode.project ?? '',
                ecosystem: remoteNode.ecosystem ?? '',
                updatedAt: remoteNode.updatedAt,
            },
        });
        return { ok: true };
    } catch (err) {
        const msg = (err as Error).message;
        console.error(
            `[SyncEngine] vector mirror failed for node ${remoteNode.id}: ${msg}`,
        );
        return { ok: false, error: msg };
    }
}

/**
 * recoverVectorMirrors — Boot-time recovery. Re-mirrors any node whose
 * vector mirror step was interrupted (outbox 'sync.vector.mirror' rows).
 *
 * Safe when a node has been deleted since the outbox entry was written
 * — silently skips missing ids.
 *
 * @param vectorStore  - Target vector store (null → skips all, returns skipped=ids.length).
 * @param localGraph   - Source of truth for node content. Only `getNode` is
 *                       called, so the handle (not the concrete Kùzu class)
 *                       is enough — this also runs against a Surreal-backed
 *                       workspace.
 * @param nodeIds      - IDs to recover.
 */
export async function recoverVectorMirrors(
    vectorStore: LoreVectorStore | null,
    localGraph: LoreGraphHandle,
    nodeIds: string[],
): Promise<{ recovered: number; skipped: number }> {
    if (!vectorStore) return { recovered: 0, skipped: nodeIds.length };
    let recovered = 0;
    let skipped = 0;
    for (const id of nodeIds) {
        const node = await localGraph.getNode(id);
        if (!node) { skipped++; continue; }
        await upsertVectorMirror(vectorStore, node);
        recovered++;
    }
    return { recovered, skipped };
}
