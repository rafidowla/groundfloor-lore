#!/usr/bin/env tsx
/**
 * workspace-erase-host-erasers-unit.ts - lane f6c: the host-level erasers (uploaded files + Postgres rows) plugged into the lifecycle.
 *
 * No Postgres, no Dataplane, no OS keychain. Covers: the name-keyed upload guard (a live workspace with the same name -> the step
 * does nothing, and that live neighbour's files are byte-identical), the same-folder guard, links refused, an unreadable registry,
 * missing / invalid upload settings -> unverifiable (never complete), a Postgres-engine workspace on a host with no Postgres
 * connection, the Postgres wrapper (private pool, always closed), result merging, and the default lifecycle run including both steps.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { createHostBlobEraser, createHostPostgresEraser, mergeBlobResults, buildHostErasers, engineOfEntry } from '../packages/lore/src/engines/workspaceErase/hostErasers.js';
import { deleteWorkspaceWithLifecycle, resolveErasers } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import { eraseNow } from '../packages/lore/src/engines/workspaceErase/tick.js';
import { readDeletionLog } from '../packages/lore/src/config/deletedWorkspaces.js';
import { FsBlobStore, sha256Hex } from '../packages/lore/src/ingestion/blobStore.js';
import { SqliteIngestionStore } from '../packages/lore/src/ingestion/sqliteStore.js';
import type { EraseStepResult, EraseTarget } from '../packages/lore/src/engines/workspaceErase/types.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { failed++; console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); }
}
const tmpRoot = fs.mkdtempSync(path.join(process.env['F6C_TMP'] ?? os.tmpdir(), 'hosterase-'));
const mkHome = (): string => { const h = fs.mkdtempSync(path.join(tmpRoot, 'home-')); loadWorkspaces(h); return h; };
const treeHash = (dir: string): string => {
    const h = createHash('sha256');
    const walk = (d: string): void => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const st = fs.lstatSync(p); h.update(path.relative(dir, p) + (st.isDirectory() ? '/' : ':')); if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } };
    walk(dir); return h.digest('hex');
};
/** Put `n` uploaded files for workspace `name` into `<dir>/ingestion-blobs` and register them in `<dir>/ingestion.sqlite`. Returns the refs. */
async function seedUploads(dir: string, name: string, n: number, tag: string): Promise<string[]> {
    fs.mkdirSync(dir, { recursive: true });
    const blobs = new FsBlobStore(path.join(dir, 'ingestion-blobs')); const store = new SqliteIngestionStore(path.join(dir, 'ingestion.sqlite'));
    const refs: string[] = [];
    for (let i = 0; i < n; i++) {
        const b = Buffer.from(`file ${tag}-${i}\n`); const sha = sha256Hex(b); const ref = await blobs.put(name, sha, b);
        await store.upsertSource({ workspace: name, fileName: `f${i}.txt`, mimeType: 'text/plain', sha256: sha, sizeBytes: b.length, storageRef: ref });
        refs.push(ref);
    }
    await store.close();
    return refs;
}
const filesUnder = (dir: string): number => { let c = 0; const walk = (d: string): void => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else c++; } }; walk(dir); return c; };
const target = (home: string, o: Partial<EraseTarget> = {}): EraseTarget => ({ id: '3f2a9c10-1111-4aaa-8bbb-000000000001', name: 'acme', path: path.join(home, 'gone'), mode: 'local', orgId: null, holdingPath: null, engine: 'sqlite', ...o });
const ENV = {}; // no LORE_PG_URL, default (filesystem) upload storage

console.log('host erasers (lane f6c)');

await test('removes the deleted workspace uploaded files (held folder) and leaves a different-named live workspace byte-identical', async () => {
    const h = mkHome(); const live = createWorkspace('acme-2', undefined, h);
    await seedUploads(live.path, 'acme-2', 3, 'live');
    const held = path.join(h, 'workspaces', '.erase-hold-x'); const refs = await seedUploads(held, 'acme', 4, 'held');
    const before = treeHash(live.path);
    const r = await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { holdingPath: held }));
    assert.equal(r.store, 'blobs-fs'); assert.equal(r.status, 'complete', JSON.stringify(r));
    assert.equal(r.removed['blobs'], refs.length); assert.equal(r.remaining['blobs'], 0);
    assert.equal(filesUnder(path.join(held, 'ingestion-blobs')), 0);
    assert.equal(treeHash(live.path), before, 'live neighbour untouched');
});

