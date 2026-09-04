/**
 * collectionsFilterScope.ts — F-COL5: the unscoped-write guard's classifier.
 *
 * SOURCE OF TRUTH for "is this filter safe to run a destructive op with?".
 * Split out of collections.ts (800-line cap) so the guard has one obvious
 * home; collections.ts re-exports `isAllFilter` for existing importers.
 *
 * The compiler in `engines/whereClause.ts` decides SQL well-formedness and
 * nothing else — it will happily emit `NOT (0 = 1)`. This module decides
 * whether the resulting predicate is a tautology BY CONSTRUCTION, and must
 * be kept in step with that compiler's constants (see its header).
 */

import { MAX_FILTER_NESTING, isFilterAnd, isFilterNot, isFilterOr } from '../../engines/collectionStorage.js';
import type { Filter, FilterNode } from '../../engines/collectionStorage.js';

/**
 * F-COL1: a contains/startsWith entry whose value is empty or
 * whitespace-only is NOT a real predicate — it compiles to LIKE '%%'
 * (matches every row), so it must NOT count as scoping or it sneaks past
 * isAllFilter and silently wipes the collection.
 */
function isScopingTextGroup(g: Record<string, string> | undefined): boolean {
    return !!g && Object.values(g).some(v => typeof v === 'string' && v.trim().length > 0);
}

/**
 * F-COL5: how a filter subtree behaves against ANY table, independent of
 * the data in it.
 *
 * - `ALL`     — a tautology: matches every row. Destructive ops refuse it
 *               unless the caller passes `all: true`.
 * - `NONE`    — a contradiction: matches no row. Harmless for a
 *               destructive op, but its negation is a tautology.
 * - `SCOPED`  — narrows to a data-dependent subset. Allowed.
 * - `INVALID` — structurally malformed; `whereClause.ts` throws on it.
 *
 * `SCOPED` is deliberately *syntactic*: `{not:{eq:{id:'nonexistent'}}}` and
 * `{gte:{id:0}}` match every row of a particular table, but only because of
 * that table's data. Classifying them would require reading the rows, so
 * they stay allowed — the guard's contract is "no filter that is a
 * tautology by construction gets through", not "no filter ever matches
 * everything".
 */
export type FilterScope = 'ALL' | 'NONE' | 'SCOPED' | 'INVALID';

/**
 * Classify a leaf `Filter`. Leaf clauses are AND-combined, so a single
 * constant-false clause makes the whole leaf a contradiction.
 *
 * The constant-false leaf is `in: {field: []}`: `whereClause.ts` compiles
 * an empty IN list to the literal `0 = 1`. Before F-COL5 the guard never
 * saw it, so `{not:{in:{id:[]}}}` compiled to `WHERE NOT (0 = 1)` — TRUE
 * for every row — and wiped the collection with no `all: true`.
 */
function classifyLeafScope(filter: Filter): FilterScope {
    for (const values of Object.values(filter.in ?? {})) {
        if (Array.isArray(values) && values.length === 0) return 'NONE';
    }
    // F-COL1: text predicates only scope when at least one value is non-empty.
    // X-allrows (2026-09-03) — dropped a dead `endsWith` branch here: no
    // `Filter`/`FilterNode` type, zod schema (leafFilterZ/filterNodeZ,
    // collectionsFilterSchema.ts), or SQL compiler (engines/whereClause.ts)
    // this repo ships has ever implemented an `endsWith` operator, so the
    // branch could never actually run — the strict zod schemas at every
    // entry point reject an `endsWith` key as unrecognized before a filter
    // ever reaches this classifier. Keeping a phantom operator name here
    // risked exactly the opposite bug of what this module guards against:
    // silent disagreement with the compiler it must stay in lockstep with.
    // If `endsWith` is ever added, it must land in the zod schema and
    // `whereClause.ts` FIRST, then here — never here alone.
    if (isScopingTextGroup(filter.contains) || isScopingTextGroup(filter.startsWith)) return 'SCOPED';
    const groups = [filter.eq, filter.gt, filter.gte, filter.lt, filter.lte, filter.in];
    return groups.every(g => !g || Object.keys(g).length === 0) ? 'ALL' : 'SCOPED';
}

/**
 * Recursively classify a FilterNode (WP2 nested and/or/not) by boolean
 * algebra. Mirrors `compileSqliteNode` in `engines/whereClause.ts` — same
 * depth accounting, same treatment of empty branches — so the guard can
 * never disagree with the SQL that eventually runs.
 *
 * - NOT  inverts: NOT ALL = NONE, NOT NONE = ALL, NOT SCOPED = SCOPED.
 * - AND  is NONE if any branch is NONE; ALL only if every branch is ALL.
 * - OR   is ALL if any branch is ALL; NONE only if every branch is NONE.
 * - An `and`/`or` with no branches is INVALID (the compiler throws on it;
 *   the zod schema already rejects it on the MCP path, but the REST routes
 *   hand the body through unparsed).
 */
