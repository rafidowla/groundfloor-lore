/**
 * postgresPlanSql.ts - the FIXED SQL templates for query-plan steps (Tables P3, Postgres).
 *
 * Nothing from a plan is ever pasted into SQL text:
 *   - table and column identifiers come from the catalogue (`TableMeta.view`, `ColumnDecl.name`) and are quoted;
 *   - aliases are plan-local labels - the SQL aliases are generated (`j0`, `j1`, ...);
 *   - every value is a bound parameter with an explicit cast; operators, functions and directions are chosen
 *     from closed switch tables below.
 * The plan reaches this module only as a `ValidPlan` (planValidator.ts).
 */

import type { ColumnDecl } from '../../contracts/tables.js';
import type { ColumnKind, MoneyBound, ValidMeasure, ValidOrderKey, ValidPredicate, ValidStep } from '../../query/planTypes.js';
import { decodePgValue, encodePgValue, selectExpr } from './postgresTableCodec.js';
import { CURRENCY_SUFFIX, PG_TYPE } from './postgresTableSchema.js';
import type { TableMeta } from './postgresTableCatalog.js';
import { qi } from './postgresTableViews.js';

export interface BuiltQuery { text: string; params: unknown[] }
export interface OutColumn { key: string; decode: (v: unknown) => unknown }

class Params {
    readonly values: unknown[] = [];
    /** Bind `v` and return its placeholder with a type cast (`$3::bigint`). */
    add(v: unknown, cast: string): string {
        this.values.push(v);
        return `$${this.values.length}::${cast}`;
    }
}

interface Src { alias: string; sql: string; meta: TableMeta }

export interface Relation {
    from: string;
    where: string[];
    params: Params;
    srcs: Src[];
    agg?: { groupExprs: Array<{ key: string; expr: string; kind: ColumnKind }>; measures: Array<{ m: ValidMeasure; expr: string; kind: ColumnKind | 'money' | null; money?: MoneyMeasure }>; having: string[] };
}

/** A sum/avg/min/max over a money column: `expr` is the amount aggregate; these carry the currency half. */
export interface MoneyMeasure {
    /** `alias.field` of the money column (the key the validator uses). */
    key: string;
    /** Plain (un-aggregated) SQL for the amount and currency columns of the source. */
    col: string;
    cur: string;
    /** The group's single currency: `min(cur)` over the rows that carry an amount. */
    curAgg: string;
    /** True when the plan groups by this column's `__currency`, so every group is single-currency by construction. */
    groupedByCurrency: boolean;
}

const kindIn = (meta: TableMeta, field: string): ColumnKind | 'money' => {
    const c = meta.schema.columns.find((x: ColumnDecl) => x.name === field);
    if (c) return c.type;
    // `<money>__currency` is a text column of the read view.
    if (field.endsWith(CURRENCY_SUFFIX) && meta.schema.columns.some(x => x.type === 'money' && x.name + CURRENCY_SUFFIX === field)) return 'string';
    throw new Error(`plan references unknown column '${field}' (catalogue changed?)`);
};
const groupKind = (meta: TableMeta, field: string): ColumnKind => {
    const k = kindIn(meta, field);
    if (k === 'money') throw new Error(`plan groups by money column '${field}'; group by '${field}${CURRENCY_SUFFIX}'`);
    return k;
};
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, ch => `\\${ch}`);

/** The instant an `as_of` step resolves to (ISO, UTC). */
export function resolveAsOf(date: string, now: Date): string {
    return date === 'today' ? now.toISOString() : new Date(String(encodePgValue(date, 'datetime', 'as_of'))).toISOString();
}

const CMP = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/**
 * A comparison on a money column's AMOUNT. It only ever holds for rows in the literal's currency: `amount > 1000 USD`
 * is false for a CAD row, never a numeric comparison across currencies. `col`/`cur` are the amount and currency columns.
 */
