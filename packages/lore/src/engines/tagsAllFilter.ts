/**
 * tagsAllFilter.ts — 3.38.2: the `tagsAll` verbatim filter key (ALL-of,
 * exact per-tag membership). Dependency-free so the SQLite vector fallback,
 * the SQLite piece index and the Arcade store can share it without pulling
 * in the Lance-backed verbatimHistory module.
 *
 * The verbatim row's `tags` column is the comma-joined, normalized list
 * written by `tagsToString` (normalizeTags.ts), so membership of `t` means
 * "`t` is one whole item of the list" — never a substring, so `client:c-0`
 * never matches `client:c-008`.
 */

/** The `VerbatimQueryFilter` key carrying the required tags. */
export const TAGS_ALL_FILTER_KEY = 'tagsAll';

/** Normalized, deduped tag values from a `tagsAll` filter value. Tags never
 *  contain commas (tagsToArray splits on them), so a value with a comma can
 *  never be a member and is dropped rather than turned into a needle that
 *  could straddle two stored tags. */
export function tagsAllValues(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : [];
    return [...new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0 && !v.includes(',')))];
}

/** True when the comma-joined list `list` contains `value` as a whole item. */
export function delimitedListHas(list: unknown, value: string): boolean {
    if (typeof list !== 'string' || list.length === 0) return false;
    return list.split(',').includes(value);
}
