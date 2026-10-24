/**
 * verbatimPromotionVerify.ts — the promotion "before commit" gate (design
 * section 3 step 6). 3.21 step 2 part 3.
 *
 * Any failure here means: delete the staging dir, drop the changes log,
 * release the gate — SQLite stays authoritative and nothing is lost (that
 * cleanup itself lives in verbatimPromotion.ts, alongside the commit it
 * gates; this module only decides pass/fail and why).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import * as lancedb from '@lancedb/lancedb';

import { computeContentHash } from './contentHash.js';
import { lanceRowId, type SourceRow } from './verbatimPromotionStage.js';
import { readEntityRows } from './verbatimPromotionEntityRows.js';

export interface VerifyResult {
    ok: boolean;
    reasons: string[];
    sourceRowCount: number;
    targetRowCount: number;
    sampledRows: number;
    sampleFailures: number;
}

/** Row counts, including history and tombstones — every physical row on
 *  BOTH sides, matching design step 6's "row counts equal, including
 *  history and tombstones". */
async function countRows(db: DatabaseType, table: lancedb.Table): Promise<{ source: number; target: number }> {
    const src = db.prepare(`SELECT count(*) as c FROM verbatim`).get() as { c: number };
    const tgt = await table.countRows();
    return { source: src.c, target: tgt };
}

/** Content-hash MULTISET equality — not a set: two physical rows can
 *  legitimately share a content hash (identical text stored under two
 *  different ids, or a history snapshot whose content happens to match an
 *  earlier one), and a multiset mismatch (same set, different counts)
 *  would silently hide a duplicated-or-dropped row a set comparison
 *  can't see. */
async function contentHashMultisetsMatch(db: DatabaseType, table: lancedb.Table): Promise<{ ok: boolean; detail: string }> {
    const srcRows = db.prepare(`SELECT content_hash FROM verbatim`).all() as Array<{ content_hash: string | null }>;
    const srcCounts = new Map<string, number>();
    for (const r of srcRows) {
        const h = r.content_hash ?? '';
        srcCounts.set(h, (srcCounts.get(h) ?? 0) + 1);
    }
    const tgtRows = (await table.query().select(['contentHash']).toArray()) as Array<{ contentHash?: string }>;
    const tgtCounts = new Map<string, number>();
    for (const r of tgtRows) {
        const h = r.contentHash ?? '';
        tgtCounts.set(h, (tgtCounts.get(h) ?? 0) + 1);
    }
    if (srcCounts.size !== tgtCounts.size) {
        return { ok: false, detail: `distinct content-hash count differs: source=${srcCounts.size} target=${tgtCounts.size}` };
    }
    for (const [hash, count] of srcCounts) {
        const tCount = tgtCounts.get(hash);
        if (tCount !== count) {
            return { ok: false, detail: `content-hash "${hash.slice(0, 16)}" count differs: source=${count} target=${tCount ?? 0}` };
        }
    }
    return { ok: true, detail: '' };
}

/**
 * A top-10 miss only proves a broken FTS index when the row is not matched at
 * all. A 3-word probe taken from the START of a row's text is not
 * discriminating when many rows share that prefix ("repro load node ..." x
 * 500: every row ties on score, so any given row is outside the top 10 by
 * construction). That made verification abort and re-trigger forever at small
 * scale, with the staged table perfectly healthy. So on a miss, re-run the
 * same query restricted to this row's id: if the FTS index still returns the
 * row, it finds it and is merely outranked by equal or better matches, which
 * is not a promotion defect. A row the index cannot return even when it is
 * the only candidate (missing/corrupt index, row absent) still fails.
 */
async function ftsStillMatchesRow(table: lancedb.Table, phrase: string, id: string): Promise<boolean> {
    const hits = await table.query().fullTextSearch(phrase, { columns: 'text' })
        .where(`id = '${id.replace(/'/g, "''")}'`).limit(1).toArray();
    return hits.some((r: { id?: string }) => r.id === id);
}