function moneyPredicate(p: ValidPredicate, col: string, cur: string, params: Params): string {
    if (p.op === 'is_null') return `${col} IS NULL`;
    if (p.op === 'not_null') return `${col} IS NOT NULL`;
    if (p.op === 'in') {
        const m = p.money as MoneyBound[];
        return `EXISTS (SELECT 1 FROM unnest(${params.add(m.map(x => x.amount), 'numeric[]')}, ${params.add(m.map(x => x.currency), 'text[]')}) AS u(a, c) ` +
            `WHERE u.a = ${col} AND u.c = ${cur}::text)`;
    }
    const m = p.money as MoneyBound;
    return `(${cur}::text = ${params.add(m.currency, 'text')} AND ${col} ${CMP[p.op as keyof typeof CMP]} ${params.add(m.amount, 'numeric')})`;
}

function predicate(p: ValidPredicate, col: string, kind: ColumnKind | 'money', params: Params, cur?: string): string {
    if (kind === 'money') return moneyPredicate(p, col, cur!, params);
    const t = PG_TYPE[kind];
    switch (p.op) {
        case 'is_null': return `${col} IS NULL`;
        case 'not_null': return `${col} IS NOT NULL`;
        case 'eq': return `${col} = ${params.add(p.bound, t)}`;
        case 'neq': return `${col} <> ${params.add(p.bound, t)}`;
        case 'in': return `${col} = ANY(${params.add(p.bound, `${t}[]`)})`;
        case 'gt': case 'gte': case 'lt': case 'lte': {
            const lhs = kind === 'string' ? `${col} COLLATE "C"` : col;
            const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[p.op];
            return `${lhs} ${op} ${params.add(p.bound, t)}`;
        }
        case 'contains': return `${col} ILIKE ${params.add(`%${likeEscape(String(p.bound))}%`, 'text')} ESCAPE '\\'`;
        case 'starts_with': return `${col} ILIKE ${params.add(`${likeEscape(String(p.bound))}%`, 'text')} ESCAPE '\\'`;
    }
}

function moneyMeasure(alias: string, field: string, col: (alias: string, field: string) => string, groupExprs: Array<{ key: string }>): MoneyMeasure {
    const amount = col(alias, field), cur = col(alias, field + CURRENCY_SUFFIX);
    return {
        key: `${alias}.${field}`, col: amount, cur, curAgg: `min(${cur}) FILTER (WHERE ${amount} IS NOT NULL)`,
        groupedByCurrency: groupExprs.some(g => g.key === `${alias}.${field}${CURRENCY_SUFFIX}`),
    };
}

const aggExpr = (m: ValidMeasure, col: (alias: string, field: string) => string): string =>
    m.ref ? `${m.fn}(${col(m.ref.alias, m.ref.field)})` : 'count(*)';

