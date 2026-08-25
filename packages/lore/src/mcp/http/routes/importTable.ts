/**
 * importTable.ts — Bucket A orchestration for the bulk-import route.
 *
 * `runImport` (routes/import.ts) already parses a CSV / XLSX / JSON /
 * JSONL upload into `{ headers, rows }` and maps each row onto a LoreNode.
 * This module is the additive second write: it resolves the target
 * workspace's `ITableStorage` (same routing as the collection_* tools),
 * derives a table schema from the source's own columns, and writes the
 * real rows — so an exact COUNT/SUM over the imported data is possible,
 * which flattened search text cannot guarantee.
 *
 * Table creation / evolution goes through `ITableStorage.createTable`
 * (idempotent) and `evolveSchema` (additive-only) — see
 * engines/tabularImport.ts and docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md.
 *
 * Kept out of import.ts because the route already sits at the file-size
 * budget; the table write is a distinct concern (see AGENTS.md file-size
 * rule — new routes/logic go to a sibling module, never grow the route).
 */

import { randomUUID } from 'node:crypto';
import type { StorageBundle } from '../../services.js';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import { resolveTargetTableStorage } from '../../tools/workspaceResolve.js';
import { inferTableSchema, writeTabularRows } from '../../../engines/tabularImport.js';

/** Result of the table write, surfaced (additively) on ImportResponse. */
export interface ImportTableResult {
    /** Resolved table name (e.g. `import_invoice`). */
    name: string;
    /** Source rows written to the table (one per parsed data row). */
    rowsWritten: number;
    /** 'created' = new table, 'reused' = same shape as a prior import,
     *  'evolved' = re-import with new columns added additively. */
    disposition: 'created' | 'reused' | 'evolved';
    /** Columns added on re-import, when disposition === 'evolved'. */
    addedColumns?: string[];
    /** 1.9 — rows skipped because a prior import already stored them
     *  (stable row key). Present only when > 0. */
    rowsDeduplicated?: number;
}

export interface ImportTableOutcome {
    table?: ImportTableResult;
    /** Present when a table write was attempted but failed (e.g. a
     *  reconcile conflict). The graph import is unaffected. */
    error?: string;
}

/**
 * Write the source's real rows into a queryable Collections table.
 * Best-effort: never throws — a failure is returned as `error` so the
 * caller (runImport) can surface it without rolling back the graph import
 * that already succeeded.
 */
export async function writeImportTable(opts: {
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    /** The daemon's active/boot workspace name. */
    activeWorkspace: string;
    entityType: string;
    filename: string;
    headers: string[];
    rows: Array<Record<string, string>>;
    /** Resolved destination workspace (non-empty; callers fall back to the
     *  active workspace when the route didn't thread one through). */
    targetWorkspace: string;
    /** 1.9 (2026-08-17 audit) — stable per-row identity (parallel to
     *  `rows`), keyed like the graph side (`${entityType}:${idValue}` or a
     *  content hash when no idColumn). Re-imports dedupe on this instead of
     *  doubling every row under a fresh randomUUID importId. */
    rowKeys?: string[];
}): Promise<ImportTableOutcome> {
    if (opts.rows.length === 0 || opts.headers.length === 0) return {};

    try {
        const tsRes = await resolveTargetTableStorage(
            opts.store,
            opts.graphRegistry,
            opts.activeWorkspace,
            opts.targetWorkspace,
        );
        if (!tsRes.ok) {
            return {
                error: 'missing' in tsRes
                    ? 'workspace_required'
                    : `workspace "${tsRes.requested}" not found`,
            };
        }

        const inferred = inferTableSchema({
            entityType: opts.entityType,
            headers: opts.headers,
            rows: opts.rows,
        });
        const result = await writeTabularRows({
            storage: tsRes.tableStorage,
            tableName: inferred.tableName,
            schema: inferred.schema,
            columns: inferred.columns,
            rows: opts.rows,
            importId: randomUUID(),
            sourceFile: opts.filename,
            rowKeys: opts.rowKeys,
        });

        return {
            table: {
                name: inferred.tableName,
                rowsWritten: result.rowsWritten,
                disposition: result.disposition,
                ...(result.addedColumns.length > 0 ? { addedColumns: result.addedColumns } : {}),
                ...(result.rowsDeduplicated > 0 ? { rowsDeduplicated: result.rowsDeduplicated } : {}),
            },
        };
    } catch (err) {
        return { error: (err as Error).message };
    }
}
