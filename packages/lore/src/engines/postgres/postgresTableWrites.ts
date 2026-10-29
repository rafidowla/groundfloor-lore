/**
 * postgresTableWrites.ts - set-based write primitives for PostgresTableStorage.
 *
 * Every function runs on a caller-supplied client INSIDE a caller-owned
 * transaction, so a multi-op `runTransaction` is all-or-nothing and the
 * single-op methods share the exact same guarded paths.
 *
 *  - insert: one `unnest` statement for the entity headers, one for all values.
 *  - update: resolve target entity ids through the READ view (so the filter has
 *    the same meaning as in `query`), lock them, then per patched field SUPERSEDE
 *    the current value row (recorded-time history) and insert the new one. The
 *    supersede runs as its own statement first, so the partial unique index
 *    (one current value per entity+field) is never violated mid-statement.
 *  - delete: hard delete of the entity header; values cascade.
 */

import type { PoolClient } from 'pg';
import type { ColumnType, DestructiveWriteOptions, Row, TableOp, TableOpResult } from '../../contracts/tables.js';
import { MAX_TABLE_TX_OPS } from '../../contracts/tables.js';
import type { FilterNode } from '../collectionStorage.js';
import { encodePgValue, splitMoney, type Encoded } from './postgresTableCodec.js';
import { TABLE_TABLES, VALUE_COLUMN, PG_TYPE, CURRENCY_COLUMN } from './postgresTableSchema.js';
import {
    PROVENANCE_COLUMNS, assertProvenanceTargets, provenanceBinds, type ProvenanceBinds, type ValueProvenance,
} from './postgresTableProvenance.js';
import type { TableMeta } from './postgresTableCatalog.js';
import { buildPgWhere } from './postgresTableWhere.js';
import { fieldIdOfIndexName } from './postgresFieldIndexName.js';

const L = 'PostgresTableStorage';
const { entity: ENTITY, value: VALUE } = TABLE_TABLES;
const CHUNK = 2000;

export interface WriteCtx {
    client: PoolClient;
    workspace: string;
    meta(table: string, op: string): TableMeta;
}

/** Map the table's unique-violation SQLSTATE onto SQLite-style wording callers already classify. */
export function mapPgWriteError(err: unknown, table: string, meta: TableMeta): unknown {
    const e = err as { code?: string; constraint?: string };
    if (e?.code !== '23505') return err;
    if (e.constraint === 'lore_entity_pk_uq') {
        return Object.assign(new Error(`UNIQUE constraint failed: ${table}.${meta.pk.name}`), { cause: err });
    }
    const fid = fieldIdOfIndexName(e.constraint ?? '', 'u'); // new `lore_ev_<hash>_<id>_u` or legacy `lore_ev_<id>_u`
    if (fid !== null) {
        const f = [...meta.fields.entries()].find(([, v]) => v.fieldId === fid);
        if (f) return Object.assign(new Error(`UNIQUE constraint failed: ${table}.${f[0]}`), { cause: err });
    }
    return err;
}

interface ValueEntry { fid: number; type: string; enc: Encoded; prov?: ProvenanceBinds }
interface PreparedRow { pk: string; header: Record<string, Encoded>; values: ValueEntry[]; key: unknown }

/** Per-column provenance for a write (column name -> provenance); absent = none, existing behaviour. */
export type ProvenanceByColumnInput = Record<string, ValueProvenance>;

function prepareRow(meta: TableMeta, table: string, row: Row, op: string, idx?: number, prov?: ProvenanceByColumnInput): PreparedRow {
    for (const k of Object.keys(row)) {
        if (!meta.fields.has(k)) throw new Error(`${L}.${op}: unknown column '${k}' on table '${table}'`);
    }
    if (Object.keys(row).length === 0) {
        throw new Error(`${L}.${op}: empty row for ${table}${idx === undefined ? '' : ` (row index ${idx})`}`);
    }
    const header: Record<string, Encoded> = {};
    const values: ValueEntry[] = [];
    const written = new Set<string>();
    let pk = '';
    for (const [name, f] of meta.fields) {
        const enc = encodePgValue(row[name], f.col.type, `column '${name}'`);
        if ((f.col.required || f.col.primary) && enc === null) {
            throw new Error(`NOT NULL constraint failed: ${table}.${name}`);
        }
        if (f.col.primary) pk = String(enc);
        if (enc === null) continue;
        if (f.header) header[f.header] = enc;
        else {
            values.push({ fid: f.fieldId, type: f.col.type, enc, ...(prov?.[name] ? { prov: provenanceBinds(prov[name]!, name) } : {}) });
            written.add(name);
        }
    }
    assertProvenanceTargets(meta, table, written, prov, op);
    return { pk, header, values, key: row[meta.pk.name] };
}

