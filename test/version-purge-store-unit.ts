#!/usr/bin/env tsx
/**
 * version-purge-store-unit.ts — VersionStore.purgeNodes / purgeWorkspace and the workspace-erase `versions` eraser.
 *
 * Pinned:
 *   - purgeNodes removes node_versions and the matching buffered changeset writes for the given node ids in ONE
 *     workspace; other nodes, the same id in another workspace and unrelated writes survive; write_count follows;
 *   - both calls are idempotent (second call deletes nothing) and accept an empty list;
 *   - purgeWorkspace removes every version row, changeset and write of that workspace only;
 *   - the eraser, through the real delete -> erase lifecycle with two workspaces, empties only the deleted
 *     workspace's rows (receipt: status complete, counts), leaves the neighbour byte-for-byte, never creates a
 *     versions.sqlite, and removes only history no newer than the deletion when a live workspace re-uses the name (`unverifiable` without a deletion time).
 *
 * Run: npx tsx test/version-purge-store-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { readDeletionLog } from '../packages/lore/src/config/deletedWorkspaces.js';
import { deleteWorkspaceWithLifecycle, type LifecycleDeps } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import { eraseNow } from '../packages/lore/src/engines/workspaceErase/tick.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const tmps: string[] = [];
const mk = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-store-')); tmps.push(d); return d; };

let seq = 0;
function addVersion(vs: VersionStore, ws: string, nodeId: string, changesetId: string | null = null): void {
    vs.recordVersion({ versionId: `v${++seq}`, nodeId, workspace: ws, timestamp: new Date(1_700_000_000_000 + seq).toISOString(), principal: 'p', operation: 'update', previousState: { content: 'old secret' }, newState: { content: 'new secret' }, changesetId });
}
function seed(vs: VersionStore): { csA: string; csB: string } {
    for (const ws of ['wa', 'wb']) for (const n of ['n1', 'n2']) { addVersion(vs, ws, n); addVersion(vs, ws, n); }
    const csA = vs.createChangeset('wa'); const csB = vs.createChangeset('wb');
    vs.addChangesetWrite(csA, 'node.upsert', { nodeData: { id: 'n1', content: 'secret' } });
    vs.addChangesetWrite(csA, 'node.upsert', { nodeData: { id: 'n2', content: 'other' } });
    vs.addChangesetWrite(csB, 'node.upsert', { nodeData: { id: 'n1', content: 'secret' } });
    return { csA, csB };
}

console.log('VersionStore purge');
try {
    await test('purgeNodes: only that node in that workspace; idempotent; empty list is a no-op', () => {
        const vs = VersionStore.open(mk());
        try {
            const { csA, csB } = seed(vs);
            const n2a = JSON.stringify(vs.getVersions('n2', 'wa')); const n1b = JSON.stringify(vs.getVersions('n1', 'wb'));
            assert.deepEqual(vs.purgeNodes([], 'wa'), { versions: 0, changesetWrites: 0, changesets: 0 });
            const c = vs.purgeNodes(['n1'], 'wa');
            assert.equal(c.versions, 2); assert.equal(c.changesetWrites, 1);
            assert.deepEqual(vs.getVersions('n1', 'wa'), []);
            assert.equal(JSON.stringify(vs.getVersions('n2', 'wa')), n2a);
            assert.equal(JSON.stringify(vs.getVersions('n1', 'wb')), n1b, 'same id in another workspace survives');
            assert.equal(vs.getChangesetWrites(csA).length, 1); assert.equal(vs.getChangesetWrites(csB).length, 1);
            assert.equal(vs.getChangeset(csA)!.writeCount, 1);
            assert.deepEqual(vs.purgeNodes(['n1'], 'wa'), { versions: 0, changesetWrites: 0, changesets: 0 });
        } finally { vs.close(); }
    });

    await test('time bound: rows no newer than upTo go (inclusive tie), newer rows and changesets survive', () => {
        const vs = VersionStore.open(mk());
        try {
            const at = (ms: number): string => new Date(ms).toISOString();
            const rec = (id: string, ms: number): void => vs.recordVersion({ versionId: id + ms, nodeId: id, workspace: 'wa', timestamp: at(ms), principal: 'p', operation: 'update', previousState: null, newState: { c: 1 }, changesetId: null });
            rec('n1', 1000); rec('n1', 2000); rec('n1', 2001); rec('n2', 1000);
            assert.equal(vs.purgeNodes(['n1'], 'wa', at(2000)).versions, 2, '1000 and the same-millisecond 2000 are removed');
            assert.deepEqual(vs.getVersions('n1', 'wa').map((v) => v.timestamp), [at(2001)], 'the version one millisecond later survives');
            assert.equal(vs.getVersions('n2', 'wa').length, 1);
            assert.equal(vs.purgeNodes(['n1'], 'wa', 'not-a-date').versions, 1, 'an unparseable bound means unbounded, never a silent no-op');
            // changesets: bounded by created_at
            const cs = vs.createChangeset('wa');
            vs.addChangesetWrite(cs, 'node.upsert', { nodeData: { id: 'n3' } });
            assert.equal(vs.purgeNodes(['n3'], 'wa', at(1)).changesetWrites, 0, 'a changeset created after the bound is kept');
            assert.equal(vs.purgeNodes(['n3'], 'wa', at(Date.now() + 60_000)).changesetWrites, 1);
            const cs2 = vs.createChangeset('wa');
            assert.deepEqual(vs.purgeWorkspace('wa', at(1)), { versions: 0, changesetWrites: 0, changesets: 0 }, 'bounded erase before everything removes nothing');
            assert.ok(vs.getChangeset(cs2));
            assert.equal(vs.purgeWorkspace('wa', at(Date.now() + 60_000)).versions, 1);
        } finally { vs.close(); }
    });

    await test('purgeNodes handles more ids than one chunk', () => {
        const vs = VersionStore.open(mk());
        try {
            const ids = Array.from({ length: 1000 }, (_, i) => `bulk-${i}`);
            for (const id of ids) addVersion(vs, 'wa', id);
            addVersion(vs, 'wa', 'survivor');
            assert.equal(vs.purgeNodes(ids, 'wa').versions, 1000);
            assert.equal(vs.getVersions('survivor', 'wa').length, 1);
        } finally { vs.close(); }
    });

    await test('purgeWorkspace: every row of that workspace, none of the other; idempotent', () => {
        const vs = VersionStore.open(mk());
        try {
            const { csA, csB } = seed(vs);
            const wb = JSON.stringify([vs.getVersions('n1', 'wb'), vs.getVersions('n2', 'wb')]);
            const c = vs.purgeWorkspace('wa');
            assert.equal(c.versions, 4); assert.equal(c.changesetWrites, 2); assert.equal(c.changesets, 1);
            assert.deepEqual(vs.getVersions('n1', 'wa'), []); assert.deepEqual(vs.getVersions('n2', 'wa'), []);
            assert.equal(vs.getChangeset(csA), null); assert.equal(vs.getChangesetWrites(csA).length, 0);
            assert.equal(JSON.stringify([vs.getVersions('n1', 'wb'), vs.getVersions('n2', 'wb')]), wb);
            assert.equal(vs.getChangesetWrites(csB).length, 1);
            assert.deepEqual(vs.purgeWorkspace('wa'), { versions: 0, changesetWrites: 0, changesets: 0 });
        } finally { vs.close(); }
    });
} finally { /* tmp dirs removed below */ }

