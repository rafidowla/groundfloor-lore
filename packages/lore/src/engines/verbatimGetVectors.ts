/**
 * verbatimGetVectors.ts - engine-neutral `getVectors(ids)` helpers (3.27.1).
 *
 * Atlas's memory export / code-graph sync needs the STORED embedding for a set
 * of rows so it can write the v2 memory file without re-embedding. Before this
 * the only path was `rawVerbatim().table` (LanceDB only), so on the SQLite
 * engine Atlas silently fell back to v1 and a git-synced memory.jsonl flipped
 * format between machines on different engines.
 *
 * One contract, both engines (VerbatimStore -> lanceGetVectors, SqliteVerbatimStore
 * -> sqliteGetVectors in sqliteVerbatimVector.ts):
 *   - ids are exact verbatim row ids; CANONICAL rows only. A `#rev<ts>` history id
 *     never matches, and an alias id (`lore:<id>#q<i>`) matches only itself.
 *   - result is `Map<id, number[]>` (plain numbers, widened from float32 - both
 *     engines store float32, so the same data is bit-identical on both).
 *   - OMITTED, never an error: unknown ids, tombstoned rows, and rows with no
 *     real embedding. "No real embedding" = NULL/empty vector (SQLite bulk rows)
 *     OR an all-zero placeholder (bulkAddPrebuiltRows on Lance AND SQLite) - the
 *     parity trap: SQLite can hold NULL where Lance holds zeros, so BOTH shapes
 *     are treated as "not embedded" on BOTH engines.
 *   - read path only: no writeGate write entry, no embedding, no promotion.
 */
import type * as lancedb from '@lancedb/lancedb';
import { assertSafeLanceId, isRevisionHistoryId, HISTORY_ID_LIKE_PATTERN, toPlainVector } from './verbatimHistory.js';

/** Upper bound on ids per getVectors call (matches nodeDeleteMany's cap). */
export const GET_VECTORS_MAX_IDS = 10_000;

/** Validate + dedupe a caller's id list. Throws a clear error on a non-array,
 *  an over-cap list, or a non-string / empty entry. Empty input -> []. */
export function normalizeGetVectorsIds(ids: unknown, site = 'getVectors'): string[] {
    if (!Array.isArray(ids)) throw new Error(`${site}: ids must be an array`);
    if (ids.length > GET_VECTORS_MAX_IDS) {
        throw new Error(`${site}: at most ${GET_VECTORS_MAX_IDS} ids per call (got ${ids.length}); split the batch`);
    }
    if (ids.some((id) => typeof id !== 'string' || id.length === 0)) throw new Error(`${site}: every id must be a non-empty string`);
    const unique = [...new Set(ids as string[])];
    // Same id allowlist as every other Lance read, applied on BOTH engines so a malformed id is
    // rejected identically (SQLite binds params, but engine-dependent errors would be a parity leak).
    unique.forEach((id) => assertSafeLanceId(id, site)); // SECURITY: assertSafeLanceId
    return unique;
}

/** True iff `v` is a usable stored embedding: non-empty with at least one non-zero component. */
export function isRealVector(v: ArrayLike<number> | null | undefined): boolean {
    if (!v || v.length === 0) return false;
    for (let i = 0; i < v.length; i++) if (v[i] !== 0) return true;
    return false;
}

/** LanceDB read: one `id IN (...)` query per `chunkSize` ids, canonical + non-tombstone only. */
export async function lanceGetVectors(table: lancedb.Table, ids: string[], chunkSize: number): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    // Validate every id up front (outside any try) so an unsafe id throws before a query is built.
    ids.forEach((id) => assertSafeLanceId(id, 'getVectors'));
    for (let i = 0; i < ids.length; i += chunkSize) {
        const list = ids.slice(i, i + chunkSize).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
        // History rows are encoded in the id suffix and tombstones in the text prefix on Lance
        // (same predicates as the FTS reconcile / search filters); `text` is filtered, not selected.
        const rows = await table.query()
            .where(`id IN (${list}) AND id NOT LIKE '${HISTORY_ID_LIKE_PATTERN}' AND text NOT LIKE '[TOMBSTONED%'`)
            .select(['id', 'vector'])
            .toArray();
        for (const raw of rows as Array<Record<string, unknown>>) {
            const id = String(raw.id ?? '');
            if (!id || isRevisionHistoryId(id)) continue;
            const vec = toPlainVector(raw.vector);
            if (isRealVector(vec)) out.set(id, vec);
        }
    }
    return out;
}
