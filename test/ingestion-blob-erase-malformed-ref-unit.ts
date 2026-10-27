#!/usr/bin/env tsx
/**
 * test/ingestion-blob-erase-malformed-ref-unit.ts - a malformed `storage_ref` must not stall a workspace erase.
 *
 * Found in 3.37.x upgrade testing: one source row whose `storage_ref` the blob store cannot even parse made the
 * store's has()/delete() throw, the eraser counted that as a failed blob -> `partial`, and the lifecycle stops at a
 * `partial` step BEFORE the row-erase steps, so the workspace could never finish erasing. Contract under test:
 *   - a ref the store cannot parse as one of its own refs names no blob it holds: not a failure, noted, rows get erased;
 *   - path-traversal / absolute refs are malformed: never touched on disk;
 *   - a real I/O failure on a WELL-FORMED ref is still `failed` -> `partial` and still blocks row deletion;
 *   - a store that does not classify refs (no isValidRef) keeps the old behaviour (a throw is a failure).
 * Runs against SQLite always and Postgres when LORE_PG_URL is set (printed skip for that half).
 *
 * Run: npx tsx test/ingestion-blob-erase-malformed-ref-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsBlobStore, sha256Hex, type IBlobStore } from '../packages/lore/src/ingestion/blobStore.js';
import { GroundfloorBlobStore } from '../packages/lore/src/ingestion/groundfloorBlobStore.js';
import { createIngestionBlobEraser } from '../packages/lore/src/ingestion/ingestionBlobErase.js';
import { SqliteIngestionStore } from '../packages/lore/src/ingestion/sqliteStore.js';
import { PostgresIngestionStore } from '../packages/lore/src/engines/postgres/postgresIngestionStore.js';
import { INGEST_TABLES } from '../packages/lore/src/engines/postgres/postgresIngestionSchema.js';
import { createPostgresWorkspaceEraser } from '../packages/lore/src/engines/postgres/postgresWorkspaceErase.js';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { deleteWorkspaceWithLifecycle, runErase, type LifecycleDeps } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import type { EraseStepResult, EraseTarget, WorkspaceEraser } from '../packages/lore/src/engines/workspaceErase/types.js';
import type { IIngestionStore } from '../packages/lore/src/ingestion/store.js';
import { ingestionBackends } from './helpers/ingestionBackends.js';
import { startFakeGroundfloor, FAKE_WS, FAKE_TOKEN } from './helpers/fakeGroundfloorFiles.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ing-erase-malformed-'));
const bytesOf = (tag: string): Buffer => Buffer.from(`file ${tag}\n`);
const targetOf = (id: string): EraseTarget => ({ id, name: 'acme', path: '/nonexistent', mode: 'local', orgId: null });
const SECRET = 'TOPSECRET-ref-marker';

let seq = 0;
/** Register a source whose storage_ref is exactly `ref` (no blob behind it). Each call gets distinct bytes so it is its own source. */
async function addSource(store: IIngestionStore, ws: string, ref: string): Promise<void> {
    const b = bytesOf(`src-${++seq}`);
    await store.upsertSource({ workspace: ws, fileName: `f${seq}.txt`, mimeType: 'text/plain', sha256: sha256Hex(b), sizeBytes: b.length, storageRef: ref });
}
async function addBlob(store: IIngestionStore, blobs: IBlobStore, ws: string): Promise<string> {
    const b = bytesOf(`blob-${++seq}`);
    const sha = sha256Hex(b);
    const ref = await blobs.put('acme', sha, b);
    await store.upsertSource({ workspace: ws, fileName: `b${seq}.txt`, mimeType: 'text/plain', sha256: sha, sizeBytes: b.length, storageRef: ref });
    return ref;
}
const sourceCount = async (store: IIngestionStore, key: string | null): Promise<number> => (await store.listSourceBlobRefs(key, 1000)).length;

// A file OUTSIDE the blob root that a traversal / absolute ref would hit if the store ever turned it into a path.
const outside = path.join(tmp, 'outside-secret.txt');
fs.writeFileSync(outside, 'must survive');
const MALFORMED = ['ref-shared-content', 'gf1:short', '', '   ', `${SECRET}/nested`, '../outside-secret.txt', '../../etc/passwd', outside, `0123456789abcdef/../../${path.basename(outside)}`, '0123456789abcdef/' + 'g'.repeat(64)];