export async function insertRows(ctx: WriteCtx, table: string, rows: Row[], op = 'insert', provenance?: Array<ProvenanceByColumnInput | undefined>): Promise<unknown[]> {
    const meta = ctx.meta(table, op);
    const prepared = rows.map((r, i) => prepareRow(meta, table, r, op, i, provenance?.[i]));
    try {
        for (let at = 0; at < prepared.length; at += CHUNK) {
            await insertChunk(ctx, meta, prepared.slice(at, at + CHUNK));
        }
    } catch (err) {
        throw mapPgWriteError(err, table, meta);
    }
    return prepared.map(p => p.key);
}

async function insertChunk(ctx: WriteCtx, meta: TableMeta, rows: PreparedRow[]): Promise<void> {
    const h = (r: PreparedRow, k: string): Encoded => r.header[k] ?? null;
    const ent = await ctx.client.query(
        `INSERT INTO ${ENTITY} (workspace_id, entity_type_id, pk_text, memory_node_id, memory_node_sk, valid_from, valid_to, source_id)
         SELECT $1, $2, u.pk, u.node, (SELECT n.sk FROM nodes n WHERE n.workspace_id = $1 AND n.id = u.node), u.vf, u.vt, u.src
           FROM unnest($3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[], $7::text[]) AS u(pk, node, vf, vt, src)
         RETURNING entity_id, pk_text`,
        [ctx.workspace, meta.entityTypeId, rows.map(r => r.pk), rows.map(r => h(r, 'memory_node_id')),
            rows.map(r => dateToTs(h(r, 'valid_from'))), rows.map(r => dateToTs(h(r, 'valid_to'))), rows.map(r => h(r, 'source_id'))],
    );
    const idByPk = new Map<string, string>();
    for (const r of ent.rows as Array<{ entity_id: string; pk_text: string }>) idByPk.set(r.pk_text, String(r.entity_id));
    await insertValues(ctx, rows.flatMap(r => r.values.map(v => ({ eid: idByPk.get(r.pk)!, v }))));
}

const SLOTS = ['string', 'integer', 'float', 'boolean', 'date', 'datetime', 'json'];

/** One INSERT for all value rows; the money and provenance columns are added to the statement only when used. */
async function insertValues(ctx: WriteCtx, items: Array<{ eid: string; v: ValueEntry }>): Promise<void> {
    if (items.length === 0) return;
    const anyMoney = items.some(i => i.v.type === 'money');
    const anyProv = items.some(i => i.v.prov);
    const arrays: Array<{ col: string; cast: string; vals: Encoded[] }> = [
        { col: 'entity_id', cast: 'bigint', vals: items.map(i => i.eid) },
        { col: 'field_id', cast: 'bigint', vals: items.map(i => String(i.v.fid)) },
    ];
    const typed: Array<[string, string]> = [['v_text', 'text'], ['v_int', 'bigint'], ['v_num', 'float8'], ['v_bool', 'boolean'], ['v_date', 'date'], ['v_ts', 'timestamptz'], ['v_json', 'jsonb']];
    typed.forEach(([col, cast], s) => arrays.push({ col, cast: cast === 'jsonb' ? 'text' : cast, vals: items.map(i => (SLOTS.indexOf(i.v.type) === s ? i.v.enc : null)) }));
    if (anyMoney) {
        arrays.push({ col: 'v_amount', cast: 'text', vals: items.map(i => (i.v.type === 'money' ? splitMoney(i.v.enc).amount : null)) });
        arrays.push({ col: CURRENCY_COLUMN, cast: 'text', vals: items.map(i => (i.v.type === 'money' ? splitMoney(i.v.enc).currency : null)) });
    }
    if (anyProv) {
        PROVENANCE_COLUMNS.forEach((pc, k) => arrays.push({ col: pc.col, cast: pc.cast, vals: items.map(i => i.v.prov?.[k] ?? null) }));
    }
    const exprs = arrays.map((a, k) => (a.col === 'v_json' ? `u.c${k}::jsonb` : a.col === 'v_amount' ? `u.c${k}::numeric` : `u.c${k}`));
    await ctx.client.query(
        `INSERT INTO ${VALUE} (workspace_id, ${arrays.map(a => a.col).join(', ')})
         SELECT $1, ${exprs.join(', ')}
           FROM unnest(${arrays.map((a, k) => `$${k + 2}::${a.cast}[]`).join(', ')}) AS u(${arrays.map((_, k) => `c${k}`).join(', ')})`,
        [ctx.workspace, ...arrays.map(a => a.vals)],
    );
}

