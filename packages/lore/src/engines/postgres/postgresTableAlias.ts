/**
 * postgresTableAlias.ts - the per-workspace entity alias table (design section 9 Q5: exact normalised match plus an
 * alias table; no fuzzy matching).
 *
 * An alias maps a spelling to a canonical spelling for ONE table column (`lore_entity_alias.field_id`). Matching is on
 * `normaliseAliasValue` forms, so `ACME Corp.` and `acme corp` are already the same without an alias; an alias is only
 * needed for spellings that differ after normalisation (`Acme Corporation`). A canonical spelling is "known" once it is
 * registered (a self-alias, alias === canonical, which `addAlias` creates for you). Aliases are single-hop: a canonical
 * can have many aliases, but a canonical cannot itself be an alias.
 *
 * Removal is soft (`valid_to` + `removed_by`); a removed row stays readable. Writes for one column are serialised with a
 * transaction-scoped advisory lock so the single-hop and uniqueness checks cannot race.
 */

import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './postgresClient.js';
import { TABLE_TABLES } from './postgresTableSchema.js';
import { loadCatalog, type FieldMeta, type TableMeta } from './postgresTableCatalog.js';
import { TableReviewError } from './postgresTableErrors.js';
import { qi } from './postgresTableViews.js';
import { normaliseAliasValue } from '../../query/aliasNormalise.js';

const A = TABLE_TABLES.alias;
type Db = Pick<Pool | PoolClient, 'query'>;
export interface AliasCtx { pool: Pool; workspace: string }

const MAX_SPELLING = 1000;
const MAX_ACTOR = 256;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
/** The most distinct stored spellings one column scan will look at (matching and `unresolved`). */
export const MAX_DISTINCT_SCAN = 100_000;

const bad = (message: string): TableReviewError => new TableReviewError('invalid_argument', message);

export interface AddAliasInput {
    table: string;
    field: string;
    /** The canonical spelling the alias resolves to. */
    canonical: string;
    /** The alias spelling. Omit (or pass the canonical) to just register the canonical spelling. */
    alias?: string;
    createdBy?: string;
}

export interface AliasRecord {
    aliasId: string;
    table: string;
    field: string;
    alias: string;
    aliasNormalised: string;
    canonical: string;
    canonicalNormalised: string;
    /** True for a canonical's own registration row (alias and canonical normalise equal). */
    isCanonical: boolean;
    createdAt: string;
    createdBy: string | null;
    /** Null while the alias is in force; the removal instant after `removeAlias`. */
    validTo: string | null;
    removedBy: string | null;
}

export interface AliasListQuery { table?: string; field?: string; canonical?: string; includeRemoved?: boolean; limit?: number; cursor?: string }
export interface AliasPage { items: AliasRecord[]; nextCursor: string | null }
export interface UnresolvedQuery { table: string; field: string; limit?: number; cursor?: string }
export interface UnresolvedValue {
    /** The normalised form (what a new alias would be keyed on). */
    normalised: string;
    /** The most common stored spelling of it. */
    example: string;
    /** How many rows hold any spelling of it. */
    rows: number;
    /** How many distinct raw spellings normalise to it. */
    spellings: number;
}
export interface UnresolvedPage { items: UnresolvedValue[]; nextCursor: string | null }

interface Row {
    alias_id: string; field_id: string; alias_norm: string; alias_raw: string; canonical_norm: string; canonical: string;
    created_at: Date; created_by: string | null; valid_to: Date | null; removed_by: string | null;
}
const COLS = `alias_id::text AS alias_id, field_id::text AS field_id, alias_norm, alias_raw, canonical_norm, canonical, created_at, created_by, valid_to, removed_by`;

interface Target { table: string; field: string; meta: TableMeta; fm: FieldMeta }

/** Resolve (table, field) to a declared string column; aliases do not apply to headers, keys' types or other kinds. */
function target(catalog: Map<string, TableMeta>, table: string, field: string): Target {
    const meta = catalog.get(table);
    if (!meta) throw bad(`unknown table '${table}'`);
    const fm = meta.fields.get(field);
    if (!fm || fm.header) throw bad(`unknown column '${field}' on table '${table}'`);
    if (fm.col.type !== 'string') throw bad(`aliases apply to string columns; '${table}.${field}' is ${fm.col.type}`);
    return { table, field, meta, fm };
}