console.log('\nFsBlobStore classifies its own refs');
await test('isValidRef accepts only <16 hex>/<64 hex>; traversal, absolute and garbage are malformed', async () => {
    const fsb = new FsBlobStore(path.join(tmp, 'cls'));
    const good = await fsb.put('acme', sha256Hex(bytesOf('x')), bytesOf('x'));
    assert.equal(fsb.isValidRef(good), true);
    for (const m of MALFORMED) assert.equal(fsb.isValidRef(m), false, `should be malformed: ${JSON.stringify(m)}`);
});
await test('GroundfloorBlobStore classifies gf1:<id>:<sha> refs', async () => {
    const gf = new GroundfloorBlobStore({ baseUrl: 'http://127.0.0.1:9', filesWorkspaceId: FAKE_WS, token: () => FAKE_TOKEN } as never);
    assert.equal(gf.isValidRef(`gf1:file_1-A:${'a'.repeat(64)}`), true);
    for (const m of [...MALFORMED, `gf1:../x:${'a'.repeat(64)}`, `gf2:abc:${'a'.repeat(64)}`]) assert.equal(gf.isValidRef(m), false, `should be malformed: ${JSON.stringify(m)}`);
});

console.log('\nBlob eraser: malformed refs (SQLite + local folder)');
await test('malformed refs are not failures: valid blobs still deleted, status complete, count noted, raw ref not leaked', async () => {
    const root = path.join(tmp, 'b1');
    const blobs = new FsBlobStore(root);
    const store = new SqliteIngestionStore(path.join(tmp, 'i1.db'));
    const refs = [await addBlob(store, blobs, 'ws1'), await addBlob(store, blobs, 'ws1')];
    for (const m of MALFORMED) await addSource(store, 'ws1', m);
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs }).erase(targetOf('ws1'));
    assert.equal(r.status, 'complete', JSON.stringify(r));
    assert.deepEqual(r.removed, { blobs: 2 });
    assert.deepEqual(r.remaining, { blobs: 0 });
    assert.match(r.detail ?? '', new RegExp(`${MALFORMED.length} source\\(s\\) had an unreadable storage reference`));
    assert.ok(!(r.detail ?? '').includes(SECRET), 'the raw ref must not appear in the note');
    for (const ref of refs) assert.equal(await blobs.has(ref), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'must survive', 'a traversal ref must never touch a file outside the blob root');
    await store.close();
});
await test('only malformed refs: complete (nothing could exist), not partial and not not-applicable', async () => {
    const blobs = new FsBlobStore(path.join(tmp, 'b2'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i2.db'));
    await addSource(store, 'ws1', 'ref-shared-content');
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs }).erase(targetOf('ws1'));
    assert.equal(r.status, 'complete', JSON.stringify(r));
    assert.match(r.detail ?? '', /1 source\(s\) had an unreadable storage reference/);
    await store.close();
});
await test('traversal / absolute refs never reach the disk: has/delete are not even called for them', async () => {
    const real = new FsBlobStore(path.join(tmp, 'b3'));
    const calls: string[] = [];
    const spy: IBlobStore = {
        put: real.put.bind(real), get: real.get.bind(real), isValidRef: real.isValidRef.bind(real),
        has: async (r) => { calls.push(`has:${r}`); return real.has(r); }, delete: async (r) => { calls.push(`delete:${r}`); return real.delete(r); },
    };
    const store = new SqliteIngestionStore(path.join(tmp, 'i3.db'));
    for (const m of MALFORMED) await addSource(store, 'ws1', m);
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: spy }).erase(targetOf('ws1'));
    assert.equal(r.status, 'complete', JSON.stringify(r));
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'must survive');
    await store.close();
});
await test('a real delete failure on a well-formed ref is still partial, even next to malformed refs', async () => {
    const real = new FsBlobStore(path.join(tmp, 'b4'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i4.db'));
    const ok = await addBlob(store, real, 'ws1');
    const bad = await addBlob(store, real, 'ws1');
    await addSource(store, 'ws1', 'ref-shared-content');
    const flaky: IBlobStore = { put: real.put.bind(real), get: real.get.bind(real), isValidRef: real.isValidRef.bind(real), has: real.has.bind(real), delete: async (r) => { if (r === bad) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return real.delete(r); } };
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: flaky }).erase(targetOf('ws1'));
    assert.equal(r.status, 'partial', JSON.stringify(r));
    assert.equal(r.remaining['blobs'], 1);
    assert.match(r.detail ?? '', /could not be deleted/);
    assert.match(r.detail ?? '', /1 source\(s\) had an unreadable storage reference/);
    assert.equal(await real.has(ok), false);
    assert.equal(await real.has(bad), true);
    await store.close();
});
await test('a well-formed ref whose has() fails with a permission error is a failure, not "malformed"', async () => {
    const real = new FsBlobStore(path.join(tmp, 'b5'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i5.db'));
    await addBlob(store, real, 'ws1');
    const denied: IBlobStore = { put: real.put.bind(real), get: real.get.bind(real), isValidRef: real.isValidRef.bind(real), has: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, delete: real.delete.bind(real) };
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: denied }).erase(targetOf('ws1'));
    assert.equal(r.status, 'partial', JSON.stringify(r));
    await store.close();
});
await test('a store that does not classify refs keeps the old behaviour: a throw is a failure -> partial', async () => {
    const real = new FsBlobStore(path.join(tmp, 'b6'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i6.db'));
    await addSource(store, 'ws1', 'ref-shared-content');
    const legacy: IBlobStore = { put: real.put.bind(real), get: real.get.bind(real), has: real.has.bind(real), delete: real.delete.bind(real) };
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: legacy }).erase(targetOf('ws1'));
    assert.equal(r.status, 'partial', JSON.stringify(r));
    await store.close();
});

