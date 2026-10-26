#!/usr/bin/env tsx
/**
 * Wire-up proof (Wave E e5): READS through the daemon BOOT verbatim reference follow a background
 * SQLite -> LanceDB promotion (d7 follow-up; d7 forwarded only WRITES).
 *
 * Real path: embedded `createLore()` runs the same server.ts boot as the daemon - createVectorStore (the boot
 * store that server.ts / routes / the sync engine hold), WorkspaceVerbatimResolver (pins + swaps), real SQLite
 * engine, real promotion via LORE_VECTOR_PROMOTE_ROWS. `lore.store.loreVerbatim` is the held boot reference.
 *
 *   A. after promotion + more writes (landing only on the promoted store) every read method on the HELD boot
 *      reference sees all rows and equals what the resolver's store returns.
 *   B. reads racing the promotion never throw and never lose a row that was acknowledged before the read began.
 *   C. closed-store semantics are unchanged: a closed boot reference answers empty and never asks the resolver.
 *   D. the forwarding rules in isolation (real SqliteVerbatimStore + a fake successor): no bounce-back, the old
 *      store answers while no successor exists, a failing replay is surfaced, optional methods the successor
 *      lacks, a successor closed under us is re-resolved once.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.LORE_MODEL_SERVER = '0';
process.env.LORE_VECTOR_PROMOTE_ROWS = '6';
process.env.LORE_DEFAULT_VECTOR_ENGINE = 'sqlite';
process.env.LORE_CACHE_DISABLED = '1'; // a fresh read must never be answered by the TTL cache
const { createLore } = await import('../packages/lore/src/index.js');
const { loadWorkspaces, getActiveWorkspaceName } = await import('../packages/lore/src/config/workspaces.js');
const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
const { SqliteVerbatimStore } = await import('../packages/lore/src/engines/sqliteVerbatimStore.js');
const { raiseWriteBarrier } = await import('../packages/lore/src/engines/verbatimWriteBarrier.js');
const { VerbatimStoreClosedError } = await import('../packages/lore/src/engines/verbatimStoreClosedError.js');

const dim = 8;
const vec = (t: string): number[] => {
    const v = new Array(dim).fill(0.01);
    for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) / 128;
    return v;
};
const provider = {
    dimension: dim, modelId: 'boot-ref-read-det', dtype: 'fp32',
    async initialize() {}, async embed(t: string) { return vec(t); }, async embedQuery(t: string) { return vec(t); },
    async embedDocument(t: string) { return vec(t); },
    async embedDocumentBatch(ts: string[]) { return ts.map(vec); },
    dispose() {},
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const doc = (id: string, text = `zebra document ${id}`) => ({ id, text, metadata: { updatedAt: '2026-10-25T00:00:00.000Z' } });
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
/** Wait until the resolver hands out a store other than the boot instance (the swap landed). */
async function waitSwapped(resolver: { getOrOpen(w: string, o?: { touch?: boolean }): Promise<unknown> }, ws: string, boot: unknown): Promise<unknown> {
    const t0 = Date.now();
    for (;;) {
        const s = await resolver.getOrOpen(ws, { touch: false });
        if (s !== boot) return s;
        if (Date.now() - t0 > 20_000) throw new Error('the resolver never swapped its boot entry to the promoted store');
        await sleep(25);
    }
}

