#!/usr/bin/env tsx
/**
 * Wire-up proof (Wave D d7): the daemon BOOT verbatim store (the instance server.ts / boot steps / the outbox
 * boot-fallback hold) must keep working across a background SQLite -> LanceDB promotion with no restart.
 *
 * Real path: embedded `createLore()` runs the same server.ts boot as the daemon - createVectorStore (boot store),
 * WorkspaceVerbatimResolver (primeWorkspaceVerbatimResolver pins the boot store), wireOutbox + a real replicator,
 * real SQLite engine, a real promotion triggered by LORE_VECTOR_PROMOTE_ROWS.
 *
 *   1. promote: after the swap the resolver hands out a different (promoted) store; the boot instance stays open.
 *   2. a write through the boot reference after the promotion lands in the promoted store, once.
 *   3. an outbox row replayed through the boot fallback (getVerbatim, no workspace on the row) lands there too and
 *      the outbox drains to zero.
 *   4. writes fired concurrently with the promotion (some parked at the commit) are all either rejected or on the
 *      promoted store exactly once; none exists only in the retired SQLite file.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

process.env.LORE_MODEL_SERVER = '0';
process.env.LORE_VECTOR_PROMOTE_ROWS = '6';
process.env.LORE_DEFAULT_VECTOR_ENGINE = 'sqlite';
const { createLore } = await import('../packages/lore/src/index.js');
const { recordHotWrite } = await import('../packages/lore/src/outbox/hotLane.js');
const { loadWorkspaces, getActiveWorkspaceName } = await import('../packages/lore/src/config/workspaces.js');
const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
const { SqliteVerbatimStore } = await import('../packages/lore/src/engines/sqliteVerbatimStore.js');

const dim = 8;
const vec = (t: string): number[] => {
    const v = new Array(dim).fill(0.01);
    for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) / 128;
    return v;
};
const provider = {
    dimension: dim, modelId: 'boot-resolver-det', dtype: 'fp32',
    async initialize() {}, async embed(t: string) { return vec(t); }, async embedQuery(t: string) { return vec(t); },
    async embedDocument(t: string) { return vec(t); },
    async embedDocumentBatch(ts: string[]) { return ts.map(vec); },
    dispose() {},
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Row ids in every retired verbatim*.sqlite under the workspace (read from an isolated copy). */
function retiredSqliteIds(basePath: string): { files: number; ids: string[] } {
    const found: string[] = [];
    const walk = (d: string): void => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/verbatim.*\.sqlite/.test(f.name) && !f.name.endsWith('-wal') && !f.name.endsWith('-shm')) found.push(p); } };
    walk(path.join(basePath, '.lore'));
    const ids: string[] = [];
    for (const file of found) {
        const snap = path.join(os.tmpdir(), `boot-resolver-snap-${process.pid}-${path.basename(file)}`);
        fs.copyFileSync(file, snap);
        const db = new Database(snap, { readonly: true, fileMustExist: true });
        try {
            if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verbatim'").get()) continue;
            for (const r of db.prepare('SELECT id FROM verbatim').all() as Array<{ id: string }>) ids.push(r.id);
        } finally { db.close(); fs.rmSync(snap, { force: true }); }
    }
    return { files: found.length, ids };
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-resolver-'));
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider as never });
try {
    const boot = lore.store.loreVerbatim as unknown as InstanceType<typeof SqliteVerbatimStore>;
    assert.ok(boot instanceof SqliteVerbatimStore, 'boot store is the SQLite engine');
    const resolver = lore._daemon.getVerbatimResolver()!;
    const wiring = lore._daemon.outboxWiring;
    const ws = getActiveWorkspaceName(dataDir);
    const basePath = (boot as unknown as { basePath: string }).basePath;
    const doc = (id: string) => ({ id, text: `document ${id}`, metadata: { updatedAt: '2026-10-24T00:00:00.000Z' } });

    await resolver.getOrOpen(ws); // primed boot entry
    assert.equal(await resolver.getOrOpen(ws), boot as never, 'resolver pins the boot store before promotion');

    // ---- seed + real promotion ------------------------------------------------
    for (let i = 0; i < 6; i++) await boot.store(doc(`seed${i}`)); // the 6th write triggers the promotion
    const t0 = Date.now();
    let swapped = false;
    for (;;) {
        const lanceFlag = loadWorkspaces(dataDir).workspaces.find((w) => w.name === ws)?.vectorEngine === 'lance';
        if (lanceFlag) {
            swapped = (await resolver.getOrOpen(ws, { touch: false })) !== (boot as never);
            if (swapped || Date.now() - t0 > 8_000) break; // not swapping is the bug, asserted below - do not hang on it
        } else if (Date.now() - t0 > 30_000) throw new Error('the promotion never committed');
        await sleep(25);
    }
    const promoted = (swapped ? await resolver.getOrOpen(ws) : await (async () => { const v = new VerbatimStore(basePath, provider as never); await v.initialize(); return v; })()) as unknown as InstanceType<typeof VerbatimStore>;
    const lanceIds = async (): Promise<string[]> => (await promoted.listIds()).slice().sort();

    await test('the resolver swapped to the promoted store and the boot instance was left open (not closed under its holders)', async () => {
        assert.ok(swapped, 'the resolver swapped its boot entry to the promoted store');
        assert.ok(promoted instanceof VerbatimStore, 'resolver now serves the Lance engine');
        assert.notEqual(promoted as never, boot as never);
        // a closed SqliteVerbatimStore would throw VerbatimStoreClosedError on writes; a retired one reports Retired
        const ids = await lanceIds();
        for (let i = 0; i < 6; i++) assert.ok(ids.includes(`seed${i}`), `promotion carried seed${i}`);
    });

    await test('a write through the boot reference after the promotion lands in the promoted store, exactly once', async () => {
        await boot.store(doc('post-direct'));
        assert.equal((await promoted.getById('post-direct'))?.text, 'document post-direct');
        const ids = await lanceIds();
        assert.equal(ids.filter((i) => i === 'post-direct').length, 1);
        await boot.storeBatch([doc('post-batch-a'), doc('post-batch-b')]);
        assert.ok((await promoted.getById('post-batch-b')) != null);
    });

    await test('bulkIngest through createLore after the promotion is persisted and readable from the promoted store', async () => {
        const id = 'post-ingest-0';
        const r = await lore.bulkIngest([{ id, workspace: ws, ecosystem: '*', nodeData: { id, type: 'memory', label: id, content: `body of ${id}`, project: 'default', ecosystem: '*' } }] as never, { autolink: false, embed: 'sync' });
        assert.equal(r.succeeded, 1, JSON.stringify(r.results));
        assert.equal((await lanceIds()).filter((i) => i.includes('post-ingest-0')).length >= 1, true);
    });

    await test('outbox replay for the boot workspace (resolver-routed, primed with the boot store) lands in the promoted store and the outbox drains to zero', async () => {
        const e = await recordHotWrite(wiring.store, {
            workspace: ws, operationKind: 'verbatim.upsert', operation: 'verbatim.upsert',
            payload: { id: 'lore:post-outbox', text: 'outbox write after the commit', metadata: { updatedAt: '2026-10-24T00:00:00.000Z' } },
        } as never);
        const db = (wiring.store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db;
        for (let i = 0; i < 40; i++) {
            await wiring.replicator.tickOnce();
            const v = db.prepare('SELECT status FROM outbox_entries WHERE id = ?').get(e.id) as { status: string };
            if (v.status === 'replicated') break;
            await sleep(100);
        }
        const v = db.prepare('SELECT status, attempts, deadReason FROM outbox_entries WHERE id = ?').get(e.id) as { status: string; attempts: number; deadReason: string | null };
        assert.equal(v.status, 'replicated', JSON.stringify(v));
        assert.equal(v.deadReason, null);
        assert.ok((await lanceIds()).some((i) => i.includes('post-outbox')), 'the outbox write is on the promoted store');
        const open = db.prepare("SELECT COUNT(*) AS n FROM outbox_entries WHERE status NOT IN ('replicated')").get() as { n: number };
        assert.equal(open.n, 0, 'nothing left pending/failed/dead');
    });

    await test('the retired boot instance still never writes the old SQLite file', async () => {
        const before = await lanceIds();
        const ackedBefore = before.length;
        await boot.store(doc('post-late'));
        assert.equal((await lanceIds()).length, ackedBefore + 1);
        const retired = retiredSqliteIds(basePath);
        assert.ok(retired.files > 0, 'the retired sqlite file was located');
        for (const id of retired.ids) assert.ok(!id.startsWith('post-'), `post-promotion id ${id} found in a retired file`);
    });
} catch (e) {
    failed++;
    console.error(`  FAIL setup ${(e as Error).stack ?? (e as Error).message}`);
}

// ---- writes racing the promotion (a fresh workspace dir would need another createLore; reuse the daemon: new workspace) ----
await test('writes fired concurrently with a promotion: every acknowledged write is on the promoted store exactly once', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-resolver-race-'));
    const lore2 = await createLore({ dataDir: dir2, deploymentMode: 'embedded', embeddingProvider: provider as never });
    try {
        const boot2 = lore2.store.loreVerbatim as unknown as InstanceType<typeof SqliteVerbatimStore>;
        const resolver2 = lore2._daemon.getVerbatimResolver()!;
        const acked: string[] = [];
        const rejected: string[] = [];
        const writers: Promise<void>[] = [];
        for (let i = 0; i < 40; i++) {
            const id = `race${i}`;
            writers.push((async () => {
                await sleep(i * 5);
                try { await boot2.store({ id, text: `race document ${id}`, metadata: { updatedAt: '2026-10-24T00:00:00.000Z' } }); acked.push(id); }
                catch { rejected.push(id); }
            })());
        }
        await Promise.all(writers);
        const t0 = Date.now();
        while ((await resolver2.getOrOpen(getActiveWorkspaceName(dir2), { touch: false })) === (boot2 as never)) {
            if (Date.now() - t0 > 8_000) throw new Error('the resolver never swapped its boot entry to the promoted store');
            await sleep(25);
        }
        const promoted2 = (await resolver2.getOrOpen(getActiveWorkspaceName(dir2))) as unknown as InstanceType<typeof VerbatimStore>;
        const ids = await promoted2.listIds();
        assert.deepEqual(rejected, [], 'with the boot resolver nothing is rejected');
        for (const id of acked) assert.equal(ids.filter((x) => x === id).length, 1, `${id} acknowledged but present ${ids.filter((x) => x === id).length}x on the promoted store`);
        const retiredIds = retiredSqliteIds((boot2 as unknown as { basePath: string }).basePath).ids;
        for (const id of retiredIds) assert.ok(ids.includes(id), `${id} exists only in the retired SQLite file`);
        assert.ok(acked.length > 6, `enough writes acknowledged (${acked.length}, rejected ${rejected.length})`);
    } finally { await lore2.dispose().catch(() => undefined); fs.rmSync(dir2, { recursive: true, force: true }); }
});

await lore.dispose().catch(() => undefined);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