console.log('workspace erase: versions eraser');
const base = (home: string): LifecycleDeps => ({ home, env: {}, eraserFactory: { keyringEnabled: false }, lock: { staleMs: 60_000, heartbeatMs: 5_000 } });
const loreDirOf = (h: string): string => path.join(loadWorkspaces(h).workspaces[0]!.path, '.lore');
const openVs = (h: string): VersionStore => { fs.mkdirSync(loreDirOf(h), { recursive: true }); return VersionStore.open(loreDirOf(h)); };
const mkHome = (): string => { const h = mk(); loadWorkspaces(h); return h; };
try {
    await test('delete -> erase empties only the deleted workspace; neighbour untouched; receipt complete', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('gone', undefined, h); createWorkspace('keep', undefined, h);
        const vs = openVs(h);
        try { for (const ws of ['gone', 'keep']) for (const n of ['n1', 'n2']) addVersion(vs, ws, n); } finally { vs.close(); }
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        const after = openVs(h);
        try {
            assert.deepEqual([after.getVersions('n1', 'gone'), after.getVersions('n2', 'gone')], [[], []]);
            assert.equal(after.getVersions('n1', 'keep').length, 1); assert.equal(after.getVersions('n2', 'keep').length, 1);
        } finally { after.close(); }
        const step = readDeletionLog(h).byId.get(r.id)!.completedErase!.stores.find((s) => s.store === 'versions')!;
        assert.equal(step.status, 'complete'); assert.equal(step.removed['rows'], 2);
    });

    await test('a live workspace re-using the name: old history is erased, the new workspace keeps its own', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('gone', undefined, h);
        const vs = openVs(h);
        try { addVersion(vs, 'gone', 'old'); } finally { vs.close(); }
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        await new Promise((x) => setTimeout(x, 5));
        createWorkspace('gone', undefined, h);
        const vs2 = openVs(h);
        try { vs2.recordVersion({ versionId: 'new-1', nodeId: 'fresh', workspace: 'gone', timestamp: new Date().toISOString(), principal: 'p', operation: 'update', previousState: null, newState: { content: 'new ws' }, changesetId: null }); } finally { vs2.close(); }
        assert.equal((await eraseNow(r.id, d)).kind, 'complete');
        assert.equal(readDeletionLog(h).byId.get(r.id)!.completedErase!.stores.find((s) => s.store === 'versions')!.status, 'complete');
        const after = openVs(h);
        try {
            assert.deepEqual(after.getVersions('old', 'gone'), [], 'the deleted workspace\'s content is no longer readable under the new one');
            assert.equal(after.getVersions('fresh', 'gone').length, 1, 'the new workspace keeps its history');
        } finally { after.close(); }
    });

    await test('name re-used and no usable deletion time: unverifiable (never complete), nothing touched', async () => {
        const { createVersionsEraser } = await import('../packages/lore/src/engines/workspaceErase/versionsEraser.js');
        const h = mkHome();
        createWorkspace('same', undefined, h);
        const vs = openVs(h);
        try { addVersion(vs, 'same', 'n1'); } finally { vs.close(); }
        const res = await createVersionsEraser({ home: h }).erase({ id: 'old-id', name: 'same', path: '', mode: null, orgId: null });
        assert.equal(res.status, 'unverifiable');
        const after = openVs(h);
        try { assert.equal(after.getVersions('n1', 'same').length, 1); } finally { after.close(); }
    });

    await test('no versions.sqlite: not-applicable and none is created', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('solo', undefined, h);
        const r = await deleteWorkspaceWithLifecycle('solo', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        assert.equal(readDeletionLog(h).byId.get(r.id)!.completedErase!.stores.find((s) => s.store === 'versions')!.status, 'not-applicable');
        assert.ok(!fs.existsSync(path.join(loreDirOf(h), 'versions.sqlite')));
    });
} finally {
    for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