export function classifyFilterScope(filter: FilterNode | undefined, depth = 0): FilterScope {
    if (!filter) return 'ALL';
    if (depth > MAX_FILTER_NESTING) return 'INVALID';
    if (isFilterNot(filter)) {
        const inner = classifyFilterScope(filter.not, depth + 1);
        if (inner === 'ALL') return 'NONE';
        if (inner === 'NONE') return 'ALL';
        return inner; // SCOPED | INVALID
    }
    if (isFilterAnd(filter)) {
        if (filter.and.length === 0) return 'INVALID';
        const parts = filter.and.map(child => classifyFilterScope(child, depth + 1));
        if (parts.includes('INVALID')) return 'INVALID';
        if (parts.includes('NONE')) return 'NONE';
        return parts.every(p => p === 'ALL') ? 'ALL' : 'SCOPED';
    }
    if (isFilterOr(filter)) {
        if (filter.or.length === 0) return 'INVALID';
        const parts = filter.or.map(child => classifyFilterScope(child, depth + 1));
        if (parts.includes('INVALID')) return 'INVALID';
        if (parts.includes('ALL')) return 'ALL';
        return parts.every(p => p === 'NONE') ? 'NONE' : 'SCOPED';
    }
    return classifyLeafScope(filter as Filter);
}

/**
 * Returns true if the filter is "all" — a tautology by construction, so it
 * matches every row of every table. Rejected before destructive ops; use
 * `truncate` to wipe. Thin wrapper over `classifyFilterScope`; prefer that
 * when the caller also needs to distinguish INVALID.
 */
export function isAllFilter(filter: FilterNode | undefined): boolean {
    return classifyFilterScope(filter) === 'ALL';
}

/**
 * F-COL5: refuse a structurally invalid filter before it reaches the SQL
 * compiler. `whereClause.ts` throws on these (an `and`/`or` with no
 * branches, nesting past MAX_FILTER_NESTING) and the REST layer would map
 * that raw engine throw to a 500 `*_failed`; refusing here turns it into a
 * validation error.
 *
 * Round-E A3 fix: INVALID used to reuse the ALL branch's "empty/all filter"
 * wording so `classifyStorageErr` (routes/collections.ts) folded it into
 * the same 400 `all_filter_refused` response — including the "use
 * collection_truncate to wipe" advice. That is wrong: a filter can be
 * INVALID while targeting exactly one row (e.g. a single-row `eq` wrapped
 * in nine `and`s, past MAX_FILTER_NESTING) — truncate is never the fix for
 * that. The message below deliberately keeps the literal "structurally
 * invalid filter" phrase (unique to this branch) so `classifyStorageErr`
 * can route it to its own 400 `filter_invalid` instead, and it carries no
 * truncate/all-filter advice.
 *
 * QA round-2 (2026-09-03) — the message used to quote `and`/`or` in single
 * quotes ('and'/'or'). `mcpToolError` → `redactError` (security/logRedact.ts)
 * hashes every single-quoted token as a potential leaked node id, so an MCP
 * caller (e.g. `collection_update`/`collection_delete`) saw mangled
 * `id#<hash>` garbage in place of the operator names instead of readable
 * guidance. Backticks are not touched by that redaction pass, so the
 * operator names below use those instead of single quotes.
 *
 * Returns the scope so callers do not classify twice.
 */
export function assertValidFilter(op: string, filter: FilterNode | undefined): FilterScope {
    const scope = classifyFilterScope(filter);
    if (scope === 'INVALID') {
        throw new Error(
            `${op} refuses a structurally invalid filter — an and/or with no branches, `
            + `or nesting deeper than ${MAX_FILTER_NESTING} levels, is malformed and cannot be `
            + 'compiled to SQL. This is unrelated to whether the filter matches all rows: fix '
            + 'the filter shape, or flatten the nesting, and retry.',
        );
    }
    return scope;
}

/**
 * F-COL2: refuse an unscoped destructive op unless the caller explicitly
 * opts in with `all: true`. An absent/empty/all filter would otherwise
 * update or delete every row. Throws when the guard trips.
 *
 * ITEM collections-cycle (2026-09) — moved here from collections.ts
 * alongside `assertValidFilter`, which it wraps: both collections.ts's own
 * handleUpdate/handleDelete and collectionsByQuery.ts's handleUpdateByQuery
 * need it, and this module has no dependency on either, so both import it
 * one-way with no cycle.
 */
export function assertScopedOrAllOptIn(op: string, filter: FilterNode | undefined, all: boolean | undefined): void {
    const scope = assertValidFilter(op, filter);
    if (all !== true && scope === 'ALL') {
        throw new Error(`${op} refuses an empty/all filter — pass all:true to confirm an unscoped ${op}, or use collection_truncate.`);
    }
}
