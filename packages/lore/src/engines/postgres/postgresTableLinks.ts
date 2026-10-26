/**
 * postgresTableLinks.ts - typed record links between structured-table rows (design 4.1).
 *
 * A link type names a relationship between two TABLES (`lore_link_type`); a link joins two ROWS of those tables
 * (`lore_entity_link`). Links are soft-invalidated: closing sets `valid_to`, it never deletes, so "what was
 * linked on D" stays answerable. Cardinality is enforced by the database (partial unique indexes over OPEN links),
 * so two concurrent writers cannot both win. Every key leads with the workspace id.
 *
 * Rows are addressed as `{ table, key }` (the table's primary key), never by internal entity id.
 */

import type { Pool, PoolClient } from 'pg';
import { TableLinkError } from './postgresTableErrors.js';
import { TABLE_TABLES } from './postgresTableSchema.js';
import { encodePgValue } from './postgresTableCodec.js';
import type { TableMeta } from './postgresTableCatalog.js';

const { entity: ENTITY, entityType: ETYPE, linkType: LTYPE, link: LINK } = TABLE_TABLES;

export type LinkCardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
const CARDINALITIES: readonly LinkCardinality[] = ['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many'];

/**
 * `one_to_many`: one `from` row, many `to` rows (each `to` row has at most one open `from`).
 * `many_to_one`: each `from` row has at most one open `to`. `one_to_one`: both. `many_to_many`: neither.
 */
export interface LinkTypeDef { name: string; fromTable: string; toTable: string; cardinality: LinkCardinality; description?: string }
export interface LinkTypeInfo extends LinkTypeDef { createdAt: string }

/** A row of a structured table, by primary key. */
export interface RowRef { table: string; key: unknown }

export interface AddLinkInput {
    linkType: string;
    from: RowRef;
    to: RowRef;
    /** Who made the link: 'manual' (default), 'extractor', 'agent', ... */
    origin?: string;
    policyVersion?: string;
    modelFingerprint?: string;
    /** 0..1 */
    confidence?: number;
    /** Valid-time bounds of the relationship itself (not of this record). */
    validFrom?: Date | string;
    validTo?: Date | string;
}

export interface EntityLink {
    linkId: string;
    linkType: string;
    from: { table: string; key: string | number | boolean };
    to: { table: string; key: string | number | boolean };
    origin: string;
    policyVersion: string | null;
    modelFingerprint: string | null;
    confidence: number | null;
    /** When this link was recorded. */
    createdAt: string;
    validFrom: string | null;
    validTo: string | null;
}

export interface ListLinksOptions {
    /** `out` = links where this row is the `from` end, `in` = the `to` end. Default `both`. */
    direction?: 'out' | 'in' | 'both';
    linkType?: string;
    /** Valid-time instant; default now. Returns links whose [validFrom, validTo) contains it. */
    asOf?: Date | string;
    /** Return every link ever recorded for the row, open or closed (ignores asOf). */
    includeClosed?: boolean;
}

export interface LinkCtx {
    db: Pick<Pool | PoolClient, 'query'>;
    workspace: string;
    meta(table: string, op: string): TableMeta;
}

function instant(v: Date | string | undefined, what: string): string | null {
    if (v === undefined || v === null) return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) throw new TableLinkError('invalid_argument', `${what} is not a valid date/time: ${JSON.stringify(v)}`);
    return d.toISOString();
}

function pkText(ctx: LinkCtx, ref: RowRef, op: string): { meta: TableMeta; pk: string } {
    const meta = ctx.meta(ref.table, op);
    let enc: unknown;
    try { enc = encodePgValue(ref.key, meta.pk.type, 'key'); } catch (e) {
        throw new TableLinkError('invalid_argument', `${op}: bad key for '${ref.table}': ${(e as Error).message}`);
    }
    if (enc === null || enc === undefined) throw new TableLinkError('invalid_argument', `${op}: key for '${ref.table}' is required`);
    return { meta, pk: String(enc) };
}

const flags = (c: LinkCardinality): { fromUnique: boolean; toUnique: boolean } => ({
    fromUnique: c === 'one_to_one' || c === 'many_to_one',
    toUnique: c === 'one_to_one' || c === 'one_to_many',
});

