/**
 * postgresPlanReview.ts - the "unreviewed" flag on plan results (design section 6.3).
 *
 * The exact label stays `exact`: the SQL answered the question over the values as stored. Separately, each row says
 * whether any value it rests on still needs review (flagged by the extractor, or confidence below the workspace
 * threshold, and not yet confirmed or corrected). The result header carries the counts. Additive fields only.
 *
 *   - A row of a plain (non-aggregate) plan rests on every column it shows, so it is flagged when ANY current value of
 *     its entities needs review.
 *   - A row of an aggregate rests on the values the plan referenced (filter, join, group and measure columns) for the
 *     entities in its group; it is flagged when any of those needs review.
 */

import type { PoolClient } from 'pg';
import type { AliasApplied, ResultRow, ReviewHeader, ValidStep } from '../../query/planTypes.js';
import { decodePgValue, selectExpr } from './postgresTableCodec.js';
import type { TableMeta } from './postgresTableCatalog.js';
import { buildRelation, type Relation } from './postgresPlanSql.js';
import { loadReviewThreshold, needsReviewSql } from './postgresTableReview.js';
import { TABLE_TABLES } from './postgresTableSchema.js';

const VALUE = TABLE_TABLES.value;

/** Referenced (non-header) field ids per plan alias. */
function referenced(steps: readonly ValidStep[], rel: Relation): Map<string, number[]> {
    const names = new Map<string, Set<string>>();
    const use = (alias: string, field: string): void => { (names.get(alias) ?? names.set(alias, new Set()).get(alias)!).add(field); };
    for (const st of steps) {
        if (st.op === 'filter') st.where.forEach(p => use(st.alias, p.field));
        else if (st.op === 'join') { use(st.left.alias, st.left.field); use(st.alias, st.rightField); }
        else if (st.op === 'aggregate') {
            st.groupBy.forEach(g => use(g.alias, g.field));
            st.measures.forEach(m => { if (m.ref) use(m.ref.alias, m.ref.field); });
        }
    }
    const out = new Map<string, number[]>();
    for (const s of rel.srcs) {
        const ids = [...(names.get(s.alias) ?? [])].map(n => s.meta.fields.get(n)).filter(f => f && !f.header).map(f => f!.fieldId);
        if (ids.length > 0) out.set(s.alias, ids);
    }
    return out;
}

/** Mark `rows` (mutating them) and return the additive result fields. `steps` are the data steps that produced the rows. */
export async function flagUnreviewed(
    client: PoolClient, workspace: string, tables: ReadonlyMap<string, TableMeta>, steps: readonly ValidStep[], now: Date,
    rows: ResultRow[], applied: AliasApplied[],
): Promise<{ review: ReviewHeader; aliasesApplied?: AliasApplied[] }> {
    const threshold = await loadReviewThreshold(client, workspace);
    const rel = buildRelation(steps, tables, now);
    const flags = rel.agg ? await aggregateFlags(client, workspace, rel, referenced(steps, rel), threshold, rows) : await entityFlags(client, workspace, rel, threshold, rows);
    let n = 0;
    rows.forEach((r, i) => { r.unreviewed = flags[i] === true; if (r.unreviewed) n++; });
    return { review: { threshold, unreviewedRows: n, totalRows: rows.length }, ...(applied.length > 0 ? { aliasesApplied: applied } : {}) };
}

async function entityFlags(client: PoolClient, workspace: string, rel: Relation, threshold: number, rows: ResultRow[]): Promise<boolean[]> {
    const ids = new Set<string>();
    const idsOf = (r: ResultRow): string[] => rel.srcs.map(s => r.values[`${s.alias}._entity_id`]).filter(v => v !== null && v !== undefined).map(String);
    rows.forEach(r => idsOf(r).forEach(id => ids.add(id)));
    if (ids.size === 0) return rows.map(() => false);
    const q = await client.query(
        `SELECT DISTINCT v.entity_id::text AS id FROM ${VALUE} v WHERE v.workspace_id = $1 AND v.entity_id = ANY($2::bigint[]) AND ${needsReviewSql('v', '$3::float8')}`,
        [workspace, [...ids], threshold]);
    const flagged = new Set((q.rows as Array<{ id: string }>).map(x => x.id));
    return rows.map(r => idsOf(r).some(id => flagged.has(id)));
}

async function aggregateFlags(client: PoolClient, workspace: string, rel: Relation, refs: Map<string, number[]>, threshold: number, rows: ResultRow[]): Promise<boolean[]> {
    if (refs.size === 0) return rows.map(() => false);
    const agg = rel.agg!;
    const w = rel.params.add(workspace, 'text');
    const t = rel.params.add(threshold, 'float8');
    const exists = rel.srcs.filter(s => refs.has(s.alias)).map(s =>
        `EXISTS (SELECT 1 FROM ${VALUE} v WHERE v.workspace_id = ${w} AND v.entity_id = ${s.sql}._lore_entity_id AND v.field_id = ANY(${rel.params.add(refs.get(s.alias), 'bigint[]')}) AND ${needsReviewSql('v', t)})`);
    const groups = agg.groupExprs.map((g, i) => ({ g, sel: `${selectExpr(g.expr, g.kind as Parameters<typeof selectExpr>[1])} AS g${i}` }));
    const sel = [...groups.map(x => x.sel), `bool_or(${exists.join(' OR ')}) AS flagged`];
    const where = rel.where.length > 0 ? ` WHERE ${rel.where.join(' AND ')}` : '';
    const group = agg.groupExprs.length > 0 ? ` GROUP BY ${agg.groupExprs.map(g => g.expr).join(', ')}` : '';
    // HAVING stays: every parameter bound while building the relation must be used, and only surviving groups matter.
    const having = agg.having.length > 0 ? ` HAVING ${agg.having.join(' AND ')}` : '';
    const q = await client.query(`SELECT ${sel.join(', ')} FROM ${rel.from}${where}${group}${having}`, rel.params.values);
    const key = (vals: unknown[]): string => JSON.stringify(vals);
    const flagged = new Set<string>();
    for (const row of q.rows as Array<Record<string, unknown>>) {
        if (row['flagged'] === true) flagged.add(key(groups.map((x, i) => decodePgValue(row[`g${i}`], x.g.kind as Parameters<typeof decodePgValue>[1]))));
    }
    return rows.map(r => flagged.has(key(agg.groupExprs.map(g => r.values[g.key]))));
}
