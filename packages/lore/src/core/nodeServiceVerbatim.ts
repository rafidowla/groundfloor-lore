/**
 * nodeServiceVerbatim.ts — verbatim fan-out + TW-4a rollback for nodeUpsert.
 *
 * Split from nodeService.ts so that file stays under the 800-line cap.
 * Behaviour is unchanged: outbox-first local write, plus the cloud
 * `inlineVerbatim` primary write (replicator does not apply verbatim
 * when getVerbatim is undefined).
 */

import { buildVerbatimText } from '../engines/verbatimSchema.js';
import { tagsToArray, tagsToString } from '../engines/normalizeTags.js';
import { computeContentHash } from '../engines/contentHash.js';
import { redactId, redactError } from '../security/logRedact.js';
import { log } from '../logger.js';
import { recordHotWrite } from '../outbox/hotLane.js';
import type { LoreNode } from '../providers/types.js';
import type { OutboxStore } from '../outbox/types.js';
import type { NodeUpsertHooks, NodeWriteGraph, VerbatimWriter } from './nodeService.js';

export async function rollbackPartialWrite(input: {
    id: string;
    workspace: string;
    initiator: string;
    logPrefix: string;
    targetGraph: NodeWriteGraph;
    outboxStore?: OutboxStore;
    nodeUpsertOutboxEntryId: string | null;
    verbatimError: Error;
}): Promise<void> {
    const { id, workspace, initiator, logPrefix, targetGraph, outboxStore, nodeUpsertOutboxEntryId, verbatimError } = input;
    let rollbackError: Error | null = null;

    try {
        await targetGraph.deleteNode(id);
    } catch (rollbackErr) {
        rollbackError = rollbackErr as Error;
        log.error(`${logPrefix} graph rollback (deleteNode) failed for ${redactId(id)}: ${redactError(rollbackErr)}`);
    }

    if (outboxStore && nodeUpsertOutboxEntryId) {
        try {
            if (outboxStore.removeIfPending) {
                const removed = await outboxStore.removeIfPending(nodeUpsertOutboxEntryId);
                if (!removed) {
                    await recordHotWrite(outboxStore, {
                        workspace,
                        operationKind: 'node.delete',
                        payload: { id },
                        initiator,
                        operation: 'graph.delete',
                    });
                    log.warn(`${logPrefix} node.upsert row for ${redactId(id)} was already claimed by the replicator; recorded a compensating node.delete to undo the resurrected orphan (C-R2-03)`);
                }
            } else {
                await outboxStore.remove(nodeUpsertOutboxEntryId);
            }
        } catch (retractErr) {
            rollbackError = rollbackError ?? (retractErr as Error);
            log.error(`${logPrefix} node.upsert outbox retraction failed for ${redactId(id)}: ${redactError(retractErr)} — replicator may resurrect a graph-only orphan`);
        }
    }

    if (rollbackError) {
        throw new Error(
            `nodeUpsert rollback incomplete for ${redactId(id)} after verbatim failure ` +
            `(${redactError(verbatimError)}): ${redactError(rollbackError)} — partial state may remain`,
        );
    }
}

function verbatimPayload(node: LoreNode, id: string, tagsStr: string, verbatimText: string): {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
} {
    return {
        id: `lore:${id}`,
        text: verbatimText,
        metadata: {
            type: node.type,
            label: node.label,
            tags: tagsStr,
            project: node.project,
            ecosystem: node.ecosystem,
            security_scopes: node.security_scopes ?? [],
            updatedAt: node.updatedAt,
            contentHash: computeContentHash(verbatimText),
        },
    };
}

async function writeInline(
    writer: VerbatimWriter,
    node: LoreNode,
    id: string,
    tagsStr: string,
    verbatimText: string,
): Promise<void> {
    await writer.verbatimStore(verbatimPayload(node, id, tagsStr, verbatimText));
}

/** Step 3 of nodeUpsert. Returns the verbatim failure, or null on success. */
export async function applyVerbatimFanout(input: {
    skipEmbed: boolean;
    asyncEmbed?: boolean;
    id: string;
    workspace: string;
    initiator: string;
    logPrefix: string;
    node: LoreNode;
    nodeData: Record<string, unknown>;
    targetGraph: NodeWriteGraph;
    hooks: Pick<NodeUpsertHooks, 'outboxStore' | 'embedQueue' | 'verbatim' | 'inlineVerbatim'>;
    nodeUpsertOutboxEntryId: string | null;
}): Promise<Error | null> {
    const {
        skipEmbed, asyncEmbed, id, workspace, initiator, logPrefix,
        node, nodeData, targetGraph, hooks, nodeUpsertOutboxEntryId,
    } = input;

    const label = String(nodeData.label ?? '');
    const content = String(nodeData.content ?? '');
    const tagsArr = tagsToArray(nodeData.tags as string | string[] | null | undefined);
    const tagsStr = tagsToString(tagsArr);
    const rollback = (verbatimError: Error) => rollbackPartialWrite({
        id, workspace, initiator, logPrefix, targetGraph,
        outboxStore: hooks.outboxStore, nodeUpsertOutboxEntryId, verbatimError,
    });

    if (skipEmbed) return null;

    if (hooks.outboxStore) {
        // RC-round4: durable outbox before async_embed. Cloud also runs
        // inlineVerbatim here — the replicator does not apply verbatim
        // (getVerbatim is undefined).
        try {
            const verbatimText = buildVerbatimText(label, content, tagsArr);
            await recordHotWrite(hooks.outboxStore, {
                workspace,
                operationKind: 'verbatim.upsert',
                payload: verbatimPayload(node, id, tagsStr, verbatimText),
                initiator,
                operation: 'verbatim.upsert',
            });
        } catch (err) {
            const verbatimWriteFailed = err as Error;
            log.error(`${logPrefix} verbatim outbox record failed for ${redactId(id)}: ${redactError(err)} — graph node + node.upsert outbox row will be retracted to maintain consistency`);
            await rollback(verbatimWriteFailed);
            return verbatimWriteFailed;
        }
        if (hooks.inlineVerbatim) {
            try {
                const verbatimText = buildVerbatimText(label, content, tagsArr);
                await writeInline(hooks.inlineVerbatim, node, id, tagsStr, verbatimText);
            } catch (err) {
                const verbatimWriteFailed = err as Error;
                log.error(`${logPrefix} inline verbatim write failed for ${redactId(id)}: ${redactError(err)} — graph node + node.upsert outbox row will be retracted to maintain consistency`);
                await rollback(verbatimWriteFailed);
                return verbatimWriteFailed;
            }
        }
        return null;
    }

    if (asyncEmbed && hooks.embedQueue) {
        hooks.embedQueue.enqueue(id, buildVerbatimText(label, content, tagsArr), workspace);
        return null;
    }

    if (hooks.verbatim) {
        try {
            const verbatimText = buildVerbatimText(label, content, tagsArr);
            await writeInline(hooks.verbatim, node, id, tagsStr, verbatimText);
        } catch (err) {
            const verbatimWriteFailed = err as Error;
            log.error(`${logPrefix} VerbatimStore write failed for ${redactId(id)}: ${redactError(err)} — graph node will be deleted to maintain consistency`);
            await rollback(verbatimWriteFailed);
            return verbatimWriteFailed;
        }
    }
    return null;
}