await test('NAME GUARD (fs store): a live workspace with the same name -> the held folder (old id only) is still erased, the live one is byte-identical', async () => {
    const h = mkHome(); const live = createWorkspace('acme', undefined, h);
    await seedUploads(live.path, 'acme', 3, 'live');
    // Same content in both: identical refs, but the fs store roots each workspace's blobs in its own folder.
    const held = path.join(h, 'workspaces', '.erase-hold-x'); await seedUploads(held, 'acme', 4, 'held'); await seedUploads(held, 'acme', 1, 'live');
    const liveBefore = treeHash(live.path);
    const r = await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { holdingPath: held }));
    assert.equal(r.status, 'complete', JSON.stringify(r)); assert.equal(r.remaining['blobs'], 0);
    assert.equal(filesUnder(path.join(held, 'ingestion-blobs')), 0);
    assert.equal(treeHash(live.path), liveBefore, 'live same-named workspace untouched');
});

await test('NAME GUARD (no held folder): a live workspace with the same name -> unverifiable, nothing touched', async () => {
    const h = mkHome(); const live = createWorkspace('acme', undefined, h);
    await seedUploads(live.path, 'acme', 3, 'live'); const liveBefore = treeHash(live.path);
    const r = await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { holdingPath: null }));
    assert.equal(r.status, 'unverifiable', JSON.stringify(r)); assert.match(r.detail ?? '', /live workspace now uses this name/);
    assert.deepEqual(r.removed, {});
    assert.equal(treeHash(live.path), liveBefore);
});

await test('NAME GUARD holds for the other engine too: engine postgres + live same name never opens Postgres', async () => {
    const h = mkHome(); createWorkspace('acme', undefined, h);
    let opened = 0;
    const r = await createHostBlobEraser({ home: h, env: { LORE_PG_URL: 'postgres://unused' }, openPostgresIngestion: async () => { opened++; throw new Error('must not open'); } }).erase(target(h, { engine: 'postgres' }));
    assert.equal(r.status, 'unverifiable', JSON.stringify(r)); assert.equal(opened, 0);
});

await test('FOLDER GUARD: a live entry pointing at the same folder -> not-applicable, files stay', async () => {
    const h = mkHome(); const live = createWorkspace('other-name', undefined, h);
    const refs = await seedUploads(live.path, 'x', 2, 'live'); const before = treeHash(live.path);
    const r = await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { holdingPath: live.path }));
    assert.equal(r.status, 'not-applicable', JSON.stringify(r)); assert.match(r.detail ?? '', /same folder/);
    assert.equal(treeHash(live.path), before); assert.ok(refs.length === 2);
});

await test('a link as the upload folder is refused (unverifiable) and the target of the link is untouched', async () => {
    const h = mkHome(); const live = createWorkspace('neighbour', undefined, h); await seedUploads(live.path, 'neighbour', 2, 'nb');
    const held = path.join(h, 'workspaces', '.erase-hold-x'); await seedUploads(held, 'acme', 2, 'held');
    fs.rmSync(path.join(held, 'ingestion-blobs'), { recursive: true }); fs.symlinkSync(path.join(live.path, 'ingestion-blobs'), path.join(held, 'ingestion-blobs'));
    const before = treeHash(live.path);
    const r = await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { holdingPath: held }));
    assert.equal(r.status, 'unverifiable', JSON.stringify(r)); assert.equal(treeHash(live.path), before);
});

await test('an unreadable registry -> partial, nothing touched', async () => {
    const h = mkHome(); const held = path.join(h, 'workspaces', '.erase-hold-x'); await seedUploads(held, 'acme', 2, 'held'); const before = treeHash(held);
    fs.writeFileSync(path.join(h, 'workspaces.json'), '{ not json');
    const r = await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { holdingPath: held }));
    assert.equal(r.status, 'partial', JSON.stringify(r)); assert.equal(treeHash(held), before);
});

