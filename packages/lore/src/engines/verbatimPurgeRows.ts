/**
 * verbatimPurgeRows.ts — row collection + delete for VerbatimStore.purgeWithHistory (3.27.0).
 *
 * Extracted from verbatimStore.ts (file-size guardrail). Matching is anchored:
 * only `X` itself and `X#rev<ISO-millis>` (isRevisionHistoryId shape, prefix
 * equal to X) are removed - never a bare prefix, so node `a` cannot take
 * `a#x`'s rows, and LIKE wildcards in X are escaped. The LIKE is only a coarse
 * pre-filter; the exact-shape check runs in JS. Embeds nothing.
 *
 * 3.27.0 (nodeDeleteMany) — the history lookup is BATCHED: one filtered query
 * covers up to PURGE_QUERY_IDS ids (an OR of their anchored LIKE patterns)
 * instead of one table scan per id, and the delete is one `id IN (...)` per
 * `chunkSize` ids. A purge of N ids is therefore ceil(N / PURGE_QUERY_IDS)
 * queries + ceil(rows / chunkSize) deletes, not N scans.
 */
import type * as lancedb from '@lancedb/lancedb';
import { assertSafeLanceId, isRevisionHistoryId, escapeLikeWildcards } from './verbatimHistory.js';

/** Max ids per history query: bounds the OR-of-LIKE predicate length. */
export const PURGE_QUERY_IDS = 256;

const REV = '#rev';

/** Delete `ids` and their revision-history rows from `table`; returns every id removed. */
export async function purgeRowsWithHistory(table: lancedb.Table, ids: string[], chunkSize: number): Promise<string[]> {
    ids.forEach((id) => assertSafeLanceId(id, 'purgeWithHistory'));
    const idSet = new Set<string>(ids);
    const wanted = new Set<string>(idSet);
    const unique = [...idSet];
    for (let i = 0; i < unique.length; i += PURGE_QUERY_IDS) {
        const likes = unique.slice(i, i + PURGE_QUERY_IDS)
            .map((id) => `id LIKE '${escapeLikeWildcards(id).replace(/'/g, "''")}#rev%' ESCAPE '\\'`);
        const rows = await table.query().where(likes.join(' OR ')).select(['id']).toArray();
        for (const raw of rows) {
            const rid = String((raw as Record<string, unknown>).id ?? '');
            // Exact id, or `<id>#rev<ts>` whose prefix (before the LAST #rev) is
            // one of the requested ids. Anything else the LIKE over-fetched is dropped.
            if (idSet.has(rid)) wanted.add(rid);
            else if (isRevisionHistoryId(rid) && idSet.has(rid.slice(0, rid.lastIndexOf(REV)))) wanted.add(rid);
        }
    }
    const all = [...wanted];
    all.forEach((id) => assertSafeLanceId(id, 'purgeWithHistory'));
    for (let i = 0; i < all.length; i += chunkSize) {
        const list = all.slice(i, i + chunkSize).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
        await table.delete(`id IN (${list})`);
    }
    return all;
}

/** Which of `ids` have a row in `table` (any row with that exact id, as Lance
 *  getById). One `id IN (...)` query per `chunkSize` ids. Throws on an unsafe id. */
export async function existingIdsInTable(table: lancedb.Table, ids: string[], chunkSize: number): Promise<string[]> {
    ids.forEach((id) => assertSafeLanceId(id, 'getExistingIds'));
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += chunkSize) {
        const list = ids.slice(i, i + chunkSize).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
        const rows = await table.query().where(`id IN (${list})`).select(['id']).toArray();
        for (const raw of rows) found.add(String((raw as Record<string, unknown>).id ?? ''));
    }
    return [...found];
}