/** Header validity bounds are timestamptz; a date-typed value means midnight UTC. */
function dateToTs(v: Encoded): Encoded {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v;
}

/** Entity ids matching `filter` (resolved through the read view, so filters mean what they mean in query()). */
async function matchingIds(ctx: WriteCtx, meta: TableMeta, filter: FilterNode | undefined): Promise<{ ids: string[]; hadWhere: boolean }> {
    const types = new Map([...meta.fields].map(([n, f]) => [n, f.col.type] as const));
    const { where, params } = buildPgWhere(filter, { typeOf: k => types.get(k) });
    const r = await ctx.client.query(`SELECT _lore_entity_id AS id FROM ${meta.view} ${where} ORDER BY _lore_entity_id`, params);
    return { ids: (r.rows as Array<{ id: string }>).map(x => String(x.id)), hadWhere: where.length > 0 };
}

async function totalRows(ctx: WriteCtx, meta: TableMeta): Promise<number> {
    const r = await ctx.client.query(
        `SELECT count(*)::int AS c FROM ${ENTITY} WHERE workspace_id = $1 AND entity_type_id = $2`, [ctx.workspace, meta.entityTypeId]);
    return (r.rows[0] as { c: number }).c;
}

/** Data-aware second layer of the unscoped-write guard (mirrors assertNotDataTautology in sqliteTableTransaction.ts). */
async function assertNotTautology(ctx: WriteCtx, meta: TableMeta, table: string, matched: number, opts: DestructiveWriteOptions | undefined, op: string, verb: 'update' | 'delete'): Promise<void> {
    if (opts?.all === true) return;
    const total = await totalRows(ctx, meta);
    if (total <= 1 || matched !== total) return;
    throw new Error(
        `${L}.${op}: this filter matches all ${total} rows of '${table}' - treating it as an empty/all filter by data ` +
        `(even though the filter shape itself is scoped). Pass all:true to confirm an intentional ${verb} of every row, ` +
        'or use truncate() for an unconditional full wipe.',
    );
}