// ---------------------------------------------------------------- A
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-ref-reads-'));
const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider as never });
try {
    const boot = lore.store.loreVerbatim as unknown as InstanceType<typeof SqliteVerbatimStore>;
    assert.ok(boot instanceof SqliteVerbatimStore, 'boot store is the SQLite engine');
    const resolver = lore._daemon.getVerbatimResolver()!;
    const ws = getActiveWorkspaceName(dataDir);
    await resolver.getOrOpen(ws); // primed boot entry
    for (let i = 0; i < 6; i++) await boot.store(doc(`seed${i}`)); // the 6th write triggers the promotion
    const promoted = (await waitSwapped(resolver, ws, boot)) as InstanceType<typeof VerbatimStore>;
    assert.ok(promoted instanceof VerbatimStore, 'resolver now serves the Lance engine');
    assert.equal(loadWorkspaces(dataDir).workspaces.find((w) => w.name === ws)?.vectorEngine, 'lance');

    // rows written AFTER the promotion, straight to the promoted store: the stale SQLite file never sees them
    await promoted.store(doc('post-a', 'quokkaterm only after promotion'));
    await promoted.storeBatch([doc('post-b', 'quokkaterm second'), doc('post-c')]);
    await boot.store(doc('post-d', 'quokkaterm via boot write forwarding'));
    const postIds = ['post-a', 'post-b', 'post-c', 'post-d'];

    await test('getById / getExistingIds / getContentHashesByIds / getHistory / getVectors through the held boot ref see post-promotion rows', async () => {
        for (const id of postIds) assert.equal(((await boot.getById(id))?.text?.length ?? 0) > 0, true, `${id} via boot.getById`);
        assert.deepEqual((await boot.getExistingIds([...postIds, 'seed0', 'nope'])).sort(), [...postIds, 'seed0'].sort());
        const hashes = await boot.getContentHashesByIds(postIds);
        assert.deepEqual([...hashes.keys()].sort(), postIds.slice().sort());
        assert.deepEqual([...(await boot.getContentHashesByIds(postIds)).entries()], [...(await promoted.getContentHashesByIds(postIds)).entries()]);
        assert.ok((await boot.getHistory('post-a')).length >= 0);
        const vecs = await boot.getVectors(['post-a', 'seed1']);
        assert.deepEqual([...vecs.keys()].sort(), ['post-a', 'seed1']);
    });

    await test('count and listIds through the held boot ref equal the promoted store (all rows)', async () => {
        const viaBoot = await boot.count();
        assert.equal(viaBoot, await promoted.count());
        assert.ok(viaBoot >= 10, `count ${viaBoot} covers seeds + post rows`);
        assert.deepEqual((await boot.listIds()).slice().sort(), (await promoted.listIds()).slice().sort());
        for (const id of postIds) assert.ok((await boot.listIds()).includes(id), `${id} listed`);
        const exported = await boot.exportRows();
        const ids = exported.rows.map((r) => (r as { id: string }).id);
        for (const id of postIds) assert.ok(ids.includes(id), `${id} exported`);
    });

    await test('search / searchByVector / searchByVectors / bm25Search through the held boot ref find post-promotion rows', async () => {
        const hits = await boot.search('quokkaterm only after promotion', 5);
        assert.equal(hits[0]?.id, 'post-a', JSON.stringify(hits.map((h) => h.id)));
        const byVec = await boot.searchByVector(vec('quokkaterm only after promotion'), { topK: 3 });
        assert.equal(byVec[0]?.id, 'post-a');
        const many = await boot.searchByVectors([{ key: 'k', vector: vec('quokkaterm only after promotion') }], { topK: 3 });
        assert.equal(many.get('k')?.[0]?.id, 'post-a');
        const bm = await boot.bm25Search('quokkaterm', 10);
        const bmIds = bm.hits.map((h) => h.id).sort();
        assert.deepEqual(bmIds, ['post-a', 'post-b', 'post-d'], JSON.stringify(bm));
        // the same answers as the resolver-routed store
        assert.deepEqual((await promoted.bm25Search('quokkaterm', 10)).hits.map((h) => h.id).sort(), bmIds);
        assert.deepEqual(hits.map((h) => h.id), (await promoted.search('quokkaterm only after promotion', 5)).map((h) => h.id));
    });

    await test('findUnchangedRowIds on the retired boot ref never reports a stale "unchanged" (promoted store has no probe -> nothing unchanged)', async () => {
        // post-a exists only on the promoted store; seed0 exists in both. Neither may be skipped on the strength of the old file.
        const rows = [{ id: 'seed0', text: 'zebra document seed0', content_hash: 'x' }];
        assert.deepEqual(await boot.findUnchangedRowIds(rows), []);
    });

    await test('the resolver-routed store sees the same rows (resolver path unchanged)', async () => {
        const viaResolver = (await resolver.getOrOpen(ws)) as InstanceType<typeof VerbatimStore>;
        assert.equal(viaResolver, promoted);
        assert.equal(await viaResolver.count(), await boot.count());
    });

    await test('reads via the boot ref never touch the renamed-away SQLite file after the swap', async () => {
        // The retired instance's own handle would still answer the OLD rows: prove it is not what answers.
        const direct = await (boot as unknown as { searchByVectorHere(v: number[], o: object): Promise<Array<{ id: string }>> }).searchByVectorHere(vec('quokkaterm only after promotion'), { topK: 20 });
        assert.ok(!direct.some((h) => h.id === 'post-a'), 'the old SQLite handle does not hold post-a (control)');
        const viaPublic = await boot.searchByVector(vec('quokkaterm only after promotion'), { topK: 20 });
        assert.ok(viaPublic.some((h) => h.id === 'post-a'), 'the public read is answered by the promoted store');
    });
} catch (e) {
    failed++;
    console.error(`  FAIL setup ${(e as Error).stack ?? (e as Error).message}`);
}