/**
 * 200 random CANONICAL rows: `searchByVector(ownVector, 1)` returns the
 * row itself on both engines, and a 3-word phrase from the row's text
 * returns it in bm25's top 10 on both (design step 6). Reuses the
 * ALREADY-COPIED vector (never re-embeds) for the vector-recall half —
 * this checks "did the promoted table preserve the ability to find a row
 * by its own vector", not embedding-model behavior.
 */
async function sampleRecall(
    db: DatabaseType,
    table: lancedb.Table,
    sampleSize: number,
): Promise<{ sampled: number; failures: number; reasons: string[] }> {
    const canonicalCount = db.prepare(`SELECT count(*) as c FROM verbatim WHERE is_canonical = 1`).get() as { c: number };
    if (canonicalCount.c === 0) return { sampled: 0, failures: 0, reasons: [] };
    const n = Math.min(sampleSize, canonicalCount.c);
    // SQLite's RANDOM() sample — fine at this scale (n <= a few hundred);
    // not intended for a 100K-row uniform sample, only a spot-check.
    const rows = db.prepare(
        `SELECT id, text, vector FROM verbatim WHERE is_canonical = 1 AND vector IS NOT NULL ORDER BY RANDOM() LIMIT ?`,
    ).all(n) as Array<{ id: string; text: string; vector: Buffer }>;

    let failures = 0;
    const reasons: string[] = [];
    for (const row of rows) {
        const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.length / 4);
        try {
            const vecResults = await table.vectorSearch(Array.from(vec)).limit(1).toArray();
            const topId = vecResults[0]?.id;
            if (topId !== row.id) {
                failures++;
                if (reasons.length < 10) reasons.push(`vector recall miss: id=${row.id} top=${topId ?? '(none)'}`);
                continue;
            }
        } catch (err) {
            // A dimension mismatch, a corrupt/unindexed table, or any
            // other native-call failure here means verification cannot
            // vouch for this row — treat it as a failure (fail closed),
            // never silently skip it. This is the abort path's job to
            // catch, not something that should crash promoteWorkspace()
            // itself uncaught.
            failures++;
            if (reasons.length < 10) reasons.push(`vector search errored for id=${row.id}: ${(err as Error).message}`);
            continue;
        }
        // A TRUE 3-word substring — 3 CONSECUTIVE tokens exactly as they
        // appear in the text, not "the first 3 tokens over length 2" (that
        // filter can skip a short word in the middle, e.g. "document
        // number 5 about" -> "document number about", which is no longer
        // a real substring of the text and correctly fails a phrase/
        // adjacency-sensitive full-text query on EITHER engine — that was
        // a bug in this verifier, not a promotion defect, caught by first
        // reproducing it against a Lance-promoted table directly).
        const tokens = row.text.split(/\s+/).filter((w) => w.length > 0);
        const words = tokens.slice(0, 3);
        if (words.length === 0) continue; // nothing to phrase-search
        const phrase = words.join(' ');
        try {
            const bm25Results = await table.query().fullTextSearch(phrase, { columns: 'text' }).limit(10).toArray();
            const found = bm25Results.some((r: { id?: string }) => r.id === row.id);
            if (!found && !(await ftsStillMatchesRow(table, phrase, row.id))) {
                failures++;
                if (reasons.length < 10) reasons.push(`bm25 recall miss: id=${row.id} phrase="${phrase}"`);
            }
        } catch {
            // No FTS index on the staging table yet, or the query errored —
            // treated as a failure so a missing/broken FTS build is caught
            // here rather than silently skipped.
            failures++;
            if (reasons.length < 10) reasons.push(`bm25 query errored for id=${row.id}`);
        }
    }
    return { sampled: rows.length, failures, reasons };
}

/** Cheap consistency check used by the final catch-up rounds in
 *  verbatimPromotion.ts: SQLite's physical row count (read inside the caller's
 *  snapshot) equals the staged table's. The full verification already ran once;
 *  this guards the small delta applied after it. */
