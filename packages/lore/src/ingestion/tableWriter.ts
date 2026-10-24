/**
 * ingestion/tableWriter.ts — structured fields -> tables (where tables exist).
 *
 * Slice-1 mapping is deliberately mechanical (schema CHOICE is the Agentic DBA's
 * job in slice 2): one row per item at `itemPath` (or one row for the whole
 * object), one column per top-level key, scalar types inferred, nested values
 * stored as JSON. Every row carries provenance columns; per-value provenance is
 * the item's page/quote/confidence plus `_field_confidence` for the fields the
 * processor flagged.
 *
 * Idempotent per job: rows of this job are deleted then re-inserted, so a
 * retried write step or a duplicate callback never doubles rows.
 *
 * When the workspace has no table storage (cloud/other engines before their
 * implementation lands) or the table cannot be reconciled additively, the
 * validated result is recorded as PENDING in the ingestion store instead of
 * being dropped or force-fit.
 */
import { createHash } from 'node:crypto';
import type { ColumnDecl, ColumnType, ITableStorage, TableSchema } from '../contracts/tables.js';
import { sanitizeIdentifier, unionSchema } from '../engines/tabularImport.js';
import type { StructureResult } from './contracts.js';
import type { SourceRecord } from './store.js';

export interface TablePort { forWorkspace(workspace: string): Promise<ITableStorage | null> }

export type TableWriteOutcome =
    | { kind: 'written'; table: string; rows: number }
    | { kind: 'pending'; reason: string };

export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 200;

const TRACE_COLUMNS: ColumnDecl[] = [
    { name: '_row_id', type: 'string', primary: true, required: true },
    { name: '_job_id', type: 'string', required: true, indexed: true },
    { name: '_source_id', type: 'string', required: true, indexed: true },
    { name: '_source_file', type: 'string' },
    { name: '_item_index', type: 'integer' },
    { name: '_processor', type: 'string' },
    { name: '_processor_version', type: 'string' },
    { name: '_source_page', type: 'integer' },
    { name: '_source_quote', type: 'string' },
    { name: '_confidence', type: 'float' },
    { name: '_confidence_level', type: 'string' },
    { name: '_needs_review', type: 'boolean' },
    { name: '_field_confidence', type: 'json' },
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function itemsAt(content: Record<string, unknown>, itemPath?: string): Record<string, unknown>[] {
    if (!itemPath) return [content];
    let node: unknown = content;
    for (const k of itemPath.split('.').filter(Boolean)) {
        if (!isObj(node) || !Object.hasOwn(node, k)) return [];
        node = node[k];
    }
    return Array.isArray(node) ? node.filter(isObj) : [];
}

function typeOf(values: unknown[]): ColumnType {
    const vs = values.filter((v) => v !== null && v !== undefined);
    if (vs.length === 0) return 'string';
    if (vs.every((v) => typeof v === 'boolean')) return 'boolean';
    if (vs.every((v) => typeof v === 'number' && Number.isInteger(v))) return 'integer';
    if (vs.every((v) => typeof v === 'number')) return 'float';
    if (vs.every((v) => typeof v === 'string')) return 'string';
    return 'json';
}

export function tableNameFor(tableBase: string): string {
    return sanitizeIdentifier('ingest_' + tableBase, 'ingest_items').toLowerCase().slice(0, 60);
}

export async function writeStructuredFields(opts: {
    port: TablePort; source: SourceRecord; jobId: string; result: StructureResult; itemPath?: string; tableBase: string;
}): Promise<TableWriteOutcome> {
    const { port, source, jobId, result, itemPath } = opts;
    const items = itemsAt(result.content, itemPath).slice(0, MAX_ROWS);
    if (items.length === 0) return { kind: 'written', table: tableNameFor(opts.tableBase), rows: 0 };

    const storage = await port.forWorkspace(source.workspace);
    if (!storage) return { kind: 'pending', reason: 'tables_unavailable' };

    // Column set: union of top-level own keys, sanitized + deduplicated, never colliding with trace columns.
    const used = new Set(TRACE_COLUMNS.map((c) => c.name));
    const keyToCol = new Map<string, string>();
    for (const it of items) for (const k of Object.keys(it)) {
        if (keyToCol.has(k) || keyToCol.size >= MAX_COLUMNS) continue;
        let name = sanitizeIdentifier(k, `field_${keyToCol.size + 1}`).replace(/^_+/, 'f_');
        const base = name; let n = 2;
        while (used.has(name)) name = `${base}_${n++}`;
        used.add(name); keyToCol.set(k, name);
    }
    const dataCols: ColumnDecl[] = [...keyToCol].map(([k, name]) => ({ name, type: typeOf(items.map((it) => it[k])) }));
    const table = tableNameFor(opts.tableBase);
    const schema: TableSchema = {
        name: table, columns: [...TRACE_COLUMNS, ...dataCols],
        description: `Structured fields ingested from source files (provenance columns start with '_').`,
    };

    try {
        try { await storage.createTable(schema); }
        catch (err) {
            if (!/different shape/i.test((err as Error).message) || !storage.evolveSchema) throw err;
            const existing = (storage as ITableStorage & { schemas?: Map<string, TableSchema> }).schemas?.get(table);
            if (!existing) throw err;
            await storage.evolveSchema(table, unionSchema(existing, schema));
        }
        const ann = new Map((result.annotations?.items ?? []).map((a) => [a.index, a]));
        const rows = items.map((it, index) => {
            const a = ann.get(index);
            const row: Record<string, unknown> = {
                _row_id: 'row_' + createHash('sha256').update(`${jobId}\0${index}`).digest('hex').slice(0, 32),
                _job_id: jobId, _source_id: source.sourceId, _source_file: source.fileName, _item_index: index,
                _processor: result.processor.id, _processor_version: result.processor.version,
                _source_page: a?.source_page ?? null, _source_quote: a?.source_quote ?? null,
                _confidence: a?.confidence.score ?? null, _confidence_level: a?.confidence.level ?? null,
                _needs_review: a ? a.needs_review : true, _field_confidence: a?.field_confidence ?? null,
            };
            for (const [k, col] of keyToCol) row[col] = it[k] === undefined ? null : it[k];
            return row;
        });
        // Job-scoped delete: `all: true` only confirms the data-dependent all-rows guard when this job owns every row.
        await storage.delete(table, { eq: { _job_id: jobId } }, { all: true });
        await storage.insertBatch(table, rows);
        return { kind: 'written', table, rows: rows.length };
    } catch (err) {
        return { kind: 'pending', reason: `table_write_failed: ${(err as Error).message}`.slice(0, 500) };
    }
}