interface TypeRow { link_type_id: string; name: string; from_type_id: string; to_type_id: string; cardinality: LinkCardinality; description: string | null; created_at: Date; from_name: string; to_name: string }

const TYPE_SELECT = `SELECT t.link_type_id, t.name, t.from_type_id, t.to_type_id, t.cardinality, t.description, t.created_at, f.name AS from_name, o.name AS to_name
   FROM ${LTYPE} t
   JOIN ${ETYPE} f ON f.workspace_id = t.workspace_id AND f.entity_type_id = t.from_type_id
   JOIN ${ETYPE} o ON o.workspace_id = t.workspace_id AND o.entity_type_id = t.to_type_id`;

const toInfo = (r: TypeRow): LinkTypeInfo => ({
    name: r.name, fromTable: r.from_name, toTable: r.to_name, cardinality: r.cardinality,
    ...(r.description ? { description: r.description } : {}), createdAt: r.created_at.toISOString(),
});

async function typeByName(ctx: LinkCtx, name: string): Promise<TypeRow | undefined> {
    const r = await ctx.db.query(`${TYPE_SELECT} WHERE t.workspace_id = $1 AND t.name = $2`, [ctx.workspace, name]);
    return r.rows[0] as TypeRow | undefined;
}

/** Create a link type, or return the existing one when the definition is identical. A different definition is a conflict. */
export async function defineLinkType(ctx: LinkCtx, def: LinkTypeDef): Promise<LinkTypeInfo> {
    if (typeof def.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/.test(def.name)) {
        throw new TableLinkError('invalid_argument', `link type name must match [A-Za-z_][A-Za-z0-9_.-]* (max 63 chars), got ${JSON.stringify(def.name)}`);
    }
    if (!CARDINALITIES.includes(def.cardinality)) {
        throw new TableLinkError('invalid_argument', `cardinality must be one of ${CARDINALITIES.join(', ')}, got ${JSON.stringify(def.cardinality)}`);
    }
    const from = ctx.meta(def.fromTable, 'defineLinkType');
    const to = ctx.meta(def.toTable, 'defineLinkType');
    await ctx.db.query(
        `INSERT INTO ${LTYPE} (workspace_id, name, from_type_id, to_type_id, cardinality, description)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (workspace_id, name) DO NOTHING`,
        [ctx.workspace, def.name, from.entityTypeId, to.entityTypeId, def.cardinality, def.description ?? null]);
    const row = (await typeByName(ctx, def.name))!;
    if (row.from_name !== def.fromTable || row.to_name !== def.toTable || row.cardinality !== def.cardinality) {
        throw new TableLinkError('link_type_conflict',
            `link type '${def.name}' already exists as ${row.from_name} -> ${row.to_name} (${row.cardinality}); it cannot be redefined as ` +
            `${def.fromTable} -> ${def.toTable} (${def.cardinality}). Define a new link type instead.`);
    }
    return toInfo(row);
}

export async function listLinkTypes(ctx: LinkCtx): Promise<LinkTypeInfo[]> {
    const r = await ctx.db.query(`${TYPE_SELECT} WHERE t.workspace_id = $1 ORDER BY t.name`, [ctx.workspace]);
    return (r.rows as TypeRow[]).map(toInfo);
}

async function entityId(ctx: LinkCtx, typeId: number, pk: string): Promise<string | undefined> {
    const r = await ctx.db.query(
        `SELECT entity_id FROM ${ENTITY} WHERE workspace_id = $1 AND entity_type_id = $2 AND pk_text = $3`, [ctx.workspace, typeId, pk]);
    const row = r.rows[0] as { entity_id: string } | undefined;
    return row ? String(row.entity_id) : undefined;
}

