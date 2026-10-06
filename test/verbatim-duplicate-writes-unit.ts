#!/usr/bin/env tsx
/**
 * test/verbatim-duplicate-writes-unit.ts — Lance `lore_verbatim` must never
 * hold two rows with the same CANONICAL id.
 *
 * Atlas found duplicated canonical rows (same text / contentHash / updatedAt in
 * every copy) in 10 workspaces, some written as late as 2026-10-05 during a
 * daemon restart — after the 2026-08-17 in-batch dedupe. Root causes, each
 * reproduced below against real LanceDB in a temp home:
 *
 *   (a) two overlapping storeBatch/store/bulk calls for the same id in ONE
 *       process: both delete-then-add (or both plain-add) -> two rows;
 *   (b) cold-table race: ensureVerbatimTable hands every concurrent first
 *       writer `created:true`, so each plain-adds the same ids;
 *   (d) an outbox replay (identical payload) overlapping the live write;
 *   (e) bulkAddPrebuiltRows is a plain append with no dedupe.
 *
 * History ids (`<id>#rev<ISO>`) are expected to repeat per revision and are NOT
 * counted — classification mirrors engines/migrateVectorsRows.ts
 * classifyLanceId (history / alias / canonical).
 *
 * Every store lives in a temp dir under os.tmpdir(); nothing touches
 * ~/.groundfloor.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { classifyLanceId } from '../packages/lore/src/engines/migrateVectorsRows.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { VerbatimDocument } from '../packages/lore/src/engines/verbatimStore.js';

const DIM = 8;
const ROUNDS = Number(process.env.LORE_DUP_TEST_ROUNDS ?? 6);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic embedder with a small jittered delay so concurrent writers
 *  genuinely interleave between preflight and write. */
function provider(): EmbeddingProvider {
    const vec = (t: string) => Array.from({ length: DIM }, (_, i) => ((t.charCodeAt(i % Math.max(1, t.length)) || 1) % 17) / 17);
    return {
        modelId: 'dup-test-fake',
        dimension: DIM,
        async initialize() { /* no-op */ },
        async embed(t: string) { return vec(t); },
        async embedDocument(t: string) { await sleep(Math.random() * 8); return vec(t); },
        async embedQuery(t: string) { return vec(t); },
        async embedDocumentBatch(texts: string[]) { await sleep(Math.random() * 8); return texts.map(vec); },
    };
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

async function withStore(fn: (store: VerbatimStore, dir: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dupw-'));
    const store = new VerbatimStore(dir, provider());
    try { await store.initialize(); await fn(store, dir); }
    finally { await store.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Read every id in lore_verbatim through an independent connection. */
async function allIds(dir: string): Promise<string[]> {
    const db = await lancedb.connect(path.join(dir, '.lore', 'lancedb'));
    try {
        const names = await db.tableNames();
        if (!names.includes('lore_verbatim')) return [];
        const t = await db.openTable('lore_verbatim');
        const rows = await t.query().select(['id']).toArray();
        return rows.map((r) => String((r as { id: unknown }).id));
    } finally { db.close(); }
}

/** Canonical ids that appear more than once (history rows excluded). */
async function duplicateCanonicals(dir: string): Promise<Array<[string, number]>> {
    const counts = new Map<string, number>();
    for (const id of await allIds(dir)) {
        if (classifyLanceId(id) === 'history') continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1);
}

async function canonicalCount(dir: string): Promise<number> {
    return (await allIds(dir)).filter((id) => classifyLanceId(id) !== 'history').length;
}

const UPDATED = '2026-10-05T00:00:00.000Z';
const docs = (prefix: string, n: number, tag = ''): VerbatimDocument[] =>
    Array.from({ length: n }, (_, i) => ({
        id: `${prefix}:${i}`,
        text: `document ${prefix} ${i} ${tag}`,
        metadata: { type: 'note', project: 'dup', ecosystem: 'test', updatedAt: UPDATED },
    }));
const clone = (d: VerbatimDocument[]): VerbatimDocument[] => d.map((x) => ({ ...x, metadata: { ...x.metadata } }));
const prebuilt = (prefix: string, n: number, tag = ''): Array<Record<string, unknown>> =>
    Array.from({ length: n }, (_, i) => ({
        vector: Array.from({ length: DIM }, () => 0),
        id: `${prefix}:${i}`, text: `bulk ${prefix} ${i} ${tag}`, type: 'note', label: '', tags: '',
        project: 'dup', ecosystem: 'test', updatedAt: UPDATED, security_scopes: [], contentHash: `h-${prefix}-${i}-${tag}`,
    }));

async function expectNoDuplicates(dir: string, what: string): Promise<void> {
    const dups = await duplicateCanonicals(dir);
    assert.deepEqual(dups, [], `${what}: duplicated canonical ids: ${JSON.stringify(dups.slice(0, 5))}`);
}

console.log(`\nVerbatimStore — no duplicate canonical ids (${ROUNDS} rounds per race)\n`);

await test('(b) cold table: two concurrent storeBatch of the same ids', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            const d = docs('cold', 40);
            await Promise.all([s.storeBatch(clone(d)), s.storeBatch(clone(d))]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 40);
        });
    }
});

