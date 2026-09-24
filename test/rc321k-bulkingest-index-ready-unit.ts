#!/usr/bin/env tsx
/**
 * test/rc321k-bulkingest-index-ready-unit.ts — Lore 3.21 step 4 (r9
 * recall-quality fix, "Finding A: keyword/BM25 leg materially worse than a
 * reference BM25").
 *
 * Root cause (see mcp/bulkIngest.ts's writePrebuiltRowsPerWorkspace doc
 * comment): `bulkIngest()`'s own contract promises "when the promise
 * resolves, every vector IS persisted... no drain race" — but the
 * underlying write path (VerbatimStore.bulkUpsertPrebuiltRows) only
 * SCHEDULED the vector/FTS index build on a debounced, unref'd timer
 * (engines/verbatimBatch.ts's scheduleSearchIndexesAfterBulk, default 2s
 * debounce) that the caller has no handle on. A caller that bulk-ingests
 * once and searches immediately after — exactly the tapestry-recall
 * benchmark's pattern, and any one-shot embedder bulk import — could query
 * before that timer ever fired. On the installed LanceDB version,
 * fullTextSearch() against an INDEX-LESS table does not behave like a
 * genuinely-ranked brute-force BM25 scan (contrary to bm25Search's own doc
 * comment): it returned near-arbitrary/physical-row-order results with no
 * error, so bm25Search reported `ranked:true` on effectively unranked
 * output. Measured impact on the real benchmark corpus (415 memories, 62
 * keyword-kind questions): raw bm25Search top-1 55/62 and top-5 58/62 AFTER
 * this fix, vs. having returned literal sequential-id garbage (top-5 3/15
 * on the first 15 sampled) BEFORE it.
 *
 * This pins the fix at the `lore.bulkIngest()` public-API level: the FTS
 * index must already exist, and bm25Search must already return correctly-
 * ranked, relevant results, the INSTANT bulkIngest's promise resolves — no
 * extra wait, no extra call.
 *
 * Run: npx tsx test/rc321k-bulkingest-index-ready-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';

import { currentFtsTokenizer } from '../packages/lore/src/engines/sqliteVerbatimFts.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('RC321k — bulkIngest() leaves the FTS index ready (not scheduled) before it resolves\n');

const { createLore } = await import('../packages/lore/src/index.js');

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bulkingest-index-ready-'));
}

await test('immediately after bulkIngest(embed:"sync") resolves, an FTS index already exists on lore_verbatim.text', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded' });
    try {
        const nodes = Array.from({ length: 10 }, (_, i) => ({
            id: `doc-${i}`, workspace: 'default', ecosystem: '*',
            nodeData: { id: `doc-${i}`, type: 'note', label: `doc ${i}`, content: `filler content number ${i} zzyzxpad`, project: 'default', ecosystem: '*' },
        }));
        const result = await lore.bulkIngest(nodes, { autolink: false, embed: 'sync' });
        assert.equal(result.succeeded, 10);

        const resolver = lore._daemon.getVerbatimResolver();
        const store = await resolver!.getOrOpen('default');
        // Reach the underlying engine-specific handle the same way the
        // original diagnostic did — through a (test-only) internal field.
        //
        // A brand-new workspace (as `tmpDataDir()` always creates here) is
        // NOT guaranteed to be LanceDB-backed: 3.21 step 2 part 2
        // (vectorEngineSelector.ts's `resolveNewWorkspaceVectorEngine`)
        // made 'sqlite' the default vector engine for every new local
        // workspace, with `LORE_DEFAULT_VECTOR_ENGINE=lance` as the only
        // opt-out. `SqliteVerbatimStore` has no `table` field (that's
        // LanceDB-only — verbatimStore.ts's `private table: lancedb.Table`),
        // so the old unconditional `store.table.listIndices()` call threw
        // `TypeError: Cannot read properties of undefined (reading
        // 'listIndices')` under the (now-default) SQLite engine — not a
        // production bug, since nothing in bulkIngest's real call path ever
        // touches a Lance-shaped `table` on a SQLite-backed store; the test
        // just hadn't been updated for the new default. Branch on whichever
        // handle the store actually exposes.
        const internals = store as unknown as {
            table?: { listIndices: () => Promise<Array<{ indexType?: string; columns?: string[] }>> } | null;
            db?: DatabaseType | null;
        };
        if (internals.table) {
            // vectorEngine: 'lance' — assert via LanceDB's own index catalog.
            const indices = await internals.table.listIndices();
            const ftsIndex = indices.find((idx) => idx.indexType === 'FTS' && idx.columns?.includes('text'));
            assert.ok(ftsIndex, `expected an FTS index on 'text' to already exist right after bulkIngest resolved; got indices=${JSON.stringify(indices)}`);
        } else if (internals.db) {
            // vectorEngine: 'sqlite' (the 3.21 default for new workspaces) —
            // the FTS5 analogue of "an index already exists" is the
            // `verbatim_fts` virtual table being live with a tokenizer
            // reconciled against the corpus (sqliteVerbatimFts.ts).
            const tokenizer = currentFtsTokenizer(internals.db);
            assert.ok(tokenizer, `expected the verbatim_fts FTS5 table to already exist right after bulkIngest resolved; got tokenizer=${JSON.stringify(tokenizer)}`);
        } else {
            assert.fail('verbatim store exposed neither a Lance `table` nor a SQLite `db` handle — update this test for the new engine shape');
        }
    } finally {
        await lore.dispose();
    }
});

await test('immediately after bulkIngest resolves, bm25Search returns the correct top hit for a rare distinguishing term (no post-write delay)', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded' });
    try {
        // 20 near-identical filler docs + ONE with a rare, distinguishing
        // token. Before the fix, an index-less fullTextSearch could return
        // near-arbitrary order — this asserts the CORRECT doc ranks first,
        // not just that AN index object exists.
        const nodes = Array.from({ length: 20 }, (_, i) => ({
            id: `filler-${i}`, workspace: 'default', ecosystem: '*',
            nodeData: { id: `filler-${i}`, type: 'note', label: `filler ${i}`, content: `generic placeholder text entry ${i}`, project: 'default', ecosystem: '*' },
        }));
        nodes.push({
            id: 'target', workspace: 'default', ecosystem: '*',
            nodeData: { id: 'target', type: 'note', label: 'target', content: 'the zzyzxrarehit distinguishing marker phrase', project: 'default', ecosystem: '*' },
        });
        const result = await lore.bulkIngest(nodes, { autolink: false, embed: 'sync' });
        assert.equal(result.succeeded, 21);

        const resolver = lore._daemon.getVerbatimResolver();
        const store = await resolver!.getOrOpen('default');
        const bm25 = await store.bm25Search('zzyzxrarehit', 5);
        assert.equal(bm25.ranked, true, 'bm25Search must report a genuinely-ranked result');
        assert.ok(bm25.hits.length > 0, 'expected at least one hit for the rare term');
        assert.equal(bm25.hits[0]!.id.replace(/^lore:/, ''), 'target', `expected 'target' to rank first for its own rare term; got ${JSON.stringify(bm25.hits.map((h) => h.id))}`);
    } finally {
        await lore.dispose();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