/** Link two rows. Returns the new link id. Throws TableLinkError (unknown_link_type, unknown_entity, duplicate_link, cardinality, ...). */
export async function addLink(ctx: LinkCtx, input: AddLinkInput): Promise<{ linkId: string }> {
    const lt = await typeByName(ctx, input.linkType);
    if (!lt) throw new TableLinkError('unknown_link_type', `unknown link type '${input.linkType}' (defineLinkType first)`);
    if (input.from.table !== lt.from_name || input.to.table !== lt.to_name) {
        throw new TableLinkError('invalid_argument',
            `link type '${lt.name}' joins ${lt.from_name} -> ${lt.to_name}, not ${input.from.table} -> ${input.to.table}`);
    }
    if (input.confidence !== undefined && input.confidence !== null && !(typeof input.confidence === 'number' && input.confidence >= 0 && input.confidence <= 1)) {
        throw new TableLinkError('invalid_argument', 'confidence must be a number between 0 and 1');
    }
    const validFrom = instant(input.validFrom, 'validFrom');
    const validTo = instant(input.validTo, 'validTo');
    if (validFrom && validTo && !(new Date(validTo) > new Date(validFrom))) {
        throw new TableLinkError('invalid_interval', 'validTo must be after validFrom');
    }
    const f = pkText(ctx, input.from, 'addLink');
    const t = pkText(ctx, input.to, 'addLink');
    const fromId = await entityId(ctx, f.meta.entityTypeId, f.pk);
    if (!fromId) throw new TableLinkError('unknown_entity', `no row with key ${f.pk} in '${input.from.table}'`);
    const toId = await entityId(ctx, t.meta.entityTypeId, t.pk);
    if (!toId) throw new TableLinkError('unknown_entity', `no row with key ${t.pk} in '${input.to.table}'`);
    const { fromUnique, toUnique } = flags(lt.cardinality);
    try {
        const r = await ctx.db.query(
            `INSERT INTO ${LINK} (workspace_id, link_type_id, from_entity_id, to_entity_id, origin, policy_version, model_fingerprint, confidence,
                                  valid_from, valid_to, from_unique, to_unique)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12) RETURNING link_id`,
            [ctx.workspace, lt.link_type_id, fromId, toId, input.origin ?? 'manual', input.policyVersion ?? null, input.modelFingerprint ?? null,
                input.confidence ?? null, validFrom, validTo, fromUnique, toUnique]);
        return { linkId: String((r.rows[0] as { link_id: string }).link_id) };
    } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e?.code === '23503') throw new TableLinkError('unknown_entity', 'one of the rows was deleted while the link was being added');
        if (e?.code === '23505') {
            if (e.constraint === 'lore_link_open_uq') {
                throw new TableLinkError('duplicate_link', `'${lt.name}' already links ${input.from.table}:${f.pk} to ${input.to.table}:${t.pk}`);
            }
            if (e.constraint === 'lore_link_from_uq') {
                throw new TableLinkError('cardinality', `'${lt.name}' is ${lt.cardinality}: ${input.from.table}:${f.pk} already has an open link of this type (close it first)`);
            }
            if (e.constraint === 'lore_link_to_uq') {
                throw new TableLinkError('cardinality', `'${lt.name}' is ${lt.cardinality}: ${input.to.table}:${t.pk} already has an open link of this type (close it first)`);
            }
        }
        throw err;
    }
}

/**
 * Soft-invalidate a link: set `valid_to` (default now). Returns false when the link does not exist in this workspace or is
 * already closed. Never deletes the row.
 */
export async function closeLink(ctx: LinkCtx, linkId: string, validTo?: Date | string): Promise<boolean> {
    if (!/^\d{1,18}$/.test(String(linkId))) throw new TableLinkError('invalid_argument', `bad link id ${JSON.stringify(linkId)}`);
    const at = instant(validTo, 'validTo');
    const cur = await ctx.db.query(
        `SELECT valid_from, valid_to FROM ${LINK} WHERE workspace_id = $1 AND link_id = $2`, [ctx.workspace, String(linkId)]);
    const row = cur.rows[0] as { valid_from: Date | null; valid_to: Date | null } | undefined;
    if (!row || row.valid_to) return false;
    const r = await ctx.db.query(
        `UPDATE ${LINK} SET valid_to = COALESCE($3::timestamptz, now())
          WHERE workspace_id = $1 AND link_id = $2 AND valid_to IS NULL
            AND (valid_from IS NULL OR COALESCE($3::timestamptz, now()) > valid_from)`,
        [ctx.workspace, String(linkId), at]);
    if ((r.rowCount ?? 0) === 0) {
        // Either a concurrent close won the race, or the requested end is not after the start.
        const again = await ctx.db.query(`SELECT valid_to FROM ${LINK} WHERE workspace_id = $1 AND link_id = $2`, [ctx.workspace, String(linkId)]);
        if ((again.rows[0] as { valid_to: Date | null } | undefined)?.valid_to) return false;
        throw new TableLinkError('invalid_interval', 'validTo must be after the link\'s validFrom');
    }
    return true;
}

