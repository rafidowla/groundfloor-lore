/**
 * whereClause.ts — ONE guarded Filter→WHERE translator (SW-01).
 *
 * Single source of truth for turning a substrate-portable `Filter` into a
 * parameterised WHERE clause. Replaces four copy-pasted `buildWhereClause`
 * implementations across the legacy graph/analytical/table storage adapters
 * and `sqliteTableStorage` — three of which skipped the
 * identifier guard, leaving Cypher-injection vectors A1/A2/A3 open
 * (a hostile filter KEY or field name could break out of the clause and
 * append `DETACH DELETE n`).
 *
 * SECURITY — why the guard lives here:
 *   Neither the Cypher dialect nor SQLite has a parameter slot for *identifiers*. VALUES
 *   bind through `$param` / `?`, but filter KEYS (column names), sort keys,
 *   key fields, and table/rel labels are always string-interpolated. The
 *   only safe interpolation is one whose input has been validated against a
 *   strict allowlist. `assertIdent` is that allowlist; every interpolated
 *   identifier across the storage builders MUST route through it.
 *
 * Dialect is parameterised:
 *   - 'cypher' → value placeholders are `$p0`, `$p1`, … and params is a
 *     keyed object (the Cypher dialect's prepared-statement shape).
 *   - 'sqlite' → value placeholders are positional `?` and params is an
 *     ordered array (better-sqlite3's shape).
 *
 * LAYERING — who owns which decision (F-COL5, 2026-09-03):
 *   This compiler owns SQL WELL-FORMEDNESS ONLY. It compiles every filter
 *   the type system admits into valid, parameterised SQL — including the
 *   two constant clauses below — and throws only on shapes that have no
 *   SQL rendering at all (an `and`/`or` with no branches, nesting past
 *   MAX_FILTER_NESTING).
 *
 *     - an empty leaf (`{}` / `{eq:{}}`) is the constant TRUE. At the top
 *       level it stays '' (no WHERE), which the engine's own
 *       update/delete backstop reads as "unscoped" and refuses; INSIDE a
 *       boolean node it must be spelled out as `1 = 1` or the join emits
 *       malformed SQL like `()` / `( OR "id" = ?)`.
 *     - an empty IN list (`in: {id: []}`) is the constant FALSE `0 = 1`.
 *       Kept (rather than refused) because an empty candidate list is a
 *       legitimate read query that should return zero rows.
 *
 *   WHETHER a well-formed clause is SAFE for a destructive op is NOT
 *   decided here. That is `classifyFilterScope` in
 *   `mcp/tools/collections.ts`, which is the single source of truth for
 *   the unscoped-write guard: it classifies the same tree as
 *   ALL/NONE/SCOPED/INVALID under the same rules as this file, so
 *   `NOT (0 = 1)` — a tautology built out of two constants — is caught as
 *   ALL and refused without `all: true`. Change the constants here and you
 *   must change that classifier in the same commit.
 */

import {
    MAX_FILTER_NESTING,
    isFilterAnd,
    isFilterNot,
    isFilterOr,
    type Filter,
    type FilterNode,
} from './collectionStorage.js';

/**
 * Validate a table / column / identifier before it is interpolated into a
 * query string. Allowlist is intentionally narrow: a leading letter or
 * underscore, then letters/digits/underscores. Anything else (parentheses,
 * spaces, semicolons, dots, comment markers) is rejected — those are the
 * characters an injection needs to break out of the clause.
 *
 * Returns the name unchanged when valid so callers can write
 * `n.${assertIdent(k)}` inline.
 *
 * The error message ("invalid identifier") is matched verbatim by the
 * SP-05 and SW-01 regression suites — do not reword without updating them.
 */
export function assertIdent(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`Lore query builder: invalid identifier '${name}'`);
    }
    return name;
}

export type WhereDialect = 'cypher' | 'sqlite';

export interface CypherWhere {
    where: string;
    params: Record<string, unknown>;
}

export interface SqliteWhere {
    where: string;
    params: unknown[];
}

/**
 * Encode a comparison value before binding. SQLite callers pass a function
 * (e.g. to coerce booleans → 0/1 / objects → JSON) keyed by the *validated*
 * column name; Cypher callers bind values verbatim.
 */
export type ValueEncoder = (key: string, value: unknown) => unknown;

