#!/usr/bin/env tsx
/**
 * surreal-search-limit-unit.ts — keyword search under a result limit,
 * on the SurrealDB engine alone.
 *
 * History: this began life as test/search-limit-parity-unit.ts (Phase 6
 * item 3), which built a legacy-engine LocalGraph and a SurrealGraph
 * INDEPENDENTLY from the same fixture and asserted the two engines
 * agreed on the exact ordered top-N at every limit. The legacy-engine-removal
 * engagement (Phase 3f, 2026-08) dropped the legacy-engine half of the
 * comparison and kept the SurrealDB-side assertions as a standalone
 * correctness pin; the parity framing is gone, the coverage remains.
 *
 * ── WHAT THIS FILE ESTABLISHES ──────────────────────────────────────────────
 *
 * The fixture has two properties that make truncation observable:
 *   1. **Genuine score ties** — every row matches `kappa` in exactly one
 *      field (content), so every score is identical and ordering is
 *      decided purely by the shared ranker's tie-break (score desc,
 *      updatedAt desc, id asc — searchRanking.ts, the single source of
 *      truth for keyword-search ordering).
 *   2. **More matches than `SEARCH_SCAN_CAP` (2000)** — so candidate
 *      selection truncates BEFORE ranking runs; the retained window must
 *      be the SEARCH_SCAN_CAP most-recently-updated rows, not an
 *      arbitrary 2000.
 *
 * Ids are zero-padded and insertion is deliberately shuffled, so id
 * order != insertion order and a wrong tie-break cannot pass by
 * accident. The expected order is computed client-side from the nodes
 * themselves using the contracted comparator, so the engine's output is
 * checked against the CONTRACT, not against itself.
 *
 * Run: npx tsx test/surreal-search-limit-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SEARCH_SCAN_CAP } from '../packages/lore/src/engines/searchRanking.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

const TERM = 'kappa';
/** Comfortably over SEARCH_SCAN_CAP so candidate selection must truncate. */
const MATCHING = SEARCH_SCAN_CAP + 500;
/** The read path clamps any requested limit into 1..1000; asking for the
 * scan cap back returns min(cap, 1000) rows. */
const EXPECTED_ROWS = Math.min(SEARCH_SCAN_CAP, 1000);

/**
 * The fixture. Every node matches `kappa` in EXACTLY the same fields, so every
 * score is identical and ordering is decided purely by the tie-break — which is
 * the thing under test. Ids are zero-padded so `id ASC` is well defined and
 * unrelated to insertion order.
 */
function fixture(i: number): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id: `tie-${String(i).padStart(6, '0')}`,
        type: 'decision',
        // `kappa` in content only — one field, one weight, identical for all.
        label: `Row ${i}`,
        content: `this row mentions kappa exactly once`,
        tags: ['tie'],
        project: 'p',
        ecosystem: 'e',
        metadata: '{}',
    };
}

/** Insert in a deliberately shuffled order so id order != insertion order. */
function insertionOrder(n: number): number[] {
    const idx = Array.from({ length: n }, (_, i) => i);
    // Deterministic shuffle (LCG) — reproducible across runs.
    let seed = 1234567;
    for (let i = idx.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const j = seed % (i + 1);
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    return idx;
}

const dirs: string[] = [];
function tmp(tag: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `lore-p6-${tag}-`));
    dirs.push(d);
    return d;
}

console.log(`SurrealGraph — search under a result limit (scan cap ${SEARCH_SCAN_CAP}, ${MATCHING} matches)`);

const order = insertionOrder(MATCHING);

const dir = tmp('surreal');
const surreal = new SurrealGraph(dir, { cacheDisabled: true });
await surreal.initialize();

for (const i of order) {
    await surreal.upsertNode(fixture(i));
}

await test('the fixture really does exceed the scan cap and really is all ties', async () => {
    const all = await surreal.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
    assert.equal(all.length, MATCHING, 'every fixture row landed');
    assert.ok(MATCHING > SEARCH_SCAN_CAP, `${MATCHING} must exceed the ${SEARCH_SCAN_CAP} scan cap`);
    // All rows match in exactly one field, so all scores are equal. If this
    // ever stops being true the fixture has lost its power to detect the bug.
    const hits = await surreal.search(TERM, 5, '*', '*');
    assert.equal(hits.length, 5);
    for (const h of hits) {
        assert.ok(h.content.includes(TERM), 'content-only match');
        assert.ok(!h.label.toLowerCase().includes(TERM), 'no label hit — would break the tie');
    }
});

/**
 * The contracted total order with every score tied: updatedAt DESC, id ASC —
 * exactly the shared ranker's tie-break comparator, applied client-side to
 * the full row set. Because every fixture score is equal, the score term
 * drops out and this IS the expected search output order.
 */
const expectedOrder = (await surreal.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true }))
    .sort((a, b) => {
        const byUpdated = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
        if (byUpdated !== 0) return byUpdated;
        return (a.id ?? '').localeCompare(b.id ?? '');
    })
    .map((n) => n.id);

await test('ordered top-N at every limit follows the contracted tie-break', async () => {
    for (const limit of [1, 5, 10, 50, 200]) {
        const got = (await surreal.search(TERM, limit, '*', '*')).map((n) => n.id);
        assert.equal(got.length, limit, `returned ${got.length} for limit ${limit}`);
        assert.deepEqual(got, expectedOrder.slice(0, limit), `limit ${limit}: wrong ordered top-${limit}`);
    }
});

await test('scan-cap truncation keeps the most-recently-updated window and reports it', async () => {
    // 3a: with more matches than the cap, candidate selection drops the
    // OLDEST-updated rows before ranking — deterministically. The ranked
    // output must therefore still be the contracted top-N of the FULL set
    // (the retained window is a prefix of it), and the caller must be told
    // the cap was hit.
    const signals: { scanCapHit: boolean } = { scanCapHit: false };
    const got = (await surreal.search(TERM, SEARCH_SCAN_CAP, '*', '*', false, signals)).map((n) => n.id);
    assert.equal(signals.scanCapHit, true, 'scan-cap hit must be signalled to the caller');
    assert.equal(got.length, EXPECTED_ROWS, `expected ${EXPECTED_ROWS} rows (scan cap clamped to 1000), got ${got.length}`);
    assert.deepEqual(
        got,
        expectedOrder.slice(0, EXPECTED_ROWS),
        'retained window is not the most-recently-updated prefix of the contracted order',
    );
});

await test('ordering is stable across repeated calls', async () => {
    // A total tie-break must also be a STABLE one; an unstable sort would
    // make the assertions above pass or fail at random. The read cache is
    // disabled for this fixture, so the second call re-runs the query and
    // the ranking rather than echoing a memoized array.
    const one = (await surreal.search(TERM, 25, '*', '*')).map((n) => n.id).join('|');
    const two = (await surreal.search(TERM, 25, '*', '*')).map((n) => n.id).join('|');
    assert.equal(two, one, 'returned a different order on the second identical call');
});

await surreal.close().catch(() => undefined);
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