function fieldNames(catalog: Map<string, TableMeta>): Map<number, { table: string; field: string }> {
    const out = new Map<number, { table: string; field: string }>();
    for (const [table, m] of catalog) for (const [field, f] of m.fields) if (!f.header) out.set(f.fieldId, { table, field });
    return out;
}

function toRecord(r: Row, names: Map<number, { table: string; field: string }>): AliasRecord {
    const n = names.get(Number(r.field_id));
    return {
        aliasId: r.alias_id, table: n?.table ?? '', field: n?.field ?? '', alias: r.alias_raw, aliasNormalised: r.alias_norm,
        canonical: r.canonical, canonicalNormalised: r.canonical_norm, isCanonical: r.alias_norm === r.canonical_norm,
        createdAt: r.created_at.toISOString(), createdBy: r.created_by, validTo: r.valid_to ? r.valid_to.toISOString() : null, removedBy: r.removed_by,
    };
}

function spelling(v: unknown, what: string): { raw: string; norm: string } {
    if (typeof v !== 'string' || v.trim() === '' || v.length > MAX_SPELLING) throw bad(`${what} must be a non-empty string of at most ${MAX_SPELLING} characters`);
    const norm = normaliseAliasValue(v);
    if (norm === '') throw bad(`${what} has no letters or digits after normalisation`);
    return { raw: v.trim().replace(/\s+/g, ' '), norm };
}

function actor(v: unknown, what: string): string | null {
    if (v === undefined) return null;
    if (typeof v !== 'string' || v.trim() === '' || v.length > MAX_ACTOR) throw bad(`${what} must be a non-empty string of at most ${MAX_ACTOR} characters`);
    return v;
}

const lockField = (c: PoolClient, workspace: string, fieldId: number): Promise<unknown> =>
    c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`lore_alias:${workspace}:${fieldId}`]);

