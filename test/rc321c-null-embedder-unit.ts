#!/usr/bin/env tsx
/**
 * test/rc321c-null-embedder-unit.ts — Lore 3.21 step 3(c): NullEmbeddingProvider.
 *
 * Real, embedded end-to-end coverage via `createLore({ embeddingProvider: new
 * NullEmbeddingProvider() })` — no ONNX model ever loads, so this is fast.
 * Pins:
 *
 *   - node writes (nodeUpsert, bulkIngest embed:'sync'/'async') succeed with
 *     NO vector write attempted, and never error because embeddings are off.
 *   - the embed queue does nothing for a null-provider instance (async mode
 *     drains cleanly with no permanent-failure log).
 *   - recall's vector leg is skipped cleanly: semantic mode (and hybrid's
 *     semantic half) degrade to the keyword/graph path instead of throwing,
 *     flagging `vector_leg_skipped` on the response.
 *   - keyword mode (3.21 step 3(a)) is completely unaffected — it never
 *     touches the embedding provider regardless of whether one is disabled.
 *   - the on-disk embedding fingerprint is never stamped or compared for a
 *     null-provider workspace.
 *
 * Run: npx tsx test/rc321c-null-embedder-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('RC321c — NullEmbeddingProvider (3.21 step 3c)\n');

const { createLore } = await import('../packages/lore/src/index.js');
const { NullEmbeddingProvider, EmbeddingDisabledError, isEmbeddingDisabled } = await import('../packages/lore/src/providers/nullEmbeddingProvider.js');
const { getActiveWorkspacePath } = await import('../packages/lore/src/config/workspaces.js');
const { readFingerprint } = await import('../packages/lore/src/engines/embeddingFingerprint.js');

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-null-embedder-'));
}

await test('NullEmbeddingProvider: modelId is "none"; every embed method throws EmbeddingDisabledError; initialize() never throws', async () => {
    const p = new NullEmbeddingProvider();
    assert.equal(p.modelId, 'none');
    assert.equal(isEmbeddingDisabled(p), true);
    await p.initialize(); // must not throw
    await assert.rejects(p.embed(), EmbeddingDisabledError);
    await assert.rejects(p.embedQuery(), EmbeddingDisabledError);
    await assert.rejects(p.embedDocument(), EmbeddingDisabledError);
    await assert.rejects(p.embedDocumentBatch(), EmbeddingDisabledError);
});

await test('node write (nodeUpsert, default sync path): succeeds, no vector write attempted, content stays searchable via keyword', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        const result = await lore.nodeUpsert({
            id: 'null-embed-node-1', workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: 'Null embed test', content: 'a distinctive marker phrase zzyzxnull' },
        });
        assert.ok(result.ok === true, `expected ok:true, got ${JSON.stringify(result)}`);
        // Graph text search (item 3.21-a's keyword leg) must find it — the
        // graph node + its text landed even though no vector was written.
        const hits = await lore.search('zzyzxnull', 10, 'default');
        assert.ok(hits.some((h) => h.id === 'null-embed-node-1'), 'graph keyword search must find the node');
    } finally {
        await lore.dispose();
    }
});

await test('bulkIngest embed:"sync" (the default) with a null provider: no errors, every node ok:true', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        const nodes = Array.from({ length: 5 }, (_, i) => ({
            id: `bulk-sync-${i}`, workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: `bulk ${i}`, content: `bulk content ${i} zzyzxbulk` },
        }));
        const result = await lore.bulkIngest(nodes);
        assert.equal(result.results.length, 5);
        for (const r of result.results) {
            assert.ok(r.ok === true, `expected every bulk result ok:true, got ${JSON.stringify(r)}`);
        }
        const hits = await lore.search('zzyzxbulk', 10, 'default');
        assert.ok(hits.length >= 5, `expected the bulk-ingested nodes reachable via graph keyword search, got ${hits.length}`);
    } finally {
        await lore.dispose();
    }
});

await test('bulkIngest embed:"async" with a null provider: no errors (the embed queue does nothing for a disabled provider)', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        const nodes = Array.from({ length: 3 }, (_, i) => ({
            id: `bulk-async-${i}`, workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: `bulk async ${i}`, content: `bulk async content ${i}` },
        }));
        const result = await lore.bulkIngest(nodes, { embed: 'async' });
        for (const r of result.results) {
            assert.ok(r.ok === true, `expected every async-mode bulk result ok:true, got ${JSON.stringify(r)}`);
        }
        // Give the (no-op) embed queue a tick — must not surface a permanent
        // failure log or throw; graph nodes must be present regardless.
        await new Promise((r) => setTimeout(r, 100));
        const hits = await lore.search('async', 10, 'default');
        assert.ok(hits.length >= 3);
    } finally {
        await lore.dispose();
    }
});

await test('recall mode:"semantic" with a null provider on a FRESH workspace: degrades to the keyword/graph path, no throw', async () => {
    // A fresh null-provider workspace never writes a single vector row (the
    // store()/storeBatch() guard no-ops every write), so the verbatim
    // table's count() is 0 and `verbatimConsulted` is correctly false —
    // the SAME pre-existing "nothing to seed from" signal a never-embedded
    // workspace has always reported. `vector_leg_skipped` is the NARROWER
    // signal for "a semantic fetch was attempted against a populated store
    // and failed because embeddings are off" (see the mock-level test
    // below for that scenario) — it stays absent here because there was
    // nothing to attempt in the first place. The important assertion is
    // still that this NEVER THROWS and still finds the node via the graph
    // keyword leg.
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.nodeUpsert({
            id: 'semantic-degrade-node', workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: 'degrade test', content: 'zzyzxsemantic marker phrase' },
        });
        const result = await lore.recall('zzyzxsemantic', { workspace: 'default', mode: 'full', searchMode: 'semantic' });
        assert.equal(result.mode, 'full');
        assert.equal((result._meta as { vector_index_consulted?: boolean }).vector_index_consulted, false);
        assert.ok(result.totalRecalled >= 1, 'expected the node to be found via the degraded keyword/graph path');
    } finally {
        await lore.dispose();
    }
});

await test('recall default mode ("hybrid") with a null provider on a FRESH workspace: still finds results via the surviving keyword leg, no throw', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.nodeUpsert({
            id: 'hybrid-degrade-node', workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: 'hybrid degrade', content: 'zzyzxhybrid marker phrase' },
        });
        const result = await lore.recall('zzyzxhybrid', { workspace: 'default', mode: 'full' });
        assert.ok(result.totalRecalled >= 1);
    } finally {
        await lore.dispose();
    }
});

await test('recall on a PREVIOUSLY-embedded workspace whose provider is now disabled: semantic fetch is attempted and caught, vector_leg_skipped:true', async () => {
    // The realistic scenario `vectorLegSkipped` exists for: a workspace that
    // already has real vector rows (verbatimConsulted / count()>0 stays
    // true even after the provider is swapped for a null one), so
    // retrieve() DOES attempt the semantic fetch and must catch the
    // resulting EmbeddingDisabledError rather than let it propagate.
    // Exercised directly at the core retrieve() level with a mock seed
    // store (fast, deterministic — no real ONNX model needed) rather than
    // writing then re-opening a real LanceDB table.
    const { retrieve } = await import('../packages/lore/src/recall/retrieve.js');
    const graph = {
        async search() { return [{ id: 'kw-only', type: 'note', label: 'kw', content: 'c', tags: [], project: 'w', ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z' }]; },
        async getNodesByIds() { return new Map(); },
        async traverse() { return []; },
    };
    const ctx = {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 5; }, // rows exist from BEFORE the provider was disabled
                async verbatimSearch() { throw new EmbeddingDisabledError('embedQuery'); },
                async verbatimBm25Search() { return { hits: [], ranked: true }; },
            },
        },
    } as unknown as import('../packages/lore/src/recall/retrieve.js').RetrieveContext;
    const outSemantic = await retrieve(ctx, 'q', { workspace: 'w', mode: 'semantic', depth: 0 });
    assert.equal(outSemantic.meta.vectorLegSkipped, true);
    assert.equal(outSemantic.meta.verbatimConsulted, true, 'the store WAS consulted — count()>0 — the FETCH is what failed');
    assert.equal(outSemantic.meta.sourcesConsulted, 1, 'only the graph keyword leg actually contributed');
    assert.deepEqual(outSemantic.results.map((r) => r.node.id), ['kw-only']);

    const outHybrid = await retrieve(ctx, 'q', { workspace: 'w', mode: 'hybrid', depth: 0 });
    assert.equal(outHybrid.meta.vectorLegSkipped, true, 'hybrid mode also catches the semantic half independently');
    assert.deepEqual(outHybrid.results.map((r) => r.node.id), ['kw-only']);
});

await test('recall mode:"keyword" with a null provider: completely unaffected (never touches the embedding provider either way)', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.nodeUpsert({
            id: 'keyword-node', workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: 'keyword test', content: 'zzyzxkeyword marker phrase' },
        });
        const result = await lore.recall('zzyzxkeyword', { workspace: 'default', mode: 'full', searchMode: 'keyword' });
        // keyword mode never attempts a semantic fetch, so nothing was
        // "skipped" — vector_leg_skipped must be absent, not true.
        assert.equal((result._meta as { vector_leg_skipped?: boolean }).vector_leg_skipped, undefined);
        assert.ok(result.totalRecalled >= 1);
    } finally {
        await lore.dispose();
    }
});

await test('fingerprint: never stamped or compared for a null-provider workspace', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.nodeUpsert({
            id: 'fingerprint-node', workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: 'fp test', content: 'fingerprint marker' },
        });
        const basePath = getActiveWorkspacePath(dataDir);
        const fp = readFingerprint(basePath);
        assert.equal(fp, null, `expected NO fingerprint to have been written for a null-provider workspace, got ${JSON.stringify(fp)}`);
    } finally {
        await lore.dispose();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