/** Build the relation for the data steps (`filter`/`join`/`as_of`/`aggregate`) of `steps`; order/limit are ignored here. */
export function buildRelation(steps: readonly ValidStep[], tables: ReadonlyMap<string, TableMeta>, now: Date): Relation {
    const params = new Params();
    const srcs: Src[] = [];
    const byAlias = new Map<string, Src>();
    const where: string[] = [];
    let from = '';
    let asOf: string | undefined;
    const col = (alias: string, field: string): string => {
        const s = byAlias.get(alias);
        if (!s) throw new Error(`plan references unknown alias '${alias}'`);
        return `${s.sql}.${qi(field)}`;
    };
    const declare = (alias: string, type: string): Src => {
        const meta = tables.get(type);
        if (!meta) throw new Error(`plan references unknown type '${type}' (catalogue changed?)`);
        const s: Src = { alias, sql: `j${srcs.length}`, meta };
        srcs.push(s); byAlias.set(alias, s);
        return s;
    };
    let agg: Relation['agg'];
    for (const st of steps) {
        if (st.op === 'as_of') asOf = resolveAsOf(st.date, now);
        else if (st.op === 'filter') {
            if (st.type !== undefined) { const s = declare(st.alias, st.type); from = `${s.meta.view} ${s.sql}`; }
            const s = byAlias.get(st.alias)!;
            for (const p of st.where) where.push(predicate(p, `${s.sql}.${qi(p.field)}`, kindIn(s.meta, p.field), params, `${s.sql}.${qi(p.field + CURRENCY_SUFFIX)}`));
        } else if (st.op === 'join') {
            const left = byAlias.get(st.left.alias);
            if (!left) throw new Error(`plan references unknown alias '${st.left.alias}'`);
            const s = declare(st.alias, st.type);
            from += ` INNER JOIN ${s.meta.view} ${s.sql} ON ${left.sql}.${qi(st.left.field)} = ${s.sql}.${qi(st.rightField)}`;
        } else if (st.op === 'aggregate') {
            const groupExprs = st.groupBy.map(g => ({ key: `${g.alias}.${g.field}`, expr: col(g.alias, g.field), kind: groupKind(byAlias.get(g.alias)!.meta, g.field) }));
            agg = {
                groupExprs,
                measures: st.measures.map(m => {
                    const kind = m.ref ? kindIn(byAlias.get(m.ref.alias)!.meta, m.ref.field) : null;
                    const money = m.ref && kind === 'money' && m.fn !== 'count' ? moneyMeasure(m.ref.alias, m.ref.field, col, groupExprs) : undefined;
                    return { m, expr: aggExpr(m, col), kind, ...(money ? { money } : {}) };
                }),
                having: [],
            };
            for (const h of st.having) {
                const me = agg.measures.find(x => x.m.as === h.measure)!;
                const op = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', neq: '<>' }[h.op];
                if (h.money !== undefined && me.money) {
                    // The group's currency must be the threshold's; a group in another currency is never compared.
                    agg.having.push(`(${me.expr} ${op} ${params.add(h.money.amount, 'numeric')} AND ${me.money.curAgg} = ${params.add(h.money.currency, 'text')})`);
                } else agg.having.push(`${me.expr} ${op} ${params.add(h.value, 'numeric')}`);
            }
        }
    }
    // Valid time applies to EVERY source, wherever the as_of step sits in the plan (the last one wins).
    if (asOf !== undefined) {
        for (const s of srcs) {
            where.push(`(${s.sql}._lore_valid_from IS NULL OR ${s.sql}._lore_valid_from <= ${params.add(asOf, 'timestamptz')})`);
            where.push(`(${s.sql}._lore_valid_to IS NULL OR ${s.sql}._lore_valid_to > ${params.add(asOf, 'timestamptz')})`);
        }
    }
    return { from, where, params, srcs, agg };
}

export const whereSql = (r: Relation): string => (r.where.length > 0 ? ` WHERE ${r.where.join(' AND ')}` : '');
export const groupBySql = (r: Relation): string =>
    r.agg && r.agg.groupExprs.length > 0 ? ` GROUP BY ${r.agg.groupExprs.map(g => g.expr).join(', ')}` : '';
const groupSql = (r: Relation): string =>
    r.agg ? `${r.agg.groupExprs.length > 0 ? ` GROUP BY ${r.agg.groupExprs.map(g => g.expr).join(', ')}` : ''}${r.agg.having.length > 0 ? ` HAVING ${r.agg.having.join(' AND ')}` : ''}` : '';

/** `SELECT count(*)` over at most `probe` rows of the relation (probe = cap + 1 detects an exceeded cap cheaply). */
export function countQuery(r: Relation, probe: number): BuiltQuery {
    const inner = r.agg ? r.agg.measures[0]!.expr : '1';
    const lim = r.params.add(probe, 'bigint');
    return { text: `SELECT count(*)::text AS n FROM (SELECT ${inner} FROM ${r.from}${whereSql(r)}${groupSql(r)} LIMIT ${lim}) s`, params: r.params.values };
}

