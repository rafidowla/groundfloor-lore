/**
 * postgresTableWhere.ts - FilterNode -> parameterised Postgres WHERE ($n placeholders).
 *
 * Port of `compileSqliteNode`/`compileSqliteLeaf` (whereClause.ts) with the same
 * guards: nesting cap, empty and[]/or[] refused, whitespace-only contains/
 * startsWith skipped, empty `in` list = `0 = 1`, identifiers validated.
 * Differences from SQLite: LIKE is case-sensitive (Postgres semantics, reported
 * via capabilities().caseSensitiveContains), range operators on string columns
 * use COLLATE "C" (byte order, as SQLite does), and values are typed-parsed so
 * a bad value for a typed column throws instead of silently matching nothing.
 */

import {
    MAX_FILTER_NESTING, isFilterAnd, isFilterNot, isFilterOr, type Filter, type FilterNode,
} from '../collectionStorage.js';
import { assertIdent } from '../whereClause.js';
import type { ColumnType } from '../../contracts/tables.js';
import { encodePgValue, type Encoded } from './postgresTableCodec.js';

export interface PgWhereOptions {
    /** Column reference SQL for a validated column name (default: quoted, unqualified). */
    qualify?: (column: string) => string;
    /** Declared type of a column, when known (drives value parsing + collation). */
    typeOf?: (column: string) => ColumnType | undefined;
    /** Number of params already bound before this clause. */
    startAt?: number;
}

export interface PgWhere {
    where: string;
    params: Encoded[];
}

function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, ch => `\\${ch}`);
}

export function buildPgWhere(filter: FilterNode | undefined, opts: PgWhereOptions = {}): PgWhere {
    if (!filter) return { where: '', params: [] };
    const params: Encoded[] = [];
    const sql = compileNode(filter, 0, opts, params);
    return { where: sql.length > 0 ? `WHERE ${sql}` : '', params };
}

const branch = (sql: string): string => (sql.length > 0 ? sql : '1 = 1');

function compileNode(node: FilterNode, depth: number, opts: PgWhereOptions, params: Encoded[]): string {
    if (depth > MAX_FILTER_NESTING) throw new Error('filter_too_nested');
    if (isFilterAnd(node)) {
        if (node.and.length === 0) throw new Error('empty and[] is not allowed');
        return `(${node.and.map(c => branch(compileNode(c, depth + 1, opts, params))).join(' AND ')})`;
    }
    if (isFilterOr(node)) {
        if (node.or.length === 0) throw new Error('empty or[] is not allowed');
        return `(${node.or.map(c => branch(compileNode(c, depth + 1, opts, params))).join(' OR ')})`;
    }
    if (isFilterNot(node)) return `NOT (${branch(compileNode(node.not, depth + 1, opts, params))})`;
    return compileLeaf(node, opts, params);
}

function compileLeaf(filter: Filter, opts: PgWhereOptions, params: Encoded[]): string {
    const base = opts.startAt ?? 0;
    const col = (k: string): string => {
        assertIdent(k);
        return opts.qualify ? opts.qualify(k) : `"${k}"`;
    };
    const bind = (k: string, v: unknown): string => {
        const t = opts.typeOf?.(k);
        params.push(t !== undefined ? encodePgValue(v, t, `filter value for '${k}'`) : (v as Encoded) ?? null);
        return `$${base + params.length}`;
    };
    // String range compares are byte-ordered, matching SQLite's default BINARY collation.
    const ranged = (k: string): string => (opts.typeOf?.(k) === 'string' ? `${col(k)} COLLATE "C"` : col(k));
    const clauses: string[] = [];

    for (const [k, v] of Object.entries(filter.eq ?? {})) clauses.push(`${col(k)} = ${bind(k, v)}`);
    for (const [k, v] of Object.entries(filter.contains ?? {})) {
        if (typeof v === 'string' && v.trim().length === 0) continue;
        params.push(`%${escapeLike(String(v))}%`);
        clauses.push(`${col(k)}::text LIKE $${base + params.length} ESCAPE '\\'`);
    }
    for (const [k, v] of Object.entries(filter.startsWith ?? {})) {
        if (typeof v === 'string' && v.trim().length === 0) continue;
        params.push(`${escapeLike(String(v))}%`);
        clauses.push(`${col(k)}::text LIKE $${base + params.length} ESCAPE '\\'`);
    }
    for (const [k, v] of Object.entries(filter.gt ?? {})) clauses.push(`${ranged(k)} > ${bind(k, v)}`);
    for (const [k, v] of Object.entries(filter.gte ?? {})) clauses.push(`${ranged(k)} >= ${bind(k, v)}`);
    for (const [k, v] of Object.entries(filter.lt ?? {})) clauses.push(`${ranged(k)} < ${bind(k, v)}`);
    for (const [k, v] of Object.entries(filter.lte ?? {})) clauses.push(`${ranged(k)} <= ${bind(k, v)}`);
    for (const [k, values] of Object.entries(filter.in ?? {})) {
        const vals = values as unknown[];
        if (vals.length === 0) { void col(k); clauses.push('0 = 1'); continue; }
        clauses.push(`${col(k)} IN (${vals.map(x => bind(k, x)).join(', ')})`);
    }
    return clauses.join(' AND ');
}
