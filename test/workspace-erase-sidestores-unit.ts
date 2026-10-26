#!/usr/bin/env tsx
/**
 * workspace-erase-sidestores-unit.ts — lane f6b: the NAME-keyed side stores erased with a workspace.
 *
 * The replication queue (`outbox.sqlite` in the ACTIVE workspace's `.lore`, rows tagged with the workspace name)
 * and `workspace-paths.json` (name -> project folders) hold a deleted workspace's traces outside its own folder.
 * Proves: they are cleaned through the real delete -> erase path, a similarly named / content-sharing neighbour is
 * untouched row-for-row and byte-for-byte, a live workspace re-using the name keeps its rows and mapping, and an
 * unreadable mapping file is never overwritten.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { readDeletionLog } from '../packages/lore/src/config/deletedWorkspaces.js';
import { deleteWorkspaceWithLifecycle, type LifecycleDeps } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import { eraseNow } from '../packages/lore/src/engines/workspaceErase/tick.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const homes: string[] = [];
const mkHome = (): string => { const h = fs.mkdtempSync(path.join(process.env['F6B_TMP'] ?? os.tmpdir(), 'ss-')); homes.push(h); loadWorkspaces(h); return h; };
const base = (home: string): LifecycleDeps => ({ home, env: {}, eraserFactory: { keyringEnabled: false }, lock: { staleMs: 60_000, heartbeatMs: 5_000 } });
const outboxDir = (h: string): string => path.join(loadWorkspaces(h).workspaces[0]!.path, '.lore');

async function seedOutbox(h: string, perWs: Record<string, number>): Promise<void> {
    const s = new SqliteOutboxStore(outboxDir(h));
    try {
        for (const [ws, n] of Object.entries(perWs)) {
            for (let i = 0; i < n; i++) await recordHotWrite(s, { workspace: ws, operationKind: 'node.upsert', payload: { id: `${ws}-n${i}` } });
            await s.writeReplicationState(ws, { lastReplicatedSeq: 1, updatedAt: new Date().toISOString() });
        }
    } finally { s.close(); }
}
async function outboxRows(h: string): Promise<Record<string, string[]>> {
    const s = new SqliteOutboxStore(outboxDir(h));
    try {
        const out: Record<string, string[]> = {};
        for (const e of await s.listUnfinished()) (out[e.workspace!] ??= []).push(e.id);
        for (const k of Object.keys(out)) out[k]!.sort();
        const state: Record<string, unknown> = {};
        for (const ws of Object.keys(perWsAll)) state[ws] = await s.readReplicationState(ws);
        return { ...out, __state: [JSON.stringify(state)] };
    } finally { s.close(); }
}
const perWsAll: Record<string, number> = { gone: 3, 'gone-2': 2, 'x-gone': 2, keep: 4 };
const pathsFile = (h: string): string => path.join(h, 'workspace-paths.json');
const projects = { gone: { ecosystem: 'node', paths: ['/p/gone'] }, 'gone-2': { ecosystem: 'node', paths: ['/p/gone-2'] }, keep: { ecosystem: 'py', paths: ['/p/keep'] } };

console.log('workspace erase: name-keyed side stores');
try {
    await test('delete -> erase removes only the deleted name from the outbox and workspace-paths; neighbours identical', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('gone', undefined, h); createWorkspace('gone-2', undefined, h); createWorkspace('keep', undefined, h);
        await seedOutbox(h, perWsAll);
        fs.writeFileSync(pathsFile(h), JSON.stringify({ projects }, null, 4) + '\n');
        const before = await outboxRows(h);
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        const after = await outboxRows(h);
        assert.equal(after['gone'], undefined, 'deleted name has no queue rows left');
        assert.deepEqual(after['gone-2'], before['gone-2']); assert.deepEqual(after['x-gone'], before['x-gone']); assert.deepEqual(after['keep'], before['keep']);
        const st = JSON.parse(String(after['__state'])) as Record<string, { lastReplicatedSeq: number } | undefined>;
        assert.deepEqual(JSON.parse(String(before['__state'])).keep, st['keep'], 'neighbour replication cursor untouched');
        const mapping = JSON.parse(fs.readFileSync(pathsFile(h), 'utf8')) as { projects: Record<string, unknown> };
        assert.deepEqual(Object.keys(mapping.projects).sort(), ['gone-2', 'keep']);
        assert.deepEqual(mapping.projects['keep'], projects.keep); assert.deepEqual(mapping.projects['gone-2'], projects['gone-2']);
        const rec = readDeletionLog(h).byId.get(r.id)!.completedErase!;
        const stores = Object.fromEntries(rec.stores.map((s) => [s.store, s]));
        assert.equal(stores['outbox']!.status, 'complete'); assert.equal(stores['outbox']!.removed['rows'], 3);
        assert.equal(stores['workspace-paths']!.status, 'complete'); assert.equal(stores['workspace-paths']!.removed['entries'], 1);
    });

    await test('a live workspace re-using the name keeps its queue rows and mapping', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('gone', undefined, h);
        await seedOutbox(h, { gone: 3, keep: 1 });
        fs.writeFileSync(pathsFile(h), JSON.stringify({ projects }, null, 4) + '\n');
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        createWorkspace('gone', undefined, h); // new live workspace, same name, different id
        const out = await eraseNow(r.id, d);
        assert.equal(out.kind, 'complete');
        const rec = readDeletionLog(h).byId.get(r.id)!.completedErase!;
        assert.equal(rec.stores.find((s) => s.store === 'outbox')!.status, 'not-applicable');
        assert.equal(rec.stores.find((s) => s.store === 'workspace-paths')!.status, 'not-applicable');
        assert.equal((await outboxRows(h))['gone']!.length, 3);
        assert.ok('gone' in (JSON.parse(fs.readFileSync(pathsFile(h), 'utf8')) as { projects: object }).projects);
    });

    await test('an unreadable workspace-paths.json is never overwritten; the step is partial and retried', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('gone', undefined, h);
        fs.writeFileSync(pathsFile(h), '{"projects": {"gone": {"paths": [');
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(r.status, 'erasing');
        assert.equal(fs.readFileSync(pathsFile(h), 'utf8'), '{"projects": {"gone": {"paths": [');
        assert.equal(readDeletionLog(h).byId.get(r.id)!.completedErase, undefined);
    });

    await test('no outbox and no mapping file: both steps are not-applicable and the erase completes', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('solo', undefined, h);
        const r = await deleteWorkspaceWithLifecycle('solo', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        const stores = Object.fromEntries(readDeletionLog(h).byId.get(r.id)!.completedErase!.stores.map((s) => [s.store, s.status]));
        assert.equal(stores['outbox'], 'not-applicable'); assert.equal(stores['workspace-paths'], 'not-applicable');
        assert.ok(!fs.existsSync(outboxDir(h)) || !fs.existsSync(path.join(outboxDir(h), 'outbox.sqlite')), 'never creates an outbox');
    });
} finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