console.log('\nBlob eraser: malformed refs (Groundfloor Files, fake server)');
const fake = await startFakeGroundfloor();
try {
    await test('a malformed gf ref is skipped without any Files API call; well-formed blobs still deleted', async () => {
        const blobs = new GroundfloorBlobStore({ baseUrl: fake.baseUrl, filesWorkspaceId: FAKE_WS, token: () => FAKE_TOKEN, sleep: async () => undefined } as never);
        const store = new SqliteIngestionStore(path.join(tmp, 'g1.db'));
        await addBlob(store, blobs, 'ws1');
        for (const m of ['gf1:short', `gf1:../x:${'a'.repeat(64)}`, 'ref-shared-content']) await addSource(store, 'ws1', m);
        const deletesBefore = fake.calls('delete');
        const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs }).erase(targetOf('ws1'));
        assert.equal(r.store, 'blobs-groundfloor');
        assert.equal(r.status, 'complete', JSON.stringify(r));
        assert.deepEqual(r.removed, { blobs: 1 });
        assert.equal(fake.calls('delete') - deletesBefore, 1, 'only the well-formed ref reaches the Files API');
        assert.match(r.detail ?? '', /3 source\(s\) had an unreadable storage reference/);
        await store.close();
    });
} finally { await fake.close(); }

