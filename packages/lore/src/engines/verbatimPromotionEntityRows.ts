/**
 * verbatimPromotionEntityRows.ts - exact per-entity row selection on a staged Lance table.
 *
 * 3.35.3 review finding F3. A Lance store keeps an entity (`foo`) as the canonical row `foo` plus
 * history rows `foo#rev<ISO ms>`. The first cut of copyTail deleted an entity with
 * `split_part(id, '#rev', 1) IN (...)`, which also matches an UNRELATED entity whose id merely contains
 * the literal `#rev` (`foo#revbar` -> first segment `foo`) and misses the history rows of an entity whose
 * own id contains `#rev` (`a#revb#rev<ts>` -> first segment `a`).
 *
 * Lance's filter dialect has no substr/length/regexp, so the predicate cannot be made exact in one
 * expression. Instead, per flush:
 *   1. a COARSE candidate query (hash-set `split_part` for ids with no `#rev` in them, one escaped
 *      prefix LIKE per odd id that contains `#rev`),
 *   2. an EXACT decision in JS: a candidate row belongs to entity E iff `row.id === E` or
 *      (`row.id` ends in the real history suffix and `row.id` minus that 28-char suffix `=== E`),
 *   3. a delete by the exact id list.
 *
 * RESIDUAL AMBIGUITY (inherent to the `<id>#rev<ts>` naming, identical on a natively-Lance store): a
 * canonical entity whose id is literally `X#rev2020-01-01T00:00:00.000Z` is indistinguishable from the
 * history row of entity `X` at that instant. Deleting/resyncing `X` also removes that row; resyncing the
 * odd entity re-adds it. Ids that merely contain `#rev` without ending in a full timestamp suffix
 * (`foo#revbar`) are handled exactly.
 */
import type { Table } from '@lancedb/lancedb';

import { HISTORY_SUFFIX_RE, escapeLikeWildcards, escapeSqlLiteral } from './verbatimHistory.js';

/** `#rev` + a 24-char ISO-8601 millisecond timestamp. */
const HISTORY_SUFFIX_LEN = 28;
const DELETE_CHUNK = 1000;

const lit = (s: string): string => `'${escapeSqlLiteral(s)}'`;

/** Lance row ids that belong to `entities`: the canonical id plus its `<id>#rev<ISO>` history rows. */
export function exactEntityIds(entities: ReadonlySet<string>, candidateIds: Iterable<string>): string[] {
    const out: string[] = [];
    for (const id of candidateIds) {
        if (entities.has(id)) { out.push(id); continue; }
        if (HISTORY_SUFFIX_RE.test(id) && entities.has(id.slice(0, -HISTORY_SUFFIX_LEN))) out.push(id);
    }
    return out;
}

/** The coarse WHERE clause(s) that are guaranteed to include every row of `entities`. */
export function candidateFilters(entities: readonly string[]): string[] {
    const plain = entities.filter((e) => !e.includes('#rev'));
    const odd = entities.filter((e) => e.includes('#rev'));
    const filters: string[] = [];
    for (let i = 0; i < plain.length; i += DELETE_CHUNK) {
        const l = plain.slice(i, i + DELETE_CHUNK).map(lit).join(', ');
        filters.push(`id IN (${l}) OR split_part(id, '#rev', 1) IN (${l})`);
    }
    for (let i = 0; i < odd.length; i += 50) {
        filters.push(odd.slice(i, i + 50)
            .map((e) => `id = ${lit(e)} OR id LIKE '${escapeSqlLiteral(escapeLikeWildcards(e))}#rev%' ESCAPE '\\'`)
            .join(' OR '));
    }
    return filters;
}

export interface EntityRowSummary { id: string; contentHash: string; updatedAt: string }

/** `{ id, contentHash, updatedAt }` of every row of `entities` currently in `table` (exact, see the header). */
export async function readEntityRows(table: Table, entities: readonly string[]): Promise<EntityRowSummary[]> {
    const set = new Set(entities);
    const rows: EntityRowSummary[] = [];
    for (const where of candidateFilters(entities)) {
        const found = await table.query().where(where).select(['id', 'contentHash', 'updatedAt']).toArray() as Array<Partial<EntityRowSummary>>;
        const keep = new Set(exactEntityIds(set, found.map((r) => String(r.id))));
        for (const r of found) {
            if (keep.has(String(r.id))) rows.push({ id: String(r.id), contentHash: r.contentHash ?? '', updatedAt: r.updatedAt ?? '' });
        }
    }
    return rows;
}

/** Delete every Lance row of `entities` (canonical + history), and nothing else. */
export async function deleteEntityRows(table: Table, entities: readonly string[]): Promise<void> {
    const set = new Set(entities);
    const doomed = new Set<string>();
    for (const where of candidateFilters(entities)) {
        const found = await table.query().where(where).select(['id']).toArray() as Array<{ id: string }>;
        for (const id of exactEntityIds(set, found.map((r) => r.id))) doomed.add(id);
    }
    const ids = [...doomed];
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        await table.delete(`id IN (${ids.slice(i, i + DELETE_CHUNK).map(lit).join(', ')})`);
    }
}
