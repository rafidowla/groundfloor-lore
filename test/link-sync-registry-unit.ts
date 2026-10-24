#!/usr/bin/env tsx
/**
 * test/link-sync-registry-unit.ts - per-workspace SyncEngines built by SyncEngineRegistry carry the link signaler, so a
 * pulled vector mirror in ANY workspace (not just the boot one) is queued for link-on-arrival.
 *
 *   registry   every lazily-built engine gets the registry's signaler (and null when none is wired)
 *   boot       buildSyncEngineRegistryForLocalMode takes the signaler from the boot engine
 *   pinned     a primed boot engine is left exactly as given
 *
 * Run: npx tsx test/link-sync-registry-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsr-'));
process.env.LORE_HOME = home;
const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
const { SyncEngineRegistry } = await import('../packages/lore/src/engines/syncEngineRegistry.js');
const { buildSyncEngineRegistryForLocalMode } = await import('../packages/lore/src/mcp/bootSteps.js');
const { SqliteGraph } = await import('../packages/lore/src/engines/sqliteGraph.js');

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

createWorkspace('ws-one', undefined, home);
createWorkspace('ws-two', undefined, home);
const graphs: Array<InstanceType<typeof SqliteGraph>> = [];
const graphRegistry = {
    getGraphHandle: async (ws: string) => { const g = new SqliteGraph(path.join(home, `g-${ws}`), { workspaceId: ws }); await g.initialize(); graphs.push(g); return g; },
    activeName: () => 'ws-one',
} as never;
const resolver = { getOrOpen: async () => ({}) } as never;
const signaler = { signal: () => undefined } as never;
const base = { graphRegistry, workspaceVerbatimResolver: resolver, getAdapter: () => null, outboxStore: null, deploymentMode: 'local' as const, home };

await test('registry: lazily-built engines for different workspaces both carry the signaler', async () => {
    const reg = new SyncEngineRegistry({ ...base, linkSignaler: signaler });
    const a = await reg.getOrOpen('ws-one');
    const b = await reg.getOrOpen('ws-two');
    assert.notEqual(a, b);
    assert.equal(a.linkSignaler, signaler);
    assert.equal(b.linkSignaler, signaler);
});

await test('registry: no signaler wired -> null (link-on-arrival off)', async () => {
    const reg = new SyncEngineRegistry({ ...base });
    assert.equal((await reg.getOrOpen('ws-one')).linkSignaler, null);
});

await test('boot builder: the registry takes the signaler from the boot engine; the pinned boot engine is untouched', async () => {
    const boot = { linkSignaler: signaler, marker: 'boot' } as never;
    const reg = buildSyncEngineRegistryForLocalMode({
        graphRegistry, workspaceVerbatimResolver: resolver, getAdapter: () => null, outboxStore: null as never,
        deploymentMode: 'local', bootSyncEngine: boot, activeWorkspace: 'ws-one', home,
    })!;
    assert.equal(await reg.getOrOpen('ws-one'), boot, 'primed boot engine returned as-is');
    assert.equal((await reg.getOrOpen('ws-two')).linkSignaler, signaler);
});

for (const g of graphs) { try { await (g as { close?: () => Promise<void> }).close?.(); } catch { /* best effort */ } }
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
