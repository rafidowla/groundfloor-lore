#!/usr/bin/env tsx
/**
 * test/review-h-engine-unit.ts — regressions for the 3.28.0 adversarial-review engine findings (slice H).
 *
 *   H1  writes queued behind a timed-out close() must REJECT (VerbatimStoreClosedError), never no-op as success;
 *       a close that drains in time still lets queued writes finish.
 *   H2  the skip-identical check reads the FRESH handle inside the write lane (two stores, one path: A T1, B T2, A T1).
 *   H3  refreshWriteTable's reopen fallback does not close the superseded handle under non-lane readers.
 *   H4  storeBatch of all-new ids issues plain add(), no mergeInsert; mixed new/existing still one row per id.
 *   H5  writeFingerprintIfAbsent leaves no temp file on a failed write, and its no-hard-link fallback is O_EXCL.
 *
 * Real LanceDB in temp dirs under os.tmpdir(); nothing touches ~/.groundfloor.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import * as lancedb from '@lancedb/lancedb';
import { VerbatimStore, VerbatimStoreClosedError } from '../packages/lore/src/engines/verbatimStore.js';
import { refreshWriteTable, type VerbatimBatchCtx } from '../packages/lore/src/engines/verbatimBatch.js';
import { writeFingerprintIfAbsent } from '../packages/lore/src/engines/embeddingFingerprint.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { VerbatimDocument } from '../packages/lore/src/engines/verbatimStore.js';

const DIM = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const vec = () => { n++; return [1, n % 7, 0.5, 0.25]; };
const provider = (): EmbeddingProvider => ({
    modelId: 'review-h-stub', dimension: DIM,
    async initialize() { /* no-op */ },
    async embed() { return vec(); }, async embedDocument() { return vec(); }, async embedQuery() { return vec(); },
    async embedDocumentBatch(t: string[]) { return t.map(() => vec()); },
});
const doc = (id: string, text: string): VerbatimDocument => ({ id, text, metadata: {} } as VerbatimDocument);
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-review-h-'));
const open = async (dir: string) => { const s = new VerbatimStore(dir, provider(), { pieceVectors: false }); await s.initialize(); return s; };

