/**
 * graphShared/keysetPage.ts — the `(updatedAt DESC, id ASC)` keyset-cursor
 * paging shape shared by `bulkList` and `bulkListProjected` on every local
 * graph engine.
 *
 * 3.21 step 1a extraction: `surrealGraphAggregates.ts`'s `bulkList` and
 * `bulkListProjected` each fetched `limit + 1` rows and then independently
 * computed `hasMore` / sliced the page / built `nextCursor` from the last
 * row — same eleven lines, twice. The cursor's ENCODING (a stable
 * `{ updatedAt, id }` position, not an offset) and the "fetch one extra row
 * to detect a further page without a second count query" trick are the part
 * that must stay byte-identical across engines; only the SQL that fetches
 * the `limit + 1` rows in the first place is engine-specific.
 */

/** A stable `(updatedAt, id)` keyset position. Same shape as `BulkListCursor`. */
export interface KeysetCursor {
    updatedAt: string;
    id: string;
}

export interface KeysetPage<T> {
    /** The page, trimmed back down to `limit` rows when `hasMore`. */
    page: T[];
    hasMore: boolean;
    /** The cursor for the NEXT page, or null when this was the last one. */
    nextCursor: KeysetCursor | null;
}

/**
 * buildKeysetPage — given `limit + 1` rows already fetched in
 * `(updatedAt DESC, id ASC)` order (or `undefined`/missing keys, which the
 * caller must not produce for a real row), decide whether a further page
 * exists and build its cursor.
 *
 * `rows` must already be ordered by the caller's query — this function does
 * not sort, it only detects overflow and derives the cursor from the last
 * KEPT row, exactly as `graphBulkList.bulkListNodes` did before this
 * extraction.
 */
export function buildKeysetPage<T extends Record<string, unknown>>(
    rows: readonly T[],
    limit: number,
): KeysetPage<T> {
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows) as T[];
    const last = page[page.length - 1];
    return {
        page,
        hasMore,
        nextCursor: hasMore && last
            ? { updatedAt: String(last['updatedAt'] ?? ''), id: String(last['id'] ?? '') }
            : null,
    };
}