function decodeKey(text: string, meta: TableMeta | undefined): string | number | boolean {
    const t = meta?.pk.type;
    if (t === 'integer' || t === 'float') {
        const n = Number(text);
        // A bigint beyond 2^53 stays text rather than silently rounding.
        if (text !== '' && Number.isFinite(n) && (t === 'float' || Number.isSafeInteger(n))) return n;
    }
    if (t === 'boolean') return text === 'true';
    return text;
}

/** Links touching one row. Default: links valid now, both directions. */
export async function listLinks(ctx: LinkCtx, ref: RowRef, opts: ListLinksOptions = {}): Promise<EntityLink[]> {
    const { meta, pk } = pkText(ctx, ref, 'listLinks');
    const id = await entityId(ctx, meta.entityTypeId, pk);
    if (!id) return [];
    const dir = opts.direction ?? 'both';
    if (!['out', 'in', 'both'].includes(dir)) throw new TableLinkError('invalid_argument', `direction must be out, in or both`);
    const params: unknown[] = [ctx.workspace, id];
    const ends = dir === 'out' ? 'l.from_entity_id = $2' : dir === 'in' ? 'l.to_entity_id = $2' : '(l.from_entity_id = $2 OR l.to_entity_id = $2)';
    let where = `l.workspace_id = $1 AND ${ends}`;
    if (opts.linkType !== undefined) { params.push(opts.linkType); where += ` AND t.name = $${params.length}`; }
    if (!opts.includeClosed) {
        const at = instant(opts.asOf, 'asOf');
        params.push(at);
        const p = `COALESCE($${params.length}::timestamptz, now())`;
        where += ` AND (l.valid_from IS NULL OR l.valid_from <= ${p}) AND (l.valid_to IS NULL OR l.valid_to > ${p})`;
    }
    const r = await ctx.db.query(
        `SELECT l.link_id, t.name AS link_type, l.origin, l.policy_version, l.model_fingerprint, l.confidence, l.created_at, l.valid_from, l.valid_to,
                fe.pk_text AS from_pk, ft.name AS from_table, te.pk_text AS to_pk, tt.name AS to_table
           FROM ${LINK} l
           JOIN ${LTYPE} t ON t.workspace_id = l.workspace_id AND t.link_type_id = l.link_type_id
           JOIN ${ENTITY} fe ON fe.workspace_id = l.workspace_id AND fe.entity_id = l.from_entity_id
           JOIN ${ETYPE} ft ON ft.workspace_id = fe.workspace_id AND ft.entity_type_id = fe.entity_type_id
           JOIN ${ENTITY} te ON te.workspace_id = l.workspace_id AND te.entity_id = l.to_entity_id
           JOIN ${ETYPE} tt ON tt.workspace_id = te.workspace_id AND tt.entity_type_id = te.entity_type_id
          WHERE ${where} ORDER BY l.link_id`, params);
    const metaOf = (table: string): TableMeta | undefined => { try { return ctx.meta(table, 'listLinks'); } catch { return undefined; } };
    const ts = (d: Date | null): string | null => (d ? d.toISOString() : null);
    return (r.rows as Array<Record<string, unknown>>).map(x => ({
        linkId: String(x['link_id']), linkType: x['link_type'] as string,
        from: { table: x['from_table'] as string, key: decodeKey(x['from_pk'] as string, metaOf(x['from_table'] as string)) },
        to: { table: x['to_table'] as string, key: decodeKey(x['to_pk'] as string, metaOf(x['to_table'] as string)) },
        origin: x['origin'] as string, policyVersion: (x['policy_version'] as string | null) ?? null,
        modelFingerprint: (x['model_fingerprint'] as string | null) ?? null,
        confidence: x['confidence'] == null ? null : Number(x['confidence']),
        createdAt: (x['created_at'] as Date).toISOString(), validFrom: ts(x['valid_from'] as Date | null), validTo: ts(x['valid_to'] as Date | null),
    }));
}