// ---- whole lifecycle: the erase must go on to delete rows --------------------------------------------------------------
console.log('\nLifecycle: a malformed ref no longer stops the row erase');
const backends = await ingestionBackends(tmp, 'ingestion-blob-erase-malformed');
const lifeIds: string[] = [];
try {
    for (const be of backends.list) {
        const rowsStub = (): { eraser: WorkspaceEraser; calls: number[] } => {
            const calls: number[] = [];
            const eraser: WorkspaceEraser = { store: 'zz-rows', erase: async (): Promise<EraseStepResult> => { calls.push(1); return { store: 'zz-rows', status: 'complete', removed: { rows: 1 }, remaining: {} }; } };
            return { eraser, calls };
        };
        const rig = async (): Promise<{ h: string; id: string; deps: (erasers: WorkspaceEraser[]) => LifecycleDeps; open: () => Promise<IIngestionStore> }> => {
            const h = fs.mkdtempSync(path.join(tmp, 'home-'));
            loadWorkspaces(h);
            createWorkspace('acme', undefined, h);
            const deps = (erasers: WorkspaceEraser[]): LifecycleDeps => ({ home: h, now: () => new Date('2026-11-01T00:00:00Z'), env: {}, eraserFactory: { keyringEnabled: false }, lock: { staleMs: 60_000, heartbeatMs: 5_000 }, erasers });
            const sched = await deleteWorkspaceWithLifecycle('acme', {}, deps([]));
            lifeIds.push(sched.id);
            const sqliteFile = path.join(tmp, `life-${sched.id}.db`);
            const open = async (): Promise<IIngestionStore> => be.name === 'postgres' ? PostgresIngestionStore.open(sched.id, backends.pool!) : new SqliteIngestionStore(sqliteFile);
            return { h, id: sched.id, deps, open };
        };
        const rowsLeft = async (id: string): Promise<number> => {
            if (be.name === 'postgres') return Number((await backends.pool!.query(`SELECT count(*)::text n FROM ${INGEST_TABLES.sources} WHERE workspace_id = $1`, [id])).rows[0].n);
            const s = new SqliteIngestionStore(path.join(tmp, `life-${id}.db`));
            try { return await sourceCount(s, id); } finally { await s.close(); }
        };
        const realRows = (): { eraser: WorkspaceEraser; calls: number[] } => {
            if (be.name !== 'postgres') return rowsStub();
            const pg = createPostgresWorkspaceEraser({ pool: backends.pool!, rowsKeyedBy: 'permanent-id', vacuum: false });
            const calls: number[] = [];
            return { calls, eraser: { store: 'postgres', erase: async (t, o) => { calls.push(1); return pg.erase(t, o); } } };
        };

        await test(`[${be.name}] one malformed ref + valid blobs: erase completes and the rows are erased`, async () => {
            const { id, deps, open } = await rig();
            const blobs = new FsBlobStore(path.join(tmp, `life-blobs-${be.name}-1`));
            const store = await open();
            const ref = await addBlob(store, blobs, id);
            await addSource(store, id, 'ref-shared-content');
            await addSource(store, id, '../outside-secret.txt');
            assert.equal(await sourceCount(store, id), 3);
            await store.close();
            const rows = realRows();
            const out = await runErase(id, deps([createIngestionBlobEraser({ ingestionStore: await open(), blobStore: blobs, store: 'blobs-fs' }), rows.eraser]), { manual: true });
            assert.equal(out.kind, 'complete', JSON.stringify(out));
            assert.equal(rows.calls.length, 1, 'the row-erase step must run');
            assert.equal(await rowsLeft(id), be.name === 'postgres' ? 0 : 3 /* sqlite rows live in the workspace folder, removed by the local-dir step (stubbed here) */);
            assert.equal(await blobs.has(ref), false);
            assert.equal(fs.readFileSync(outside, 'utf8'), 'must survive');
        });
        await test(`[${be.name}] a real I/O failure on a well-formed ref still ends partial and the rows are NOT erased`, async () => {
            const { id, deps, open } = await rig();
            const real = new FsBlobStore(path.join(tmp, `life-blobs-${be.name}-2`));
            const store = await open();
            const bad = await addBlob(store, real, id);
            await addSource(store, id, 'ref-shared-content');
            const denied: IBlobStore = { put: real.put.bind(real), get: real.get.bind(real), isValidRef: real.isValidRef.bind(real), has: real.has.bind(real), delete: async (r) => { if (r === bad) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return real.delete(r); } };
            const rows = realRows();
            const out = await runErase(id, deps([createIngestionBlobEraser({ ingestionStore: store, blobStore: denied, store: 'blobs-fs' }), rows.eraser]), { manual: true });
            assert.equal(out.kind, 'partial', JSON.stringify(out));
            assert.equal(rows.calls.length, 0, 'rows are the only record of which blobs belong to the workspace: keep them');
            assert.equal(await sourceCount(store, id), 2);
            assert.equal(await real.has(bad), true);
            await store.close();
        });
    }
} finally {
    if (backends.pool && lifeIds.length > 0) {
        try { for (const t of Object.values(INGEST_TABLES)) await backends.pool.query(`DELETE FROM ${t} WHERE workspace_id = ANY($1)`, [lifeIds]); } catch { /* best effort */ }
    }
    await backends.dispose();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
