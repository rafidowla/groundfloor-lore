#!/usr/bin/env tsx
/**
 * audit-56-history-id-suffix-unit.ts — regression for audit finding 5.6
 * (2026-08-17 functional-correctness audit, HIGH).
 *
 * Bug: VerbatimStore.isHistoryId() was a bare `id.includes('#rev')`
 * SUBSTRING test (mirrored by `id NOT LIKE '%#rev%'` SQL filters in
 * search()/bm25Search() and `includes('#rev')` checks in the export,
 * consistency-sweep, and reaper paths). Any id merely CONTAINING '#rev'
 * — e.g. the URL fragment in "https://docs.example.com/api#revisions",
 * which the node write path's assertSafeLanceId permits — was silently
 * treated as an internal revision-snapshot row: invisible to search and
 * bm25, appended-not-upserted on update, untombstonable, dropped from
 * workspace export, and permanently flagged as a missing embedding.
 *
 * Fix: the predicate is anchored to the ACTUAL internally-generated suffix
 * shape `<id>#rev<ISO-8601 millis timestamp>` at the END of the id
 * (isRevisionHistoryId / HISTORY_ID_LIKE_PATTERN in verbatimHistory.ts).
 *
 * Reproduces the finding's RAN-AND-OBSERVED scenario against a real
 * VerbatimStore + real LocalEmbeddingProvider on a temp LORE_HOME, and
 * proves a REAL snapshot row (produced by the actual update path) is
 * still classified as history.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/audit-56-history-id-suffix-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit56-'));
process.env['LORE_HOME'] = TEST_HOME;

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import {
    isRevisionHistoryId,
    HISTORY_ID_LIKE_PATTERN,
} from '../packages/lore/src/engines/verbatimHistory.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        if (process.env['AUDIT56_DEBUG']) console.error((e as Error).stack);
        failed++;
    }
};

const URL_ID = 'lore:https://docs.example.com/api#revisions';
const TEXT_V1 = 'Ledger API revision policy: every write creates an immutable revision entry';
const TEXT_V2 = 'Ledger API revision policy: immutable revision entries may carry compaction markers';

console.log('Audit 5.6 — "#rev" substring vs anchored revision-suffix predicate');

await test('predicate unit shape: real ISO suffix matches, URL fragments and lookalikes do not', () => {
    // Real internally-generated shape (snapshotForRev/tombstone/storeBatch
    // all use `${id}#rev${new Date().toISOString()}`).
    assert.equal(isRevisionHistoryId(`${URL_ID}#rev2026-08-17T05:12:33.456Z`), true);
    assert.equal(isRevisionHistoryId('lore:node#rev2026-01-01T00:00:00.000Z'), true);
    // Substring lookalikes that the OLD predicate misclassified:
    assert.equal(isRevisionHistoryId(URL_ID), false);
    assert.equal(isRevisionHistoryId('notes#review-2026'), false);
    assert.equal(isRevisionHistoryId('lore:doc#revisions'), false);
    // Not anchored at the end → not a snapshot id.
    assert.equal(isRevisionHistoryId('x#rev2026-08-17T05:12:33.456Z-trailing'), false);
    // The SQL LIKE mirror must encode the same shape.
    assert.match(HISTORY_ID_LIKE_PATTERN, /^%#rev/);
    assert.match(HISTORY_ID_LIKE_PATTERN, /Z$/);
});

await test('RAN repro: URL-fragment node id is searchable, upsertable, tombstonable', async () => {
    const store = new VerbatimStore(path.join(TEST_HOME, 'ws'), new LocalEmbeddingProvider());
    await store.initialize();

    await store.store({ id: 'lore:normal-node', text: 'An ordinary ledger node about daily settlement batches', metadata: {} });
    await store.store({ id: URL_ID, text: TEXT_V1, metadata: {} });

    // 1. Vector search visibility (pre-fix: `id NOT LIKE '%#rev%'` hid it).
    const hits = await store.search('Ledger API revision policy immutable', 10);
    assert.ok(
        hits.some((h) => h.id === URL_ID),
        `search must return the URL-fragment node; got [${hits.map((h) => h.id).join(', ')}]`,
    );

    // 2. BM25 visibility.
    const bm25 = await store.bm25Search('Ledger revision policy', 10);
    assert.ok(
        bm25.hits.some((h) => h.id === URL_ID),
        `bm25Search must return the URL-fragment node; got [${bm25.hits.map((h) => h.id).join(', ')}]`,
    );

    // 3. Update is an UPSERT, not an append (pre-fix: listIds returned the
    //    id TWICE and getById returned the STALE first version).
    await store.store({ id: URL_ID, text: TEXT_V2, metadata: {} });
    const ids = await store.listIds();
    assert.equal(ids.filter((i) => i === URL_ID).length, 1, 'canonical id must appear exactly once');
    const got = await store.getById(URL_ID);
    assert.equal(got?.text, TEXT_V2, 'getById must return the updated text');

    // 4. Tombstone is NOT a no-op for this id (pre-fix: early-return).
    await store.tombstone(URL_ID, 'node deleted');
    const tomb = await store.getById(URL_ID);
    assert.ok(tomb?.text?.startsWith('[TOMBSTONED'), 'tombstone must mark the canonical row');
    const afterTomb = await store.search('Ledger API revision policy immutable', 10);
    assert.ok(!afterTomb.some((h) => h.id === URL_ID), 'tombstoned row must leave search results');

    // 5. A REAL revision snapshot (produced by the actual update path) is
    //    still classified as history and excluded from default search.
    await store.store({ id: 'lore:rev-doc', text: 'Settlement cutoff moves to 17:00 UTC on weekdays', metadata: {} });
    await store.store({ id: 'lore:rev-doc', text: 'Settlement cutoff moves to 18:00 UTC on weekdays', metadata: {} });
    const history = await store.getHistory('lore:rev-doc');
    const snapshots = history.filter((h) => !h.isCanonical);
    assert.ok(snapshots.length >= 1, 'update must produce a #rev snapshot row');
    assert.ok(
        snapshots.every((s) => isRevisionHistoryId(s.id)),
        `snapshot ids must carry the anchored suffix: ${snapshots.map((s) => s.id).join(', ')}`,
    );
    const revSearch = await store.search('Settlement cutoff weekdays', 10);
    assert.ok(revSearch.some((h) => h.id === 'lore:rev-doc'));
    assert.ok(
        revSearch.every((h) => !isRevisionHistoryId(h.id) && !h.id.includes('#rev')),
        `default search must exclude snapshot rows; got [${revSearch.map((h) => h.id).join(', ')}]`,
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
