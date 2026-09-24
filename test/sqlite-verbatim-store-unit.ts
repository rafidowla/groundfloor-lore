#!/usr/bin/env tsx
/**
 * test/sqlite-verbatim-store-unit.ts — 3.21 step 2 part 1.
 *
 * Core CRUD/behaviour contract for SqliteVerbatimStore, parameterized over
 * LORE_TEST_VECTOR_ENGINE ('sqlite' native-vector-search when sqlite-vec is
 * installed, forced to the JS brute-force fallback via
 * LORE_SQLITE_VECTOR_DISABLE_NATIVE=1) — see package.json's `:native` /
 * `:fallback` script variants. Both paths must produce the SAME behaviour;
 * where a scenario needs a score assertion, both must produce the SAME
 * value (cosine similarity is exact, not approximate, so this is a real
 * equality check, not a fuzzy one).
 *
 * Covers: store/storeBatch upsert + skip-identical, history snapshot on
 * overwrite, tombstone marker + search exclusion, physicalDelete /
 * physicalDeleteMany, bulkAddPrebuiltRows / bulkUpsertPrebuiltRows,
 * listIds / exportRows / getContentHashesByIds, ensureFtsIndex tokenizer
 * reconcile, compact(), role:'read' refuses writes, handleCount /
 * vectorSearchPath, close() idempotency, isVerbatimStore() structural
 * guard recognizes it, resolveSearchWorkerIsolation('sqlite') is always
 * false regardless of policy/env, and (Opus review follow-up) a disabled
 * embedding provider: store()/storeBatch() persist a text-only (NULL
 * vector) row instead of failing the write, bm25Search still finds it,
 * and vector search silently skips it (never returns a NULL-vector row,
 * never throws on one).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { isVerbatimStore } from '../packages/lore/src/engines/verbatimStoreApi.js';
import { VerbatimStoreRoleError } from '../packages/lore/src/engines/verbatimStoreRole.js';
import { resolveSearchWorkerIsolation } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { EmbeddingDisabledError } from '../packages/lore/src/providers/nullEmbeddingProvider.js';
import type { EmbeddingProvider, VerbatimDocument } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const VECTOR_PATH = process.env.LORE_SQLITE_VECTOR_DISABLE_NATIVE === '1' ? 'fallback' : 'native-if-available';

/** Deterministic char-code embedding — no ONNX/model download, exact and
 *  reproducible so cosine-similarity assertions are not flaky. */
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'sqlite-verbatim-unit-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
}

function tmpWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-verbatim-unit-'));
}

/** Mirrors the contract `NullEmbeddingProvider` exposes (3.21 integration:
 *  the two independently-written "disabled embedder" contracts were unified
 *  into providers/nullEmbeddingProvider.ts — see its header):
 *  every embed method throws an `EmbeddingDisabledError`-shaped error.
 *  `dimension`/`modelId` are still required by the EmbeddingProvider
 *  interface (used for schema sizing elsewhere) even though no embedding
 *  ever actually happens. */
class DisabledEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'sqlite-verbatim-unit-disabled';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { throw new EmbeddingDisabledError(); }
    async embedQuery(): Promise<number[]> { throw new EmbeddingDisabledError(); }
    async embedDocument(): Promise<number[]> { throw new EmbeddingDisabledError(); }
}

/** The OTHER mirrored shape the review calls out: a `disabled: true` flag
 *  instead of a thrown error. resolveVector() (sqliteVerbatimWrite.ts)
 *  checks this BEFORE ever calling embedDocument, so this provider's embed
 *  methods should never even be invoked — asserted below via a call
 *  counter. */
class FlaggedDisabledEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'sqlite-verbatim-unit-flagged-disabled';
    readonly disabled = true;
    embedCalls = 0;
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { this.embedCalls++; return []; }
    async embedQuery(): Promise<number[]> { this.embedCalls++; return []; }
    async embedDocument(): Promise<number[]> { this.embedCalls++; return []; }
}

