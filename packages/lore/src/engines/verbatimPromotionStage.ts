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
import { deleteEntityRows } from './verbatimPromotionEntityRows.js';

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

/** SQLITE-STALL fix item 1 — changes-log rows read per SQLite window in
 *  copyTail. Each window is one synchronous read (no `await`), sized so a
 *  window stays millisecond-scale. */
const TAIL_CHUNK_ROWS = 200;

/** Distinct entities buffered before one Lance delete+add flush. Bounds both
 *  memory (rows held) and the number of full-table delete scans a long
 *  backlog costs (one per flush, not one per window). */
const TAIL_FLUSH_ENTITIES = 1000;

/** Cap on the distinct entity ids copyTail reports back for the gate's content check. */
export const MAX_TOUCHED_REPORTED = 20_000;

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

export interface CopyTailOptions {
    /** Resume after this changes-log `seq` (exclusive). Default 0. */
    fromSeq?: number;
    /** Stop at this `seq` (inclusive). Default: no upper bound. */
    toSeq?: number;
}

/**
 * Apply the tail: replay every changes-log entry with `fromSeq < seq <=
 * toSeq` against the staging table, in bounded chunks (SQLITE-STALL fix
 * item 1).
 *
 * LOCKING. No SQLite lock is ever held across an `await`. Each chunk is one
 * synchronous window: `BEGIN` (a deferred READ transaction, so the chunk
 * sees one consistent snapshot while writers in other connections/processes
 * proceed untouched under WAL), read at most `TAIL_CHUNK_ROWS` changes-log
 * rows plus the current SQLite rows of every entity they touch, `COMMIT`.
 * The LanceDB writes happen after the window closes. A caller that already
 * holds a transaction (the final catch-up snapshot in verbatimPromotion.ts,
 * or a unit harness's crash simulation) keeps its own: the windows then read
 * inside that snapshot and copyTail neither begins nor commits.
 *
 * SEMANTICS - resync by entity. A changes-log entry only says "something
 * about entity `row_id` changed". SQLite keeps an entity's canonical row and
 * its history rows under the SAME `id` (store() demotes the old canonical row
 * to history in place and inserts a new one; replaceCanonical deletes and
 * re-inserts; physicalDelete / reclaim remove rows), while Lance keeps them
 * as separate rows (`<id>` and `<id>#rev<ts>`). Replaying individual rowids
 * therefore cannot express the demotion or a partial delete, so for every
 * entity touched in a chunk the staging table is made to equal SQLite's
 * CURRENT rows for that id: delete every Lance row of the entity
 * (`deleteEntityRows`: an exact per-entity decision, so `foo` never takes
 * `foo#revbar` with it; see verbatimPromotionEntityRows.ts), then add the
 * current SQLite rows mapped through `toLanceRow`. The rows are added
 * ROW FOR ROW: two history snapshots that share a `superseded_at`
 * millisecond map to the same `<id>#rev<ISO>` Lance id and both are kept,
 * exactly as the native Lance engine keeps them (plain `table.add`), so a
 * promoted store is row-for-row equal to a natively-Lance one and
 * streamStage, copyTail and the verifier's physical row count agree. Entities are applied in log order and a later read of the
 * same entity replaces an earlier buffered one, so the end state converges on
 * SQLite however writes interleave between chunks. Changes to rows whose
 * rowid is at or below the stream's high-water mark (history demotions,
 * deletes of streamed rows) are NOT skipped; filtering on rowid, as the first
 * cut of this fix did, silently lost exactly those.
 *
 * Crash-safety is unchanged: nothing is deleted from `verbatim_changes_log`
 * here (it is dropped only at the commit point, verbatimPromotion.ts), and the
 * cursor lives in memory, so an interrupted run leaves the log for
 * `recoverOnOpen` to discard with the staging dir (SQLite stays
 * authoritative).
 *
 * `_highWaterRowid` is kept for call compatibility; the cursor is `seq`.
 * Returns `tailRowsApplied` (changes-log entries consumed), `lastSeq`
 * (the highest `seq` consumed, or `fromSeq` if none) and `touchedEntities`
 * (distinct entity ids resynced, capped at MAX_TOUCHED_REPORTED; `touchedOverflow`
 * says the cap was hit) so the gate can content-check exactly those rows.
 */
export async function copyTail(
    db: DatabaseType,
    stagingDir: string,
    dim: number,
    _highWaterRowid: number,
    opts: CopyTailOptions = {},
): Promise<{ tailRowsApplied: number; lastSeq: number; touchedEntities: string[]; touchedOverflow: boolean }> {
    const touchedAll = new Set<string>();
    let touchedOverflow = false;
    const connection = await lancedb.connect(stagingDir);
    const table = await connection.openTable('lore_verbatim');

    type ChangesRow = { seq: number; row_id: string };
    const changesStmt = db.prepare(
        `SELECT seq, row_id FROM verbatim_changes_log WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
    );
    const entityStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM verbatim WHERE id = ? ORDER BY rowid`);
    const toSeq = opts.toSeq ?? Number.MAX_SAFE_INTEGER;

    // entity id -> the Lance rows it must have after this flush (possibly none).
    let pending = new Map<string, LanceRow[]>();
    const flush = async (): Promise<void> => {
        if (pending.size === 0) return;
        const ids = [...pending.keys()];
        const rows: LanceRow[] = [];
        for (const r of pending.values()) rows.push(...r);
        pending = new Map();
        await deleteEntityRows(table, ids);
        if (rows.length > 0) await table.add(rows as unknown as Record<string, unknown>[]);
    };

    let applied = 0;
    let cursor = opts.fromSeq ?? 0;
    for (;;) {
        const ownTxn = !db.inTransaction;
        if (ownTxn) db.exec('BEGIN');
        let changes: ChangesRow[];
        const touched = new Map<string, LanceRow[]>();
        try {
            changes = changesStmt.all(cursor, toSeq, TAIL_CHUNK_ROWS) as ChangesRow[];
            for (const c of changes) {
                if (touched.has(c.row_id)) continue;
                touched.set(c.row_id, (entityStmt.all(c.row_id) as SourceRow[]).map((raw) => toLanceRow(raw, dim)));
            }
        } finally {
            if (ownTxn) db.exec('COMMIT');
        }
        if (changes.length === 0) break;
        cursor = changes[changes.length - 1]!.seq;
        applied += changes.length;
        for (const [id, rows] of touched) {
            if (touchedAll.size < MAX_TOUCHED_REPORTED) touchedAll.add(id); else if (!touchedAll.has(id)) touchedOverflow = true;
            pending.delete(id); // a newer read replaces an older buffered one
            pending.set(id, rows);
        }
        if (pending.size >= TAIL_FLUSH_ENTITIES) await flush();
    }
    await flush();
    return { tailRowsApplied: applied, lastSeq: cursor, touchedEntities: [...touchedAll], touchedOverflow };
}
