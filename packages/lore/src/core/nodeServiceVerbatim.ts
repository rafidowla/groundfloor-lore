/**
 * nodeServiceVerbatim.ts — verbatim fan-out + TW-4a rollback for nodeUpsert.
 *
 * Split from nodeService.ts so that file stays under the 800-line cap.
 * Outbox-first local write, plus the cloud `inlineVerbatim` primary write
 * (replicator does not apply verbatim when getVerbatim is undefined).
 *
 * 3.21 step 3(d) — an embed/verbatim write failure no longer deletes the
 * graph node in the two cases where the failure is an INDEXING problem, not
 * a durability problem:
 *
 *   - `hooks.outboxStore` wired + `hooks.inlineVerbatim` fails: the
 *     `verbatim.upsert` outbox row was ALREADY recorded successfully one
 *     step earlier — that IS the durable retry (the dispatcher/replicator
 *     picks it up with its existing backoff + dead-letter machinery,
 *     surviving a restart since it's a SQLite row). `inlineVerbatim` is only
 *     cloud's EAGER best-effort direct mirror; losing it must not undo the
 *     graph write and the durable retry that already exists. Returns
 *     `embedPending: true`.
 *   - No outbox wired at all + `hooks.verbatim` fails: there is no durable
 *     row to fall back on for this caller. The node is still KEPT (deleting
 *     real content because a search index failed to update is the bug this
 *     closes); best-effort, `hooks.embedQueue` is used for an in-process
 *     retry if the caller happens to have one wired. Also `embedPending: true`
 *     — honest about there being no durable-across-restart guarantee here,
 *     since none of NodeUpsertHooks in this branch was durable in the first
 *     place.
 *
 * The remaining rollback (`hooks.outboxStore` wired but the `verbatim.upsert`
 * *record* itself fails — a SQLite/outbox substrate failure, not an
 * embedding failure) is UNCHANGED: there is no durable intent recorded at
 * all in that case, so the graph write is retracted exactly as before.
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
import { aliasRowId, MAX_QUESTIONS } from './questionAliases.js';

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

/**
 * 3.21 step 3(e) — question-alias verbatim payload. Same shape as the main
 * row's `verbatimPayload`, keyed at `aliasRowId(id, index)` instead of
 * `lore:<id>`, text = the question itself (embedded + BM25-indexed exactly
 * like any other verbatim row — no model call happens here, the CALLER
 * supplied the question), and `aliasOf` in metadata so a reader that lands
 * on the row directly (rather than through retrieve()'s alias→parent
 * mapping) can still identify its parent.
 */
function aliasVerbatimPayload(node: LoreNode, id: string, index: number, question: string): {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
} {
    return {
        id: aliasRowId(id, index),
        text: question,
        metadata: {
            aliasOf: id,
            type: node.type,
            project: node.project,
            ecosystem: node.ecosystem,
            security_scopes: node.security_scopes ?? [],
            updatedAt: node.updatedAt,
            contentHash: computeContentHash(question),
        },
    };
}

/**
 * Tombstone every fixed alias slot (0..MAX_QUESTIONS-1) for `id`, durably
 * via the SAME `verbatim.tombstone` outbox kind delete_node already uses
 * (dispatcher.ts's existing case, VerbatimStore.tombstone() — a no-op when
 * the row doesn't exist, so sweeping the whole fixed range is cheap and
 * correct whether this node ever had aliases or not). Callers decide WHEN
 * to sweep (applyVerbatimFanout only calls this when the caller's write
 * explicitly touches `questions`, never on an ordinary content-only
 * rewrite — see its call site); this function itself is unconditional once
 * invoked. Runs BEFORE `recordQuestionAliases` below (same outbox, so
 * commit order — and therefore replay order — has the tombstone land before
 * any NEW alias write reusing the same slot). Best-effort: a failure here
 * degrades to "a stale alias phrasing stays searchable a bit longer," never
 * the write's correctness, so it never fails the caller's write.
 */
