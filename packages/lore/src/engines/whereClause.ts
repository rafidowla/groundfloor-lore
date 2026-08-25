/**
 * whereClause.ts — ONE guarded Filter→WHERE translator (SW-01).
 *
 * Single source of truth for turning a substrate-portable `Filter` into a
 * parameterised WHERE clause. Replaces four copy-pasted `buildWhereClause`
 * implementations (kuzuAnalyticalStorage, kuzuCollectionStorage,
 * kuzuTableStorage, sqliteTableStorage) — three of which skipped the
 * identifier guard, leaving Cypher-injection vectors A1/A2/A3 open
 * (a hostile filter KEY or field name could break out of the clause and
 * append `DETACH DELETE n`).
 *
 * SECURITY — why the guard lives here:
 *   Neither Kùzu nor SQLite has a parameter slot for *identifiers*. VALUES
 *   bind through `$param` / `?`, but filter KEYS (column names), sort keys,
 *   key fields, and table/rel labels are always string-interpolated. The
 *   only safe interpolation is one whose input has been validated against a
 *   strict allowlist. `assertIdent` is that allowlist; every interpolated
 *   identifier across the storage builders MUST route through it.
 *
 * Dialect is parameterised:
 *   - 'cypher' → value placeholders are `$p0`, `$p1`, … and params is a
 *     keyed object (Kùzu's prepared-statement shape).
 *   - 'sqlite' → value placeholders are positional `?` and params is an
 *     ordered array (better-sqlite3's shape).
 */

import type { Filter } from './collectionStorage.js';

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
 * Build a Cypher WHERE clause (Kùzu). Every filter key is validated through
 * `assertIdent` before interpolation; values bind to `${paramPrefix}<n>`.
 */
export function buildCypherWhere(
    filter: Filter | undefined,
    alias: string,
    paramPrefix: string,
): CypherWhere {
    if (!filter) return { where: '', params: {} };
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
    filter: Filter | undefined,
    opts?: { alias?: string; encode?: ValueEncoder },
): SqliteWhere {
    if (!filter) return { where: '', params: [] };
    const alias = opts?.alias;
    const encode = opts?.encode ?? ((_k: string, v: unknown) => v);
    const clauses: string[] = [];
    const params: unknown[] = [];
    // SECURITY (SW-01): validate + quote every key. The alias prefix is
    // fixed code (l./r. on joins), not caller input.
    const col = (k: string) => alias ? `${alias}."${assertIdent(k)}"` : `"${assertIdent(k)}"`;

    for (const [k, v] of Object.entries(filter.eq ?? {})) {
        clauses.push(`${col(k)} = ?`); params.push(encode(k, v));
    }
    for (const [k, v] of Object.entries(filter.contains ?? {})) {
        // F-COL1: empty/whitespace value → LIKE '%%' matches all — skip it.
        if (typeof v === 'string' && v.trim().length === 0) continue;
        clauses.push(`${col(k)} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(String(v))}%`);
    }
    for (const [k, v] of Object.entries(filter.startsWith ?? {})) {
        if (typeof v === 'string' && v.trim().length === 0) continue; // F-COL1
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
            // IN with empty list matches nothing — validate the key first
            // so a hostile key still throws rather than silently passing.
            void col(k);
            clauses.push('0 = 1');
            continue;
        }
        const placeholders = vals.map(() => '?').join(', ');
        clauses.push(`${col(k)} IN (${placeholders})`);
        params.push(...vals.map(x => encode(k, x)));
    }

    return {
        where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
        params,
    };
}

/**
 * Quote a SQLite identifier (validated). Centralised here so all SQLite
 * builders quote consistently with the WHERE builder.
 */
export function quoteSqliteIdent(name: string): string {
    return `"${assertIdent(name)}"`;
}