async function main(): Promise<void> {
    console.log(`sqlite-verbatim-store-unit — vector path requested: ${VECTOR_PATH}\n`);

    await test('initialize() opens the store; handleCount()=1; isVerbatimStore() recognizes it', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        assert.equal(store.handleCount(), 1);
        assert.ok(isVerbatimStore(store), 'isVerbatimStore(sqliteStore) must be true');
        await store.close();
        assert.equal(store.handleCount(), 0);
    });

    await test('store() + getById() round-trips text and metadata', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'alpha document about tokens', metadata: { type: 'note', label: 'Alpha' } });
        const got = await store.getById('a1');
        assert.ok(got);
        assert.equal(got!.text, 'alpha document about tokens');
        assert.equal(got!.type, 'note');
        assert.equal(got!.label, 'Alpha');
        await store.close();
    });

    await test('store() is skip-identical: re-storing the same text does not create a history row', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'stable text', metadata: {} });
        await store.store({ id: 'a1', text: 'stable text', metadata: {} });
        const hist = await store.getHistory('a1');
        assert.equal(hist.length, 1, 'identical re-store must not snapshot a history row');
        await store.close();
    });

    await test('store() overwrite snapshots the previous canonical row as history (newest-first, canonical first)', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'version one', metadata: {} });
        await store.store({ id: 'a1', text: 'version two', metadata: {} });
        await store.store({ id: 'a1', text: 'version three', metadata: {} });
        const hist = await store.getHistory('a1');
        assert.equal(hist.length, 3);
        assert.equal(hist[0]!.text, 'version three');
        assert.ok(hist[0]!.isCanonical);
        assert.ok(!hist[1]!.isCanonical && !hist[2]!.isCanonical);
        const canonical = await store.getById('a1');
        assert.equal(canonical!.text, 'version three');
        await store.close();
    });

    await test('tombstone() marks the canonical row and excludes it from search/bm25', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'weather forecast for tomorrow', metadata: {} });
        await store.tombstone('a1', 'no longer relevant');
        const got = await store.getById('a1');
        assert.ok(got?.text?.startsWith('[TOMBSTONED'));
        assert.ok(got?.text?.includes('no longer relevant'));
        const searchHits = await store.search('weather forecast', 5);
        assert.ok(!searchHits.some((h) => h.id === 'a1'));
        const bm25 = await store.bm25Search('weather forecast', 5);
        assert.ok(!bm25.hits.some((h) => h.id === 'a1'));
        // tombstone is idempotent
        await store.tombstone('a1', 'second call');
        const got2 = await store.getById('a1');
        assert.equal(got2!.text, got!.text, 'second tombstone call is a no-op');
        await store.close();
    });

    await test('physicalDelete() / physicalDeleteMany() hard-remove rows (no history left behind)', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'one', metadata: {} });
        await store.store({ id: 'a2', text: 'two', metadata: {} });
        await store.store({ id: 'a3', text: 'three', metadata: {} });
        await store.physicalDelete('a1');
        assert.equal(await store.count(), 2);
        const n = await store.physicalDeleteMany(['a2', 'a3', 'nonexistent']);
        assert.equal(n, 3, 'processed count includes the non-matching id (harmless no-op)');
        assert.equal(await store.count(), 0);
        await store.close();
    });

    await test('bulkAddPrebuiltRows() / bulkUpsertPrebuiltRows() write rows without calling the embedder', async () => {
        let embedCalls = 0;
        class CountingProvider extends DetEmbedProvider {
            override async embedDocument(text: string): Promise<number[]> { embedCalls++; return super.embedDocument(text); }
        }
        const store = new SqliteVerbatimStore(tmpWorkspace(), new CountingProvider());
        await store.initialize();
        const provider = new DetEmbedProvider();
        await store.bulkAddPrebuiltRows([
            { id: 'b1', text: 'bulk one', vector: await provider.embedDocument('bulk one') },
            { id: 'b2', text: 'bulk two', vector: await provider.embedDocument('bulk two') },
        ]);
        assert.equal(embedCalls, 0, 'bulkAddPrebuiltRows must not call the store embedder');
        assert.equal(await store.count(), 2);
        await store.bulkUpsertPrebuiltRows([
            { id: 'b1', text: 'bulk one updated', vector: await provider.embedDocument('bulk one updated') },
        ]);
        assert.equal(embedCalls, 0, 'bulkUpsertPrebuiltRows must not call the store embedder');
        const got = await store.getById('b1');
        assert.equal(got!.text, 'bulk one updated');
        // NOT a history snapshot on overwrite — matches Lance's real
        // bulkUpsertPrebuiltRows (verbatimBatch.ts calls mergeInsert
        // directly with no separate snapshot step, unlike store()'s
        // deliberate extra snapshotForRev() call). Caught by the Opus
        // review's mechanical cross-engine parameterization of
        // audit-bulk-dedup-unit.ts, which asserts exactly 1 physical row
        // after a bulk re-ingest of the same id.
        const hist = await store.getHistory('b1');
        assert.equal(hist.length, 1, 'bulkUpsertPrebuiltRows replaces in place — no history snapshot, matching Lance');
        await store.close();
    });

    await test('listIds() / exportRows() / getContentHashesByIds() cover canonical rows only', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'lore:x1', text: 'x one', metadata: {} });
        await store.store({ id: 'lore:x2', text: 'x two', metadata: {} });
        await store.store({ id: 'other:y1', text: 'y one', metadata: {} });
        await store.store({ id: 'lore:x1', text: 'x one v2', metadata: {} }); // history snapshot, must not leak into listIds
        const ids = await store.listIds('lore:');
        assert.deepEqual(ids.sort(), ['lore:x1', 'lore:x2']);
        const exported = await store.exportRows();
        assert.equal(exported.rows.length, 3, 'exportRows returns canonical rows only, history excluded');
        assert.equal(exported.dim, 8);
        const hashes = await store.getContentHashesByIds(['lore:x1', 'lore:x2', 'missing']);
        assert.equal(hashes.size, 2);
        await store.close();
    });

    await test('vector search: near-identical query ranks the matching doc first; score matches cosine similarity', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'the quick brown fox jumps over the lazy dog', metadata: {} });
        await store.store({ id: 'a2', text: 'completely unrelated text about database internals', metadata: {} });
        const hits = await store.search('the quick brown fox jumps over the lazy dog', 5);
        assert.ok(hits.length >= 1);
        assert.equal(hits[0]!.id, 'a1');
        assert.ok(hits[0]!.score > 0.99, `expected near-1.0 cosine similarity for an identical query, got ${hits[0]!.score}`);
        await store.close();
    });

    await test('vector search filter: metadata filter restricts results to matching rows', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'same-ish content one', metadata: { project: 'p1' } });
        await store.store({ id: 'a2', text: 'same-ish content two', metadata: { project: 'p2' } });
        const hits = await store.search('same-ish content', 10, { project: 'p1' });
        assert.ok(hits.every((h) => h.metadata.project === 'p1'));
        assert.ok(hits.some((h) => h.id === 'a1'));
        assert.ok(!hits.some((h) => h.id === 'a2'));
        await store.close();
    });

    await test('bm25Search: keyword match ranks the containing doc; ranked=true on a genuine FTS hit', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'the distinctive marker zephyr appears here', metadata: {} });
        await store.store({ id: 'a2', text: 'no relation to the other document at all', metadata: {} });
        const bm25 = await store.bm25Search('zephyr', 5);
        assert.ok(bm25.ranked);
        assert.ok(bm25.hits.some((h) => h.id === 'a1'));
        assert.ok(!bm25.hits.some((h) => h.id === 'a2'));
        await store.close();
    });

    await test('bm25Search: porter stemming matches a different inflection of the same word', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'the runner was running quickly through the park', metadata: {} });
        const bm25 = await store.bm25Search('run', 5);
        assert.ok(bm25.hits.some((h) => h.id === 'a1'), 'porter stemmer should match run -> running/runner');
        await store.close();
    });

    await test('ensureVectorIndex() is a no-op (scalar-function path, nothing to build); ensureFtsIndex() reconciles CJK', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        assert.equal(await store.ensureVectorIndex(), false);
        // Seed a CJK-heavy corpus so the tokenizer sample detects CJK and
        // rebuilds from the Latin default.
        for (let i = 0; i < 5; i++) {
            await store.store({ id: `cjk${i}`, text: '供应商保险证明审批流程第步骤说明文件', metadata: {} });
        }
        const rebuilt = await store.ensureFtsIndex();
        assert.equal(rebuilt, true, 'a CJK-heavy corpus should trigger a tokenizer rebuild');
        const bm25 = await store.bm25Search('保险证明', 5);
        assert.ok(bm25.hits.length > 0, 'trigram tokenizer should make CJK content searchable after reconcile');
        await store.close();
    });

    await test('compact() runs without throwing and returns a result shape', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'content', metadata: {} });
        const result = await store.compact();
        assert.ok(result);
        assert.equal(result!.fragmentsRemoved, 0);
        await store.close();
    });

    await test("role:'read' refuses every mutating call with VerbatimStoreRoleError; search still works", async () => {
        const base = tmpWorkspace();
        const writer = new SqliteVerbatimStore(base, new DetEmbedProvider());
        await writer.initialize();
        await writer.store({ id: 'a1', text: 'seeded by the writer', metadata: {} });
        await writer.close();

        const reader = new SqliteVerbatimStore(base, new DetEmbedProvider(), { role: 'read' });
        await reader.initialize();
        await assert.rejects(() => reader.store({ id: 'a2', text: 'x', metadata: {} }), VerbatimStoreRoleError);
        await assert.rejects(() => reader.storeBatch([{ id: 'a2', text: 'x', metadata: {} }]), VerbatimStoreRoleError);
        await assert.rejects(() => reader.tombstone('a1', 'x'), VerbatimStoreRoleError);
        await assert.rejects(() => reader.physicalDelete('a1'), VerbatimStoreRoleError);
        await assert.rejects(() => reader.physicalDeleteMany(['a1']), VerbatimStoreRoleError);
        await assert.rejects(() => reader.bulkAddPrebuiltRows([{ id: 'a2', text: 'x' }]), VerbatimStoreRoleError);
        await assert.rejects(() => reader.bulkUpsertPrebuiltRows([{ id: 'a2', text: 'x' }]), VerbatimStoreRoleError);
        const hits = await reader.search('seeded by the writer', 5);
        assert.ok(hits.some((h) => h.id === 'a1'), 'a read-role store must still serve reads written by another handle');
        await reader.close();
    });

    await test('close() is idempotent; a closed store reports handleCount()=0', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DetEmbedProvider());
        await store.initialize();
        await store.store({ id: 'a1', text: 'x', metadata: {} });
        await store.close();
        await store.close(); // must not throw
        assert.equal(store.handleCount(), 0);
    });

    await test("resolveSearchWorkerIsolation('sqlite') is always false, regardless of policy or LORE_SEARCH_WORKER", async () => {
        const prevEnv = process.env.LORE_SEARCH_WORKER;
        try {
            process.env.LORE_SEARCH_WORKER = '1';
            assert.equal(resolveSearchWorkerIsolation('/fake/path', undefined, 'sqlite'), false);
            assert.equal(resolveSearchWorkerIsolation('/fake/path', true, 'sqlite'), false, 'engineKind wins even over an explicit true policy');
            assert.equal(resolveSearchWorkerIsolation('/fake/path', () => true, 'sqlite'), false);
            // Sanity: omitting engineKind (or 'lance') preserves prior behaviour.
            assert.equal(resolveSearchWorkerIsolation('/fake/path', true), true);
        } finally {
            if (prevEnv === undefined) delete process.env.LORE_SEARCH_WORKER; else process.env.LORE_SEARCH_WORKER = prevEnv;
        }
    });

    await test('store() with a disabled embedder (throws EmbeddingDisabledError) persists a text-only row; bm25Search finds it', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace(), new DisabledEmbedProvider());
        await store.initialize();
        await store.store({ id: 'noembed1', text: 'a distinctive marker glimmerfox appears in this text-only row', metadata: {} });
        const got = await store.getById('noembed1');
        assert.ok(got, 'the row must exist');
        assert.equal(got!.text, 'a distinctive marker glimmerfox appears in this text-only row');
        const bm25 = await store.bm25Search('glimmerfox', 5);
        assert.ok(bm25.hits.some((h) => h.id === 'noembed1'), 'bm25Search must find a text-only row');
        await store.close();
    });

    await test("store() with a `disabled: true`-flagged provider never calls embedDocument, and storeBatch() does the same", async () => {
        const provider = new FlaggedDisabledEmbedProvider();
        const store = new SqliteVerbatimStore(tmpWorkspace(), provider);
        await store.initialize();
        await store.store({ id: 'noembed2', text: 'flagged provider single store', metadata: {} });
        assert.equal(provider.embedCalls, 0, 'a disabled:true provider must never be called for store()');
        await store.storeBatch([
            { id: 'noembed3', text: 'flagged provider batch one', metadata: {} },
            { id: 'noembed4', text: 'flagged provider batch two', metadata: {} },
        ]);
        assert.equal(provider.embedCalls, 0, 'a disabled:true provider must never be called for storeBatch()');
        assert.equal(await store.count(), 3);
        await store.close();
    });

    await test('vector search silently skips NULL-vector (text-only) rows — never returned, never throws', async () => {
        // Mixed store: a real embedder writes some rows, then a SEPARATE
        // handle with a disabled embedder writes a text-only row sharing
        // enough vocabulary that it WOULD be a plausible top hit if vector
        // search didn't correctly exclude it.
        const ws = tmpWorkspace();
        const embedder = new DetEmbedProvider();
        const writer = new SqliteVerbatimStore(ws, embedder);
        await writer.initialize();
        await writer.store({ id: 'real1', text: 'the glimmerfox marker appears in a real embedded row', metadata: {} });
        await writer.close();

        const disabledWriter = new SqliteVerbatimStore(ws, new DisabledEmbedProvider());
        await disabledWriter.initialize();
        await disabledWriter.store({ id: 'textonly1', text: 'the glimmerfox marker appears in a text-only row', metadata: {} });
        await disabledWriter.close();

        const reader = new SqliteVerbatimStore(ws, embedder);
        await reader.initialize();
        assert.equal(await reader.count(), 2, 'both rows exist');
        const hits = await reader.search('the glimmerfox marker appears in a real embedded row', 10);
        assert.ok(hits.some((h) => h.id === 'real1'), 'the real embedded row must be found');
        assert.ok(!hits.some((h) => h.id === 'textonly1'), 'the NULL-vector row must never appear in vector-search results');
        // bm25, unlike vector search, DOES find the text-only row — it has
        // no vector dependency.
        const bm25 = await reader.bm25Search('glimmerfox', 10);
        assert.ok(bm25.hits.some((h) => h.id === 'textonly1'), 'bm25Search must still find the text-only row');
        await reader.close();
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
