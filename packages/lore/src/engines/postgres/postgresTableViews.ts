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
import { CURRENCY_COLUMN, CURRENCY_SUFFIX, TABLE_TABLES, VALUE_COLUMN } from './postgresTableSchema.js';
import { selectExpr } from './postgresTableCodec.js';
import type { FieldMeta, TableMeta } from './postgresTableCatalog.js';

export const sqlLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;
export const qi = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Header columns present on every view, in this order, ahead of the user columns. */
export const HEADER_VIEW_COLUMNS = [
    '_lore_entity_id', '_lore_pk', '_lore_memory_node_id', '_lore_memory_node_sk',
    '_lore_valid_from', '_lore_valid_to', '_lore_source_id',
] as const;

/** Which value row of a (entity, field) a view column reads: the CURRENT one, or the one known at a recorded instant. */
type ValuePredicate = (alias: string) => string;
const CURRENT_VALUE: ValuePredicate = a => `${a}.superseded_at IS NULL`;

function columnExpr(f: FieldMeta, valueColumn: string, pred: ValuePredicate): string {
    if (f.header) {
        // valid_from/valid_to are timestamptz; a column declared as `date` reads the UTC calendar day.
        if (f.col.type === 'date' && (f.header === 'valid_from' || f.header === 'valid_to')) {
            return `(e.${f.header} AT TIME ZONE 'UTC')::date`;
        }
        return `e.${f.header}`;
    }
    return `(SELECT v.${valueColumn} FROM ${TABLE_TABLES.value} v ` +
        `WHERE v.workspace_id = e.workspace_id AND v.entity_id = e.entity_id ` +
        `AND v.field_id = ${f.fieldId} AND ${pred('v')})`;
}

/** `SELECT` body shared by the read view and the recorded-time source: header columns, then each user column. */
function viewSelect(workspace: string, meta: TableMeta, pred: ValuePredicate, extraWhere = ''): string {
    const cols = [
        'e.entity_id AS _lore_entity_id', 'e.pk_text AS _lore_pk',
        'e.memory_node_id AS _lore_memory_node_id', 'e.memory_node_sk AS _lore_memory_node_sk',
        'e.valid_from AS _lore_valid_from', 'e.valid_to AS _lore_valid_to', 'e.source_id AS _lore_source_id',
    ];
    for (const c of meta.schema.columns) {
        const f = meta.fields.get(c.name)!;
        cols.push(`${columnExpr(f, VALUE_COLUMN[c.type], pred)} AS ${qi(c.name)}`);
        if (c.type === 'money') cols.push(`${columnExpr(f, CURRENCY_COLUMN, pred)} AS ${qi(c.name + CURRENCY_SUFFIX)}`);
    }
    return `SELECT ${cols.join(', ')} FROM ${TABLE_TABLES.entity} e ` +
        `WHERE e.workspace_id = ${sqlLiteral(workspace)} AND e.entity_type_id = ${meta.entityTypeId}${extraWhere}`;
}

export function viewDdl(workspace: string, meta: TableMeta): string {
    return `CREATE OR REPLACE VIEW ${meta.view} AS ${viewSelect(workspace, meta, CURRENT_VALUE)}`;
}

/**
 * RECORDED-time source: the table as Lore knew it at `ts` (a SQL expression, e.g. `$3::timestamptz`) - each value is
 * the row with `recorded_at <= ts` and not superseded at or before `ts`, and entities created after `ts` are absent.
 * Same columns as the read view, so the same filters and ordering apply. Header-held columns (the reserved
 * `_memory_node_id/_source_id/_valid_*`) are overwritten in place and so read as of NOW, not as of `ts`.
 */
export function recordedSourceSql(workspace: string, meta: TableMeta, ts: string): string {
    const pred: ValuePredicate = a => `${a}.recorded_at <= ${ts} AND (${a}.superseded_at IS NULL OR ${a}.superseded_at > ${ts})`;
    return `(${viewSelect(workspace, meta, pred, ` AND e.created_at <= ${ts}`)})`;
}

/** The select-list fragment for one declared column of a relation aliased `alias` (money reads as { amount, currency }). */
export function selectColumn(alias: string, c: ColumnDecl): string {
    const cur = c.type === 'money' ? `${alias}.${qi(c.name + CURRENCY_SUFFIX)}` : undefined;
    return selectExpr(`${alias}.${qi(c.name)}`, c.type, cur);
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
