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
 *
 * 3.27.1 — an idempotent no-op purge commits NOTHING. Every LanceDB
 * `table.delete()` writes a new table version (a _versions + _transactions
 * file) even when its predicate matches no row. 3.27.0 seeded the delete set
 * with every requested id, so each outbox replay of an already-purged
 * `verbatim.purge` row committed an empty version: Atlas's 16,177-node purge
 * left ~16.7k version files (+266 MB) in lore_verbatim.lance. Now the batch
 * query covers the exact ids too (`id IN (...) OR <anchored #rev LIKEs>`),
 * the delete set holds only rows actually found, and no delete runs when
 * nothing matched. The return value is the ids actually removed.
 *
 * VerbatimStore.purgeWithHistory (3.27.1) bumps the search epoch only when
 * rows were removed. Its piece delete still covers every requested id, but
 * LancePieceIndex.deleteRows is query-then-delete (no commit when nothing
 * matches), so a no-op costs a count, not a version. It is kept because a
 * piece row CAN outlive its verbatim row: a crash between the verbatim delete
 * and the piece delete leaves a still-valid index with orphan pieces (a FAILED
 * piece delete instead marks the index incomplete, which stops piece search
 * until a rebuild), and the outbox replay is what cleans that up.
 */
import type * as lancedb from '@lancedb/lancedb';
import { assertSafeLanceId, isRevisionHistoryId, escapeLikeWildcards } from './verbatimHistory.js';

/** Max ids per history query: bounds the OR-of-LIKE predicate length. */
export const PURGE_QUERY_IDS = 256;

const REV = '#rev';

/** Delete `ids` and their revision-history rows from `table`; returns the ids
 *  actually removed (empty, and no commit, when nothing matched). */
export async function purgeRowsWithHistory(table: lancedb.Table, ids: string[], chunkSize: number): Promise<string[]> {
    ids.forEach((id) => assertSafeLanceId(id, 'purgeWithHistory'));
    const idSet = new Set<string>(ids);
    const wanted = new Set<string>();
    const unique = [...idSet];
    for (let i = 0; i < unique.length; i += PURGE_QUERY_IDS) {
        const batch = unique.slice(i, i + PURGE_QUERY_IDS);
        const exact = `id IN (${batch.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`;
        const likes = batch
            .map((id) => `id LIKE '${escapeLikeWildcards(id).replace(/'/g, "''")}#rev%' ESCAPE '\\'`);
        const rows = await table.query().where([exact, ...likes].join(' OR ')).select(['id']).toArray();
        for (const raw of rows) {
            const rid = String((raw as Record<string, unknown>).id ?? '');
            // Exact id, or `<id>#rev<ts>` whose prefix (before the LAST #rev) is
            // one of the requested ids. Anything else the LIKE over-fetched is dropped.
            if (idSet.has(rid)) wanted.add(rid);
            else if (isRevisionHistoryId(rid) && idSet.has(rid.slice(0, rid.lastIndexOf(REV)))) wanted.add(rid);
        }
    }
    const all = [...wanted];
    if (all.length === 0) return all; // 3.27.1 — nothing matched: commit no (empty) version
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

/** 3.27.1 — physicalDeleteMany's chunked `id IN (...)` delete, but each chunk is
 *  probed first (limit 1) and skipped when nothing matches: LanceDB commits a new
 *  table version for every delete(), even a zero-row one, so replayed/redundant
 *  purges of absent ids bloated the version log. Returns true iff any chunk deleted. */
export async function deleteExistingIds(table: lancedb.Table, ids: string[], chunkSize: number): Promise<boolean> {
    let any = false;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const list = ids.slice(i, i + chunkSize).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
        if ((await table.query().where(`id IN (${list})`).select(['id']).limit(1).toArray()).length === 0) continue;
        await table.delete(`id IN (${list})`);
        any = true;
    }
    return any;
}
