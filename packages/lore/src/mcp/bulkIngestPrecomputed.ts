/**
 * bulkIngestPrecomputed.ts — `embed:'precomputed'` path of bulkIngest().
 * Split out of bulkIngest.ts to keep it under the 800-line file-size cap
 * (integ/d-all D1+D5 merge). Behaviour unchanged; the per-workspace row
 * writer is passed in (same pattern as bulkIngestAliasSync.ts) to avoid a
 * runtime import cycle.
 */

import { buildVerbatimText } from '../engines/verbatimSchema.js';
import { tagsToArray, tagsToString } from '../engines/normalizeTags.js';
import { computeContentHash } from '../engines/contentHash.js';
import type { BulkIngestDeps, BulkIngestNodeArgs, BulkIngestResult } from './bulkIngest.js';
import type { WriteRowsPerWorkspaceFn } from './bulkIngestAliasSync.js';

export async function writePrecomputedVectors(
    toEmbed: Array<{ node: BulkIngestNodeArgs; idx: number }>,
    resultSlots: BulkIngestResult['results'],
    deps: BulkIngestDeps,
    finish: () => BulkIngestResult,
    writeRows: WriteRowsPerWorkspaceFn,
): Promise<BulkIngestResult> {
    const expectedDim = deps.embeddingProvider.dimension;

    // Validate per-node: embedding present + correct dimension.
    const valid: Array<{ node: BulkIngestNodeArgs; idx: number; vector: number[] }> = [];
    for (const { node, idx } of toEmbed) {
        if (!node.embedding || node.embedding.length === 0) {
            resultSlots[idx] = {
                ok: false, id: node.id,
                error: `embed:'precomputed' requires node.embedding — missing on node '${node.id}'`,
            };
            continue;
        }
        if (node.embedding.length !== expectedDim) {
            resultSlots[idx] = {
                ok: false, id: node.id,
                error: `embedding dimension mismatch: got ${node.embedding.length}, model expects ${expectedDim}`,
            };
            continue;
        }
        valid.push({ node, idx, vector: node.embedding });
    }

    if (valid.length === 0) return finish();

    const texts = valid.map(({ node }) => buildVerbatimText(
        String(node.nodeData.label ?? ''),
        String(node.nodeData.content ?? ''),
        tagsToArray(node.nodeData.tags as string | string[] | undefined),
    ));

    // R4 #4 — route each precomputed vector to ITS workspace's LanceDB (not
    // the boot/active store), grouped per workspace; same-id duplicates were
    // collapsed keep-last in Step 0 (C3 3.4). (Cloud has no resolver;
    // bulkUpsertPrebuiltRows requires a local VerbatimStore — the helper's
    // per-row store() fallback ignores the precomputed vector, matching the
    // prior cloud behavior where the Dataplane re-embeds server-side.)
    await writeRows(deps, valid.map(({ node, vector, idx }, i) => ({
        node, idx,
        row: {
            vector,
            id: `lore:${node.id}`,
            text: texts[i]!,
            type: String(node.nodeData.type ?? ''),
            label: String(node.nodeData.label ?? ''),
            tags: tagsToString(node.nodeData.tags as string | string[] | undefined),
            project: String(node.nodeData.project ?? node.ecosystem),
            ecosystem: node.ecosystem,
            updatedAt: new Date().toISOString(),
            security_scopes: (node.nodeData['security_scopes'] as string[] | undefined) ?? [],
            contentHash: computeContentHash(texts[i]!),
        },
    })), resultSlots);

    return finish();
}
