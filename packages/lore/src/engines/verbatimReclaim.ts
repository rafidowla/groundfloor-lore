/**
 * verbatimReclaim.ts — collapse the duplicate verbatim rows that pre-3.35.0
 * skip-identical gaps left behind in a SQLite verbatim store (3.35.0).
 *
 * BACKGROUND. Before 3.35.0 every re-store of an unchanged node wrote a fresh
 * history row (the skip-identical check compared `updatedAt`, which the graph
 * re-stamps on every re-store). The rows are byte-for-byte copies of each other
 * apart from timestamps, so they carry no history worth keeping.
 *
 * RULE (per node id, rows in rowid order = time order — the old canonical row
 * is flipped to history in place and the new one is inserted at a higher rowid):
 *   - a RUN is a maximal stretch of CONSECUTIVE rows with the same content
 *     signature: content_hash, type, label, tags, project, ecosystem,
 *     security_scopes, tombstone flag and "has a vector";
 *   - a run that contains the canonical row keeps ONLY the canonical row;
 *   - a run among superseded rows keeps its OLDEST row;
 *   - a row whose signature differs from its neighbours is never deleted, so
 *     every real change stays in the history (A,A,B,B,A(canonical) -> A,B,A);
 *   - rows without a content_hash and tombstones never join a run.
 *
 * SIDE TABLES. `verbatim_fts` (external content) is cleaned by its own
 * AFTER DELETE trigger inside the same statement; the promotion changes-log
 * triggers (when a promotion is staging) fire the same way. `verbatim_pieces`
 * is keyed by node id and the canonical row always survives, so it needs no
 * change. After an apply the FTS index is integrity-checked against the table.
 *
 * Pure engine module: no daemon/holder policy here (the CLI owns that).
 */
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as fs from 'node:fs';

/** Rows deleted per transaction. */
export const RECLAIM_CHUNK_ROWS = 500;

export interface ReclaimRow { rowid: number; id: string; bytes: number }

export interface ReclaimPlan {
    totalRows: number;
    distinctIds: number;
    /** Number of runs that lose rows. */
    runsCollapsed: number;
    /** Distinct node ids that lose rows. */
    idsAffected: number;
    rowsToDelete: number;
    /** Text + vector bytes of the rows to delete (a floor on the space they hold). */
    bytesEstimate: number;
    /** Up to 10 affected ids, most-duplicated first. */
    sampleIds: Array<{ id: string; rows: number }>;
    rows: ReclaimRow[];
}

export class ReclaimConflictError extends Error {
    constructor(message: string) { super(message); this.name = 'ReclaimConflictError'; }
}

const SIGNATURE = `json_array(content_hash, type, label, tags, project, ecosystem, security_scopes, is_tombstone, vector IS NULL)`;

/** The windowed plan. `idFilter` restricts it to a set of ids (bound as one JSON array). */
function planSql(idFilter: boolean): string {
    return `
        WITH s AS (
            SELECT rowid AS rid, id, is_canonical AS canon, ${SIGNATURE} AS sig,
                   (content_hash IS NOT NULL AND is_tombstone = 0) AS eligible
            FROM verbatim
            ${idFilter ? 'WHERE id IN (SELECT value FROM json_each(?))' : ''}
        ), p AS (
            SELECT *, LAG(sig) OVER (PARTITION BY id ORDER BY rid) AS psig FROM s
        ), r AS (
            SELECT *, SUM(CASE WHEN psig IS NULL OR psig <> sig OR NOT eligible THEN 1 ELSE 0 END)
                      OVER (PARTITION BY id ORDER BY rid) AS run
            FROM p
        ), k AS (
            SELECT *, MIN(rid) OVER (PARTITION BY id, run) AS run_min,
                   MAX(CASE WHEN canon = 1 THEN rid END) OVER (PARTITION BY id, run) AS canon_rid
            FROM r
        )
        SELECT k.rid AS rowid, k.id AS id, k.run AS run,
               length(CAST(v.text AS BLOB)) + coalesce(length(v.vector), 0) AS bytes
        FROM k JOIN verbatim v ON v.rowid = k.rid
        WHERE k.eligible
          AND ((k.canon_rid IS NOT NULL AND k.rid <> k.canon_rid)
            OR (k.canon_rid IS NULL AND k.rid <> k.run_min))
        ORDER BY k.id, k.rid`;
}

interface PlanRow { rowid: number; id: string; run: number; bytes: number }

function planRows(db: DatabaseType, ids?: readonly string[]): PlanRow[] {
    const stmt = db.prepare(planSql(ids !== undefined));
    return (ids !== undefined ? stmt.all(JSON.stringify(ids)) : stmt.all()) as PlanRow[];
}

