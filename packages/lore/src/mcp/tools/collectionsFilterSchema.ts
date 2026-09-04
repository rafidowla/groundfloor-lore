/**
 * Zod schemas for leaf Filter and nested FilterNode.
 * Kept out of collections.ts for the 800-line cap.
 *
 * QA round-3 (2026-09-03, finding A3) — this file's `leafFilterZ`/`filterNodeZ`
 * were the ONE place round-2's ".strict() the filter schema" fix (see
 * collectionsTransaction.ts's `filterZ`) did NOT reach: they back
 * `collection_update` / `collection_delete` / `collection_update_by_query` /
 * `collection_delete_by_query` (mcp/tools/collections.ts) and `collection_join_query`
 * (collectionsJoin.ts), and were still plain (non-strict) zod. A filter like
 * `{eqq:{id:'r1'}, eq:{status:'closed'}}` parsed successfully with `eqq`
 * silently stripped, leaving `{eq:{status:'closed'}}` — a caller who meant to
 * scope a bulk update/delete to one row instead mutated every row matching the
 * surviving predicate, with no error at all. `{and:[{eqx:{id:'r1'}}], eq:{...}}`
 * and a mis-cased `{EQ:{...}}` had the same hole (the whole intended branch
 * silently vanishes). Both `leafFilterZ` and every and/or/not object literal
 * inside `filterNodeZ` are now `.strict()`, so ANY unrecognized key anywhere in
 * the tree rejects the whole filter with a `ZodError` instead of silently
 * narrowing it. `describeFilterZodError` below turns that into a readable
 * `filter_invalid` message naming the offending key — mirrors
 * `describeTransactionFailure`'s `ZodError` branch (collectionsTransaction.ts).
 *
 * NOTE: `eq`/`gt`/`gte`/`lt`/`lte`/`in`/`contains`/`startsWith` stay
 * `z.record(...)` (unstructured) — their keys are caller-defined COLUMN names,
 * not a fixed operator vocabulary, so an unrecognized key inside one of those
 * records is not a typo class this schema can detect and is deliberately left
 * permissive (a bad column name still surfaces cleanly downstream when the
 * storage engine rejects an unknown column).
 */

import { z } from 'zod';
import type { Filter, FilterNode } from '../../engines/collectionStorage.js';

export const leafFilterZ = z.object({
    eq: z.record(z.string(), z.unknown()).optional(),
    contains: z.record(z.string(), z.string()).optional(),
    startsWith: z.record(z.string(), z.string()).optional(),
    gt: z.record(z.string(), z.unknown()).optional(),
    gte: z.record(z.string(), z.unknown()).optional(),
    lt: z.record(z.string(), z.unknown()).optional(),
    lte: z.record(z.string(), z.unknown()).optional(),
    in: z.record(z.string(), z.array(z.unknown())).optional(),
}).strict();

export const filterNodeZ: z.ZodType<FilterNode> = z.lazy(() =>
    z.union([
        z.object({ and: z.array(filterNodeZ).min(1) }).strict(),
        z.object({ or: z.array(filterNodeZ).min(1) }).strict(),
        z.object({ not: filterNodeZ }).strict(),
        leafFilterZ,
    ]),
);

export const optionalFilterNodeZ = filterNodeZ.optional();

export function parseFilterNode(value: unknown): FilterNode | undefined {
    if (value === undefined) return undefined;
    return filterNodeZ.parse(value);
}

export type ParsedLeafFilter = z.infer<typeof leafFilterZ> & Filter;

/* ------------------------------------------------------------------ */
/*  QA round-3 (2026-09-03) — readable filter_invalid error mapping    */
/* ------------------------------------------------------------------ */

interface ZodIssueLike {
    code: string;
    path: (string | number)[];
    keys?: string[];
    errors?: ZodIssueLike[][];
    origin?: string;
    minimum?: number;
}

interface UnrecognizedKeyHit {
    path: (string | number)[];
    keys: string[];
}

/**
 * Recursively walk a `ZodError`'s issue tree (descending into `invalid_union`
 * branches, since `filterNodeZ` is a union of and/or/not/leaf) collecting
 * every `unrecognized_keys` issue found anywhere, with its path made ABSOLUTE
 * (a sub-issue's `path` inside a union branch's `errors` is relative to that
 * branch, not to the root).
 */
function collectUnrecognizedKeyHits(
    issues: ZodIssueLike[],
    basePath: (string | number)[] = [],
): UnrecognizedKeyHit[] {
    const hits: UnrecognizedKeyHit[] = [];
    for (const issue of issues) {
        const absPath = [...basePath, ...issue.path];
        if (issue.code === 'unrecognized_keys' && issue.keys) {
            hits.push({ path: absPath, keys: issue.keys });
        }
        if (issue.code === 'invalid_union' && issue.errors) {
            for (const branch of issue.errors) {
                hits.push(...collectUnrecognizedKeyHits(branch, absPath));
            }
        }
    }
    return hits;
}

