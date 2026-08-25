/**
 * bulkEmbedFlush.ts — flush the queued-embed outbox rows for a POST
 * /api/nodes/bulk write. Extracted from bulkWrite.ts (file-size budget) so the
 * two mode-specific flush strategies live behind ONE named concern.
 *
 * Two strategies, mutually exclusive by target substrate:
 *
 *   LOCAL  (LocalGraph target) — ONE `embed.batch` row covering every queued
 *          node. The local outbox wiring (outbox/wiring.ts) wires
 *          batchedEmbedder + storeEmbedBatch, so the replicator embeds the
 *          whole batch in one model call and stores the vectors. Efficient
 *          async batch; unchanged from Sprint E2.
 *
 *   ARCADE (non-local cell target) — one WIRED `verbatim.upsert` row PER queued
 *          node. The arcade cell outbox (arcadeOutboxWiring.ts) deliberately
 *          leaves `embed.batch` UNWIRED — the cell embeds INLINE via the wired
 *          `verbatim.upsert` → ArcadeVectorStore.store() path (the same path the
 *          single-node arcade route uses, arcadeData.ts). Emitting an
 *          embed.batch row here dead-lettered every bulk node's embedding
 *          (UnwiredOperationKindError), leaving the nodes non-recallable-by-
 *          meaning in their own cell. Emitting verbatim.upsert rows instead
 *          makes arcade bulk fully recall-complete, cell-isolated, dead-row-free
 *          — parity with the single-node arcade path.
 *
 * Both flushes are NON-FATAL: the substrate graph writes already landed before
 * this runs, so a commit failure only DEFERS the embeddings (logged to audit for
 * an operator re-embed). Per-item results stay as-is.
 */

import type { AuditLog } from '../../../security/audit.js';
import { recordHotWriteBatch } from '../../../outbox/hotLane.js';
import type { OutboxStore } from '../../../outbox/types.js';
import { buildBulkVerbatimMetadata } from '../../../core/bulkNodeScope.js';

/** One queued node's verbatim payload for the arcade flush. */
export interface VerbatimSpec {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
}

/**
 * Build one arcade `verbatim.upsert` spec for a queued bulk node. Mirrors the
 * single-node arcade payload (core/nodeService.ts): canonical `lore:<id>` key,
 * the pre-built verbatim text, and the shared bulk metadata above — so this
 * path and the inline one cannot disagree about project/ecosystem again.
 */
export function buildVerbatimSpec(input: {
    id: string;
    text: string;
    type: string;
    label: string;
    tags: string;
    project: string;
    ecosystem?: string;
}): VerbatimSpec {
    return {
        id: `lore:${input.id}`,
        text: input.text,
        metadata: buildBulkVerbatimMetadata(input),
    };
}

/**
 * Flush the queued-embed outbox rows for a bulk-node write.
 *
 * @param isLocalTarget  true when the resolved graph is a LocalGraph (drives the
 *                        embed.batch strategy); false for arcade/cloud cells
 *                        (drives the per-node verbatim.upsert strategy).
 */
export async function flushBulkQueuedEmbeds(input: {
    isLocalTarget: boolean;
    outboxStore: OutboxStore | undefined;
    auditLog: AuditLog;
    requestedWorkspace: string;
    embedTexts: string[];
    embedTargetIds: string[];
    verbatimSpecs: VerbatimSpec[];
}): Promise<void> {
    const { outboxStore, auditLog, requestedWorkspace } = input;
    if (!outboxStore) return;

    // LOCAL — Sprint E2: ONE embed.batch row for the whole batch.
    if (input.isLocalTarget && input.embedTexts.length > 0) {
        try {
            await recordHotWriteBatch(outboxStore, [{
                workspace: requestedWorkspace,
                operationKind: 'embed.batch',
                payload: { texts: input.embedTexts, targetNodeIds: input.embedTargetIds },
                initiator: 'http:POST /api/nodes/bulk',
                operation: 'embed.batch',
            }]);
        } catch (err) {
            auditLog.log({
                toolName: 'bulk_store_nodes_embed_batch',
                args: { count: input.embedTexts.length, workspace: requestedWorkspace, surface: 'http' },
                result: 'error',
                resultDetail: `embed.batch outbox commit failed: ${(err as Error).message}`,
                durationMs: 0,
            });
        }
        return;
    }

    // ARCADE — one WIRED verbatim.upsert row per queued node. One
    // recordHotWriteBatch commits them atomically (single-file rewrite), matching
    // the local flush's durability. embed.batch is NEVER produced here.
    if (!input.isLocalTarget && input.verbatimSpecs.length > 0) {
        try {
            await recordHotWriteBatch(outboxStore, input.verbatimSpecs.map((spec) => ({
                workspace: requestedWorkspace,
                operationKind: 'verbatim.upsert' as const,
                payload: { id: spec.id, text: spec.text, metadata: spec.metadata },
                initiator: 'http:POST /api/nodes/bulk',
                operation: 'verbatim.upsert',
            })));
        } catch (err) {
            auditLog.log({
                toolName: 'bulk_store_nodes_verbatim_batch',
                args: { count: input.verbatimSpecs.length, workspace: requestedWorkspace, surface: 'http' },
                result: 'error',
                resultDetail: `verbatim.upsert outbox commit failed: ${(err as Error).message}`,
                durationMs: 0,
            });
        }
    }
}
