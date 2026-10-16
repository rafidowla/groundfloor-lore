#!/usr/bin/env tsx
/**
 * verbatim-skip-identical-updatedat-unit.ts — Lore 3.35.0 fixes (l) and (m).
 *
 * (l) store(): a re-store whose only difference is `updatedAt` (the graph re-stamps it on every
 *     re-store) must NOT write a new row, supersede the canonical row, or call the embedder; the
 *     canonical row's `updatedAt` is updated in place. A real content/metadata change still writes.
 * (m) storeBatch(): the same rule, applied before embedding — N unchanged docs + 1 changed doc =
 *     exactly 1 embed and 1 new row. SQLite also re-checks inside the write transaction (a writer
 *     that stored the same content while the batch was embedding must not cause a duplicate row).
 *
 * Runs on both engines: LORE_TEST_VECTOR_ENGINE=sqlite for SQLite, default is Lance.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EmbeddingProvider, VerbatimDocument } from '../packages/lore/src/providers/types.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import { makeVerbatimStore, testVectorEngine } from './helpers/testVerbatimStore.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-updatedat-'));
process.env['LORE_HOME'] = HOME;
const ENGINE = testVectorEngine();

class CountingEmbedder implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'skip-updatedat-det';
    readonly dtype = 'fp32';
    calls = 0;
    onEmbed: (() => Promise<void>) | null = null;
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / n);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> {
        this.calls++;
        const hook = this.onEmbed;
        if (hook) { this.onEmbed = null; await hook(); }
        return this.vec(t);
    }
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).message}`); failed++; }
};

async function fresh(): Promise<{ store: VerbatimStoreApi; emb: CountingEmbedder; done: () => Promise<void> }> {
    const emb = new CountingEmbedder();
    const store = makeVerbatimStore(fs.mkdtempSync(path.join(HOME, 'ws-')), emb);
    await store.initialize();
    emb.calls = 0;
    return { store, emb, done: async () => { await store.close(); } };
}
const doc = (id: string, text: string, updatedAt: string, extra: Partial<VerbatimDocument['metadata']> = {}): VerbatimDocument =>
    ({ id, text, metadata: { updatedAt, project: 'p', ...extra } });
const rows = async (s: VerbatimStoreApi, id: string): Promise<number> => (await s.getHistory(id)).length;

(async () => {
    console.log(`verbatim skip-identical ignores updatedAt (3.35.0) — engine: ${ENGINE}`);

    await test('l1 — re-store with a newer updatedAt: no new row, no embed, updatedAt synced in place', async () => {
        const { store, emb, done } = await fresh();
        try {
            await store.store(doc('lore:a', 'same text', '2026-10-01T00:00:00.000Z'));
            const rows0 = await rows(store, 'lore:a');
            const embeds0 = emb.calls;
            assert.equal(embeds0, 1);
            for (let i = 2; i <= 4; i++) await store.store(doc('lore:a', 'same text', `2026-10-0${i}T00:00:00.000Z`));
            assert.equal(await rows(store, 'lore:a'), rows0, 'row count unchanged');
            assert.equal(emb.calls, embeds0, 'embedder not called again');
            assert.equal((await store.getById('lore:a'))?.updatedAt, '2026-10-04T00:00:00.000Z', 'canonical updatedAt follows the newest store');
        } finally { await done(); }
    });

    await test('l2 — a content change still writes a new row and embeds', async () => {
        const { store, emb, done } = await fresh();
        try {
            await store.store(doc('lore:a', 'v1', '2026-10-01T00:00:00.000Z'));
            const rows0 = await rows(store, 'lore:a');
            await store.store(doc('lore:a', 'v2 changed', '2026-10-02T00:00:00.000Z'));
            assert.equal(await rows(store, 'lore:a'), rows0 + 1, 'a real change adds one history row');
            assert.equal(emb.calls, 2);
            assert.equal((await store.getById('lore:a'))?.text, 'v2 changed');
        } finally { await done(); }
    });

    await test('l3 — a metadata change (same text) still writes; scopes are metadata', async () => {
        const { store, done } = await fresh();
        try {
            await store.store(doc('lore:a', 'same', '2026-10-01T00:00:00.000Z', { label: 'x' }));
            const rows0 = await rows(store, 'lore:a');
            await store.store(doc('lore:a', 'same', '2026-10-02T00:00:00.000Z', { label: 'y' }));
            assert.equal(await rows(store, 'lore:a'), rows0 + 1, 'label change is a real change');
            await store.store(doc('lore:a', 'same', '2026-10-03T00:00:00.000Z', { label: 'y', security_scopes: ['team:a'] }));
            assert.equal(await rows(store, 'lore:a'), rows0 + 2, 'scope change is a real change');
        } finally { await done(); }
    });

    await test('m1 — storeBatch of 5 unchanged + 1 changed: exactly 1 embed, 1 new row, unchanged docs only sync updatedAt', async () => {
        const { store, emb, done } = await fresh();
        try {
            const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => `lore:${s}`);
            await store.storeBatch(ids.map((id) => doc(id, `text of ${id}`, '2026-10-01T00:00:00.000Z')));
            assert.equal(emb.calls, 6);
            const before = await Promise.all(ids.map((id) => rows(store, id)));
            emb.calls = 0;
            const second = ids.map((id, i) => doc(id, i === 5 ? `text of ${id} CHANGED` : `text of ${id}`, '2026-10-09T00:00:00.000Z'));
            await store.storeBatch(second);
            assert.equal(emb.calls, 1, 'only the changed doc is embedded');
            const after = await Promise.all(ids.map((id) => rows(store, id)));
            assert.deepEqual(after, before.map((n, i) => (i === 5 ? n + 1 : n)), 'one new row, only for the changed doc');
            assert.equal((await store.getById('lore:a'))?.updatedAt, '2026-10-09T00:00:00.000Z', 'unchanged doc updatedAt synced');
        } finally { await done(); }
    });

    await test('m2 — storeBatch of the identical batch twice adds no rows and embeds nothing', async () => {
        const { store, emb, done } = await fresh();
        try {
            const mk = (ts: string) => Array.from({ length: 30 }, (_, i) => doc(`lore:n${i}`, `body ${i}`, ts));
            await store.storeBatch(mk('2026-10-01T00:00:00.000Z'));
            const before = await Promise.all(Array.from({ length: 30 }, (_, i) => rows(store, `lore:n${i}`)));
            emb.calls = 0;
            await store.storeBatch(mk('2026-10-02T00:00:00.000Z'));
            assert.equal(emb.calls, 0);
            const after = await Promise.all(Array.from({ length: 30 }, (_, i) => rows(store, `lore:n${i}`)));
            assert.deepEqual(after, before);
        } finally { await done(); }
    });

    if (ENGINE === 'sqlite') {
        await test('m3 (sqlite) — in-transaction recheck: same content stored while the batch embeds must not duplicate', async () => {
            const { store, emb, done } = await fresh();
            try {
                await store.store(doc('lore:r', 'v1', '2026-10-01T00:00:00.000Z'));
                const rows0 = await rows(store, 'lore:r');
                // The batch sees v2 as a change (hint read) and goes to embed; while embedding, a concurrent
                // writer stores the very same v2. The write transaction must notice and skip, not append a copy.
                emb.onEmbed = async () => { await store.store(doc('lore:r', 'v2', '2026-10-02T00:00:00.000Z')); };
                await store.storeBatch([doc('lore:r', 'v2', '2026-10-03T00:00:00.000Z')]);
                assert.equal(await rows(store, 'lore:r'), rows0 + 1, 'v2 appears once, not twice');
                assert.equal((await store.getById('lore:r'))?.text, 'v2');
            } finally { await done(); }
        });
    }

    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