export async function updateRows(ctx: WriteCtx, table: string, filter: FilterNode, patch: Partial<Row>, op = 'update', opts?: DestructiveWriteOptions, provenance?: ProvenanceByColumnInput): Promise<number> {
    const meta = ctx.meta(table, op);
    const planned: Array<{ name: string; fieldId: number; type: Parameters<typeof encodePgValue>[1]; enc: Encoded; header?: string; prov?: ProvenanceBinds }> = [];
    for (const [key, value] of Object.entries(patch)) {
        const f = meta.fields.get(key);
        if (!f) throw new Error(`${L}.${op}: unknown column '${key}' on table '${table}'`);
        if (f.col.primary) throw new Error(`${L}.${op}: cannot update primary key column '${key}' of '${table}'`);
        const enc = encodePgValue(value, f.col.type, `column '${key}'`);
        if (f.col.required && enc === null) throw new Error(`NOT NULL constraint failed: ${table}.${key}`);
        planned.push({ name: key, fieldId: f.fieldId, type: f.col.type, enc, header: f.header, ...(provenance?.[key] ? { prov: provenanceBinds(provenance[key]!, key) } : {}) });
    }
    assertProvenanceTargets(meta, table, new Set(planned.filter(p => !p.header && p.enc !== null).map(p => p.name)), provenance, op);
    if (planned.length === 0) return 0;
    const { ids, hadWhere } = await matchingIds(ctx, meta, filter);
    if (!hadWhere && opts?.all !== true) {
        throw new Error(`${L}.${op}: refusing to update all rows of '${table}' with an empty/all filter - provide a scoping filter, or pass all:true to confirm.`);
    }
    await assertNotTautology(ctx, meta, table, ids.length, opts, op, 'update');
    if (ids.length === 0) return 0;
    try {
        await ctx.client.query(
            `SELECT 1 FROM ${ENTITY} WHERE workspace_id = $1 AND entity_id = ANY($2::bigint[]) ORDER BY entity_id FOR UPDATE`, [ctx.workspace, ids]);
        const sets: string[] = ['updated_at = now()'];
        const hp: Encoded[] = [];
        for (const p of planned.filter(x => x.header)) {
            hp.push(p.header!.startsWith('valid_') ? dateToTs(p.enc) : p.enc);
            const ph = `$${hp.length + 2}`;
            if (p.header === 'memory_node_id') {
                sets.push(`memory_node_id = ${ph}`, `memory_node_sk = (SELECT n.sk FROM nodes n WHERE n.workspace_id = $1 AND n.id = ${ph})`);
            } else {
                sets.push(`${p.header} = ${p.header!.startsWith('valid_') ? `${ph}::timestamptz` : ph}`);
            }
        }
        await ctx.client.query(
            `UPDATE ${ENTITY} SET ${sets.join(', ')} WHERE workspace_id = $1 AND entity_id = ANY($2::bigint[])`, [ctx.workspace, ids, ...hp]);
        for (const p of planned.filter(x => !x.header)) await supersedeAndInsert(ctx, ids, p);
    } catch (err) {
        throw mapPgWriteError(err, table, meta);
    }
    return ids.length;
}

/**
 * Replace one column's current value on `ids`. A plain patch only supersedes rows whose value actually changes (history
 * stays free of no-op versions); a patch that carries provenance always supersedes, because the provenance IS new information.
 */
async function supersedeAndInsert(ctx: WriteCtx, ids: string[], p: { fieldId: number; type: ColumnType; enc: Encoded; prov?: ProvenanceBinds }): Promise<void> {
    const money = p.type === 'money';
    const parts = money && p.enc !== null ? splitMoney(p.enc) : null;
    const valueCols = money ? ['v_amount', CURRENCY_COLUMN] : [VALUE_COLUMN[p.type]!];
    const valueParams: Encoded[] = money ? [parts?.amount ?? null, parts?.currency ?? null] : [p.enc];
    const valueCasts = money ? ['numeric', 'text'] : [PG_TYPE[p.type]!];
    // $1 workspace, $2 field, $3 ids, then the value params.
    const vp = valueParams.map((_, i) => `$${i + 4}`);
    const distinct = p.prov
        ? 'TRUE'
        : valueCols.map((c, i) => `${c} IS DISTINCT FROM ${vp[i]}::${valueCasts[i]}`).join(' OR ');
    await ctx.client.query(
        `UPDATE ${VALUE} SET superseded_at = now()
          WHERE workspace_id = $1 AND field_id = $2 AND superseded_at IS NULL
            AND entity_id = ANY($3::bigint[]) AND (${distinct})`,
        // With provenance the predicate is TRUE and references no value placeholders, so they must not be bound.
        p.prov ? [ctx.workspace, String(p.fieldId), ids] : [ctx.workspace, String(p.fieldId), ids, ...valueParams]);
    if (p.enc === null) return;
    const provCols = p.prov ? PROVENANCE_COLUMNS.map(c => c.col) : [];
    const provParams = p.prov ?? [];
    const provPh = provParams.map((_, i) => `$${i + 4 + valueParams.length}::${PROVENANCE_COLUMNS[i]!.cast}`);
    await ctx.client.query(
        `INSERT INTO ${VALUE} (workspace_id, entity_id, field_id, ${[...valueCols, ...provCols].join(', ')})
         SELECT $1, e, $2, ${[...vp.map((x, i) => `${x}::${valueCasts[i]}`), ...provPh].join(', ')} FROM unnest($3::bigint[]) AS e
          WHERE NOT EXISTS (SELECT 1 FROM ${VALUE} v WHERE v.workspace_id = $1 AND v.entity_id = e
                               AND v.field_id = $2 AND v.superseded_at IS NULL)`,
        [ctx.workspace, String(p.fieldId), ids, ...valueParams, ...provParams]);
}

