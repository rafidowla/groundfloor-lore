/**
 * engines/metaArrayFilter.ts — E2 helpers for the `entities` / `topics`
 * keyword-leg pushdown in graph.search() (sqliteGraphReads.ts /
 * surrealGraphReads.ts).
 *
 * Semantics are defined by recall/retrieveFilters.ts `nodeMetaList` +
 * `passesEntitiesTopicsProject`: `metadata` is a JSON string, the key must be
 * a top-level array, only its STRING elements count, and every requested
 * value must be present (ALL-of, exact, case-sensitive). Anything that is not
 * a string / not valid JSON / has no such array matches nothing.
 *
 * The DB predicate is allowed to over-match (false positives) but must never
 * under-match; `metaArraysContainAll` is then applied to the fetched rows
 * before ranking so graph.search() returns exactly what the old JS post-filter
 * would have kept. retrieve.ts's applySeedFilters still re-checks as a
 * backstop.
 */

/** Exact membership check with nodeMetaList semantics. Never throws. */
export function metaArraysContainAll(
    metadata: unknown,
    entities: readonly string[] | undefined,
    topics: readonly string[] | undefined,
): boolean {
    const wantE = entities && entities.length > 0 ? entities : undefined;
    const wantT = topics && topics.length > 0 ? topics : undefined;
    if (!wantE && !wantT) return true;
    if (typeof metadata !== 'string' || metadata === '') return false;
    let parsed: unknown;
    try { parsed = JSON.parse(metadata); } catch { return false; }
    if (parsed === null || typeof parsed !== 'object') return false;
    const has = (key: 'entities' | 'topics', want: readonly string[]): boolean => {
        const list = (parsed as Record<string, unknown>)[key];
        if (!Array.isArray(list)) return false;
        const strs = list.filter((x): x is string => typeof x === 'string');
        return want.every((v) => strs.includes(v));
    };
    if (wantE && !has('entities', wantE)) return false;
    if (wantT && !has('topics', wantT)) return false;
    return true;
}

/** Escape a literal for the Rust `regex` crate (SurrealDB string::matches).
 *  Only used outside character classes, so this set is sufficient. */
function escapeRegexLiteral(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One JSON string token: "..." with backslash escapes.
const JSON_STR = '"(?:[^"\\\\]|\\\\.)*"';
// Bare scalar token (number / true / false / null).
const JSON_SCALAR = '[^\\s,\\[\\]{}"]+';
// One-level array / object element whose own members are strings or scalars.
const FLAT_ARRAY = `\\[(?:${JSON_STR}|[^"\\[\\]{}])*\\]`;
const FLAT_OBJECT = `\\{(?:${JSON_STR}|[^"\\[\\]{}])*\\}`;
const JSON_ELEM = `(?:${JSON_STR}|${JSON_SCALAR}|${FLAT_ARRAY}|${FLAT_OBJECT})`;

/**
 * Regex (Rust `regex` syntax, linear-time) that matches a JSON-encoded
 * metadata string in which `"<key>": [ ... ]` contains the string element
 * `value`.
 *
 * - The needle is `JSON.stringify(value)`, so values with `"`, `\`, control
 *   characters etc. are matched in their stored (JSON-escaped) form.
 * - Earlier elements are skipped as whole JSON tokens, so a `]` or `,` inside
 *   an earlier string (`["br]acket","Acme"]`) cannot end the array early.
 * - Whitespace between tokens is tolerated (`"entities": [ "Acme" ]`).
 * - `[{,]` before the key keeps it at a key position; an escaped `\"entities\"`
 *   inside some other string value cannot match. A nested `other.entities`
 *   array can (false positive) — removed by `metaArraysContainAll`.
 *
 * Known false negatives, neither producible by a supported write path
 * (metadata is always written with JSON.stringify and validateQuestionsMeta
 * only admits string arrays): elements nested deeper than one level before
 * the match are not skipped, and a value stored with non-canonical escapes
 * (`\u0041cme` for `Acme`) does not match its canonical needle.
 *
 * `value` is only ever bound as a query variable, never interpolated into the
 * query text.
 */
export function metaArrayContainsPattern(key: 'entities' | 'topics', value: string): string {
    const needle = escapeRegexLiteral(JSON.stringify(value));
    return `[{,]\\s*"${key}"\\s*:\\s*\\[\\s*(?:${JSON_ELEM}\\s*,\\s*)*${needle}\\s*[,\\]]`;
}