await test('invalid upload settings (LORE_INGEST_BLOB_STORE) -> unverifiable and the files are not deleted', async () => {
    const h = mkHome(); const held = path.join(h, 'workspaces', '.erase-hold-x'); await seedUploads(held, 'acme', 2, 'held');
    const r = await createHostBlobEraser({ home: h, env: { LORE_INGEST_BLOB_STORE: 'bogus' } }).erase(target(h, { holdingPath: held }));
    assert.equal(r.status, 'unverifiable', JSON.stringify(r)); assert.match(r.detail ?? '', /LORE_INGEST_BLOB_STORE/);
    assert.equal(filesUnder(path.join(held, 'ingestion-blobs')), 2);
});

await test('no ingestion store at all -> not-applicable (a plain workspace)', async () => {
    const h = mkHome(); const held = path.join(h, 'workspaces', '.erase-hold-x'); fs.mkdirSync(held, { recursive: true });
    const r = await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { holdingPath: held }));
    assert.equal(r.status, 'not-applicable', JSON.stringify(r));
    assert.equal((await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { holdingPath: null }))).status, 'not-applicable');
});

await test('legacy delete (holdingPath undefined): the data is still at `path`, so the files there are erased', async () => {
    const h = mkHome(); const p = path.join(h, 'workspaces', 'acme-legacy'); await seedUploads(p, 'acme', 2, 'legacy');
    const t = target(h, { path: p }); delete t.holdingPath;
    const r = await createHostBlobEraser({ home: h, env: ENV }).erase(t);
    assert.equal(r.status, 'complete', JSON.stringify(r)); assert.equal(filesUnder(path.join(p, 'ingestion-blobs')), 0);
});

await test('Postgres-engine workspace on a host with no Postgres connection: uploads and rows both unverifiable, never complete', async () => {
    const h = mkHome();
    const b = await createHostBlobEraser({ home: h, env: ENV }).erase(target(h, { engine: 'postgres' }));
    assert.equal(b.status, 'unverifiable', JSON.stringify(b));
    const p = await createHostPostgresEraser({ home: h, env: ENV }).erase(target(h, { engine: 'postgres' }));
    assert.equal(p.status, 'unverifiable', JSON.stringify(p));
    assert.equal((await createHostPostgresEraser({ home: h, env: ENV }).erase(target(h, { engine: 'sqlite' }))).status, 'not-applicable');
    assert.equal((await createHostPostgresEraser({ home: h, env: ENV }).erase(target(h, { engine: null }))).status, 'not-applicable');
});

await test('legacy record (engine unknown) on a Postgres host: uploads unverifiable, never silently complete', async () => {
    const h = mkHome();
    const r = await createHostBlobEraser({ home: h, env: { LORE_PG_URL: 'postgres://unused' } }).erase(target(h, { engine: null }));
    assert.equal(r.status, 'unverifiable', JSON.stringify(r)); assert.match(r.detail ?? '', /before its storage engine was recorded/);
});

await test('Postgres wrapper: opens a PRIVATE pool, passes the result through unchanged, always closes', async () => {
    const h = mkHome(); const calls: string[] = []; let optsSeen: unknown;
    const res: EraseStepResult = { store: 'postgres', status: 'unverifiable', removed: {}, remaining: { rows: 5 }, detail: 'counted only' };
    const e = createHostPostgresEraser({ home: h, env: { LORE_PG_URL: 'postgres://unused' }, openPostgres: async (_e, o) => { optsSeen = o; return { erase: async () => { calls.push('erase'); return res; }, close: async () => { calls.push('close'); } } as never; } });
    assert.deepEqual(await e.erase(target(h, { engine: 'postgres' })), res);
    assert.deepEqual(optsSeen, { dedicatedPool: true }); assert.deepEqual(calls, ['erase', 'close']);
    const boom = createHostPostgresEraser({ home: h, env: { LORE_PG_URL: 'postgres://unused' }, openPostgres: async () => ({ erase: async () => { throw new Error('db down'); }, close: async () => { calls.push('close2'); } }) as never });
    await assert.rejects(() => boom.erase(target(h, { engine: 'postgres' })), /db down/); assert.ok(calls.includes('close2'), 'closed even when the erase threw');
});

