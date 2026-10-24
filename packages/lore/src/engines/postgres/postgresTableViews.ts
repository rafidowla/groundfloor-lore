/**
 * postgresTableViews.ts - generated per-type READ views over the narrow EAV rows,
 * plus the per-field partial indexes.
 *
 * `lore_tv_<entity_type_id>` exposes one typed column per declared field (a
 * correlated scalar subquery over the CURRENT value row) plus the always-present
 * `_lore_*` header columns used for node joins and as-of predicates. The
 * workspace id is baked into the view body as a literal, so a query through the
 * view cannot cross the workspace boundary. Reserved columns (`_source_id`, ...)
 * read straight from the entity header.
 */

import type { ColumnDecl } from '../../contracts/tables.js';
import { TABLE_TABLES, VALUE_COLUMN } from './postgresTableSchema.js';
import type { FieldMeta, TableMeta } from './postgresTableCatalog.js';

export const sqlLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;
export const qi = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Header columns present on every view, in this order, ahead of the user columns. */
export const HEADER_VIEW_COLUMNS = [
    '_lore_entity_id', '_lore_pk', '_lore_memory_node_id', '_lore_memory_node_sk',
    '_lore_valid_from', '_lore_valid_to', '_lore_source_id',
] as const;

function columnExpr(f: FieldMeta): string {
    if (f.header) {
        // valid_from/valid_to are timestamptz; a column declared as `date` reads the UTC calendar day.
        if (f.col.type === 'date' && (f.header === 'valid_from' || f.header === 'valid_to')) {
            return `(e.${f.header} AT TIME ZONE 'UTC')::date`;
        }
        return `e.${f.header}`;
    }
    return `(SELECT v.${VALUE_COLUMN[f.col.type]} FROM ${TABLE_TABLES.value} v ` +
        `WHERE v.workspace_id = e.workspace_id AND v.entity_id = e.entity_id ` +
        `AND v.field_id = ${f.fieldId} AND v.superseded_at IS NULL)`;
}

export function viewDdl(workspace: string, meta: TableMeta): string {
    const cols = [
        'e.entity_id AS _lore_entity_id', 'e.pk_text AS _lore_pk',
        'e.memory_node_id AS _lore_memory_node_id', 'e.memory_node_sk AS _lore_memory_node_sk',
        'e.valid_from AS _lore_valid_from', 'e.valid_to AS _lore_valid_to', 'e.source_id AS _lore_source_id',
        ...meta.schema.columns.map(c => `${columnExpr(meta.fields.get(c.name)!)} AS ${qi(c.name)}`),
    ];
    return `CREATE OR REPLACE VIEW ${meta.view} AS SELECT ${cols.join(', ')} FROM ${TABLE_TABLES.entity} e ` +
        `WHERE e.workspace_id = ${sqlLiteral(workspace)} AND e.entity_type_id = ${meta.entityTypeId}`;
}

/** Partial indexes for one field (header-stored reserved columns are indexed on the entity table already). */
export function fieldIndexDdl(fieldId: number, col: ColumnDecl): string[] {
    if (RESERVED_NAMES.has(col.name) || col.primary) return [];
    const vc = VALUE_COLUMN[col.type];
    const out: string[] = [];
    if (col.unique) {
        out.push(`CREATE UNIQUE INDEX IF NOT EXISTS lore_ev_${fieldId}_u ON ${TABLE_TABLES.value} (${vc}) ` +
            `WHERE field_id = ${fieldId} AND superseded_at IS NULL`);
    } else if (col.indexed) {
        out.push(`CREATE INDEX IF NOT EXISTS lore_ev_${fieldId}_i ON ${TABLE_TABLES.value} (${vc}) ` +
            `WHERE field_id = ${fieldId} AND superseded_at IS NULL`);
    }
    return out;
}

const RESERVED_NAMES = new Set(['_memory_node_id', '_source_id', '_valid_from', '_valid_to']);