export async function deleteRows(ctx: WriteCtx, table: string, filter: FilterNode, op = 'delete', opts?: DestructiveWriteOptions): Promise<number> {
    const meta = ctx.meta(table, op);
    const { ids, hadWhere } = await matchingIds(ctx, meta, filter);
    if (!hadWhere && opts?.all !== true) {
        throw new Error(`${L}.${op}: refusing to delete all rows from '${table}' with no filter. Pass all:true to confirm, or use truncate() for that.`);
    }
    await assertNotTautology(ctx, meta, table, ids.length, opts, op, 'delete');
    if (ids.length === 0) return 0;
    const r = await ctx.client.query(
        `DELETE FROM ${ENTITY} WHERE workspace_id = $1 AND entity_type_id = $2 AND entity_id = ANY($3::bigint[])`,
        [ctx.workspace, meta.entityTypeId, ids]);
    return r.rowCount ?? 0;
}

export async function truncateRows(ctx: WriteCtx, table: string): Promise<number> {
    const meta = ctx.meta(table, 'truncate');
    const r = await ctx.client.query(`DELETE FROM ${ENTITY} WHERE workspace_id = $1 AND entity_type_id = $2`, [ctx.workspace, meta.entityTypeId]);
    return r.rowCount ?? 0;
}

export async function runOps(ctx: WriteCtx, ops: TableOp[]): Promise<TableOpResult[]> {
    if (ops.length === 0) throw new Error('table transaction requires at least one operation');
    if (ops.length > MAX_TABLE_TX_OPS) throw new Error(`table transaction accepts at most ${MAX_TABLE_TX_OPS} operations (got ${ops.length})`);
    const results: TableOpResult[] = [];
    for (let index = 0; index < ops.length; index++) {
        const item = ops[index]!;
        try {
            if (item.op === 'insert') {
                const [key] = await insertRows(ctx, item.collection, [item.row], 'runTransaction');
                results.push({ op: 'insert', collection: item.collection, key });
            } else if (item.op === 'update') {
                const count = await updateRows(ctx, item.collection, item.filter, item.patch, 'runTransaction', { all: item.all });
                results.push({ op: 'update', collection: item.collection, count });
            } else if (item.op === 'delete') {
                const count = await deleteRows(ctx, item.collection, item.filter, 'runTransaction', { all: item.all });
                results.push({ op: 'delete', collection: item.collection, count });
            } else {
                results.push(await upsertOp(ctx, item.collection, item.row));
            }
        } catch (error) {
            const wrapped = new Error(`table transaction operation ${index} failed: ${(error as Error).message}`, { cause: error }) as Error & { failedOpIndex: number };
            wrapped.failedOpIndex = index;
            throw wrapped;
        }
    }
    return results;
}

async function upsertOp(ctx: WriteCtx, table: string, row: Row): Promise<TableOpResult> {
    const meta = ctx.meta(table, 'runTransaction');
    for (const k of Object.keys(row)) {
        if (!meta.fields.has(k)) throw new Error(`${L}.runTransaction: unknown column '${k}' on table '${table}'`);
    }
    const key = row[meta.pk.name];
    if (key === undefined || key === null) {
        throw new Error(`${L}.runTransaction: upsert row for '${table}' must include primary key '${meta.pk.name}'`);
    }
    const pk = String(encodePgValue(key, meta.pk.type, `column '${meta.pk.name}'`));
    const hit = await ctx.client.query(
        `SELECT 1 FROM ${ENTITY} WHERE workspace_id = $1 AND entity_type_id = $2 AND pk_text = $3`, [ctx.workspace, meta.entityTypeId, pk]);
    if (hit.rowCount) {
        const patch = { ...row };
        delete patch[meta.pk.name];
        if (Object.keys(patch).length > 0) await updateRows(ctx, table, { eq: { [meta.pk.name]: key } }, patch, 'runTransaction');
    } else {
        await insertRows(ctx, table, [row], 'runTransaction');
    }
    return { op: 'upsert', collection: table, key };
}
