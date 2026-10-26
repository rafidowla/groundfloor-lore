#!/usr/bin/env tsx
/**
 * test/ingestion-blob-erase-unit.ts - the ingestion source-file eraser (lane f6a).
 *
 * Erases a workspace's uploaded files from the blob store (local folder AND the Groundfloor Files API, the latter
 * against a local fake server) using the ingestion store as the record of which blobs are the workspace's, and proves
 * that other workspaces' files - including one that shares the same stored reference - are left alone. Runs against
 * SQLite always and Postgres when LORE_PG_URL is set (otherwise a printed skip for that half).
 *
 * Run: npx tsx test/ingestion-blob-erase-unit.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsBlobStore, sha256Hex, type IBlobStore } from '../packages/lore/src/ingestion/blobStore.js';
import { GroundfloorBlobStore } from '../packages/lore/src/ingestion/groundfloorBlobStore.js';
import { createIngestionBlobEraser } from '../packages/lore/src/ingestion/ingestionBlobErase.js';
import { SqliteIngestionStore } from '../packages/lore/src/ingestion/sqliteStore.js';
import type { IIngestionStore } from '../packages/lore/src/ingestion/store.js';
import type { EraseTarget } from '../packages/lore/src/engines/workspaceErase/types.js';
import { ingestionBackends } from './helpers/ingestionBackends.js';
import { startFakeGroundfloor, FAKE_WS, FAKE_TOKEN } from './helpers/fakeGroundfloorFiles.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ing-erase-'));
const targetOf = (id: string): EraseTarget => ({ id, name: 'acme', path: '/nonexistent', mode: 'local', orgId: null });
const bytesOf = (tag: string): Buffer => Buffer.from(`file ${tag}\n`);

interface Seeded { refs: string[] }
/** Upload `n` distinct files for `ws` into `blobs` and register them as ingestion sources of `ws`. */
async function seedWs(store: IIngestionStore, blobs: IBlobStore, ws: string, blobWs: string, n: number, tag = ws): Promise<Seeded> {
    const refs: string[] = [];
    for (let i = 0; i < n; i++) {
        const b = bytesOf(`${tag}-${i}`);
        const sha = sha256Hex(b);
        const ref = await blobs.put(blobWs, sha, b);
        await store.upsertSource({ workspace: ws, fileName: `f${i}.txt`, mimeType: 'text/plain', sha256: sha, sizeBytes: b.length, storageRef: ref });
        refs.push(ref);
    }
    return { refs };
}
const allThere = async (blobs: IBlobStore, refs: string[]): Promise<boolean> => { for (const r of refs) if (!(await blobs.has!(r))) return false; return true; };
const noneThere = async (blobs: IBlobStore, refs: string[]): Promise<boolean> => { for (const r of refs) if (await blobs.has!(r)) return false; return true; };

const TARGET = '3f2a9c10-1111-4aaa-8bbb-000000000001';
const OTHER = '3f2a9c10-1111-4aaa-8bbb-00000000000';        // prefix of the target id
const OTHER2 = TARGET.toUpperCase();                         // same id, other case