await test('(b) cold table: concurrent store() of the same id', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            const d = docs('coldone', 1)[0];
            await Promise.all([s.store({ ...d }), s.store({ ...d }), s.store({ ...d })]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 1);
        });
    }
});

await test('(a) warm table: three concurrent storeBatch of the same ids', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            await s.storeBatch(docs('warm', 40, 'seed'));
            await Promise.all([
                s.storeBatch(docs('warm', 40, 'a')),
                s.storeBatch(docs('warm', 40, 'b')),
                s.storeBatch(docs('warm', 40, 'c')),
            ]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 40);
        });
    }
});

await test('(a) storeBatch racing store() on overlapping ids (warm)', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            await s.storeBatch(docs('mix', 30, 'seed'));
            const single = docs('mix', 30, 'single');
            await Promise.all([
                s.storeBatch(docs('mix', 30, 'batch')),
                ...single.slice(0, 10).map((d) => s.store({ ...d })),
            ]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 30);
        });
    }
});

await test('(a/b) storeBatch racing store() on a COLD table', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            const single = docs('mixc', 12, 'single');
            await Promise.all([
                s.storeBatch(docs('mixc', 12, 'batch')),
                ...single.map((d) => s.store({ ...d })),
            ]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 12);
        });
    }
});

await test('(d) replayed identical payload (same text/hash/updatedAt) overlapping the original', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            await s.storeBatch(docs('rep', 25, 'seed'));
            const payload = docs('rep', 25, 'changed');
            await Promise.all([s.storeBatch(clone(payload)), s.storeBatch(clone(payload))]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 25);
        });
    }
});

await test('(e) bulkAddPrebuiltRows twice with the same ids (sequential)', async () => {
    await withStore(async (s, dir) => {
        await s.bulkAddPrebuiltRows(prebuilt('bulk', 20));
        await s.bulkAddPrebuiltRows(prebuilt('bulk', 20));
        await expectNoDuplicates(dir, 'sequential');
        assert.equal(await canonicalCount(dir), 20);
    });
});

await test('(e) bulkAddPrebuiltRows concurrent with itself and with storeBatch (cold)', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            await Promise.all([
                s.bulkAddPrebuiltRows(prebuilt('bulkc', 20, 'x')),
                s.bulkAddPrebuiltRows(prebuilt('bulkc', 20, 'y')),
                s.storeBatch(docs('bulkc', 20, 'z')),
            ]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 20);
        });
    }
});

