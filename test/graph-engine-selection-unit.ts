#!/usr/bin/env tsx
/**
 * graph-engine-selection-unit.ts — 3.21 step 1d: workspace/engine selection.
 *
 * Covers the design doc's "Selection, default, migration" section:
 *   - a NEW local workspace's `graphEngine` is written explicitly as
 *     'sqlite' (createWorkspace());
 *   - an EXISTING workspace with an ABSENT `graphEngine` field still
 *     resolves to 'surreal' — a pre-3.21 workspace never silently changes
 *     substrate;
 *   - the `LORE_DEFAULT_GRAPH_ENGINE=surreal` operator escape hatch;
 *   - an embedded end-to-end write→search→traverse against a
 *     `graphEngine: 'sqlite'` workspace opened through `openWorkspaceGraph`
 *     (the real selection path, not a direct `new SqliteGraph`);
 *   - backup→restore round trip via the real `backupWorkspace`/
 *     `restoreWorkspace` engine for a sqlite-backed workspace;
 *   - restore engine-mismatch refusal (sqlite archive into a
 *     surreal-registered workspace, and the reverse).
 *
 * Run: npx tsx test/graph-engine-selection-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceGraphEngine, resolveNewWorkspaceGraphEngine } from '../packages/lore/src/engines/graphEngineSelector.js';
import { openWorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';
import { backupWorkspace } from '../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function freshHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selection-home-'));
}

console.log('GRAPH-ENGINE-SELECTION — 3.21 step 1d');
console.log('='.repeat(72));

await test('createWorkspace() writes graphEngine: sqlite for a new workspace', () => {
    const home = freshHome();
    // loadWorkspaces() seeds the "default" entry on first call — call it
    // first so the workspace-under-test is a genuine createWorkspace() call,
    // not the fresh-home seed path (covered separately below).
    loadWorkspaces(home);
    const entry = createWorkspace('brand-new', {}, home);
    assert.equal(entry.graphEngine, 'sqlite', 'new workspace defaults to sqlite');
    assert.equal(resolveWorkspaceGraphEngine('brand-new', home), 'sqlite');
});

await test('fresh-home seeding (no prior workspaces.json, no legacy .lore) writes graphEngine: sqlite', () => {
    const home = freshHome();
    const file = loadWorkspaces(home); // first call seeds "default"
    const defaultEntry = file.workspaces.find((w) => w.name === 'default');
    assert.ok(defaultEntry, 'default workspace seeded');
    assert.equal(defaultEntry!.graphEngine, 'sqlite');
});

await test('fresh-home seeding that ADOPTS an existing legacy .lore leaves graphEngine absent (stays surreal)', () => {
    const home = freshHome();
    // Simulate a pre-existing .lore/ (the "adopt legacy home" branch) —
    // loadWorkspaces() must not stamp graphEngine on data it did not create.
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    const file = loadWorkspaces(home);
    const defaultEntry = file.workspaces.find((w) => w.name === 'default');
    assert.ok(defaultEntry, 'default workspace seeded');
    assert.equal(defaultEntry!.graphEngine, undefined, 'adopted legacy home: field stays absent');
    assert.equal(resolveWorkspaceGraphEngine('default', home), 'surreal', 'absent still resolves to surreal');
});

await test('an EXISTING workspace with an absent graphEngine field resolves to surreal, never silently switches', () => {
    const home = freshHome();
    loadWorkspaces(home);
    // Directly craft an entry with NO graphEngine field, as a pre-3.21
    // workspaces.json would have.
    const controlPath = path.join(home, 'workspaces.json');
    const file = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    file.workspaces.push({ name: 'legacy-style', path: path.join(home, 'legacy-style'), createdAt: new Date().toISOString() });
    fs.writeFileSync(controlPath, JSON.stringify(file, null, 2));
    assert.equal(resolveWorkspaceGraphEngine('legacy-style', home), 'surreal');
});

await test('LORE_DEFAULT_GRAPH_ENGINE=surreal escape hatch — resolveNewWorkspaceGraphEngine() and createWorkspace()', () => {
    const prior = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    process.env['LORE_DEFAULT_GRAPH_ENGINE'] = 'surreal';
    try {
        assert.equal(resolveNewWorkspaceGraphEngine(), 'surreal');
        const home = freshHome();
        loadWorkspaces(home);
        const entry = createWorkspace('escape-hatch-ws', {}, home);
        assert.equal(entry.graphEngine, 'surreal');
    } finally {
        if (prior === undefined) delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];
        else process.env['LORE_DEFAULT_GRAPH_ENGINE'] = prior;
    }
});

await test('an unrecognised LORE_DEFAULT_GRAPH_ENGINE value is treated as sqlite (only "surreal" opts out)', () => {
    const prior = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    process.env['LORE_DEFAULT_GRAPH_ENGINE'] = 'bogus';
    try {
        assert.equal(resolveNewWorkspaceGraphEngine(), 'sqlite');
    } finally {
        if (prior === undefined) delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];
        else process.env['LORE_DEFAULT_GRAPH_ENGINE'] = prior;
    }
});

await test('embedded end-to-end: openWorkspaceGraph() on a sqlite-selected workspace — write, search, traverse', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('e2e-sqlite', {}, home);
    assert.equal(entry.graphEngine, 'sqlite');

    const g = openWorkspaceGraph(entry.path, { workspaceId: 'e2e-sqlite', home });
    assert.ok(g instanceof SqliteGraph, 'openWorkspaceGraph resolved to SqliteGraph');
    await g.initialize();
    try {
        await g.upsertNode({ id: 'a', type: 'note', label: 'Alpha', content: 'body one', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
        await g.upsertNode({ id: 'b', type: 'note', label: 'Beta', content: 'body two', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'relates_to' });

        const found = await g.search('Alpha', 10, '*', '*', false);
        assert.ok(found.some((n) => n.id === 'a'), 'search finds the written node');

        const walk = await g.traverse('a', 2);
        assert.ok(walk.some((r) => r.node.id === 'b'), 'traverse reaches the linked node');
    } finally {
        await g.close();
    }
});

await test('backup -> restore round trip via the real engine for a sqlite-backed workspace', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('backup-roundtrip-sqlite', {}, home);
    const g = openWorkspaceGraph(entry.path, { workspaceId: entry.name, home });
    assert.ok(g instanceof SqliteGraph);
    await g.initialize();
    await g.upsertNode({ id: 'k1', type: 'decision', label: 'Alpha', content: 'first body', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    await g.close();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selection-out-'));
    const backupResult = await backupWorkspace({ workspaceDir: entry.path, workspaceName: entry.name, outDir });
    assert.ok(backupResult.files.includes('graph.sqlite'), `graph.sqlite travelled (${backupResult.files.join(', ')})`);

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selection-dst-'));
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    await restoreWorkspace({ tarballPath: backupResult.tarballPath, workspaceDir: destDir, expectedEngine: 'sqlite' });

    const restored = new SqliteGraph(destDir, { workspaceId: 'restored' });
    await restored.initialize();
    try {
        const node = await restored.getNode('k1');
        assert.ok(node, 'node survived backup+restore');
        assert.equal(node!.label, 'Alpha');
    } finally {
        await restored.close();
    }
});

await test('restore refuses a sqlite archive into a workspace registered as surreal', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('mismatch-sqlite-src', {}, home);
    const g = openWorkspaceGraph(entry.path, { workspaceId: entry.name, home });
    await g.initialize();
    await g.upsertNode({ id: 'x', type: 'note', label: 'X', content: 'c', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    await g.close();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selection-mismatch-out-'));
    const backupResult = await backupWorkspace({ workspaceDir: entry.path, workspaceName: entry.name, outDir });

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selection-mismatch-dst-'));
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    await assert.rejects(
        () => restoreWorkspace({ tarballPath: backupResult.tarballPath, workspaceDir: destDir, expectedEngine: 'surreal' }),
        /engine mismatch/i,
    );
});

await test('restore refuses a surreal archive into a workspace registered as sqlite', async () => {
    const home = freshHome();
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selection-surreal-src-'));
    fs.mkdirSync(path.join(workspaceDir, '.lore'), { recursive: true });
    const g = new SurrealGraph(workspaceDir, { workspaceId: 'surreal-src' });
    await g.initialize();
    await g.upsertNode({ id: 'y', type: 'note', label: 'Y', content: 'c', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    await g.close();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selection-surreal-out-'));
    const backupResult = await backupWorkspace({ workspaceDir, workspaceName: 'surreal-src', outDir });

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selection-surreal-dst-'));
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    await assert.rejects(
        () => restoreWorkspace({ tarballPath: backupResult.tarballPath, workspaceDir: destDir, expectedEngine: 'sqlite' }),
        /engine mismatch/i,
    );
    void home;
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