// ---- SQLite store + local folder ---------------------------------------------------------------------------------------
console.log('\nFsBlobStore + SQLite ingestion store');
await test('erases the target files, keeps every other workspace file, reports counts, verifies', async () => {
    const blobs = new FsBlobStore(path.join(tmp, 'blobs1'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i1.db'));
    const mine = await seedWs(store, blobs, TARGET, 'acme', 5);
    const theirs = await seedWs(store, blobs, OTHER, 'other', 4);
    const theirs2 = await seedWs(store, blobs, OTHER2, 'OTHER', 3);
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs }).erase(targetOf(TARGET));
    assert.equal(r.store, 'blobs-fs');
    assert.equal(r.status, 'complete', JSON.stringify(r));
    assert.deepEqual(r.removed, { blobs: 5 });
    assert.deepEqual(r.remaining, { blobs: 0 });
    assert.ok(await noneThere(blobs, mine.refs));
    assert.ok(await allThere(blobs, theirs.refs) && await allThere(blobs, theirs2.refs), 'neighbour files must be untouched');
    await store.close();
});
await test('a blob another workspace still points at is kept (and said so); it is not counted as remaining', async () => {
    const blobs = new FsBlobStore(path.join(tmp, 'blobs2'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i2.db'));
    const mine = await seedWs(store, blobs, TARGET, 'acme', 3);
    // Another workspace registers a source over the SAME stored reference (same bytes, same blob dir).
    const shared = mine.refs[1]!;
    const b = bytesOf(`${TARGET}-1`);
    await store.upsertSource({ workspace: OTHER, fileName: 'shared.txt', mimeType: 'text/plain', sha256: sha256Hex(b), sizeBytes: b.length, storageRef: shared });
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs }).erase(targetOf(TARGET));
    assert.equal(r.status, 'complete', JSON.stringify(r));
    assert.deepEqual(r.removed, { blobs: 2 });
    assert.match(r.detail ?? '', /still referenced by another workspace/);
    assert.equal(await blobs.has!(shared), true, 'the shared blob must survive');
    assert.equal(await blobs.has!(mine.refs[0]!), false);
    await store.close();
});
await test('second run is a clean no-op; an empty workspace is not-applicable', async () => {
    const blobs = new FsBlobStore(path.join(tmp, 'blobs3'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i3.db'));
    await seedWs(store, blobs, TARGET, 'acme', 4);
    const e = createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs });
    await e.erase(targetOf(TARGET));
    const again = await e.erase(targetOf(TARGET));
    assert.equal(again.status, 'complete', JSON.stringify(again));
    assert.deepEqual(again.removed, {});
    const none = await e.erase(targetOf('11111111-2222-4333-8444-555555555555'));
    assert.equal(none.status, 'not-applicable');
    await store.close();
});
await test('abort part-way -> partial with an honest remaining count; resume finishes; neighbours untouched', async () => {
    const blobs = new FsBlobStore(path.join(tmp, 'blobs4'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i4.db'));
    const mine = await seedWs(store, blobs, TARGET, 'acme', 8);
    const theirs = await seedWs(store, blobs, OTHER, 'other', 3);
    const e = createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs });
    let calls = 0;
    const signal = { get aborted() { return ++calls > 6; } } as unknown as AbortSignal;
    const r1 = await e.erase(targetOf(TARGET), { signal });
    assert.equal(r1.status, 'partial', JSON.stringify(r1));
    assert.ok((r1.remaining['blobs'] ?? 0) > 0 && (r1.removed['blobs'] ?? 0) > 0, JSON.stringify(r1));
    assert.equal((r1.removed['blobs'] ?? 0) + (r1.remaining['blobs'] ?? 0), 8, 'removed + remaining accounts for every file');
    assert.ok(await allThere(blobs, theirs.refs));
    const r2 = await e.erase(targetOf(TARGET));
    assert.equal(r2.status, 'complete', JSON.stringify(r2));
    assert.ok(await noneThere(blobs, mine.refs));
    assert.ok(await allThere(blobs, theirs.refs));
    await store.close();
});
await test('a delete failure is reported as partial (retry later), never swallowed as complete', async () => {
    const real = new FsBlobStore(path.join(tmp, 'blobs5'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i5.db'));
    const mine = await seedWs(store, real, TARGET, 'acme', 3);
    let n = 0;
    const flaky: IBlobStore = { put: real.put.bind(real), get: real.get.bind(real), has: real.has!.bind(real), delete: async (ref) => { if (++n === 2) throw new Error('disk busy'); return real.delete!(ref); } };
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: flaky, store: 'blobs-fs' }).erase(targetOf(TARGET));
    assert.equal(r.status, 'partial', JSON.stringify(r));
    assert.equal(r.remaining['blobs'], 1);
    assert.match(r.detail ?? '', /could not be deleted/);
    const again = await createIngestionBlobEraser({ ingestionStore: store, blobStore: real }).erase(targetOf(TARGET));
    assert.equal(again.status, 'complete');
    assert.ok(await noneThere(real, mine.refs));
    await store.close();
});
await test('a blob store that cannot delete is unverifiable, never complete', async () => {
    const real = new FsBlobStore(path.join(tmp, 'blobs6'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i6.db'));
    await seedWs(store, real, TARGET, 'acme', 2);
    const readonly: IBlobStore = { put: real.put.bind(real), get: real.get.bind(real) };
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: readonly, store: 'blobs-fs' }).erase(targetOf(TARGET));
    assert.equal(r.status, 'unverifiable', JSON.stringify(r));
    await store.close();
});
await test('wholeStore: a dedicated per-workspace store lists every source; paging covers more than one page', async () => {
    const blobs = new FsBlobStore(path.join(tmp, 'blobs7'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i7.db'));
    const N = 1105; const refs: string[] = [];
    for (let i = 0; i < N; i++) {
        const sha = createHash('sha256').update(`p${i}`).digest('hex');
        const ref = `${'a'.repeat(16)}/${sha}`;
        refs.push(ref);
        await store.upsertSource({ workspace: 'whatever-name', fileName: 'x', mimeType: 'text/plain', sha256: sha, sizeBytes: 1, storageRef: ref });
    }
    const seen: string[] = [];
    const counting: IBlobStore = { put: blobs.put.bind(blobs), get: blobs.get.bind(blobs), has: async (r) => !seen.includes(r) && refs.includes(r), delete: async (r) => { seen.push(r); return true; } };
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: counting, store: 'blobs-fs', wholeStore: true }).erase(targetOf(TARGET));
    assert.equal(r.status, 'complete', JSON.stringify(r));
    assert.equal(r.removed['blobs'], N);
    assert.equal(new Set(seen).size, N, 'every source visited exactly once across pages');
    await store.close();
});
await test('the isRefHeldElsewhere hook protects a blob the ingestion store cannot see', async () => {
    const blobs = new FsBlobStore(path.join(tmp, 'blobs8'));
    const store = new SqliteIngestionStore(path.join(tmp, 'i8.db'));
    const mine = await seedWs(store, blobs, TARGET, 'acme', 2);
    const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs, isRefHeldElsewhere: async (ref) => ref === mine.refs[0] }).erase(targetOf(TARGET));
    assert.equal(r.removed['blobs'], 1, JSON.stringify(r));
    assert.equal(await blobs.has!(mine.refs[0]!), true);
    await store.close();
});
await test('an empty target id or empty workspace key is refused', async () => {
    const store = new SqliteIngestionStore(path.join(tmp, 'i9.db'));
    const blobs = new FsBlobStore(path.join(tmp, 'blobs9'));
    await assert.rejects(createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs }).erase(targetOf('')), /target\.id/);
    await assert.rejects(createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs, workspaceKey: () => '' }).erase(targetOf(TARGET)), /empty workspace key/);
    await store.close();
});

