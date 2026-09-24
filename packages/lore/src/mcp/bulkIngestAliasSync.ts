/**
 * bulkIngestAliasSync.ts — r9 follow-up (Opus review of the 3.21 r9
 * recall-quality fixes). Split out of bulkIngest.ts to stay under the
 * 800-line file-size cap (CLAUDE.md).
 *
 * Question-alias rows must follow the SAME embed mode as the main
 * verbatim row. Before this, `bulkIngest.ts`'s Step 1b
 * (`applyBulkQuestionAliases`) recorded each alias as a durable
 * `verbatim.upsert` OUTBOX row (kept exactly as-is — that's still the
 * crash-recovery replay path) but never embedded/wrote it inline. So a
 * `bulkIngest(embed:'sync')` caller's own "vectors ARE persisted before
 * the promise resolves" guarantee held for the main content row and
 * silently did NOT hold for its `questions[]` aliases, which only became
 * searchable once the outbox's background replicator got to them on its
 * own schedule — a real, timing-dependent gap, confirmed as the reason
 * the tapestry-recall benchmark's C4/C6 (both use `questions[]`) scored
 * below C3 (no aliases) with run-to-run variance even after fixing the
 * alias-dilution over-fetch bug (recall/multiQuerySeedFetch.ts).
 *
 * This mirrors exactly what cloud's `hooks.inlineVerbatim` already does
 * for the MAIN row on the single-nodeUpsert path
 * (core/nodeServiceVerbatim.ts's `applyVerbatimFanout`) — an eager,
 * best-effort mirror write ALONGSIDE (never instead of) the durable
 * outbox record, so a crash between the two still has the outbox replay
 * as its safety net.
 *
 * Scope: `embed:'sync'` only (the mode `bulkIngest()`'s own doc comment
 * makes this promise for). `embed:'async'` explicitly wants the
 * background path (untouched). `embed:'precomputed'` has no model-backed
 * text to re-embed for aliases without defeating its own purpose
 * (untouched — same as before this fix).
 */

import { computeContentHash } from '../engines/contentHash.js';
import { aliasRowId } from '../core/questionAliases.js';
import type { BulkIngestDeps, BulkIngestNodeArgs, BulkIngestResult } from './bulkIngest.js';

/** The shape `writePrebuiltRowsPerWorkspace` (bulkIngest.ts) accepts —
 *  duplicated here as a type only (no runtime import) to keep this
 *  module dependency-injected rather than circularly importing back into
 *  bulkIngest.ts. */
export type WriteRowsPerWorkspaceFn = (
    deps: BulkIngestDeps,
    items: Array<{ node: BulkIngestNodeArgs; idx: number; row: Record<string, unknown> }>,
    resultSlots: BulkIngestResult['results'],
    opts?: {
        onGroupError?: (group: Array<{ node: BulkIngestNodeArgs; idx: number; row: Record<string, unknown> }>, err: Error) => void;
    },
) => Promise<void>;

/**
 * Embed and write every `toEmbed` node's `questions[]` alias rows inline,
 * best-effort, alongside the main content row's own embed:'sync' write.
 * Caller (bulkIngest.ts) is responsible for the `aborted()` cooperative-
 * cancel check before invoking this — cancellation simply skips aliases
 * for the cancelled batch (the outbox durable record already covers them,
 * exactly as it did before this fix).
 *
 * `writeRows` is `writePrebuiltRowsPerWorkspace` from bulkIngest.ts,
 * passed in rather than imported back (avoids a circular module import;
 * that function already handles per-workspace grouping, store
 * resolution, the bulk write itself, and the immediate
 * ensureVectorIndex()/ensureFtsIndex() calls from Finding A's fix — alias
 * rows get that SAME index-readiness guarantee for free by reusing it).
 */
export async function embedAndWriteAliasRowsInline(
    deps: BulkIngestDeps,
    toEmbed: ReadonlyArray<{ node: BulkIngestNodeArgs; idx: number }>,
    resultSlots: BulkIngestResult['results'],
    writeRows: WriteRowsPerWorkspaceFn,
): Promise<void> {
    const aliasItems: Array<{ node: BulkIngestNodeArgs; text: string; aliasId: string }> = [];
    for (const { node, idx } of toEmbed) {
        // This node's own content write already failed — its outbox alias
        // rows (if any) stay the only retry path; never embed aliases for
        // a node bulkIngest is about to report as ok:false.
        if (resultSlots[idx]?.ok !== true) continue;
        const questions = node.questions;
        if (!questions || questions.length === 0) continue;
        // Already capped at MAX_QUESTIONS and length-validated by
        // nodeServiceUpsert's validateQuestionsMeta in bulkIngest.ts's Step
        // 1b — a node that violated the cap never reached `toEmbed` as
        // ok:true, so no re-validation is needed here.
        questions.forEach((q, i) => {
            aliasItems.push({ node, text: q, aliasId: aliasRowId(node.id, i) });
        });
    }
    if (aliasItems.length === 0) return;

    try {
        const aliasVectors = await deps.embeddingProvider.embedDocumentBatch!(aliasItems.map((a) => a.text));
        await writeRows(
            deps,
            aliasItems.map((a, i) => ({
                node: a.node,
                idx: -1, // no result slot of its own — see onGroupError below
                row: {
                    vector: aliasVectors[i]!,
                    id: a.aliasId,
                    text: a.text,
                    type: String(a.node.nodeData.type ?? ''),
                    // Alias rows carry no label/tags of their own — the same
                    // shape core/nodeServiceVerbatim.ts's aliasVerbatimPayload
                    // uses; they're never surfaced directly, only collapsed to
                    // their parent by questionAliases.ts's mapAliasHitsToParent.
                    label: '',
                    tags: '',
                    project: String(a.node.nodeData.project ?? a.node.ecosystem),
                    ecosystem: a.node.ecosystem,
                    updatedAt: new Date().toISOString(),
                    security_scopes: (a.node.nodeData['security_scopes'] as string[] | undefined) ?? [],
                    contentHash: computeContentHash(a.text),
                },
            })),
            resultSlots,
            {
                // Best-effort, exactly like tombstoneQuestionAliases/
                // recordQuestionAliases' own catches: an alias write failure
                // must NEVER flip an already-successful node to ok:false.
                // The durable verbatim.upsert outbox row Step 1b already
                // recorded remains the real retry.
                onGroupError: (group, err) => {
                    for (const g of group) {
                        console.error(`[Lore bulkIngest] inline alias verbatim write failed for ${g.node.id} (non-fatal — the outbox verbatim.upsert row recorded in Step 1b remains the durable retry): ${err.message}`);
                    }
                },
            },
        );
    } catch (aliasEmbedErr) {
        console.error(`[Lore bulkIngest] inline alias embedding failed (non-fatal — the outbox rows recorded in Step 1b remain the durable retry): ${(aliasEmbedErr as Error).message}`);
    }
}