// ---------------------------------------------------------------- B + C
await test('reads racing the promotion never throw and never lose a row acknowledged before the read began', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-ref-reads-race-'));
    const lore2 = await createLore({ dataDir: dir2, deploymentMode: 'embedded', embeddingProvider: provider as never });
    try {
        const boot2 = lore2.store.loreVerbatim as unknown as InstanceType<typeof SqliteVerbatimStore>;
        const resolver2 = lore2._daemon.getVerbatimResolver()!;
        const ws2 = getActiveWorkspaceName(dir2);
        await resolver2.getOrOpen(ws2);
        const acked = new Set<string>();
        const errors: string[] = [];
        const losses: string[] = [];
        let reads = 0;
        let writing = true;
        const reader = async (kind: 'list' | 'get' | 'count' | 'search'): Promise<void> => {
            while (writing) {
                const before = [...acked];
                try {
                    if (kind === 'list') { const ids = new Set(await boot2.listIds()); for (const id of before) if (!ids.has(id)) losses.push(`list lost ${id}`); }
                    else if (kind === 'get') { for (const id of before.slice(-3)) if (!(await boot2.getById(id))) losses.push(`get lost ${id}`); }
                    else if (kind === 'count') { const c = await boot2.count(); if (c < before.length) losses.push(`count ${c} < acked ${before.length}`); }
                    else { const h = await boot2.bm25Search('zebra', 100); const ids = new Set(h.hits.map((x) => x.id)); if (before.length <= 100) for (const id of before) if (!ids.has(id)) losses.push(`bm25 lost ${id}`); }
                    reads++;
                } catch (e) { errors.push(`${kind}: ${(e as Error).message}`); }
                await sleep(2);
            }
        };
        const readers = (['list', 'get', 'count', 'search'] as const).map((k) => reader(k));
        for (let i = 0; i < 30; i++) {
            const id = `race${i}`;
            await boot2.store(doc(id));
            acked.add(id);
            await sleep(5);
        }
        await waitSwapped(resolver2, ws2, boot2);
        for (let i = 30; i < 36; i++) { const id = `race${i}`; await boot2.store(doc(id)); acked.add(id); await sleep(5); }
        writing = false;
        await Promise.all(readers);
        assert.deepEqual(errors, [], 'no read errored');
        assert.deepEqual(losses, [], 'no acknowledged row went missing from a read');
        assert.ok(reads > 20, `enough concurrent reads ran (${reads})`);
        const finalIds = new Set(await boot2.listIds());
        for (const id of acked) assert.ok(finalIds.has(id), `${id} readable at the end`);

        // C. closed-store semantics unchanged: shutdown-drain order is resolver.closeAll() then boot.close()
        const opened = resolver2.openCount();
        await boot2.close();
        assert.equal(await boot2.count(), 0);
        assert.deepEqual(await boot2.listIds(), []);
        assert.deepEqual(await boot2.search('zebra', 5), []);
        assert.equal(await boot2.getById('race0'), null);
        assert.equal(resolver2.openCount(), opened, 'a closed boot ref does not ask the resolver to open anything');
    } finally { await lore2.dispose().catch(() => undefined); fs.rmSync(dir2, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- D
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-ref-reads-unit-'));
async function retiredStore(resolve: () => unknown): Promise<{ store: InstanceType<typeof SqliteVerbatimStore>; calls: { n: number } }> {
    const base = fs.mkdtempSync(path.join(dir3, 'ws-'));
    const calls = { n: 0 };
    const store = new SqliteVerbatimStore(base, provider as never, { resolveSuccessor: () => { calls.n++; return resolve() as never; } });
    await store.initialize();
    await store.store(doc('old1'));
    await store.store(doc('old2'));
    const h = await raiseWriteBarrier(base);
    assert.ok(h, 'barrier raised');
    h!.retire(); // bumps the retire generation exactly as a promotion commit does
    return { store, calls };
}
await test('retired + successor: every read method is replayed there once, with the same arguments', async () => {
    const seen: Array<[string, unknown[]]> = [];
    const fake = new Proxy({}, { get: (_t, m: string) => m === 'then' ? undefined : (...a: unknown[]) => { seen.push([m, a]); return Promise.resolve(m === 'count' ? 42 : m === 'listIds' ? ['f'] : m === 'getById' ? { text: 'fake' } : m === 'bm25Search' ? { hits: [], ranked: true } : []); } });
    const { store } = await retiredStore(() => fake);
    assert.equal(await store.count(), 42);
    assert.deepEqual(await store.listIds('p'), ['f']);
    assert.deepEqual(await store.getById('old1'), { text: 'fake' });
    await store.bm25Search('x', 3);
    await store.search('x', 3);
    assert.deepEqual(seen.map((s) => s[0]), ['count', 'listIds', 'getById', 'bm25Search', 'search']);
    assert.deepEqual(seen[1]![1], ['p', undefined]);
    await store.close();
});
await test('no bounce-back: the resolver handing back the retired store itself reads locally (old data), once', async () => {
    let self: unknown;
    const { store, calls } = await retiredStore(() => self);
    self = store;
    assert.equal(await store.count() >= 2, true);
    assert.equal(calls.n, 1, 'one resolution per read, no recursion');
    assert.equal((await store.search('zebra', 5)).length > 0, true);
    assert.equal(calls.n, 2, 'search resolved once, not once per internal hop');
    await store.close();
});
await test('no successor yet (resolver throws / returns undefined): the old store answers instead of failing', async () => {
    const t = await retiredStore(() => { throw new Error('not swapped'); });
    assert.deepEqual((await t.store.listIds()).sort(), ['old1', 'old2']);
    await t.store.close();
    const u = await retiredStore(() => undefined);
    assert.equal(await u.store.count() >= 2, true);
    await u.store.close();
});
await test('a failing replay is surfaced, never answered from the stale file', async () => {
    const { store } = await retiredStore(() => ({ count: async () => { throw new Error('lance exploded'); } }));
    await assert.rejects(store.count(), /lance exploded/);
    await store.close();
});
await test('successor closed under us (idle eviction) is re-resolved once; a second closed error surfaces', async () => {
    let n = 0;
    const closed = { count: async () => { throw new VerbatimStoreClosedError('x', 'count'); } };
    const good = { count: async () => 7 };
    const t = await retiredStore(() => (n++ === 0 ? closed : good));
    assert.equal(await t.store.count(), 7);
    await t.store.close();
    const u = await retiredStore(() => closed);
    await assert.rejects(u.store.count(), /closed store/);
    await u.store.close();
});
await test('optional methods the successor lacks: searchByVectors answers per query, findUnchangedRowIds reports nothing unchanged', async () => {
    const { store } = await retiredStore(() => ({ searchByVector: async () => [{ id: 'promoted-hit', score: 1, text: 't', metadata: {} }] }));
    const m = await store.searchByVectors([{ key: 'a', vector: vec('a') }, { key: 'b', vector: vec('b') }], { topK: 2 });
    assert.deepEqual([...m.keys()], ['a', 'b']);
    assert.equal(m.get('b')![0]!.id, 'promoted-hit');
    assert.deepEqual(await store.findUnchangedRowIds([{ id: 'old1', text: 'zebra document old1' }]), []);
    await store.close();
});
await test('not retired: no resolver call at all (hot path stays one Map lookup)', async () => {
    const base = fs.mkdtempSync(path.join(dir3, 'ws-'));
    let n = 0;
    const store = new SqliteVerbatimStore(base, provider as never, { resolveSuccessor: () => { n++; return undefined; } });
    await store.initialize();
    await store.store(doc('a1'));
    await store.count(); await store.listIds(); await store.search('zebra', 3); await store.bm25Search('zebra', 3); await store.getById('a1');
    assert.equal(n, 0);
    await store.close();
});

await lore.dispose().catch(() => undefined);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(dir3, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