await test('mergeBlobResults: worst outcome wins, counts add, nothing -> not-applicable', () => {
    const r = (status: EraseStepResult['status'], removed = 0): EraseStepResult => ({ store: 'blobs-fs', status, removed: removed ? { blobs: removed } : {}, remaining: { blobs: 0 } });
    assert.equal(mergeBlobResults('blobs-fs', []).status, 'not-applicable');
    assert.equal(mergeBlobResults('blobs-fs', [r('complete', 2), r('complete', 3)]).removed['blobs'], 5);
    assert.equal(mergeBlobResults('blobs-fs', [r('complete'), r('unverifiable')]).status, 'unverifiable');
    assert.equal(mergeBlobResults('blobs-fs', [r('unverifiable'), r('partial')]).status, 'partial');
    assert.equal(mergeBlobResults('blobs-fs', [r('not-applicable'), r('not-applicable')]).status, 'not-applicable');
    assert.equal(mergeBlobResults('blobs-fs', [r('not-applicable'), r('complete', 1)]).status, 'complete');
});

await test('engineOfEntry: unknown for no entry; default engine when the entry declares none', () => {
    assert.equal(engineOfEntry(undefined), null); assert.equal(engineOfEntry({ graphEngine: 'postgres' }), 'postgres');
    assert.equal(typeof engineOfEntry({}), 'string');
});

await test('the default lifecycle run includes both steps; a caller-supplied eraser for the same store replaces ours', async () => {
    const h = mkHome();
    const stores = resolveErasers({ home: h, env: {}, eraserFactory: { keyringEnabled: false } }).map((e) => e.store);
    assert.ok(stores.includes('blobs-fs') && stores.includes('postgres'), stores.join(','));
    assert.ok(stores.indexOf('blobs-fs') < stores.indexOf('postgres') && stores.indexOf('postgres') < stores.indexOf('local-dir'), `order: ${stores.join(',')}`);
    const fake = { store: 'postgres', erase: async () => ({ store: 'postgres', status: 'complete' as const, removed: {}, remaining: {} }) };
    const withFake = resolveErasers({ home: h, env: {}, eraserFactory: { keyringEnabled: false }, extraErasers: [fake] });
    assert.equal(withFake.filter((e) => e.store === 'postgres').length, 1); assert.ok(withFake.includes(fake));
    assert.equal(buildHostErasers({ home: h, env: {} }).length, 2);
});

await test('full lifecycle, same name reused: erase-now of the OLD record leaves the NEW same-named workspace and its uploads byte-identical; receipt complete', async () => {
    const h = mkHome(); const base = { home: h, env: {}, eraserFactory: { keyringEnabled: false } };
    const old = createWorkspace('acme', undefined, h); await seedUploads(old.path, 'acme', 3, 'old');
    const del = await deleteWorkspaceWithLifecycle('acme', {}, base);
    const fresh = createWorkspace('acme', undefined, h); await seedUploads(fresh.path, 'acme', 2, 'new');
    const freshBefore = treeHash(fresh.path);
    const out = await eraseNow(del.id, base);
    assert.ok(out, 'erased');
    const rec = readDeletionLog(h).byId.get(del.id)!;
    const steps = rec.completedErase!.stores;
    assert.equal(rec.completedErase!.status, 'complete', JSON.stringify(steps));
    assert.equal(steps.find((s) => s.store === 'blobs-fs')?.status, 'complete', 'old uploads in the id-derived held folder are erased even though the name is live again');
    assert.equal(steps.find((s) => s.store === 'local-dir')?.status, 'complete', JSON.stringify(steps));
    assert.ok(del.holdingPath && !fs.existsSync(del.holdingPath), 'the OLD held folder is gone');
    assert.equal(treeHash(fresh.path), freshBefore, 'new same-named workspace untouched');
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nworkspace-erase-host-erasers: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