/** Rows (text) per exact id through an independent connection. */
async function rows(dir: string, where: string): Promise<string[]> {
    const db = await lancedb.connect(path.join(dir, '.lore', 'lancedb'));
    try {
        const t = await db.openTable('lore_verbatim');
        return (await t.query().where(where).toArray()).map((r) => String((r as { text: unknown }).text));
    } finally { db.close(); }
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

async function main(): Promise<void> {
    // ---------------------------------------------------------------- H1
    await test('H1: writes queued behind a timed-out close() reject (typed) and leave disk untouched', async () => {
        process.env.LORE_VERBATIM_CLOSE_DRAIN_MS = '300';
        const dir = mkdir();
        try {
            const A = await open(dir);
            await A.store(doc('lore:x', 'x v1')); await A.store(doc('lore:z', 'z v1')); await A.store(doc('lore:y', 'y v1'));
            await A.store(doc('lore:p', 'p v1'));
            const B = await open(dir);
            const hold = (B as unknown as { writeLane(f: () => Promise<void>): Promise<void> }).writeLane(async () => { await sleep(1500); });
            const pending = {
                store: settle(A.store(doc('lore:x', 'x v2'))),
                tombstone: settle(A.tombstone('lore:z', 'test')),
                physicalDelete: settle(A.physicalDelete('lore:y')),
                physicalDeleteMany: settle(A.physicalDeleteMany(['lore:p'])),
                purge: settle(A.purgeWithHistory(['lore:p'])),
                storeBatch: settle(A.storeBatch([doc('lore:w', 'w v1')])),
            };
            await sleep(200);
            const t0 = Date.now();
            await A.close();
            const closeMs = Date.now() - t0;
            assert.ok(closeMs < 1200, `close() must stay bounded by the drain timeout, took ${closeMs}ms`);
            await hold;
            for (const [name, p] of Object.entries(pending)) {
                const r = await p;
                assert.ok(!r.ok, `${name} must reject, not resolve as a no-op`);
                assert.ok((r as { e: unknown }).e instanceof VerbatimStoreClosedError, `${name}: typed closed error, got ${String((r as { e: unknown }).e)}`);
                assert.equal(((r as { e: VerbatimStoreClosedError }).e).operation, 'closed');
            }
            await B.close();
            assert.deepEqual(await rows(dir, "id = 'lore:x'"), ['x v1']);
            assert.deepEqual(await rows(dir, "id = 'lore:z'"), ['z v1'], 'z must not be tombstoned');
            assert.deepEqual(await rows(dir, "id = 'lore:y'"), ['y v1'], 'y must still exist');
            assert.deepEqual(await rows(dir, "id = 'lore:p'"), ['p v1'], 'p must still exist');
            assert.deepEqual(await rows(dir, "id = 'lore:w'"), [], 'w must not exist');
            assert.deepEqual(await rows(dir, "id LIKE '%#rev%'"), [], 'no history rows from writes that did not run');
        } finally { delete process.env.LORE_VERBATIM_CLOSE_DRAIN_MS; fs.rmSync(dir, { recursive: true, force: true }); }
    });

    await test('H1: a close() that drains in time lets queued writes finish (history snapshot included)', async () => {
        process.env.LORE_VERBATIM_CLOSE_DRAIN_MS = '4000';
        const dir = mkdir();
        try {
            const A = await open(dir);
            await A.store(doc('lore:x', 'x v1')); await A.store(doc('lore:y', 'y v1'));
            const B = await open(dir);
            const hold = (B as unknown as { writeLane(f: () => Promise<void>): Promise<void> }).writeLane(async () => { await sleep(400); });
            const ps = [settle(A.store(doc('lore:x', 'x v2'))), settle(A.physicalDelete('lore:y'))];
            await sleep(150);
            await A.close(); await hold;
            for (const p of ps) { const r = await p; assert.ok(r.ok, `queued write must succeed, got ${String((r as { e?: unknown }).e)}`); }
            await B.close();
            assert.deepEqual(await rows(dir, "id = 'lore:x'"), ['x v2']);
            assert.deepEqual(await rows(dir, "id = 'lore:y'"), []);
            assert.equal((await rows(dir, "id LIKE 'lore:x#rev%'")).length, 1, 'snapshotForRev must still run for a write queued before close()');
        } finally { delete process.env.LORE_VERBATIM_CLOSE_DRAIN_MS; fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // ---------------------------------------------------------------- H2
    await test('H2: skip-identical uses the fresh handle in the lane (A T1, B T2, A T1 => T1)', async () => {
        const dir = mkdir();
        try {
            const A = await open(dir);
            await A.store(doc('lore:k', 'T1'));
            const B = await open(dir);
            await B.store(doc('lore:k', 'T2'));
            await A.store(doc('lore:k', 'T1'));
            assert.equal((await A.getById('lore:k'))?.text, 'T1', 'A must see its own last write');
            assert.deepEqual(await rows(dir, "id = 'lore:k'"), ['T1'], 'disk must end at T1, not B\'s T2');
            await A.close(); await B.close();
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    await test('H2: a genuinely unchanged re-store is still skipped (no history row, no rewrite)', async () => {
        const dir = mkdir();
        try {
            const A = await open(dir);
            await A.store(doc('lore:u', 'same'));
            await A.store(doc('lore:u', 'same'));
            await A.store(doc('lore:u', 'same'));
            assert.deepEqual(await rows(dir, "id LIKE 'lore:u%'"), ['same'], 'identical re-stores add no #rev snapshot');
            await A.store(doc('lore:u', 'different'));
            assert.equal((await rows(dir, "id LIKE 'lore:u%'")).length, 2, 'a real change still snapshots + replaces');
            await A.close();
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // ---------------------------------------------------------------- H3
    await test('H3: refreshWriteTable fallback reopens WITHOUT closing the superseded handle', async () => {
        let oldClosed = 0;
        const oldT = { checkoutLatest: async () => { throw new Error('boom'); }, close: () => { oldClosed++; } };
        const newT = { tag: 'new', close() { /* */ } };
        const ctx = { db: { openTable: async () => newT }, table: oldT } as unknown as VerbatimBatchCtx;
        await refreshWriteTable(ctx);
        assert.equal((ctx.table as unknown as { tag?: string }).tag, 'new', 'ctx moved to the reopened handle');
        assert.equal(oldClosed, 0, 'old handle must not be closed synchronously under readers');
    });

    // ---------------------------------------------------------------- H4
    function spyMergeInsert(store: VerbatimStore): { count: () => number } {
        const t = (store as unknown as { table: { mergeInsert: (k: string) => unknown } }).table;
        assert.ok(t, 'store has a table');
        let c = 0;
        const orig = t.mergeInsert.bind(t);
        t.mergeInsert = (k: string) => { c++; return orig(k); };
        return { count: () => c };
    }
    await test('H4: storeBatch of all-new ids uses plain add (no mergeInsert); mixed batch = one row per id', async () => {
        const dir = mkdir();
        try {
            const A = await open(dir);
            await A.store(doc('lore:seed', 'seed')); // table exists => not the created:true shortcut
            const spy = spyMergeInsert(A);
            const fresh = Array.from({ length: 1200 }, (_, i) => doc(`lore:n${i}`, `new ${i}`));
            await A.storeBatch(fresh);
            assert.equal(spy.count(), 0, 'all-new ids must not call mergeInsert');
            // mixed: 100 existing (changed text) + 100 new + an in-batch duplicate id (keep-last)
            const mixed = [
                ...Array.from({ length: 100 }, (_, i) => doc(`lore:n${i}`, `changed ${i}`)),
                ...Array.from({ length: 100 }, (_, i) => doc(`lore:m${i}`, `fresh ${i}`)),
                doc('lore:m0', 'fresh 0 LAST'),
            ];
            await A.storeBatch(mixed);
            assert.equal(spy.count(), 1, 'one mergeInsert chunk for the 100 pre-existing ids');
            assert.deepEqual(await rows(dir, "id = 'lore:n5'"), ['changed 5']);
            assert.deepEqual(await rows(dir, "id = 'lore:m0'"), ['fresh 0 LAST']);
            const db = await lancedb.connect(path.join(dir, '.lore', 'lancedb'));
            const t = await db.openTable('lore_verbatim');
            const all = (await t.query().select(['id']).toArray()).map((r) => String((r as { id: unknown }).id)).filter((id) => !id.includes('#rev'));
            db.close();
            assert.equal(all.length, new Set(all).size, 'no duplicate canonical ids');
            assert.equal(all.length, 1 + 1200 + 100, 'seed + 1200 + 100 new');
            await A.close();
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // ---------------------------------------------------------------- H5
    const patchFs = <K extends keyof typeof fs>(k: K, f: (typeof fs)[K]): (() => void) => {
        const orig = fs[k]; (fs as Record<string, unknown>)[k] = f; syncBuiltinESMExports();
        return () => { (fs as Record<string, unknown>)[k] = orig; syncBuiltinESMExports(); };
    };
    await test('H5: a failed temp write leaves no .tmp file behind', async () => {
        const dir = mkdir();
        const realWrite = fs.writeFileSync;
        const restore = patchFs('writeFileSync', ((p: fs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView, o?: fs.WriteFileOptions) => {
            if (String(p).includes('.tmp-')) { realWrite(p, 'partial', o); throw Object.assign(new Error('ENOSPC simulated'), { code: 'ENOSPC' }); }
            return realWrite(p, d, o);
        }) as typeof fs.writeFileSync);
        try {
            assert.throws(() => writeFingerprintIfAbsent(dir, { modelId: 'm', dimension: 4 }), /ENOSPC/);
        } finally { restore(); }
        const left = fs.readdirSync(path.join(dir, '.lore', 'lancedb'));
        assert.deepEqual(left, [], `no stray files, found ${left.join(',')}`);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('H5: no-hard-link fallback is O_EXCL — it never overwrites a stamp another writer just made', async () => {
        const dir = mkdir();
        const lance = path.join(dir, '.lore', 'lancedb');
        fs.mkdirSync(lance, { recursive: true });
        // Discover the real filename by letting a normal call create it, then reset the dir.
        const probe = writeFingerprintIfAbsent(dir, { modelId: 'probe', dimension: 4 });
        assert.ok(probe);
        const name = fs.readdirSync(lance)[0];
        const target = path.join(lance, name);
        fs.writeFileSync(target, 'OTHER-WRITER');
        const realExists = fs.existsSync;
        const r1 = patchFs('existsSync', ((p: fs.PathLike) => (String(p) === target ? false : realExists(p))) as typeof fs.existsSync);
        const r2 = patchFs('linkSync', (() => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); }) as typeof fs.linkSync);
        try {
            assert.equal(writeFingerprintIfAbsent(dir, { modelId: 'late', dimension: 4 }), null);
        } finally { r2(); r1(); }
        assert.equal(fs.readFileSync(target, 'utf8'), 'OTHER-WRITER', 'existing stamp must survive');
        assert.deepEqual(fs.readdirSync(lance).filter((f) => f.includes('.tmp-')), []);
        // and with the fallback and no competing file, the stamp is created exactly once
        fs.unlinkSync(target);
        const r3 = patchFs('linkSync', (() => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); }) as typeof fs.linkSync);
        try {
            const first = writeFingerprintIfAbsent(dir, { modelId: 'fb', dimension: 4 });
            assert.equal(first?.modelId, 'fb');
            assert.equal(writeFingerprintIfAbsent(dir, { modelId: 'fb2', dimension: 4 }), null);
        } finally { r3(); }
        assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).modelId, 'fb');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