/**
 * Escape LIKE wildcards for SQLite `contains` / `startsWith`. Mirrors the
 * previous sqliteTableStorage.escapeLike so behaviour is unchanged.
 */
function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/**
 * Build a Cypher WHERE clause. Every filter key is validated through
 * `assertIdent` before interpolation; values bind to `${paramPrefix}<n>`.
 */
export function buildCypherWhere(
    filter: Filter | undefined,
    alias: string,
    paramPrefix: string,
): CypherWhere {
    if (!filter) return { where: '', params: {} };
    if (isFilterAnd(filter) || isFilterOr(filter) || isFilterNot(filter)) {
        throw new Error('filter_too_nested');
    }
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    let i = 0;
    const next = () => `${paramPrefix}${i++}`;
    // SECURITY (SW-01): validate every key — keys are interpolated, values
    // are parameterised. An unvalidated key injects raw Cypher.
    const col = (k: string) => `${alias}.${assertIdent(k)}`;

    for (const [k, v] of Object.entries(filter.eq ?? {})) {
        const p = next(); clauses.push(`${col(k)} = $${p}`); params[p] = v;
    }
    for (const [k, v] of Object.entries(filter.contains ?? {})) {
        // F-COL1: empty/whitespace value matches everything — skip it so it
        // never becomes an accidental all-rows predicate.
        if (typeof v === 'string' && v.trim().length === 0) continue;
        const p = next(); clauses.push(`${col(k)} CONTAINS $${p}`); params[p] = v;
    }
    for (const [k, v] of Object.entries(filter.startsWith ?? {})) {
        if (typeof v === 'string' && v.trim().length === 0) continue; // F-COL1
        const p = next(); clauses.push(`${col(k)} STARTS WITH $${p}`); params[p] = v;
    }
    for (const [k, v] of Object.entries(filter.gt ?? {})) {
        const p = next(); clauses.push(`${col(k)} > $${p}`); params[p] = v;
    }
    for (const [k, v] of Object.entries(filter.gte ?? {})) {
        const p = next(); clauses.push(`${col(k)} >= $${p}`); params[p] = v;
    }
    for (const [k, v] of Object.entries(filter.lt ?? {})) {
        const p = next(); clauses.push(`${col(k)} < $${p}`); params[p] = v;
    }
    for (const [k, v] of Object.entries(filter.lte ?? {})) {
        const p = next(); clauses.push(`${col(k)} <= $${p}`); params[p] = v;
    }
    for (const [k, v] of Object.entries(filter.in ?? {})) {
        const p = next(); clauses.push(`${col(k)} IN $${p}`); params[p] = v;
    }

    return {
        where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
        params,
    };
}

/**
 * Build a SQLite WHERE clause. Every filter key is validated + quoted; an
 * optional `alias` prefixes the (fixed, non-user) join side. Values bind as
 * positional `?` in clause order, encoded via the optional `encode` hook.
 */
export function buildSqliteWhere(
    filter: FilterNode | undefined,
    opts?: { alias?: string; encode?: ValueEncoder; qualify?: (column: string) => string },
): SqliteWhere {
    if (!filter) return { where: '', params: [] };
    const compiled = compileSqliteNode(filter, 0, opts);
    return {
        where: compiled.sql.length > 0 ? `WHERE ${compiled.sql}` : '',
        params: compiled.params,
    };
}

/**
 * The constant TRUE. An empty leaf compiles to no clauses at all, which is
 * correct at the top level ('' → no WHERE) but malformed once it is a
 * branch of a boolean node: `{and:[{eq:{}}]}` produced `()` and
 * `{or:[{eq:{}},{eq:{id:'x'}}]}` produced `( OR "id" = ?)`, both SQLite
 * syntax errors. Spelling the branch out as `1 = 1` keeps the emitted SQL
 * valid AND semantically honest — an empty leaf really does match every
 * row, which is exactly what `classifyFilterScope` reports as ALL.
 */
const SQLITE_TRUE = '1 = 1';

/** Render a compiled child as a boolean branch, never as empty text. */
function branchSql(part: { sql: string }): string {
    return part.sql.length > 0 ? part.sql : SQLITE_TRUE;
}

