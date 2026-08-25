/**
 * documentTables.ts — write tables detected INSIDE documents (Bucket C)
 * into queryable Collections tables, reusing Bucket A's pipeline.
 *
 * The DOCX/PDF extractors detect tables and surface them on
 * `ExtractedContent.tables` (see engines/extractors/types.ts). This module is
 * the single write path that turns those `{ headers, rows }` shapes into real
 * Collections tables — it does NOT re-implement schema inference or writing;
 * it delegates entirely to `tabularImport.ts`'s `inferTableSchema()` +
 * `writeTabularRows()`, exactly as Bucket A does for spreadsheets.
 *
 * Table naming: a document has no caller-supplied `entityType` (unlike the
 * `/api/import` route, which gets `mapping.entityType`), so each table keys
 * off the source document's name + its 1-based position among the document's
 * tables — `import_<sanitized-stem>_table_<N>`.
 *
 * Schema safety: `inferTableSchema` + `writeTabularRows` carry the
 * createTable (idempotent) + evolveSchema (additive-only) guardrails — see
 * docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md. Nothing here hand-rolls DDL.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ITableStorage } from '../contracts/tables.js';
import type { DetectedTable } from './extractors/types.js';
import { inferTableSchema, writeTabularRows, sanitizeIdentifier } from './tabularImport.js';

/** Derive a stable per-table entity type from the source file name + position. */
export function documentTableEntityType(sourceName: string, position: number): string {
    const base = path.basename(sourceName).replace(/\.[^.]+$/, '').trim();
    // sanitizeIdentifier keeps the SAME naming rules as Bucket A (don't
    // re-implement identifier sanitation here).
    return `${sanitizeIdentifier(base, 'document')}_table_${position}`;
}

export interface DocumentTableWriteResult {
    /** Number of tables written. */
    written: number;
    /** Resolved table names, in document order. */
    tableNames: string[];
    /** Total data rows written across all tables. */
    rows: number;
}

/**
 * Write every detected table into its own Collections table. Each table is a
 * separate `inferTableSchema` + `writeTabularRows` call, so a two-table
 * document yields two tables (names derived from source name + position).
 */
export async function writeDocumentTables(opts: {
    storage: ITableStorage;
    sourceName: string;
    tables: DetectedTable[];
}): Promise<DocumentTableWriteResult> {
    const { storage, sourceName, tables } = opts;
    const tableNames: string[] = [];
    let rows = 0;

    for (const table of tables) {
        const entityType = documentTableEntityType(sourceName, table.position);
        const inferred = inferTableSchema({
            entityType,
            headers: table.headers,
            rows: table.rows,
        });
        const result = await writeTabularRows({
            storage,
            tableName: inferred.tableName,
            schema: inferred.schema,
            columns: inferred.columns,
            rows: table.rows,
            importId: randomUUID(),
            sourceFile: sourceName,
        });
        tableNames.push(inferred.tableName);
        rows += result.rowsWritten;
    }

    return { written: tables.length, tableNames, rows };
}
