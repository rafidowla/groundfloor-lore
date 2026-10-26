/**
 * Name reuse must not leave a deleted workspace's held folder behind under a `complete` receipt.
 *
 * Delete `alpha` (window > 0) -> its folder moves to `.erase-hold-<id>`; a NEW `alpha` is created at the same
 * default path; the due erase must still remove the old held folder (it is id-derived, so the live `alpha` can
 * never point at it) and the new `alpha` must be untouched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { readDeletionLog } from '../packages/lore/src/config/deletedWorkspaces.js';
import { deleteWorkspaceWithLifecycle, type LifecycleDeps } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import { eraseNow } from '../packages/lore/src/engines/workspaceErase/tick.js';
import { createHostBlobEraser } from '../packages/lore/src/engines/workspaceErase/hostErasers.js';
import { createLocalDirEraser, holdingPathFor } from '../packages/lore/src/engines/workspaceErase/localDir.js';
import type { EraseTarget } from '../packages/lore/src/engines/workspaceErase/types.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const homes: string[] = [];
const mkHome = (): string => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-')); homes.push(h); loadWorkspaces(h); return h; };
const base = (home: string): LifecycleDeps => ({ home, env: { LORE_WORKSPACE_ERASE_AFTER_DAYS: '7' }, eraserFactory: { keyringEnabled: false }, lock: { staleMs: 60_000, heartbeatMs: 5_000 } });
const pathOf = (h: string, name: string): string => loadWorkspaces(h).workspaces.find((w) => w.name === name)!.path;

console.log('workspace erase: name reuse at the same path');
try {
    await test('old held folder is erased after the name is reused; receipt complete only when it is gone; new workspace untouched', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('alpha', undefined, h);
        const oldPath = pathOf(h, 'alpha');
        fs.mkdirSync(oldPath, { recursive: true });
        fs.writeFileSync(path.join(oldPath, 'secret.txt'), 'old alpha data');
        const r = await deleteWorkspaceWithLifecycle('alpha', {}, d);
        assert.equal(r.status, 'scheduled');
        const hold = r.holdingPath;
        assert.ok(hold && fs.existsSync(path.join(hold, 'secret.txt')), 'old data is held under the id-derived holding path');
        assert.equal(readDeletionLog(h).byId.get(r.id)?.deletion?.holdingPath, hold, 'holding path recorded');

        createWorkspace('alpha', undefined, h);
        const newPath = pathOf(h, 'alpha');
        assert.equal(path.resolve(newPath), path.resolve(oldPath), 'precondition: the new workspace reuses the same default path');
        fs.mkdirSync(newPath, { recursive: true });
        fs.writeFileSync(path.join(newPath, 'fresh.txt'), 'new alpha data');

        const out = await eraseNow(r.id, d);
        const after = readDeletionLog(h).byId.get(r.id)!;
        const receipt = after.completedErase;
        assert.ok(!fs.existsSync(hold), `old held folder must be gone (outcome ${JSON.stringify(out)})`);
        assert.equal(receipt?.status, 'complete');
        const local = receipt!.stores.find((s) => s.store === 'local-dir')!;
        assert.equal(local.status, 'complete');
        assert.equal(fs.readFileSync(path.join(newPath, 'fresh.txt'), 'utf8'), 'new alpha data', 'new workspace untouched');
        assert.ok(loadWorkspaces(h).workspaces.some((w) => w.name === 'alpha'), 'new workspace still registered');
    });

    await test('uploads keyed by a reused name outside a held folder are reported unverifiable, never not-applicable', async () => {
        const h = mkHome();
        createWorkspace('beta', undefined, h);
        const live = loadWorkspaces(h).workspaces.find((w) => w.name === 'beta')!;
        const target: EraseTarget = { id: 'old-beta-id', name: 'beta', path: path.join(h, 'workspaces', 'beta-old'), mode: 'local', orgId: null, holdingPath: null };
        const r = await createHostBlobEraser({ home: h, env: {} }).erase(target);
        assert.equal(r.status, 'unverifiable', JSON.stringify(r));
        assert.ok(live, 'the live workspace is still registered');
        const pg = await createHostBlobEraser({ home: h, env: {} }).erase({ ...target, engine: 'postgres' } as EraseTarget);
        assert.equal(pg.status, 'unverifiable', JSON.stringify(pg));
    });

    await test('a held folder that a live entry points at is refused AND reported unverifiable while it still exists', async () => {
        const h = mkHome();
        const id = 'held-id-1';
        const hold = holdingPathFor(h, id);
        fs.mkdirSync(hold, { recursive: true });
        fs.writeFileSync(path.join(hold, 'x.txt'), 'x');
        // Simulate an operator pointing a live workspace at the holding folder by editing the registry.
        createWorkspace('gamma', undefined, h);
        const file = path.join(h, 'workspaces.json');
        const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
        reg.workspaces.find((w: { name: string }) => w.name === 'gamma').path = hold;
        fs.writeFileSync(file, JSON.stringify(reg, null, 2));
        const r = await createLocalDirEraser({ home: h }).erase({ id, name: 'old', path: path.join(h, 'workspaces', 'old'), mode: 'local', orgId: null, holdingPath: hold });
        assert.equal(r.status, 'unverifiable', JSON.stringify(r));
        assert.ok(fs.existsSync(path.join(hold, 'x.txt')), 'the live folder is untouched');
    });
} finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}