function compileSqliteNode(
    node: FilterNode,
    depth: number,
    opts?: { alias?: string; encode?: ValueEncoder; qualify?: (column: string) => string },
): { sql: string; params: unknown[] } {
    if (depth > MAX_FILTER_NESTING) {
        throw new Error('filter_too_nested');
    }
    if (isFilterAnd(node)) {
        if (node.and.length === 0) {
            throw new Error('empty and[] is not allowed');
        }
        const parts = node.and.map(child => compileSqliteNode(child, depth + 1, opts));
        return {
            sql: `(${parts.map(branchSql).join(' AND ')})`,
            params: parts.flatMap(part => part.params),
        };
    }
    if (isFilterOr(node)) {
        if (node.or.length === 0) {
            throw new Error('empty or[] is not allowed');
        }
        const parts = node.or.map(child => compileSqliteNode(child, depth + 1, opts));
        return {
            sql: `(${parts.map(branchSql).join(' OR ')})`,
            params: parts.flatMap(part => part.params),
        };
    }
    if (isFilterNot(node)) {
        // `{not:{}}` used to throw while the equivalent `{not:{and:[{eq:{}}]}}`
        // compiled — two renderings of the same filter. Both are now
        // `NOT (1 = 1)`, i.e. matches nothing, which is what the guard's
        // NONE classification says they mean.
        const inner = compileSqliteNode(node.not, depth + 1, opts);
        return { sql: `NOT (${branchSql(inner)})`, params: inner.params };
    }
    return compileSqliteLeaf(node, opts);
}

function compileSqliteLeaf(
    filter: Filter,
    opts?: { alias?: string; encode?: ValueEncoder; qualify?: (column: string) => string },
): { sql: string; params: unknown[] } {
    const alias = opts?.alias;
    const encode = opts?.encode ?? ((_k: string, v: unknown) => v);
    const clauses: string[] = [];
    const params: unknown[] = [];
    const col = (k: string) => {
        if (opts?.qualify) return opts.qualify(assertIdent(k));
        return alias ? `${alias}."${assertIdent(k)}"` : `"${assertIdent(k)}"`;
    };

    for (const [k, v] of Object.entries(filter.eq ?? {})) {
        clauses.push(`${col(k)} = ?`); params.push(encode(k, v));
    }
    for (const [k, v] of Object.entries(filter.contains ?? {})) {
        if (typeof v === 'string' && v.trim().length === 0) continue;
        clauses.push(`${col(k)} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(String(v))}%`);
    }
    for (const [k, v] of Object.entries(filter.startsWith ?? {})) {
        if (typeof v === 'string' && v.trim().length === 0) continue;
        clauses.push(`${col(k)} LIKE ? ESCAPE '\\'`);
        params.push(`${escapeLike(String(v))}%`);
    }
    for (const [k, v] of Object.entries(filter.gt ?? {})) {
        clauses.push(`${col(k)} > ?`); params.push(encode(k, v));
    }
    for (const [k, v] of Object.entries(filter.gte ?? {})) {
        clauses.push(`${col(k)} >= ?`); params.push(encode(k, v));
    }
    for (const [k, v] of Object.entries(filter.lt ?? {})) {
        clauses.push(`${col(k)} < ?`); params.push(encode(k, v));
    }
    for (const [k, v] of Object.entries(filter.lte ?? {})) {
        clauses.push(`${col(k)} <= ?`); params.push(encode(k, v));
    }
    for (const [k, values] of Object.entries(filter.in ?? {})) {
        const vals = values as unknown[];
        if (vals.length === 0) {
            // Constant FALSE — an empty candidate list matches nothing. Kept
            // (not refused) so a read query built from an empty list works.
            // `classifyFilterScope` mirrors this as NONE so its negation is
            // caught as ALL rather than sailing past the write guard (F-COL5).
            void col(k); // validate the identifier even though it is unused
            clauses.push('0 = 1');
            continue;
        }
        const placeholders = vals.map(() => '?').join(', ');
        clauses.push(`${col(k)} IN (${placeholders})`);
        params.push(...vals.map(x => encode(k, x)));
    }

    return { sql: clauses.join(' AND '), params };
}

/**
 * Quote a SQLite identifier (validated). Centralised here so all SQLite
 * builders quote consistently with the WHERE builder.
 */
export function quoteSqliteIdent(name: string): string {
    return `"${assertIdent(name)}"`;
}
