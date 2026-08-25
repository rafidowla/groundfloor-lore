#!/usr/bin/env tsx
/**
 * getgraphhandle-no-kuzu-open-unit.ts — a Surreal-backed workspace no longer
 * forces an unused Kùzu open through getGraphHandle/tableStorageFor/
 * sessionCacheFor.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * `LocalGraphRegistry.getGraphHandle()` called `getOrOpen()` (the Kùzu
 * substrate accessor) UNCONDITIONALLY, before even checking the workspace's
 * declared engine — so every Surreal-backed workspace also opened a real,
 * empty, never-touched `.lore/graph` Kùzu database on every access.
 * `tableStorageFor`/`sessionCacheFor` had the same shape. Found 2026-08-10
 * while investigating why every migrated workspace still carried an open
 * Kùzu handle in the daemon's memory.
 *
 * ── HOW THIS IS OBSERVED ─────────────────────────────────────────────────────
 *
 * Opening a Kùzu `Database` and calling `initialize()` (CREATE TABLE IF NOT
 * EXISTS ...) creates `.lore/graph` on disk. So the fail-then-pass signal is
 * external and filesystem-based rather than reaching into registry
 * internals: on the pre-fix code, `.lore/graph` exists after these calls; on
 * the fixed code, it does not, because Kùzu was never opened at all.
 *
 * Run: npx tsx test/getgraphhandle-no-kuzu-open-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalGraphRegistry, WorkspaceNotFoundError } from '../packages/lore/src/engines/localGraphRegistry.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error('       ' + ((err as Error).message ?? String(err)));
    }
}

function freshHome(): { home: string; wsPath: string; wsName: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-nokuzu-'));
    const wsName = 'sws';
    const wsPath = path.join(home, 'workspaces', wsName);
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1,
        active: wsName,
        workspaces: [{ name: wsName, path: wsPath, graphEngine: 'surreal' }],
    }, null, 2));
    return { home, wsPath, wsName };
}

function kuzuGraphExists(wsPath: string): boolean {
    return fs.existsSync(path.join(wsPath, '.lore', 'graph'));
}

console.log('getGraphHandle/tableStorageFor/sessionCacheFor — no incidental Kùzu open on a Surreal workspace');

await test('getGraphHandle on a Surreal-backed workspace never creates .lore/graph', async () => {
    const { home, wsPath, wsName } = freshHome();
    const registry = new LocalGraphRegistry({ autoEvict: false, home });
    try {
        const handle = await registry.getGraphHandle(wsName);
        assert.equal(handle.constructor.name, 'SurrealGraph');
        assert.equal(kuzuGraphExists(wsPath), false,
            'getGraphHandle must not have opened the Kùzu substrate for a Surreal-backed workspace');
    } finally {
        await registry.disposeAll();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('tableStorageFor on a Surreal-backed workspace never creates .lore/graph', async () => {
    const { home, wsPath, wsName } = freshHome();
    const registry = new LocalGraphRegistry({ autoEvict: false, home });
    try {
        const storage = await registry.tableStorageFor(wsName);
        assert.ok(storage);
        assert.equal(kuzuGraphExists(wsPath), false,
            'tableStorageFor is path-keyed SQLite and must not force a Kùzu open');
    } finally {
        await registry.disposeAll();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('sessionCacheFor on a Surreal-backed workspace never creates .lore/graph', async () => {
    const { home, wsPath, wsName } = freshHome();
    const registry = new LocalGraphRegistry({ autoEvict: false, home });
    try {
        const cache = await registry.sessionCacheFor(wsName);
        assert.ok(cache);
        assert.equal(kuzuGraphExists(wsPath), false,
            'sessionCacheFor is path-keyed JSON and must not force a Kùzu open');
    } finally {
        await registry.disposeAll();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('the confinement gate still applies on the Surreal-only path', async () => {
    // assertWorkspaceOpenAllowed lives inside ensureEntry now, not getOrOpen —
    // confirm getGraphHandle still throws for a workspace outside a bound
    // request's authorized target, same as before the refactor.
    const { home, wsName } = freshHome();
    const { runWithRouteBindingSlot } = await import('../packages/lore/src/security/routeWorkspaceBinding.js');
    const registry = new LocalGraphRegistry({ autoEvict: false, home });
    try {
        await runWithRouteBindingSlot({ target: 'other-workspace', lane: 'workspace' }, async () => {
            await assert.rejects(
                () => registry.getGraphHandle(wsName),
                /WorkspaceAccessDenied|denied|not allowed/i,
                'a workspace outside the bound request target must still be refused',
            );
        });
    } finally {
        await registry.disposeAll();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('an unknown workspace is refused via the Surreal path too', async () => {
    const { home } = freshHome();
    const registry = new LocalGraphRegistry({ autoEvict: false, home });
    try {
        await assert.rejects(
            () => registry.getGraphHandle('does-not-exist'),
            WorkspaceNotFoundError,
        );
    } finally {
        await registry.disposeAll();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('two workspace names on the SAME path share one Surreal handle (alias dedup)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-nokuzu-alias-'));
    const wsPath = path.join(home, 'workspaces', 'shared');
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1,
        active: 'a',
        workspaces: [
            { name: 'a', path: wsPath, graphEngine: 'surreal' },
            { name: 'b', path: wsPath, graphEngine: 'surreal' },
        ],
    }, null, 2));
    const registry = new LocalGraphRegistry({ autoEvict: false, home });
    try {
        const handleA = await registry.getGraphHandle('a');
        const handleB = await registry.getGraphHandle('b');
        assert.equal(handleA, handleB,
            'two names on the same on-disk path must share one Surreal handle, not open two');
    } finally {
        await registry.disposeAll();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