// ---- Groundfloor Files API (fake server) ------------------------------------------------------------------------------
console.log('\nGroundfloorBlobStore (fake Files server)');
const fake = await startFakeGroundfloor();
try {
    await test('deletes the target files on the Files API and leaves the other workspace objects alone', async () => {
        const blobs = new GroundfloorBlobStore({ baseUrl: fake.baseUrl, filesWorkspaceId: FAKE_WS, token: () => FAKE_TOKEN, sleep: async () => undefined } as never);
        const store = new SqliteIngestionStore(path.join(tmp, 'g1.db'));
        const mine = await seedWs(store, blobs, TARGET, 'acme', 3);
        const theirs = await seedWs(store, blobs, OTHER, 'other', 2);
        assert.equal(fake.objects.size, 5);
        const r = await createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs }).erase(targetOf(TARGET));
        assert.equal(r.store, 'blobs-groundfloor');
        assert.equal(r.status, 'complete', JSON.stringify(r));
        assert.deepEqual(r.removed, { blobs: 3 });
        assert.equal(fake.objects.size, 2, 'only the neighbour objects remain');
        assert.ok(await noneThere(blobs, mine.refs)); assert.ok(await allThere(blobs, theirs.refs));
        const again = await createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs }).erase(targetOf(TARGET));
        assert.equal(again.status, 'complete'); assert.deepEqual(again.removed, {});
        await store.close();
    });
} finally { await fake.close(); }

// ---- Postgres ingestion store (when available) --------------------------------------------------------------------------
console.log('\nBoth ingestion backends');
const backends = await ingestionBackends(tmp, 'ingestion-blob-erase');
try {
    for (const be of backends.list) {
        await test(`[${be.name}] erase by the store's own workspace key; a second workspace sharing one ref keeps it; neighbours untouched`, async () => {
            const blobs = new FsBlobStore(path.join(tmp, `blobs-be-${be.name}`));
            const a = await be.open();
            const b = be.name === 'postgres' ? await be.open() : { store: a.store, ws: 'w2' }; // sqlite is one file per workspace: a second workspace lives in the same store
            const mine = await seedWs(a.store, blobs, a.ws, 'acme', 4);
            const theirs = await seedWs(b.store, blobs, b.ws, 'other', 3);
            const shared = mine.refs[2]!; const sb = bytesOf(`${a.ws}-2`);
            await b.store.upsertSource({ workspace: b.ws, fileName: 's.txt', mimeType: 'text/plain', sha256: sha256Hex(sb), sizeBytes: sb.length, storageRef: shared });
            assert.equal(await a.store.countBlobRefsHeldByOtherWorkspaces(a.ws, shared), 1, 'the other workspace row is visible through the store');
            const target: EraseTarget = { id: a.ws, name: 'acme', path: '/x', mode: 'local', orgId: null };
            const r = await createIngestionBlobEraser({ ingestionStore: a.store, blobStore: blobs }).erase(target);
            assert.equal(r.status, 'complete', JSON.stringify(r));
            assert.ok(await noneThere(blobs, mine.refs.filter((x) => x !== shared)));
            assert.equal(await blobs.has!(shared), true, 'shared ref kept');
            assert.deepEqual(r.removed, { blobs: 3 });
            assert.ok(await allThere(blobs, theirs.refs));
            await a.store.close(); if (b.store !== a.store) await b.store.close();
        });
    }
} finally { await backends.dispose(); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
