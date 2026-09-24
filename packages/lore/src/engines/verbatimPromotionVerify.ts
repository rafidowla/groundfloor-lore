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
            if (!found) {
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