export async function tombstoneQuestionAliases(input: {
    id: string;
    workspace: string;
    initiator: string;
    logPrefix: string;
    outboxStore: OutboxStore;
}): Promise<void> {
    const { id, workspace, initiator, logPrefix, outboxStore } = input;
    for (let i = 0; i < MAX_QUESTIONS; i++) {
        const rowId = aliasRowId(id, i);
        try {
            await recordHotWrite(outboxStore, {
                workspace,
                operationKind: 'verbatim.tombstone',
                payload: { id: rowId, reason: 'node rewritten — aliases replaced' },
                initiator,
                operation: 'verbatim.tombstone',
            });
        } catch (err) {
            log.warn(`${logPrefix} question-alias tombstone record failed for ${redactId(rowId)} (non-fatal): ${redactError(err)}`);
        }
    }
}

/**
 * Record a durable `verbatim.upsert` outbox row per question — the EXACT
 * same operationKind + dispatcher branch the main row uses (dispatcher.ts's
 * `case 'verbatim.upsert'` → `VerbatimStore.store()`), so replay, backoff,
 * dead-letter, and (3.21 step 3(c)) the null-embedder no-op all apply
 * identically with no dispatcher changes. Best-effort per question — one
 * failed alias record is logged and skipped, never fails the caller's write
 * (the main node content already landed; a missing alias only means that
 * ONE phrasing doesn't find the node yet).
 */
export async function recordQuestionAliases(input: {
    id: string;
    workspace: string;
    initiator: string;
    logPrefix: string;
    node: LoreNode;
    questions: string[];
    outboxStore: OutboxStore;
}): Promise<void> {
    const { id, workspace, initiator, logPrefix, node, questions, outboxStore } = input;
    for (let i = 0; i < questions.length; i++) {
        const rowId = aliasRowId(id, i);
        try {
            await recordHotWrite(outboxStore, {
                workspace,
                operationKind: 'verbatim.upsert',
                payload: aliasVerbatimPayload(node, id, i, questions[i]!),
                initiator,
                operation: 'verbatim.upsert',
            });
        } catch (err) {
            log.warn(`${logPrefix} question-alias outbox record failed for ${redactId(rowId)} (non-fatal — this phrasing will not be searchable): ${redactError(err)}`);
        }
    }
}

/** Result of {@link applyVerbatimFanout}. `error` set ⇒ the whole write must
 *  be reported as failed (the caller rolls back / returns {ok:false});
 *  `embedPending` true ⇒ the graph node is being KEPT despite an
 *  embed/verbatim write failure — see this file's module doc for which of
 *  the two cases that covers and why each one is safe to keep. */
export interface VerbatimFanoutOutcome {
    error: Error | null;
    embedPending: boolean;
}

