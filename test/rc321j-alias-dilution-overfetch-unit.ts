#!/usr/bin/env tsx
/**
 * test/rc321j-alias-dilution-overfetch-unit.ts — Lore 3.21 step 4 (r9
 * recall-quality fix, "Finding B: alias dilution").
 *
 * Root cause (see multiQuerySeedFetch.ts's fetchCollapsedRanked/
 * fetchCollapsedBm25 doc comments): `mapAliasHitsToParent` correctly
 * collapses a parent's several verbatim rows (its own row + up to
 * MAX_QUESTIONS `<parent>#q<n>` alias rows) down to one — but it can only
 * collapse what it's handed. Before this fix, the raw top-`window` fetch
 * from the store was already truncated to `window` rows BEFORE collapsing,
 * so a handful of parents each contributing several near-top alias rows
 * could fill that raw window and push every OTHER parent's single row out
 * of it entirely, even though the store held far more distinct parents.
 * This is the confirmed mechanism behind the tapestry-recall benchmark's
 * C4 (hybrid + write-time questions[]) scoring BELOW its own no-aliases
 * baseline C3.
 *
 * Pins:
 *   - a parent crowded out of the naive top-`window` raw fetch by another
 *     parent's alias cluster IS still recovered once the window is widened
 *     (over-fetch, bounded).
 *   - a corpus with no aliases at all never triggers a retry (raw ===
 *     collapsed already) — no added query cost for the common case.
 *   - the over-fetch is bounded (ALIAS_OVERFETCH_MAX_MULTIPLIER): a
 *     pathological case does not fetch unboundedly.
 *   - the same fix applies to semantic mode and to hybrid's bm25 leg.
 */

import assert from 'node:assert/strict';
import { fetchSeeds } from '../packages/lore/src/recall/multiQuerySeedFetch.js';
import type { VerbatimSeedStore } from '../packages/lore/src/recall/retrieveSeedStore.js';
import type { VerbatimSeedHit } from '../packages/lore/src/recall/ecosystemSeedUnion.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('RC321j — alias dilution: alias rows must not crowd other parents out of the raw seed window\n');

/** Build a fixed rank-ordered row set: P1's own row + 5 alias rows all rank
 *  ABOVE 9 other parents' single rows — the worst-case MAX_QUESTIONS fan-out
 *  the fix's ALIAS_ROW_FANOUT constant is sized for. */
function crowdedRows(): Array<{ id: string; score: number }> {
    const rows: Array<{ id: string; score: number }> = [];
    rows.push({ id: 'lore:p1', score: 1.0 });
    for (let i = 0; i < 5; i++) rows.push({ id: `lore:p1#q${i}`, score: 0.99 - i * 0.001 });
    for (let i = 2; i <= 10; i++) rows.push({ id: `lore:p${i}`, score: 0.5 - i * 0.001 });
    return rows; // 6 p1-cluster rows, then 9 distinct-parent rows = 15 total
}

function mockStore(rows: Array<{ id: string; score: number }>, calls: number[]): VerbatimSeedStore {
    return {
        async count() { return rows.length; },
        async search(_q: string, n: number): Promise<VerbatimSeedHit[]> {
            calls.push(n);
            return rows.slice(0, n);
        },
        async bm25Search(_q: string, n: number) {
            calls.push(n);
            return { hits: rows.slice(0, n), ranked: true };
        },
    };
}

await test('keyword mode: a parent crowded out by another parent\'s alias cluster is recovered by over-fetch', async () => {
    const calls: number[] = [];
    const store = mockStore(crowdedRows(), calls);
    // desiredCount=4: naively, the top-4 RAW rows are all p1's own cluster
    // (p1, p1#q0, p1#q1, p1#q2) — collapsing that alone yields ONLY 'p1'.
    const outcome = await fetchSeeds(store, ['Q'], 'keyword', 4);
    assert.ok(calls.length > 1, `expected at least one over-fetch retry, got calls=${JSON.stringify(calls)}`);
    assert.ok(outcome.seedNodeIds.includes('lore:p2'), `expected 'p2' recovered after widening the window; got ${JSON.stringify(outcome.seedNodeIds)}`);
    assert.ok(outcome.seedNodeIds.includes('lore:p1'), 'p1 itself must still be present');
    assert.equal(outcome.bm25Ranked, true);
});

