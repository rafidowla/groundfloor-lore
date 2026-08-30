#!/usr/bin/env tsx
/**
 * dedup-single-model-load-unit.ts — proves VerbatimSearchWorkerProxy's
 * parentEmbedder path does its embedding ONCE, in the parent process,
 * instead of routing search()/storeBatch() through the child's own
 * embedder (see verbatimSearchWorkerProxy.ts's `parentEmbedder` param).
 *
 * With a parentEmbedder configured:
 *   - search() embeds the query via parentEmbedder.embedQuery() and sends
 *     the pre-computed vector to the child over IPC via `searchByVector`
 *     (never the child's own `search`).
 *   - storeBatch() embeds every row via parentEmbedder.embedDocumentBatch()
 *     and sends pre-built rows (vectors included) to the child via
 *     `bulkUpsertPrebuiltRows` (never the child's own `storeBatch`).
 * Without a parentEmbedder, search/storeBatch forward straight to the
 * child's own embedder — the pre-existing backward-compatible path.
 *
 * Harness: a real child_process fork (the production path — same as
 * verbatim-search-worker-e2e.ts), with a CountingEmbedProvider wrapping the
 * real LocalEmbeddingProvider as parentEmbedder. Using the real provider
 * (not a fake with an arbitrary dimension) keeps vectors dimension-
 * compatible with the child's own default-model LanceDB schema, since the
 * child always constructs its own default embedder for schema sizing/
 * fingerprinting even when the parent supplies the actual vectors.
 *
 * Run: npx tsx test/dedup-single-model-load-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

/** Embedding provider that counts embedQuery/embedDocumentBatch calls —
 *  lets us prove the parent is the ONE place embedding happens per
 *  search()/storeBatch() call on the proxy. */
class CountingEmbedProvider implements EmbeddingProvider {
    queryCalls = 0;
    documentBatchCalls = 0;
    constructor(private inner: EmbeddingProvider) {}
    get modelId() { return this.inner.modelId; }
    get dimension() { return this.inner.dimension; }
    async initialize() { await this.inner.initialize(); }
    async embed(text: string) { return this.inner.embed(text); }
    async embedQuery(text: string) { this.queryCalls++; return this.inner.embedQuery(text); }
    async embedDocument(text: string) { return this.inner.embedDocument(text); }
    async embedDocumentBatch(texts: string[]) {
        this.documentBatchCalls++;
        return this.inner.embedDocumentBatch!(texts);
    }
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

// Give the child a generous ready budget on slower machines (model load).
process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';

async function main() {
    console.log('dedup-single-model-load: parentEmbedder routes embedding through the parent, not the child');

    // ── Section A: WITH parentEmbedder ──────────────────────────────────
    const homeWith = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-model-load-with-'));
    const parentEmbedder = new CountingEmbedProvider(new LocalEmbeddingProvider());
    const proxyWith = new VerbatimSearchWorkerProxy(homeWith, undefined, parentEmbedder);
    try {
        await proxyWith.initialize();

        await test('storeBatch with parentEmbedder embeds via embedDocumentBatch on the parent, exactly once for the whole batch', async () => {
            assert.equal(parentEmbedder.documentBatchCalls, 0, 'sanity: no embedding has happened yet');
            await proxyWith.storeBatch([
                { id: 'lore:d1', text: 'alpha document about search indexing', metadata: {} },
                { id: 'lore:d2', text: 'beta document about retrieval systems', metadata: {} },
            ] as never[]);
            assert.equal(parentEmbedder.documentBatchCalls, 1, 'storeBatch calls embedDocumentBatch exactly once (one batched call for both rows)');
            assert.equal(parentEmbedder.queryCalls, 0, 'storeBatch never touches embedQuery');
        });

        await test('storeBatch rows are actually persisted by the worker (via bulkUpsertPrebuiltRows)', async () => {
            const one = await proxyWith.getById('lore:d1');
            assert.ok(one && one.text === 'alpha document about search indexing', 'row round-trips through the worker with the correct text');
            assert.equal(await proxyWith.count(), 2, 'both rows persisted in the child');
        });

        await test('search with parentEmbedder embeds the query via embedQuery on the parent, exactly once, and returns correct worker results', async () => {
            const before = parentEmbedder.queryCalls;
            const hits = await proxyWith.search('search indexing', 5);
            assert.equal(parentEmbedder.queryCalls, before + 1, 'search calls embedQuery exactly once on the parent');
            assert.ok(hits.length > 0, `search returns hits from the worker (got ${hits.length})`);
            assert.ok(hits.some((h) => h.id === 'lore:d1'), 'the seeded row is found by the worker\'s vector search over the parent-computed vector');
        });

        await test('each search() call re-embeds via the parent (no proxy-side embed cache short-circuits parentEmbedder)', async () => {
            const before = parentEmbedder.queryCalls;
            await proxyWith.search('search indexing', 5);
            assert.equal(parentEmbedder.queryCalls, before + 1, 'a second identical search still calls embedQuery on the parent exactly once more');
        });
    } finally {
        await proxyWith.close();
        fs.rmSync(homeWith, { recursive: true, force: true });
    }

    // ── Section B: WITHOUT parentEmbedder — backward-compatible path ────
    const homeWithout = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-model-load-without-'));
    const proxyWithout = new VerbatimSearchWorkerProxy(homeWithout);
    try {
        await proxyWithout.initialize();

        await test('without a parentEmbedder, storeBatch + search still work end-to-end (child embeds itself — backward compat)', async () => {
            await proxyWithout.storeBatch([
                { id: 'lore:e1', text: 'gamma document about vector databases', metadata: {} },
            ] as never[]);
            assert.equal(await proxyWithout.count(), 1, 'row persisted via the child\'s own embedder path');
            const hits = await proxyWithout.search('vector databases', 5);
            assert.ok(hits.some((h) => h.id === 'lore:e1'), 'backward-compatible path returns correct results without a parentEmbedder');
        });
    } finally {
        await proxyWithout.close();
        fs.rmSync(homeWithout, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