/** Step 3 of nodeUpsert. */
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
    /** 3.21 step 3(e) — optional question phrasings. See questionAliases.ts. */
    questions?: string[];
}): Promise<VerbatimFanoutOutcome> {
    const {
        skipEmbed, asyncEmbed, id, workspace, initiator, logPrefix,
        node, nodeData, targetGraph, hooks, nodeUpsertOutboxEntryId, questions,
    } = input;

    const label = String(nodeData.label ?? '');
    const content = String(nodeData.content ?? '');
    const tagsArr = tagsToArray(nodeData.tags as string | string[] | null | undefined);
    const tagsStr = tagsToString(tagsArr);
    const rollback = (verbatimError: Error) => rollbackPartialWrite({
        id, workspace, initiator, logPrefix, targetGraph,
        outboxStore: hooks.outboxStore, nodeUpsertOutboxEntryId, verbatimError,
    });

    if (skipEmbed) return { error: null, embedPending: false };

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
            // FATAL — unlike the inlineVerbatim case below, nothing durable
            // was recorded at all here: this IS the attempt to establish
            // durability, and it failed. No retry path exists to keep the
            // node pending against, so the graph write is retracted exactly
            // as before 3.21 step 3(d).
            const verbatimWriteFailed = err as Error;
            log.error(`${logPrefix} verbatim outbox record failed for ${redactId(id)}: ${redactError(err)} — graph node + node.upsert outbox row will be retracted to maintain consistency`);
            await rollback(verbatimWriteFailed);
            return { error: verbatimWriteFailed, embedPending: false };
        }
        let mainEmbedPending = false;
        if (hooks.inlineVerbatim) {
            try {
                const verbatimText = buildVerbatimText(label, content, tagsArr);
                await writeInline(hooks.inlineVerbatim, node, id, tagsStr, verbatimText);
            } catch (err) {
                // 3.21 step 3(d) — NOT fatal. The verbatim.upsert outbox row
                // recorded just above already exists durably (SQLite) — that
                // IS the retry, picked up by the dispatcher/replicator with
                // its existing backoff + dead-letter machinery, surviving a
                // restart. `inlineVerbatim` is only cloud's EAGER best-effort
                // direct mirror; keep the node + the already-queued retry.
                log.warn(`${logPrefix} inline verbatim write failed for ${redactId(id)} — node KEPT; a durable retry is already queued via the verbatim.upsert outbox row: ${redactError(err)}`);
                mainEmbedPending = true;
            }
        }

        // 3.21 step 3(e) — question aliases. Gated on hooks.outboxStore (the
        // coordinator's own note on 3(d) applies here too — "production
        // wiring always has an outbox") AND on `questions !== undefined` —
        // a caller who never mentions `questions` on THIS write must not pay
        // 5 extra outbox rows (or touch any pre-existing aliases) on every
        // ordinary content-only update. A caller that DOES pass `questions`
        // (including `[]` to explicitly clear) gets the fixed slot range
        // tombstoned FIRST (so a rewrite with fewer questions than before
        // cleanly drops the stale ones — see tombstoneQuestionAliases), then
        // the new ones recorded. Both are best-effort against the ALIAS rows
        // only — neither can fail this function or roll back the main write.
        if (questions !== undefined) {
            await tombstoneQuestionAliases({ id, workspace, initiator, logPrefix, outboxStore: hooks.outboxStore });
            if (questions.length > 0) {
                await recordQuestionAliases({ id, workspace, initiator, logPrefix, node, questions, outboxStore: hooks.outboxStore });
            }
        }

        return { error: null, embedPending: mainEmbedPending };
    }

    if (asyncEmbed && hooks.embedQueue) {
        hooks.embedQueue.enqueue(id, buildVerbatimText(label, content, tagsArr), workspace);
        return { error: null, embedPending: false };
    }

    if (hooks.verbatim) {
        try {
            const verbatimText = buildVerbatimText(label, content, tagsArr);
            await writeInline(hooks.verbatim, node, id, tagsStr, verbatimText);
        } catch (err) {
            // 3.21 step 3(d) — NOT fatal. No outbox is wired for this caller
            // at all, so there is no durable row to fall back on; best
            // effort: retry via `hooks.embedQueue` if supplied (in-memory
            // only — does NOT survive a restart, an honest limitation of a
            // caller that opted out of outbox durability entirely), else the
            // node stays without a vector until the next write/re-embed.
            // Either way the node is KEPT — deleting real content because a
            // search index failed to update is the bug this closes.
            const queuedBestEffort = !!hooks.embedQueue;
            if (hooks.embedQueue) hooks.embedQueue.enqueue(id, buildVerbatimText(label, content, tagsArr), workspace);
            log.warn(`${logPrefix} inline verbatim write failed for ${redactId(id)} — node KEPT; no outbox is wired for this caller, so there is no durable retry (${queuedBestEffort ? 'a best-effort in-process retry was queued via embedQueue' : 'no retry mechanism is available; the node stays un-embedded until the next write'}): ${redactError(err)}`);
            return { error: null, embedPending: true };
        }
    }
    return { error: null, embedPending: false };
}