/** Read-only scan: what a reclaim would delete. Writes nothing. */
export function scanReclaim(db: DatabaseType): ReclaimPlan {
    const totalRows = (db.prepare('SELECT count(*) AS c FROM verbatim').get() as { c: number }).c;
    const distinctIds = (db.prepare('SELECT count(DISTINCT id) AS c FROM verbatim').get() as { c: number }).c;
    const rows = planRows(db);
    const perId = new Map<string, number>();
    let runs = 0;
    let lastRun = '';
    let bytes = 0;
    for (const r of rows) {
        perId.set(r.id, (perId.get(r.id) ?? 0) + 1);
        const key = `${r.id}\u0000${r.run}`;
        if (key !== lastRun) { runs++; lastRun = key; }
        bytes += r.bytes;
    }
    const sampleIds = [...perId.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10).map(([id, n]) => ({ id, rows: n }));
    return {
        totalRows, distinctIds, runsCollapsed: runs, idsAffected: perId.size,
        rowsToDelete: rows.length, bytesEstimate: bytes, sampleIds,
        rows: rows.map((r) => ({ rowid: r.rowid, id: r.id, bytes: r.bytes })),
    };
}

export interface ReclaimApplyResult {
    deleted: number;
    chunks: number;
    /** Rows / distinct ids / canonical rows after, for the caller's before-vs-after check. */
    after: { totalRows: number; distinctIds: number; canonicalRows: number; remainingDeletable: number };
    ftsIntegrity: 'ok' | string;
}

/**
 * Delete the planned rows, grouped by node id, one transaction per chunk of
 * ~RECLAIM_CHUNK_ROWS rows. Inside each transaction the plan for just that
 * chunk's ids is recomputed and must equal what was planned: a concurrent
 * writer that changed those ids aborts the run (ReclaimConflictError) with every
 * earlier chunk already committed and valid on its own.
 */
export function applyReclaim(db: DatabaseType, plan: ReclaimPlan, chunkRows = RECLAIM_CHUNK_ROWS): ReclaimApplyResult {
    const byId = new Map<string, number[]>();
    for (const r of plan.rows) {
        const list = byId.get(r.id);
        if (list) list.push(r.rowid); else byId.set(r.id, [r.rowid]);
    }
    const chunks: Array<{ ids: string[]; rowids: number[] }> = [];
    let cur: { ids: string[]; rowids: number[] } = { ids: [], rowids: [] };
    for (const [id, rowids] of byId) {
        cur.ids.push(id);
        cur.rowids.push(...rowids);
        if (cur.rowids.length >= chunkRows) { chunks.push(cur); cur = { ids: [], rowids: [] }; }
    }
    if (cur.rowids.length > 0) chunks.push(cur);

    const del = db.prepare('DELETE FROM verbatim WHERE rowid = ?');
    let deleted = 0;
    for (const chunk of chunks) {
        const tx = db.transaction(() => {
            const fresh = planRows(db, chunk.ids).map((r) => r.rowid);
            const planned = new Set(chunk.rowids);
            if (fresh.length !== planned.size || fresh.some((rid) => !planned.has(rid))) {
                throw new ReclaimConflictError(
                    'the verbatim rows changed while the reclaim was running (another process wrote to this store); '
                    + 'nothing in the current chunk was deleted. Stop every host that has this store open and re-run.');
            }
            let n = 0;
            for (const rid of chunk.rowids) n += del.run(rid).changes;
            if (n !== chunk.rowids.length) {
                throw new ReclaimConflictError(`expected to delete ${chunk.rowids.length} rows, deleted ${n}; rolled back`);
            }
            return n;
        });
        deleted += tx.immediate();
    }
    return {
        deleted, chunks: chunks.length,
        after: {
            totalRows: (db.prepare('SELECT count(*) AS c FROM verbatim').get() as { c: number }).c,
            distinctIds: (db.prepare('SELECT count(DISTINCT id) AS c FROM verbatim').get() as { c: number }).c,
            canonicalRows: (db.prepare('SELECT count(*) AS c FROM verbatim WHERE is_canonical = 1').get() as { c: number }).c,
            remainingDeletable: planRows(db).length,
        },
        ftsIntegrity: ftsIntegrity(db),
    };
}

/** FTS5 external-content integrity check: compares the index to the content table. */
export function ftsIntegrity(db: DatabaseType): 'ok' | string {
    try {
        db.prepare(`INSERT INTO verbatim_fts(verbatim_fts, rank) VALUES ('integrity-check', 1)`).run();
        return 'ok';
    } catch (e) {
        return (e as Error).message;
    }
}

export function canonicalRowCount(db: DatabaseType): number {
    return (db.prepare('SELECT count(*) AS c FROM verbatim WHERE is_canonical = 1').get() as { c: number }).c;
}

/** Main file + WAL bytes on disk (0 for a missing file). */
export function sqliteFootprintBytes(dbPath: string): { main: number; wal: number; total: number } {
    const size = (p: string): number => { try { return fs.statSync(p).size; } catch { return 0; } };
    const main = size(dbPath);
    const wal = size(`${dbPath}-wal`);
    return { main, wal, total: main + wal };
}

/** Free pages inside the file (what a VACUUM would give back). */
export function freelistBytes(db: DatabaseType): number {
    const pages = db.pragma('freelist_count', { simple: true }) as number;
    const size = db.pragma('page_size', { simple: true }) as number;
    return pages * size;
}

/** Open the store file directly: read-only for a dry run, read-write for apply. No store init, no sqlite-vec. */
export function openReclaimDb(dbPath: string, writable: boolean): DatabaseType {
    const db = new Database(dbPath, writable ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
    if (writable) db.pragma('busy_timeout = 5000');
    return db;
}
