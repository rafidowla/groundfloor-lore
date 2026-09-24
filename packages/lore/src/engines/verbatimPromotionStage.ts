/**
 * verbatimPromotionStage.ts — streams SQLite rows into a fresh LanceDB
 * table (the "staging" table, `<ws>/.lore/lancedb.promoting/`), and later
 * applies the tail (rows written after the stream started).
 *
 * 3.21 step 2 part 3. Vectors are copied, never re-embedded (design
 * section 3 step 2). Row id/text mapping bridges the two engines' history
 * representations:
 *
 *   - SQLite: `is_canonical` / `is_tombstone` real columns; history rows
 *     share the canonical `id` (distinguished by rowid + is_canonical=0).
 *   - Lance: no such columns — a history snapshot is a SEPARATE physical
 *     row keyed by the synthetic id `<canonicalId>#rev<ISO-timestamp>`
 *     (verbatimHistory.ts's HISTORY_SUFFIX_RE), and a tombstone is just the
 *     canonical row with its text prefixed `[TOMBSTONED ...]` (already true
 *     of a SQLite tombstone row's `text` column — see sqliteVerbatimWrite.ts's
 *     tombstone(), so no extra encoding is needed there, only for history
 *     rows' id).
 *
 * A SQLite row with a NULL vector (step 3c: a text-only row, null
 * embedder) gets a zero-vector placeholder in Lance — `buildVerbatimSchema`'s
 * `vector` field is non-nullable, and a zero-vector placeholder is this
 * codebase's existing convention for "no embedding yet" (see
 * bulkAddPrebuiltRows's doc comment in verbatimStore.ts: "the caller passes
 * placeholder zero-vectors"). It is filtered OUT of native vector search's
 * useful results by cosine similarity being ~0 for any real query, and
 * remains BM25-searchable.
 */

import * as lancedb from '@lancedb/lancedb';
import type { Database as DatabaseType } from 'better-sqlite3';

import { buildVerbatimSchema } from './verbatimSchema.js';
import { decodeVector } from './sqliteVerbatimVector.js';

export interface SourceRow {
    rowid: number;
    id: string;
    text: string;
    vector: Buffer | null;
    content_hash: string | null;
    type: string | null;
    label: string | null;
    tags: string | null;
    project: string | null;
    ecosystem: string | null;
    updatedAt: string | null;
    security_scopes: string | null;
    is_canonical: number;
    is_tombstone: number;
    superseded_at: string | null;
    created_at: string;
}

/** The Lance row shape (matches buildVerbatimSchema's field list exactly —
 *  see verbatimStore.ts's own `store()` for the reference row shape this
 *  mirrors). */
export interface LanceRow {
    vector: number[];
    id: string;
    text: string;
    type: string;
    label: string;
    tags: string;
    project: string;
    ecosystem: string;
    updatedAt: string;
    security_scopes: string[];
    contentHash: string;
}

/** Lance's history-snapshot id convention — see verbatimHistory.ts's
 *  HISTORY_SUFFIX_RE / isRevisionHistoryId. Only used when writing a
 *  non-canonical SQLite row into the promoted Lance table. */
export function lanceRowId(row: SourceRow): string {
    if (row.is_canonical) return row.id;
    const ts = row.superseded_at ?? row.created_at;
    // Match HISTORY_SUFFIX_RE exactly: #rev<ISO-8601 millis timestamp>.
    const iso = new Date(ts).toISOString();
    return `${row.id}#rev${iso}`;
}

export function toLanceRow(row: SourceRow, dim: number): LanceRow {
    const vec = decodeVector(row.vector);
    const vector = vec ? Array.from(vec) : new Array(dim).fill(0);
    let scopes: string[] = [];
    if (row.security_scopes) {
        try { scopes = JSON.parse(row.security_scopes); } catch { scopes = []; }
    }
    return {
        vector,
        id: lanceRowId(row),
        text: row.text,
        type: row.type ?? '',
        label: row.label ?? '',
        tags: row.tags ?? '',
        project: row.project ?? '',
        ecosystem: row.ecosystem ?? '',
        updatedAt: row.updatedAt ?? '',
        security_scopes: scopes,
        contentHash: row.content_hash ?? '',
    };
}

const SELECT_COLUMNS = `rowid, id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt,
                         security_scopes, is_canonical, is_tombstone, superseded_at, created_at`;

/**
 * Create the staging Lance table at `stagingDir` and stream every row from
 * `db` in rowid order, chunked. Returns the high-water rowid recorded
 * BEFORE the scan started (design step 2/3: "Record the high-water rowid
 * at the start of step 2" — writes landing during this scan are picked up
 * by the tail-copy, not here, even if they happen to have a rowid within
 * the range already scanned by the time table.add() runs for that chunk).
 */
