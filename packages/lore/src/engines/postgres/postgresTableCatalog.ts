/**
 * postgresTableCatalog.ts - the table catalog for PostgresTableStorage: reserved
 * header columns, per-table metadata, schema validation/equality, and the
 * load/create queries over lore_entity_type / lore_field_def.
 */

import type { PoolClient } from 'pg';
import type { ColumnDecl, ColumnType, TableSchema } from '../../contracts/tables.js';
import { assertIdent } from '../whereClause.js';
import { CURRENCY_SUFFIX, HEADER_COLUMN_PREFIX, TABLE_TABLES, TABLE_VIEW_PREFIX } from './postgresTableSchema.js';

const LABEL = 'PostgresTableStorage';

/** Reserved columns live in the entity header, not in entity_value. */
export type HeaderField = 'memory_node_id' | 'source_id' | 'valid_from' | 'valid_to';
export const RESERVED: Record<string, { header: HeaderField; types: ColumnType[] }> = {
    _memory_node_id: { header: 'memory_node_id', types: ['string'] },
    _source_id: { header: 'source_id', types: ['string'] },
    _valid_from: { header: 'valid_from', types: ['date', 'datetime'] },
    _valid_to: { header: 'valid_to', types: ['date', 'datetime'] },
};

export interface FieldMeta {
    fieldId: number;
    col: ColumnDecl;
    header?: HeaderField;
}

export interface TableMeta {
    entityTypeId: number;
    schema: TableSchema;
    fields: Map<string, FieldMeta>;
    pk: ColumnDecl;
    view: string;
    createdAt?: string;
}

export const viewName = (entityTypeId: number): string => `${TABLE_VIEW_PREFIX}${entityTypeId}`;

/** Declared type per readable view column, including the `<money>__currency` sidecars (drives filters and ordering). */
export function columnTypes(schema: TableSchema): Map<string, ColumnType> {
    const out = new Map<string, ColumnType>();
    for (const c of schema.columns) {
        out.set(c.name, c.type);
        if (c.type === 'money') out.set(`${c.name}${CURRENCY_SUFFIX}`, 'string');
    }
    return out;
}

export function pickPrimary(cols: ColumnDecl[]): ColumnDecl {
    const pks = cols.filter(c => c.primary);
    if (pks.length !== 1) throw new Error(`${LABEL}: schema requires exactly one primary column, got ${pks.length}`);
    return pks[0]!;
}

/** Validate a schema before any DDL runs. */
export function validateSchema(schema: TableSchema): void {
    assertIdent(schema.name);
    const pk = pickPrimary(schema.columns);
    const seen = new Set<string>();
    for (const c of schema.columns) {
        assertIdent(c.name);
        if (seen.has(c.name)) throw new Error(`${LABEL}: duplicate column '${c.name}' in '${schema.name}'`);
        seen.add(c.name);
        if (c.name.startsWith(HEADER_COLUMN_PREFIX)) {
            throw new Error(`${LABEL}: column '${c.name}' uses the reserved '${HEADER_COLUMN_PREFIX}' prefix`);
        }
        const reserved = RESERVED[c.name];
        if (reserved && !reserved.types.includes(c.type)) {
            throw new Error(`${LABEL}: reserved column '${c.name}' must be of type ${reserved.types.join(' or ')}`);
        }
        for (const ef of c.extractedFields ?? []) assertIdent(ef.key);
        if (c.type === 'money') {
            if (c.primary || c.unique) throw new Error(`${LABEL}: money column '${c.name}' cannot be primary or unique`);
            if (RESERVED[c.name]) throw new Error(`${LABEL}: reserved column '${c.name}' cannot be money`);
        }
    }
    // A money column `p` is exposed on the read view as `p` and `p__currency`; no other column may take that name.
    for (const c of schema.columns) {
        if (c.type === 'money' && seen.has(`${c.name}${CURRENCY_SUFFIX}`)) {
            throw new Error(`${LABEL}: column '${c.name}${CURRENCY_SUFFIX}' clashes with the currency half of money column '${c.name}'`);
        }
    }
    if (RESERVED[pk.name]) throw new Error(`${LABEL}: the primary key cannot be the reserved column '${pk.name}'`);
}

/** Canonical stringify (sorted keys) so JSONB round-trips never read as a "different shape". */
export function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
}

export function sameSchema(a: TableSchema, b: TableSchema): boolean {
    return canonical({ ...a, description: a.description ?? null }) === canonical({ ...b, description: b.description ?? null });
}

export function flagsOf(c: ColumnDecl): string {
    return [c.primary && 'primary', c.required && 'required', c.unique && 'unique', c.indexed && 'indexed']
        .filter(Boolean).join(',');
}

export function buildMeta(entityTypeId: number, schema: TableSchema, ids: Map<string, number>, createdAt?: string): TableMeta {
    const fields = new Map<string, FieldMeta>();
    for (const col of schema.columns) {
        fields.set(col.name, { fieldId: ids.get(col.name)!, col, header: RESERVED[col.name]?.header });
    }
    return { entityTypeId, schema, fields, pk: pickPrimary(schema.columns), view: viewName(entityTypeId), createdAt };
}

/** Read every declared table of a workspace. */
export async function loadCatalog(client: Pick<PoolClient, 'query'>, workspace: string, onlyName?: string): Promise<Map<string, TableMeta>> {
    const { entityType, fieldDef } = TABLE_TABLES;
    const r = await client.query(
        `SELECT t.entity_type_id, t.name, t.description, t.created_at, f.field_id, f.decl_json
           FROM ${entityType} t LEFT JOIN ${fieldDef} f
             ON f.workspace_id = t.workspace_id AND f.entity_type_id = t.entity_type_id
          WHERE t.workspace_id = $1 ${onlyName === undefined ? '' : 'AND t.name = $2'} ORDER BY t.name, f.position`,
        onlyName === undefined ? [workspace] : [workspace, onlyName],
    );
    const byType = new Map<number, { name: string; description?: string; createdAt: string; cols: ColumnDecl[]; ids: Map<string, number> }>();
    for (const row of r.rows as Array<Record<string, unknown>>) {
        const id = Number(row['entity_type_id']);
        let t = byType.get(id);
        if (!t) {
            t = {
                name: String(row['name']), description: row['description'] == null ? undefined : String(row['description']),
                createdAt: (row['created_at'] as Date).toISOString(), cols: [], ids: new Map(),
            };
            byType.set(id, t);
        }
        if (row['decl_json'] != null) {
            const col = JSON.parse(String(row['decl_json'])) as ColumnDecl;
            t.cols.push(col);
            t.ids.set(col.name, Number(row['field_id']));
        }
    }
    const out = new Map<string, TableMeta>();
    for (const [id, t] of byType) {
        const schema: TableSchema = { name: t.name, columns: t.cols, ...(t.description !== undefined ? { description: t.description } : {}) };
        out.set(t.name, buildMeta(id, schema, t.ids, t.createdAt));
    }
    return out;
}
