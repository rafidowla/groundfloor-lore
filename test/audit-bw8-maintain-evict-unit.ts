#!/usr/bin/env tsx
/**
 * audit-bw8-maintain-evict-unit.ts — re-audit 2026-06-25 (MEDIUM, concurrency).
 *
 * In-process `lore maintain` ephemeral-workspace cleanup rmSync-deleted a
 * workspace's data dir without closing any cached graph-engine handle for it —
 * deleting the embedded-store/LanceDB files out from under an open pool.
 * WorkspaceRegistry now takes the graph registry and closes the handle
 * (closeWorkspace) BEFORE the dir is removed; the CLI path (no registry)
 * still works.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bw8-'));
process.env['LORE_HOME'] = TMP_HOME;

const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function seedWorkspace(name: string): string {
    const wsPath = path.join(TMP_HOME, 'workspaces', name);
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(wsPath, '.lore', 'marker.txt'), 'data');
    fs.writeFileSync(path.join(TMP_HOME, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [
            { name: 'default', path: TMP_HOME, createdAt: new Date().toISOString() },
            { name, path: wsPath, createdAt: new Date().toISOString() },
        ],
    }, null, 2));
    return wsPath;
}

console.log('BW-8 — maintain closes the graph handle before deleting a workspace dir');

await test('delete closes the cached handle BEFORE removing the data dir', async () => {
    const wsPath = seedWorkspace('ephemeral-x');
    const calls: Array<{ name: string; dirExistedAtClose: boolean }> = [];
    const spyRegistry = {
        closeWorkspace: async (name: string) => {
            // Capture whether the dir still exists at close time → proves ordering.
            calls.push({ name, dirExistedAtClose: fs.existsSync(wsPath) });
            return true;
        },
    } as never;
    const reg = new WorkspaceRegistry(spyRegistry);
    const { bytesFreed } = await reg.delete('ephemeral-x');
    assert.equal(calls.length, 1, 'closeWorkspace called exactly once');
    assert.equal(calls[0]!.name, 'ephemeral-x', 'closed the right workspace');
    assert.equal(calls[0]!.dirExistedAtClose, true, 'handle closed BEFORE the dir was rmSync-ed');
    assert.ok(!fs.existsSync(wsPath), 'data dir removed after the handle was closed');
    assert.ok(bytesFreed >= 0, 'bytesFreed reported');
});

await test('delete works without a graphRegistry (CLI path) — no throw', async () => {
    const wsPath = seedWorkspace('ephemeral-y');
    const reg = new WorkspaceRegistry(); // CLI path: no live registry
    await reg.delete('ephemeral-y');
    assert.ok(!fs.existsSync(wsPath), 'dir removed even without a registry');
});

// RA2-reaudit2 (#19) — when the handle can't be closed (borrowed/aliased),
// closeWorkspace returns false; delete must REFUSE and NOT rmSync the dir.
await test('delete refuses (no rmSync) when the graph handle is stuck open', async () => {
    const wsPath = seedWorkspace('ephemeral-stuck');
    const stuckRegistry = { closeWorkspace: async () => false } as never;
    const reg = new WorkspaceRegistry(stuckRegistry);
    await assert.rejects(() => reg.delete('ephemeral-stuck'), /still open|borrowed|refusing/i);
    assert.ok(fs.existsSync(wsPath), 'data dir must NOT be removed when the handle is stuck');
});

fs.rmSync(TMP_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