await test('semantic mode: same recovery via seedStore.search()', async () => {
    const calls: number[] = [];
    const store = mockStore(crowdedRows(), calls);
    const outcome = await fetchSeeds(store, ['Q'], 'semantic', 4);
    assert.ok(calls.length > 1, 'expected an over-fetch retry on the semantic leg too');
    assert.ok(outcome.seedNodeIds.includes('lore:p2'), `expected 'p2' recovered; got ${JSON.stringify(outcome.seedNodeIds)}`);
});

await test('hybrid mode: the bm25 leg recovers the crowded-out parent even though the semantic leg is uncrowded', async () => {
    const calls: number[] = [];
    // Semantic leg: a plain, alias-free ranking (no crowding) — only the
    // bm25 leg has the alias cluster. Confirms the fix is leg-independent.
    const flatRows = Array.from({ length: 10 }, (_, i) => ({ id: `lore:s${i + 1}`, score: 1 - i * 0.05 }));
    const bm25Calls: number[] = [];
    const semanticCalls: number[] = [];
    const store: VerbatimSeedStore = {
        async count() { return 15; },
        async search(_q: string, n: number) { semanticCalls.push(n); return flatRows.slice(0, n); },
        async bm25Search(_q: string, n: number) { bm25Calls.push(n); return { hits: crowdedRows().slice(0, n), ranked: true }; },
    };
    const outcome = await fetchSeeds(store, ['Q'], 'hybrid', 4);
    assert.ok(bm25Calls.length > 1, `expected the bm25 leg to retry; got ${JSON.stringify(bm25Calls)}`);
    assert.ok(outcome.seedNodeIds.includes('lore:p2'), `expected 'p2' recovered via the bm25 leg's over-fetch; got ${JSON.stringify(outcome.seedNodeIds)}`);
});

await test('no-alias corpus: collapsing is a no-op, so no retry ever fires (no added query cost)', async () => {
    const calls: number[] = [];
    const flatRows = Array.from({ length: 20 }, (_, i) => ({ id: `lore:n${i + 1}`, score: 1 - i * 0.01 }));
    const store = mockStore(flatRows, calls);
    const outcome = await fetchSeeds(store, ['Q'], 'keyword', 4);
    assert.deepEqual(calls, [4], `expected exactly ONE fetch (no retry) for an alias-free corpus, got ${JSON.stringify(calls)}`);
    assert.deepEqual(outcome.seedNodeIds, ['lore:n1', 'lore:n2', 'lore:n3', 'lore:n4']);
});

await test('bounded over-fetch: a pathological all-alias corpus stops widening at the multiplier cap, never fetches unboundedly', async () => {
    const calls: number[] = [];
    // EVERY row is an alias of the SAME single parent — collapsing can
    // never produce more than 1 distinct id, no matter how wide the window
    // gets. The loop must still terminate (bounded by
    // desiredCount * ALIAS_OVERFETCH_MAX_MULTIPLIER = 4*4 = 16), not spin
    // or fetch an unbounded window.
    const allSameParent = Array.from({ length: 500 }, (_, i) => ({ id: i === 0 ? 'lore:solo' : `lore:solo#q${i % 5}`, score: 1 - i * 0.0001 }));
    const store = mockStore(allSameParent, calls);
    const outcome = await fetchSeeds(store, ['Q'], 'keyword', 4);
    assert.ok(calls.every((n) => n <= 16), `expected every fetch window capped at 16, got ${JSON.stringify(calls)}`);
    assert.deepEqual(outcome.seedNodeIds, ['lore:solo']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