/**
 * An empty `and`/`or` array (`{and:[]}`, `{or:[]}`) fails `.min(1)` with a
 * `too_small` issue on that array, not `unrecognized_keys` — same
 * structurally-invalid shape `assertValidFilter` (collectionsFilterScope.ts)
 * already refuses post-parse for a filter that reaches the handler (e.g. an
 * MCP direct call bypassing this pre-parse). Recognizing it here too means
 * REST — which now rejects BEFORE the handler ever runs — keeps the same
 * `filter_invalid` code and a comparably useful message instead of falling
 * back to a generic "failed validation".
 */
function findEmptyAndOrPath(
    issues: ZodIssueLike[],
    basePath: (string | number)[] = [],
): (string | number)[] | null {
    for (const issue of issues) {
        const absPath = [...basePath, ...issue.path];
        if (issue.code === 'too_small' && issue.origin === 'array' && issue.minimum === 1) {
            const last = absPath[absPath.length - 1];
            if (last === 'and' || last === 'or') return absPath;
        }
        if (issue.code === 'invalid_union' && issue.errors) {
            for (const branch of issue.errors) {
                const found = findEmptyAndOrPath(branch, absPath);
                if (found) return found;
            }
        }
    }
    return null;
}

/**
 * Pick the single most-likely-intended hit out of every union branch's
 * failure. A DEEPER path pinpoints a more specific failure location (e.g. an
 * `and[0]` typo over the top-level "this whole object didn't match any
 * branch" noise); at the same depth, FEWER unrecognized keys means that
 * branch recognized more of the caller's input — i.e. it's the branch the
 * caller actually meant to use (e.g. the leaf branch recognizing `eq` while
 * only flagging the typo'd `eqq`, versus the and/or/not branches flagging
 * both as unrecognized because they don't have either key).
 */
function pickMostLikelyHit(hits: UnrecognizedKeyHit[]): UnrecognizedKeyHit | null {
    if (hits.length === 0) return null;
    let best = hits[0]!;
    for (const hit of hits.slice(1)) {
        if (hit.path.length > best.path.length) best = hit;
        else if (hit.path.length === best.path.length && hit.keys.length < best.keys.length) best = hit;
    }
    return best;
}

function formatFilterPath(path: (string | number)[]): string {
    if (path.length === 0) return 'the top level';
    return path.map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : (i === 0 ? seg : `.${seg}`))).join('');
}

/**
 * Turn a `ZodError` thrown by `filterNodeZ`/`leafFilterZ` (or a larger schema
 * that embeds one, e.g. `joinQueryBodyZ`) into a readable `filter_invalid`
 * message naming the offending key and its location. Returns `null` when the
 * error contains no `unrecognized_keys` issue (e.g. a wrong-typed `and`
 * value) — callers should fall back to a generic invalid-request message in
 * that case rather than claiming a specific bad key.
 */
export function describeFilterZodError(error: z.ZodError): { code: 'filter_invalid'; message: string } | null {
    const issues = error.issues as unknown as ZodIssueLike[];
    const hit = pickMostLikelyHit(collectUnrecognizedKeyHits(issues));
    if (hit) {
        const keys = hit.keys.map((k) => `"${k}"`).join(', ');
        return {
            code: 'filter_invalid',
            message: `filter refuses unsupported key(s) ${keys} at ${formatFilterPath(hit.path)} `
                + '— filters accept only eq/contains/startsWith/gt/gte/lt/lte/in leaves, '
                + 'optionally combined with and/or/not.',
        };
    }
    const emptyAndOrPath = findEmptyAndOrPath(issues);
    if (emptyAndOrPath) {
        return {
            code: 'filter_invalid',
            message: `filter refuses a structurally invalid \`${emptyAndOrPath[emptyAndOrPath.length - 1]}\` `
                + `at ${formatFilterPath(emptyAndOrPath)} with no branches — an and/or must list at least one filter.`,
        };
    }
    return null;
}

/**
 * MCP tool error envelope for a caught `ZodError` from `filterNodeZ.parse`.
 * Shared by `collection_update`/`collection_delete`/`collection_update_by_query`/
 * `collection_delete_by_query` (mcp/tools/collections.ts) so the 800-line file
 * cap there doesn't force choosing between this and readability.
 */
export function filterInvalidMcpEnvelope(
    e: z.ZodError,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    const detail = describeFilterZodError(e) ?? {
        code: 'filter_invalid' as const,
        message: 'filter failed validation — filters accept only eq/contains/startsWith/gt/gte/lt/lte/in leaves, optionally combined with and/or/not.',
    };
    return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: detail.code, message: detail.message }, null, 2) }],
        isError: true,
    };
}