export async function stagedRowCountsMatch(db: DatabaseType, stagingDir: string): Promise<{ ok: boolean; source: number; target: number }> {
    const connection = await lancedb.connect(stagingDir);
    const table = await connection.openTable('lore_verbatim');
    const counts = await countRows(db, table);
    return { ok: counts.source === counts.target, source: counts.source, target: counts.target };
}

/**
 * 3.35.3 review finding F6: the gate's row-count check alone cannot see a row that was REWRITTEN
 * (same count, different content) by the later catch-up rounds. For the entities those rounds
 * touched, compare the multiset of (Lance row id, content hash, updatedAt) on both sides. Run
 * inside the caller's read snapshot, after the delta was applied. Cheap: one indexed SQLite lookup
 * and one filtered Lance scan per chunk of entities, only for the touched set.
 */
export async function stagedEntitiesMatch(
    db: DatabaseType, stagingDir: string, entities: readonly string[],
): Promise<{ ok: boolean; checked: number; detail: string }> {
    if (entities.length === 0) return { ok: true, checked: 0, detail: '' };
    const connection = await lancedb.connect(stagingDir);
    const table = await connection.openTable('lore_verbatim');
    const key = (id: string, hash: string | null, updatedAt: string | null): string => `${id}\u0000${hash ?? ''}\u0000${updatedAt ?? ''}`;
    const want = new Map<string, number>();
    for (let i = 0; i < entities.length; i += 500) {
        const chunk = entities.slice(i, i + 500);
        const rows = db.prepare(
            `SELECT id, is_canonical, superseded_at, created_at, content_hash, updatedAt FROM verbatim WHERE id IN (${chunk.map(() => '?').join(',')})`,
        ).all(...chunk) as unknown as SourceRow[];
        for (const r of rows) {
            const k = key(lanceRowId(r), r.content_hash, r.updatedAt);
            want.set(k, (want.get(k) ?? 0) + 1);
        }
    }
    const have = new Map<string, number>();
    for (const r of await readEntityRows(table, entities)) {
        const k = key(r.id, r.contentHash, r.updatedAt);
        have.set(k, (have.get(k) ?? 0) + 1);
    }
    for (const [k, n] of want) {
        if (have.get(k) !== n) return { ok: false, checked: entities.length, detail: `entity row differs: id=${k.split('\u0000')[0]} source=${n} target=${have.get(k) ?? 0}` };
    }
    for (const [k, n] of have) {
        if (!want.has(k)) return { ok: false, checked: entities.length, detail: `staged row not in source: id=${k.split('\u0000')[0]} target=${n}` };
    }
    return { ok: true, checked: entities.length, detail: '' };
}

export async function verifyPromotion(
    db: DatabaseType,
    stagingDir: string,
    sampleSize = 200,
): Promise<VerifyResult> {
    const connection = await lancedb.connect(stagingDir);
    const table = await connection.openTable('lore_verbatim');
    const reasons: string[] = [];

    const counts = await countRows(db, table);
    if (counts.source !== counts.target) {
        reasons.push(`row count mismatch: source=${counts.source} target=${counts.target}`);
    }

    const hashCheck = await contentHashMultisetsMatch(db, table);
    if (!hashCheck.ok) reasons.push(`content-hash multiset mismatch: ${hashCheck.detail}`);

    const recall = await sampleRecall(db, table, sampleSize);
    if (recall.failures > 0) {
        reasons.push(`sample recall: ${recall.failures}/${recall.sampled} rows failed (${recall.reasons.join('; ')})`);
    }

    return {
        ok: reasons.length === 0,
        reasons,
        sourceRowCount: counts.source,
        targetRowCount: counts.target,
        sampledRows: recall.sampled,
        sampleFailures: recall.failures,
    };
}

// Re-exported for the CLI's --dry-run summary and tests.
export { computeContentHash };