await test('(e) bulkAddPrebuiltRows replaces the existing canonical row (last write wins)', async () => {
    await withStore(async (s, dir) => {
        await s.bulkAddPrebuiltRows(prebuilt('lw', 3, 'old'));
        await s.bulkAddPrebuiltRows(prebuilt('lw', 3, 'new'));
        const got = await s.getById('lw:1');
        assert.ok(got && (got.text ?? '').includes('new'), `expected replaced row, got ${JSON.stringify(got?.text)}`);
        await expectNoDuplicates(dir, 'lw');
    });
});

await test('(a) bulkUpsertPrebuiltRows racing storeBatch (warm)', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            await s.storeBatch(docs('bu', 20, 'seed'));
            await Promise.all([
                s.bulkUpsertPrebuiltRows(prebuilt('bu', 20, 'up')),
                s.storeBatch(docs('bu', 20, 'batch')),
                s.bulkUpsertPrebuiltRows(prebuilt('bu', 20, 'up2')),
            ]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 20);
        });
    }
});

await test('tombstone racing store/storeBatch leaves exactly one canonical row', async () => {
    for (let r = 0; r < ROUNDS; r++) {
        await withStore(async (s, dir) => {
            await s.storeBatch(docs('tomb', 10, 'seed'));
            await Promise.all([
                s.tombstone('tomb:3', 'race'),
                s.storeBatch(docs('tomb', 10, 'batch')),
                s.store({ ...docs('tomb', 10, 'one')[3] }),
            ]);
            await expectNoDuplicates(dir, `round ${r}`);
            assert.equal(await canonicalCount(dir), 10);
        });
    }
});

await test('#rev history semantics preserved: one snapshot per superseded canonical, history ids not counted', async () => {
    await withStore(async (s, dir) => {
        await s.storeBatch(docs('hist', 5, 'v1'));
        await sleep(5);
        await s.storeBatch(docs('hist', 5, 'v2'));
        await sleep(5);
        await s.store({ ...docs('hist', 5, 'v3')[2] });
        const ids = await allIds(dir);
        const hist = ids.filter((id) => classifyLanceId(id) === 'history');
        // v1->v2 snapshots all 5; v2->v3 snapshots hist:2 only.
        assert.equal(hist.length, 6, `history rows: ${JSON.stringify(hist)}`);
        assert.equal(hist.filter((h) => h.startsWith('hist:2#rev')).length, 2);
        assert.equal(ids.filter((id) => classifyLanceId(id) !== 'history').length, 5);
        await expectNoDuplicates(dir, 'hist');
        const h = await s.getHistory('hist:2');
        assert.ok(h.length >= 3, `getHistory returns canonical + 2 revs, got ${h.length}`);
    });
});

await test('a failed embed leaves every canonical row in place (none deleted, none added)', async () => {
    await withStore(async (s, dir) => {
        await s.storeBatch(docs('fe', 4, 'seed'));
        const canon = async () => (await allIds(dir)).filter((id) => classifyLanceId(id) !== 'history').sort();
        const before = await canon();
        const bad = s as unknown as { embeddingProvider: EmbeddingProvider };
        const orig = bad.embeddingProvider.embedDocumentBatch;
        bad.embeddingProvider.embedDocumentBatch = async () => { throw new Error('embed boom'); };
        await assert.rejects(() => s.storeBatch(docs('fe', 4, 'changed')), /embed boom/);
        bad.embeddingProvider.embedDocumentBatch = orig;
        assert.deepEqual(await canon(), before, 'canonical rows unchanged');
    });
});

await test('close() with queued writers drains without deadlock and without duplicates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dupw-close-'));
    const store = new VerbatimStore(dir, provider());
    try {
        await store.initialize();
        const writes = Array.from({ length: 6 }, (_, i) => store.storeBatch(docs('cl', 10, `w${i}`)).catch(() => undefined));
        const closed = await Promise.race([
            Promise.all([...writes, store.close()]).then(() => 'ok'),
            sleep(30_000).then(() => 'timeout'),
        ]);
        assert.equal(closed, 'ok', 'close + queued writers finished');
        await expectNoDuplicates(dir, 'close');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
