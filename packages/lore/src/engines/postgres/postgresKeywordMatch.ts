/**
 * postgresKeywordMatch.ts - the keyword-search candidate predicate for the
 * Postgres engine, written so the planner can answer it from the GIN indexes in
 * postgresKeywordIndex.ts instead of scanning every node.
 *
 * The OLD predicate (still the contract, see {@link legacyKeywordMatchClause})
 * was `strpos(lower(label), t) > 0 OR strpos(lower(content), t) > 0 OR
 * <exact tag = t>`, AND-ed over the query's terms and OR-ed with an exact-tag
 * match on the whole query. `strpos(...) > 0` cannot use an index, so every
 * search read the whole table (about 2.9 s at 1M nodes).
 *
 * The NEW predicate is the SAME boolean function, restated:
 *   - `strpos(lower(col), t) > 0`  ==>  `lower(col) LIKE '%t%'` (t escaped), which a
 *     pg_trgm GIN index on `lower(col)` serves for terms of 3+ characters;
 *   - the exact-tag EXISTS over `jsonb_array_elements_text` ==> `tags::jsonb @> '["t"]'`
 *     (string-element containment), which a jsonb_path_ops GIN index serves;
 *   - `qTag OR AND_t(L_t OR C_t OR T_t)`  ==>  `AND_t(qTag OR L_t OR C_t OR T_t)`
 *     (distributivity). Postgres only builds a BitmapOr when EVERY arm of an OR
 *     is indexable, and a single un-indexable arm drags the whole OR back to a
 *     scan; in the nested form the whole-query tag arm sat outside the AND and
 *     the planner could not push it into each term's OR.
 *
 * Result-set change: none for string tags (every tag the engine writes is a
 * string). A tag stored as a bare JSON NUMBER would have matched the old
 * `je = 'text'` text comparison and does not match `@>` of a string element;
 * the shared rankSearchResults re-check (which reads LoreNode.tags: string[])
 * never saw such a tag anyway.
 *
 * Terms shorter than 3 characters have no trigram: they keep the OLD arms and
 * the old plan (see keywordMatchClause). That is the only slow case left.
 */
import type { PgParams } from './postgresGraphRow.js';

/** LIKE-escape a literal so `%`, `_` and `\` are matched as themselves. */
export function escapeLike(term: string): string {
    return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Exact tag membership as an indexable containment (`tags::jsonb` is the expression the GIN index is built on). */
export function tagContainsExact(params: PgParams, value: string): string {
    return `(nodes.tags::jsonb @> ${params.add(JSON.stringify([value]))}::jsonb)`;
}

/** The pre-index exact-tag form (an EXISTS over the array elements). */
function tagExistsExact(params: PgParams, value: string): string {
    return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(nodes.tags::jsonb) je WHERE je = ${params.add(value)})`;
}

/** Fewest characters pg_trgm can index a LIKE pattern on (a trigram is 3). */
export const MIN_TRIGRAM_CHARS = 3;

/** True when `term` has a trigram, i.e. its LIKE arms can be answered from the GIN index. */
export function isTrigramTerm(term: string): boolean {
    return [...term].length >= MIN_TRIGRAM_CHARS;
}

/**
 * keywordMatchClause - the candidate predicate for `terms` (from
 * keywordSearchTerms) and the lowercased whole query `q`.
 * An empty term list means "no keyword constraint": `TRUE`.
 *
 * A term shorter than a trigram gets the OLD arms (strpos / EXISTS): no index
 * can serve it either way, and keeping the old text keeps the old plan. The
 * indexable forms have a much lower planner row estimate, which for a
 * short/common term flips `ORDER BY updatedAt DESC LIMIT` from the cheap
 * ordered index walk to a full scan + sort (measured: 0.3 s -> 0.8 s at 1M rows).
 */
export function keywordMatchClause(params: PgParams, terms: readonly string[], q: string): string {
    if (terms.length === 0) return 'TRUE';
    const anyIndexable = terms.some(isTrigramTerm);
    const wholeQueryTag = anyIndexable ? tagContainsExact(params, q) : tagExistsExact(params, q);
    const perTerm = terms.map((t) => {
        if (isTrigramTerm(t)) {
            const like = params.add(`%${escapeLike(t)}%`);
            const arms = [wholeQueryTag, `lower(label) LIKE ${like}`, `lower(content) LIKE ${like}`];
            // When the term IS the whole query the tag arm would repeat wholeQueryTag.
            if (t !== q) arms.push(tagContainsExact(params, t));
            return `(${arms.join(' OR ')})`;
        }
        const arms = [wholeQueryTag, `strpos(lower(label), ${params.add(t)}) > 0`, `strpos(lower(content), ${params.add(t)}) > 0`];
        if (t !== q) arms.push(tagExistsExact(params, t));
        return `(${arms.join(' OR ')})`;
    });
    return perTerm.join(' AND ');
}

/**
 * legacyKeywordMatchClause - the pre-index predicate, kept verbatim as the
 * reference the equivalence test compares {@link keywordMatchClause} against.
 * Not used by the engine.
 */
export function legacyKeywordMatchClause(params: PgParams, terms: readonly string[], q: string): string {
    if (terms.length === 0) return 'TRUE';
    const exactTag = (v: string): string =>
        `EXISTS (SELECT 1 FROM jsonb_array_elements_text(nodes.tags::jsonb) je WHERE je = ${params.add(v)})`;
    const termClauses = terms.map((t) =>
        `(strpos(lower(label), ${params.add(t)}) > 0 OR strpos(lower(content), ${params.add(t)}) > 0 OR ${exactTag(t)})`);
    return `(${exactTag(q)} OR (${termClauses.join(' AND ')}))`;
}
