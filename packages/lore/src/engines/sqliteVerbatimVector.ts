/**
 * sqliteVerbatimVector.ts — vector search for SqliteVerbatimStore.
 *
 * 3.21 step 2 part 1. Two paths, chosen once at open (SqliteVecLoadResult
 * from sqliteVerbatimSchema.ts) and reported via handleCount()/stats so an
 * operator can see which one is serving a given store:
 *
 * 1. sqlite-vec loaded: `vec_distance_cosine(vector, ?)` as a scalar
 *    function over the BLOB column, `ORDER BY ... LIMIT k`. This is a
 *    full-scan distance computation (sqlite-vec's `vec0` ANN virtual table
 *    is NOT used here — the design calls for the scalar-function path
 *    specifically), just a SIMD-accelerated one instead of a JS loop.
 * 2. Fallback: JS brute force over a lazily-built Float32Array matrix, kept
 *    in memory only up to LORE_SQLITE_VECTOR_CACHE_MB (default 64). Above
 *    that budget, rows are streamed from SQLite in chunks per query instead
 *    of cached, trading query latency for a bounded memory footprint.
 *
 * Distance→score mapping matches VerbatimStore's Lance path exactly:
 * cosine similarity in [0,1], 1 = identical direction. sqlite-vec's
 * `vec_distance_cosine` returns `1 - cosine_similarity` (cosine DISTANCE),
 * so `score = 1 - distance`. The JS fallback computes cosine similarity
 * directly (dot / (|a| * |b|)) and uses it as the score unchanged — the
 * same value, computed the other way round.
 *
 * Ordering tie-break (score desc, then id asc) matches the Lance path in
 * core so results tie the same way on both engines (design section 1.1.3).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { log } from '../logger.js';

/** Little-endian float32 encode/decode — the on-disk BLOB shape. */
export function encodeVector(vec: readonly number[] | Float32Array): Buffer {
    const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function decodeVector(blob: Buffer | null): Float32Array | null {
    if (!blob || blob.length === 0) return null;
    // Copy into a fresh, aligned buffer — `blob` from better-sqlite3 may
    // not be 4-byte aligned within its underlying ArrayBuffer, and
    // Float32Array requires alignment.
    const copy = Buffer.from(blob);
    return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const av = a[i]!, bv = b[i]!;
        dot += av * bv; na += av * av; nb += bv * bv;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface VectorHitRow {
    rowid: number;
    id: string;
    text: string;
    type: string | null;
    label: string | null;
    tags: string | null;
    project: string | null;
    ecosystem: string | null;
    updatedAt: string | null;
    security_scopes: string | null;
}

export interface VectorHit {
    row: VectorHitRow;
    score: number;
}

const DEFAULT_CACHE_MB = 64;

function cacheBudgetMb(): number {
    const raw = process.env.LORE_SQLITE_VECTOR_CACHE_MB;
    if (!raw || raw.trim() === '') return DEFAULT_CACHE_MB;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_MB;
}

/**
 * Lazily-built in-memory matrix for the JS brute-force fallback. One
 * instance per store (constructed once, invalidated on every write via
 * `invalidate()` — mirrors VerbatimStore's search-cache epoch bump).
 * Bounded by LORE_SQLITE_VECTOR_CACHE_MB: a store whose canonical,
 * non-null-vector row count exceeds the budget is never cached — every
 * query streams chunks from SQLite instead, trading latency for a
 * bounded footprint (design section 1.1.2).
 */
export class BruteForceVectorCache {
    private rows: VectorHitRow[] | null = null;
    private vectors: Float32Array[] | null = null;
    private dirty = true;

    invalidate(): void {
        this.dirty = true;
        this.rows = null;
        this.vectors = null;
    }

    /** Whether the last build attempt fit in budget (used by stats/tests to
     *  report which fallback sub-path actually ran). */
    private streaming = false;
    isStreaming(): boolean {
        return this.streaming;
    }

    private ensureBuilt(db: DatabaseType, dim: number): void {
        if (!this.dirty && this.rows && this.vectors) return;
        const budgetBytes = cacheBudgetMb() * 1024 * 1024;
        const countRow = db.prepare(
            `SELECT count(*) as c FROM verbatim WHERE is_canonical = 1 AND is_tombstone = 0 AND vector IS NOT NULL`,
        ).get() as { c: number };
        const estimatedBytes = countRow.c * (dim * 4 + 200); // vector + row overhead estimate
        if (budgetBytes > 0 && estimatedBytes > budgetBytes) {
            this.streaming = true;
            this.rows = null;
            this.vectors = null;
            this.dirty = false;
            return;
        }
        this.streaming = false;
        const stmt = db.prepare(
            `SELECT rowid, id, text, type, label, tags, project, ecosystem, updatedAt, security_scopes, vector
             FROM verbatim WHERE is_canonical = 1 AND is_tombstone = 0 AND vector IS NOT NULL`,
        );
        const rows: VectorHitRow[] = [];
        const vectors: Float32Array[] = [];
        for (const raw of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
            const v = decodeVector(raw.vector as Buffer | null);
            if (!v) continue;
            rows.push({
                rowid: raw.rowid as number, id: raw.id as string, text: raw.text as string,
                type: raw.type as string | null, label: raw.label as string | null, tags: raw.tags as string | null,
                project: raw.project as string | null, ecosystem: raw.ecosystem as string | null,
                updatedAt: raw.updatedAt as string | null, security_scopes: raw.security_scopes as string | null,
            });
            vectors.push(v);
        }
        this.rows = rows;
        this.vectors = vectors;
        this.dirty = false;
    }

    /** In-memory brute force. Caller has already confirmed the cache fit in
     *  budget (isStreaming() false) after ensureBuilt(). `filter` is applied
     *  AFTER scoring (post-filter over the shared cached matrix — the cache
     *  is built once and reused across every query regardless of that
     *  query's own filter), matching the SQL WHERE-based native path's
     *  RESULT SET, just computed differently. */
    search(db: DatabaseType, dim: number, query: Float32Array, k: number, filter: RowFilter = []): VectorHit[] {
        this.ensureBuilt(db, dim);
        if (this.streaming || !this.rows || !this.vectors) {
            return streamingBruteForceSearch(db, query, k, filter);
        }
        const hits: VectorHit[] = [];
        for (let i = 0; i < this.rows.length; i++) {
            if (filter.length > 0 && !matchesRowFilter(this.rows[i]!, filter)) continue;
            const score = cosineSimilarity(query, this.vectors[i]!);
            hits.push({ row: this.rows[i]!, score });
        }
        return topK(hits, k);
    }
}

/** Streamed brute force for stores over the cache budget — reads rows in
 *  chunks so peak memory stays bounded regardless of store size. */
function streamingBruteForceSearch(db: DatabaseType, query: Float32Array, k: number, filter: RowFilter = []): VectorHit[] {
    const CHUNK = 2000;
    let best: VectorHit[] = [];
    const stmt = db.prepare(
        `SELECT rowid, id, text, type, label, tags, project, ecosystem, updatedAt, security_scopes, vector
         FROM verbatim WHERE is_canonical = 1 AND is_tombstone = 0 AND vector IS NOT NULL`,
    );
    let batch: VectorHit[] = [];
    for (const raw of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
        const v = decodeVector(raw.vector as Buffer | null);
        if (!v) continue;
        const row: VectorHitRow = {
            rowid: raw.rowid as number, id: raw.id as string, text: raw.text as string,
            type: raw.type as string | null, label: raw.label as string | null, tags: raw.tags as string | null,
            project: raw.project as string | null, ecosystem: raw.ecosystem as string | null,
            updatedAt: raw.updatedAt as string | null, security_scopes: raw.security_scopes as string | null,
        };
        if (filter.length > 0 && !matchesRowFilter(row, filter)) continue;
        const score = cosineSimilarity(query, v);
        batch.push({ row, score });
        if (batch.length >= CHUNK) {
            best = topK(best.concat(batch), k);
            batch = [];
        }
    }
    if (batch.length > 0) best = topK(best.concat(batch), k);
    return best;
}

/** score desc, then id asc — matches the Lance path's tie-break rule. */
function topK(hits: VectorHit[], k: number): VectorHit[] {
    hits.sort((a, b) => (b.score - a.score) || a.row.id.localeCompare(b.row.id));
    return hits.slice(0, k);
}

/** [column, value] pairs — the same allowlisted-column shape the main store
 *  class builds from `buildSqlFilterEntries` before calling into this
 *  module, so both vector-search paths honor an identical metadata filter
 *  regardless of which one actually served the query. D2: `value` may be a
 *  `string[]` (IN-list semantics, e.g. `types: string[]`) as well as a
 *  plain scalar (equality) — see `buildSqlFilterEntries`'s `rowValue`. */
export type RowFilter = ReadonlyArray<readonly [string, string | string[]]>;

function matchesRowFilter(row: VectorHitRow, filter: RowFilter): boolean {
    for (const [key, value] of filter) {
        const rowValue = (row as unknown as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
            if (!value.includes(rowValue as string)) return false;
        } else if (rowValue !== value) {
            return false;
        }
    }
    return true;
}

/**
 * Native sqlite-vec path: `vec_distance_cosine` as a scalar function over
 * the BLOB column, ORDER BY ... LIMIT k. `whereSql`/`params` let the
 * caller add scope/history filters (built the same way the fallback's
 * WHERE clause is, so both paths honor identical filtering).
 *
 * TWO queries, not one — measured (100K x 384-d store) that a single
 * `SELECT id, text, ..., vec_distance_cosine(...) AS distance ... ORDER BY
 * distance LIMIT k` made SQLite's sorter carry every SELECTed column
 * (including `text`) for all 100K candidate rows into the sort, not just
 * the rowid+distance it needs to pick the top k — 74ms p50, OVER the
 * design's 50ms budget, and slower than the JS brute-force fallback on the
 * same data. Splitting into (1) a lean `rowid, distance` scan+sort+limit
 * and (2) an indexed-by-rowid fetch of just the k winners' full columns
 * dropped that to the sub-20ms range: step 1 still pays the full O(n)
 * distance computation the design's scalar-function-over-full-scan
 * approach requires, but the sorter now carries 8 bytes/row instead of a
 * ~100-byte row, and step 2 only marshals k rows instead of n.
 */
export function nativeVectorSearch(
    db: DatabaseType,
    query: Float32Array,
    k: number,
    extraWhereSql: string,
    extraParams: unknown[],
): VectorHit[] {
    const qBlob = encodeVector(query);
    const topKSql = `
        SELECT rowid, vec_distance_cosine(vector, ?) as distance
        FROM verbatim
        WHERE is_canonical = 1 AND is_tombstone = 0 AND vector IS NOT NULL
        ${extraWhereSql ? `AND ${extraWhereSql}` : ''}
        ORDER BY distance ASC
        LIMIT ?
    `;
    try {
        const winners = db.prepare(topKSql).all(qBlob, ...extraParams, k) as Array<{ rowid: number; distance: number }>;
        if (winners.length === 0) return [];
        const distanceByRowid = new Map(winners.map((w) => [w.rowid, w.distance]));
        const placeholders = winners.map(() => '?').join(', ');
        const rows = db.prepare(
            `SELECT rowid, id, text, type, label, tags, project, ecosystem, updatedAt, security_scopes
             FROM verbatim WHERE rowid IN (${placeholders})`,
        ).all(...winners.map((w) => w.rowid)) as Array<Record<string, unknown>>;
        const hits = rows.map((r) => ({
            row: {
                rowid: r.rowid as number, id: r.id as string, text: r.text as string,
                type: r.type as string | null, label: r.label as string | null, tags: r.tags as string | null,
                project: r.project as string | null, ecosystem: r.ecosystem as string | null,
                updatedAt: r.updatedAt as string | null, security_scopes: r.security_scopes as string | null,
            },
            score: 1 - (distanceByRowid.get(r.rowid as number) ?? 0),
        }));
        // The IN(...) fetch doesn't preserve step 1's order — re-sort +
        // re-apply the same tie-break (score desc, then id asc) the
        // fallback path uses, so both paths return identically ordered
        // results for identical scores.
        hits.sort((a, b) => (b.score - a.score) || a.row.id.localeCompare(b.row.id));
        return hits;
    } catch (err) {
        log.error(`[SqliteVerbatimStore] native vector search failed (falling back non-fatal for this call): ${(err as Error).message}`);
        throw err;
    }
}