function orderSql(r: Relation, order: readonly ValidOrderKey[] | undefined, byAlias: Map<string, Src>): string {
    const parts: string[] = [];
    for (const k of order ?? []) {
        const dir = k.dir === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST';
        if (k.kind === 'measure') {
            const me = r.agg!.measures.find(x => x.m.as === k.measure)!;
            if (me.money) parts.push(`${me.money.curAgg} ASC NULLS LAST`);
            parts.push(`${me.expr} ${dir}`);
        } else {
            const s = byAlias.get(k.alias)!;
            const kind = kindIn(s.meta, k.field);
            // Money orders by currency first, so rows in different currencies never interleave by raw amount.
            if (kind === 'money') parts.push(`${s.sql}.${qi(k.field + CURRENCY_SUFFIX)} ASC`);
            parts.push(`${s.sql}.${qi(k.field)}${kind === 'string' ? ' COLLATE "C"' : ''} ${dir}`);
        }
    }
    const tie = r.agg ? r.agg.groupExprs.map(g => g.expr) : r.srcs.map(s => `${s.sql}._lore_entity_id`);
    const all = [...parts, ...tie];
    return all.length > 0 ? ` ORDER BY ${all.join(', ')}` : '';
}

const numText = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n)) ? n : String(v);
};

/** The final row query: ordered, limited, with decoders per output column. */
export function rowsQuery(r: Relation, order: readonly ValidOrderKey[] | undefined, limit: number): BuiltQuery & { columns: OutColumn[] } {
    const byAlias = new Map(r.srcs.map(s => [s.alias, s] as const));
    const sel: string[] = [];
    const columns: OutColumn[] = [];
    const out = (key: string, expr: string, decode: (v: unknown) => unknown): void => {
        sel.push(`${expr} AS c${columns.length}`);
        columns.push({ key, decode });
    };
    if (r.agg) {
        for (const g of r.agg.groupExprs) out(g.key, selectExpr(g.expr, g.kind as ColumnDecl['type']), v => decodePgValue(v, g.kind as ColumnDecl['type']));
        for (const me of r.agg.measures) {
            if (me.money) {
                // Exact: amount aggregated as numeric and read as text; the currency is the group's single currency.
                out(me.m.as, `CASE WHEN ${me.expr} IS NULL THEN NULL ELSE jsonb_build_object('amount', ${me.expr}::text, 'currency', ${me.money.curAgg}::text) END`, v => decodePgValue(v, 'money'));
            } else if (me.m.fn === 'count') out(me.m.as, `${me.expr}::text`, numText);
            else if (me.m.fn === 'sum' || me.m.fn === 'avg') out(me.m.as, `${me.expr}::text`, numText);
            else out(me.m.as, selectExpr(me.expr, me.kind as ColumnDecl['type']), v => decodePgValue(v, me.kind as ColumnDecl['type']));
        }
    } else {
        for (const s of r.srcs) {
            for (const c of s.meta.schema.columns) {
                const cur = c.type === 'money' ? `${s.sql}.${qi(c.name + CURRENCY_SUFFIX)}` : undefined;
                out(`${s.alias}.${c.name}`, selectExpr(`${s.sql}.${qi(c.name)}`, c.type, cur), v => decodePgValue(v, c.type));
            }
            out(`${s.alias}._entity_id`, `${s.sql}._lore_entity_id`, v => decodePgValue(v, 'integer'));
            out(`${s.alias}._memory_node_id`, `${s.sql}._lore_memory_node_id`, v => v ?? null);
            out(`${s.alias}._source_id`, `${s.sql}._lore_source_id`, v => v ?? null);
        }
    }
    const lim = r.params.add(limit, 'bigint');
    const text = `SELECT ${sel.join(', ')} FROM ${r.from}${whereSql(r)}${groupSql(r)}${orderSql(r, order, byAlias)} LIMIT ${lim}`;
    return { text, params: r.params.values, columns };
}
