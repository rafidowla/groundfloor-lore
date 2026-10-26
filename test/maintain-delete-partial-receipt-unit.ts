#!/usr/bin/env tsx
/**
 * maintain-delete-partial-receipt-unit.ts - lane f6c: `maintain` expiry (WorkspaceRegistry.delete) when a store other than the folder
 * leaves the erase receipt `partial` / unverifiable. The folder is gone, so that is NOT a "directory removal is incomplete" error;
 * the scheduled erase keeps retrying the remaining store. A genuinely stuck folder is still reported as an error.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(process.env['F6C_TMP'] ?? os.tmpdir(), 'lore-f6c-maint-'));
process.env['LORE_HOME'] = TMP_HOME;
delete process.env['LORE_PG_URL'];
const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');
const { setLifecycleTestDefaults } = await import('../packages/lore/src/engines/workspaceErase/lifecycle.js');
const { readDeletionLog } = await import('../packages/lore/src/config/deletedWorkspaces.js');
setLifecycleTestDefaults({ eraserFactory: { keyringEnabled: false } });

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
function seed(names: Array<{ name: string; engine?: string }>): void {
    const list = [{ name: 'default', path: TMP_HOME, createdAt: new Date().toISOString() }];
    for (const n of names) {
        const p = path.join(TMP_HOME, 'workspaces', n.name);
        fs.mkdirSync(path.join(p, '.lore'), { recursive: true }); fs.writeFileSync(path.join(p, '.lore', 'marker.txt'), `data-${n.name}`);
        list.push({ name: n.name, path: p, createdAt: new Date().toISOString(), ...(n.engine ? { graphEngine: n.engine } : {}) } as never);
    }
    fs.writeFileSync(path.join(TMP_HOME, 'workspaces.json'), JSON.stringify({ active: 'default', workspaces: list }, null, 2));
}

console.log('maintain delete: partial receipt from a non-folder store');

await test('a Postgres-engine workspace on a host with no Postgres connection: folder erased, no error, receipt partial, neighbour untouched', async () => {
    seed([{ name: 'pg-doomed', engine: 'postgres' }, { name: 'neighbour' }]);
    const nb = path.join(TMP_HOME, 'workspaces', 'neighbour', '.lore', 'marker.txt');
    const out = await new WorkspaceRegistry().delete('pg-doomed');
    assert.equal(typeof out.bytesFreed, 'number');
    assert.ok(!fs.existsSync(path.join(TMP_HOME, 'workspaces', 'pg-doomed')), 'folder gone');
    assert.equal(fs.readFileSync(nb, 'utf8'), 'data-neighbour');
    const rec = [...readDeletionLog(TMP_HOME).byId.values()].find((s) => s.deletion?.name === 'pg-doomed')!;
    assert.equal(rec.lastErased?.status, 'partial', 'receipt is partial (rows could not be checked), not complete');
    const steps = rec.lastErased!.stores;
    assert.equal(steps.find((s) => s.store === 'postgres')?.status, 'unverifiable');
    assert.equal(steps.find((s) => s.store === 'local-dir')?.status, 'complete');
    assert.equal(rec.completedErase, undefined, 'not recorded as completed: the scheduled erase keeps it due');
});

await test('an ordinary workspace still deletes cleanly with a complete receipt', async () => {
    seed([{ name: 'plain' }]);
    await new WorkspaceRegistry().delete('plain');
    const rec = [...readDeletionLog(TMP_HOME).byId.values()].find((s) => s.deletion?.name === 'plain')!;
    assert.equal(rec.lastErased?.status, 'complete');
});

fs.rmSync(TMP_HOME, { recursive: true, force: true });
console.log(`\nmaintain-delete-partial-receipt: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