export async function streamStage(
    db: DatabaseType,
    stagingDir: string,
    dim: number,
    chunkSize = 2000,
): Promise<{ highWaterRowid: number; rowsStaged: number }> {
    const highWaterRow = db.prepare(`SELECT COALESCE(MAX(rowid), 0) as m FROM verbatim`).get() as { m: number };
    const highWaterRowid = highWaterRow.m;

    const connection = await lancedb.connect(stagingDir);
    const schema = buildVerbatimSchema(dim);
    let table: lancedb.Table | null = null;

    const stmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM verbatim WHERE rowid <= ? ORDER BY rowid`);
    let batch: LanceRow[] = [];
    let rowsStaged = 0;
    const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        if (!table) {
            table = await connection.createTable('lore_verbatim', batch as unknown as Record<string, unknown>[], { schema });
        } else {
            await table.add(batch as unknown as Record<string, unknown>[]);
        }
        rowsStaged += batch.length;
        batch = [];
    };
    for (const raw of stmt.iterate(highWaterRowid) as IterableIterator<SourceRow>) {
        batch.push(toLanceRow(raw, dim));
        if (batch.length >= chunkSize) await flush();
    }
    await flush();
    if (!table) {
        // Empty source — still create an empty table with the right schema
        // so downstream index-build / open logic has something to open.
        table = await connection.createEmptyTable('lore_verbatim', schema);
    }
    return { highWaterRowid, rowsStaged };
}

/**
 * Apply the tail: every row the changes-log recorded with rowid >
 * `highWaterRowid`, replayed against the staging table. `op:'upsert'`
 * re-reads the CURRENT row from `verbatim` (it may have been written,
 * then overwritten again, multiple times since staging started — only the
 * latest state matters) and mergeInsert-upserts it by Lance id;
 * `op:'delete'` removes the corresponding Lance row(s) — a canonical
 * delete removes exactly one row; nothing here removes history-snapshot
 * rows, since SQLite never hard-deletes a snapshot on its own (only
 * physicalDeleteMany against the canonical row's id could, and that also
 * hard-deletes on SQLite's side, which the changes-log records as
 * `op:'delete'` for that specific rowid — including snapshot rowids, since
 * physicalDelete/physicalDeleteMany operate on `id`, not
 * `is_canonical`-scoped, matching Lance's own physicalDelete semantics of
 * removing whatever row(s) match the predicate).
 *
 * Caller is responsible for the write-gate (see verbatimPromotion.ts) —
 * this function assumes no further writes land on `db` while it runs.
 */
export async function copyTail(
    db: DatabaseType,
    stagingDir: string,
    dim: number,
    highWaterRowid: number,
): Promise<{ tailRowsApplied: number }> {
    const connection = await lancedb.connect(stagingDir);
    const table = await connection.openTable('lore_verbatim');

    const changes = db.prepare(
        `SELECT row_rowid, row_id, op FROM verbatim_changes_log WHERE row_rowid > ? ORDER BY seq`,
    ).all(highWaterRowid) as Array<{ row_rowid: number; row_id: string; op: 'upsert' | 'delete' }>;
    if (changes.length === 0) return { tailRowsApplied: 0 };

    // Dedupe to the LATEST op per rowid (a row can be upserted multiple
    // times, or upserted-then-deleted, within the tail window). rowid, not
    // row_id, is the dedupe key — physicalDelete removes every row sharing
    // an id (canonical + all its history snapshots) in one statement, so
    // several DISTINCT rowids can share the same row_id; each is its own
    // physical row and needs its own resolution.
    const latestOpByRowid = new Map<number, { op: 'upsert' | 'delete'; rowId: string }>();
    for (const c of changes) latestOpByRowid.set(c.row_rowid, { op: c.op, rowId: c.row_id });

    const upsertStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM verbatim WHERE rowid = ?`);
    // Ids already deleted from Lance this pass — physicalDelete's `DELETE
    // FROM verbatim WHERE id = ?` removes every physical row sharing an id
    // (canonical + history) in one statement, so ONE delete of the
    // canonical row implies every history-snapshot row for that id is
    // ALSO gone; deleting by id-prefix once covers all of them instead of
    // once per stale changes-log entry.
    const deletedIds = new Set<string>();
    let applied = 0;
    for (const [rowid, { op, rowId }] of latestOpByRowid) {
        if (op === 'delete') {
            if (deletedIds.has(rowId)) { applied++; continue; }
            deletedIds.add(rowId);
            const safe = rowId.replace(/'/g, "''");
            await table.delete(`id = '${safe}' OR id LIKE '${safe.replace(/[\\%_]/g, (ch) => `\\${ch}`)}#rev%' ESCAPE '\\'`);
            applied++;
            continue;
        }
        const row = upsertStmt.get(rowid) as SourceRow | undefined;
        if (!row) continue; // deleted again since — nothing to apply
        const lanceRow = toLanceRow(row, dim);
        await table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([lanceRow as unknown as Record<string, unknown>]);
        applied++;
    }
    return { tailRowsApplied: applied };
}