export async function addAlias(ctx: AliasCtx, input: AddAliasInput): Promise<{ record: AliasRecord; created: boolean }> {
    const canonical = spelling(input.canonical, 'canonical');
    const alias = input.alias === undefined ? canonical : spelling(input.alias, 'alias');
    const by = actor(input.createdBy, 'createdBy');
    return withTransaction(ctx.pool, async (client) => {
        const catalog = await loadCatalog(client, ctx.workspace);
        const t = target(catalog, input.table, input.field);
        const names = fieldNames(catalog);
        await lockField(client, ctx.workspace, t.fm.fieldId);
        const open = async (norm: string): Promise<Row | undefined> =>
            (await client.query(`SELECT ${COLS} FROM ${A} WHERE workspace_id = $1 AND field_id = $2 AND alias_norm = $3 AND valid_to IS NULL`,
                [ctx.workspace, t.fm.fieldId, norm])).rows[0] as Row | undefined;
        const existing = await open(alias.norm);
        if (existing) {
            if (existing.canonical_norm === canonical.norm) return { record: toRecord(existing, names), created: false };
            throw new TableReviewError('conflict', `'${alias.raw}' already resolves to '${existing.canonical}' on ${t.table}.${t.field}; remove that alias first`, { aliasId: existing.alias_id });
        }
        const canonRow = await open(canonical.norm);
        if (canonRow && canonRow.canonical_norm !== canonical.norm) {
            throw new TableReviewError('conflict', `'${canonical.raw}' is itself an alias of '${canonRow.canonical}'; aliases are single-hop, use '${canonRow.canonical}' as the canonical`, { aliasId: canonRow.alias_id });
        }
        const insert = async (a: { raw: string; norm: string }): Promise<Row> => (await client.query(
            `INSERT INTO ${A} (workspace_id, field_id, alias_norm, alias_raw, canonical_norm, canonical, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
            [ctx.workspace, t.fm.fieldId, a.norm, a.raw, canonical.norm, canonical.raw, by])).rows[0] as Row;
        if (!canonRow) { const self = await insert(canonical); if (alias.norm === canonical.norm) return { record: toRecord(self, names), created: true }; }
        else if (alias.norm === canonical.norm) return { record: toRecord(canonRow, names), created: false };
        return { record: toRecord(await insert(alias), names), created: true };
    });
}

export async function listAliases(ctx: AliasCtx, q: AliasListQuery = {}): Promise<AliasPage> {
    const limit = q.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw bad(`limit must be an integer 1..${MAX_PAGE}`);
    const catalog = await loadCatalog(ctx.pool, ctx.workspace);
    const names = fieldNames(catalog);
    const params: unknown[] = [ctx.workspace];
    const conds = ['workspace_id = $1'];
    const add = (v: unknown, cast: string): string => { params.push(v); return `$${params.length}::${cast}`; };
    if (q.field !== undefined && q.table === undefined) throw bad('field needs table');
    if (q.table !== undefined) {
        if (!catalog.has(q.table)) throw bad(`unknown table '${q.table}'`);
        const ids = [...(catalog.get(q.table)!.fields)].filter(([n, f]) => !f.header && (q.field === undefined || n === q.field)).map(([, f]) => f.fieldId);
        if (q.field !== undefined && ids.length === 0) throw bad(`unknown column '${q.field}' on table '${q.table}'`);
        conds.push(`field_id = ANY(${add(ids, 'bigint[]')})`);
    }
    if (q.canonical !== undefined) conds.push(`canonical_norm = ${add(spelling(q.canonical, 'canonical').norm, 'text')}`);
    if (!q.includeRemoved) conds.push('valid_to IS NULL');
    if (q.cursor !== undefined) {
        if (!/^a1:\d{1,18}$/.test(q.cursor)) throw bad('cursor is not a cursor returned by listAliases');
        conds.push(`alias_id > ${add(q.cursor.slice(3), 'bigint')}`);
    }
    params.push(limit + 1);
    const r = await ctx.pool.query(`SELECT ${COLS} FROM ${A} WHERE ${conds.join(' AND ')} ORDER BY alias_id LIMIT $${params.length}`, params);
    const rows = r.rows as Row[];
    const items = rows.slice(0, limit).map(x => toRecord(x, names));
    return { items, nextCursor: rows.length > limit ? `a1:${items[items.length - 1]!.aliasId}` : null };
}

/** Soft-remove: sets valid_to. Removing something already removed returns it unchanged (`removed: false`). */
export async function removeAlias(ctx: AliasCtx, aliasId: string, removedBy?: string): Promise<{ record: AliasRecord; removed: boolean }> {
    if (typeof aliasId !== 'string' || !/^\d{1,18}$/.test(aliasId)) throw bad('aliasId must be the alias id string returned by addAlias/listAliases');
    const by = actor(removedBy, 'removedBy');
    return withTransaction(ctx.pool, async (client) => {
        const names = fieldNames(await loadCatalog(client, ctx.workspace));
        const found = (await client.query(`SELECT field_id FROM ${A} WHERE workspace_id = $1 AND alias_id = $2`, [ctx.workspace, aliasId])).rows[0] as { field_id: string } | undefined;
        if (!found) throw new TableReviewError('not_found', `alias ${aliasId} does not exist in this workspace`);
        await lockField(client, ctx.workspace, Number(found.field_id));
        const row = (await client.query(`SELECT ${COLS} FROM ${A} WHERE workspace_id = $1 AND alias_id = $2 FOR UPDATE`, [ctx.workspace, aliasId])).rows[0] as Row;
        if (row.valid_to !== null) return { record: toRecord(row, names), removed: false };
        if (row.alias_norm === row.canonical_norm) {
            const dep = await client.query(
                `SELECT 1 FROM ${A} WHERE workspace_id = $1 AND field_id = $2 AND canonical_norm = $3 AND alias_norm <> canonical_norm AND valid_to IS NULL LIMIT 1`,
                [ctx.workspace, row.field_id, row.canonical_norm]);
            if (dep.rows.length > 0) throw new TableReviewError('conflict', `'${row.canonical}' still has aliases; remove them first`, { aliasId });
        }
        const upd = await client.query(`UPDATE ${A} SET valid_to = now(), removed_by = $3 WHERE workspace_id = $1 AND alias_id = $2 RETURNING ${COLS}`, [ctx.workspace, aliasId, by]);
        return { record: toRecord(upd.rows[0] as Row, names), removed: true };
    });
}

// ---- matching support (plan filters + unresolved) -------------------------------------------------------------------

/** For each field id, `alias_norm -> canonical_norm` over the open rows (a canonical maps to itself). */
export async function loadAliasIndex(db: Db, workspace: string, fieldIds: readonly number[]): Promise<Map<number, Map<string, string>>> {
    const out = new Map<number, Map<string, string>>();
    if (fieldIds.length === 0) return out;
    const r = await db.query(
        `SELECT field_id, alias_norm, canonical_norm FROM ${A} WHERE workspace_id = $1 AND field_id = ANY($2::bigint[]) AND valid_to IS NULL`, [workspace, fieldIds]);
    for (const row of r.rows as Array<{ field_id: string; alias_norm: string; canonical_norm: string }>) {
        const k = Number(row.field_id);
        if (!out.has(k)) out.set(k, new Map());
        out.get(k)!.set(row.alias_norm, row.canonical_norm);
    }
    return out;
}

/** Distinct stored spellings of a column with their row counts; refuses (not truncates) past MAX_DISTINCT_SCAN. */
export async function scanSpellings(db: Db, meta: TableMeta, column: string): Promise<Array<{ value: string; rows: number }>> {
    const r = await db.query(`SELECT ${qi(column)} AS v, count(*)::text AS n FROM ${meta.view} WHERE ${qi(column)} IS NOT NULL GROUP BY 1 LIMIT ${MAX_DISTINCT_SCAN + 1}`);
    if (r.rows.length > MAX_DISTINCT_SCAN) {
        throw new TableReviewError('too_large', `column '${column}' has more than ${MAX_DISTINCT_SCAN} distinct values; alias matching refuses to scan it`);
    }
    return (r.rows as Array<{ v: string; n: string }>).map(x => ({ value: x.v, rows: Number(x.n) }));
}

/** Stored values that are not a registered canonical or alias spelling, grouped by normalised form. */
export async function listUnresolved(ctx: AliasCtx, q: UnresolvedQuery): Promise<UnresolvedPage> {
    const limit = q.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw bad(`limit must be an integer 1..${MAX_PAGE}`);
    let after: string | null = null;
    if (q.cursor !== undefined) {
        if (!/^u1:[A-Za-z0-9_-]*$/.test(q.cursor)) throw bad('cursor is not a cursor returned by listUnresolved');
        after = Buffer.from(q.cursor.slice(3), 'base64url').toString('utf8');
    }
    const t = target(await loadCatalog(ctx.pool, ctx.workspace), q.table, q.field);
    const known = (await loadAliasIndex(ctx.pool, ctx.workspace, [t.fm.fieldId])).get(t.fm.fieldId) ?? new Map<string, string>();
    const groups = new Map<string, { example: string; best: number; rows: number; spellings: number }>();
    for (const s of await scanSpellings(ctx.pool, t.meta, q.field)) {
        const norm = normaliseAliasValue(s.value);
        if (norm === '' || known.has(norm)) continue;
        const g = groups.get(norm);
        if (!g) groups.set(norm, { example: s.value, best: s.rows, rows: s.rows, spellings: 1 });
        else { g.rows += s.rows; g.spellings += 1; if (s.rows > g.best || (s.rows === g.best && s.value < g.example)) { g.best = s.rows; g.example = s.value; } }
    }
    const sorted = [...groups].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).filter(([n]) => after === null || n > after);
    const page = sorted.slice(0, limit).map(([normalised, g]): UnresolvedValue => ({ normalised, example: g.example, rows: g.rows, spellings: g.spellings }));
    const last = page[page.length - 1];
    return { items: page, nextCursor: sorted.length > limit && last ? `u1:${Buffer.from(last.normalised, 'utf8').toString('base64url')}` : null };
}
