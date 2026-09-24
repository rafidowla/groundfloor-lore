#!/usr/bin/env tsx
/**
 * sqlite-backup-roundtrip-unit.ts — the "sqlite twin" of
 * `surreal-backup-roundtrip-unit.ts` (3.21 step 1b design doc, Tests §1).
 *
 * NOT a `LORE_TEST_GRAPH_ENGINE` parameterization of the Surreal file, and
 * deliberately so: that file exercises `backup.ts`'s `backupWorkspace` /
 * `restore.ts`'s `restoreWorkspace` — the WORKSPACE-level orchestration
 * (tarball, manifest, `detectArchivedEngine`, `expectedEngine` validation)
 * — none of which know about the `'sqlite'` graph engine yet. Teaching them
 * to is explicitly the design doc's "Selection, default, migration" section,
 * and explicitly a LATER branch ("Do NOT wire it into workspace selection
 * yet") — this branch only builds the engine and its own primitives.
 *
 * So this twin exercises the one thing that IS in scope here: SqliteGraph's
 * own online-backup primitive, `backupTo()` (better-sqlite3 `db.backup()`),
 * directly — open, write, back up to a second file, open THAT file as a
 * fresh SqliteGraph, and prove the data (not just file presence) survived.
 * Once workspace-level backup/restore learns the sqlite engine (the later
 * branch), backupTo() is the primitive that call sits on.
 *
 * Run: npx tsx test/sqlite-backup-roundtrip-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sqlitebackup-'));
const srcDir = path.join(root, 'src');
fs.mkdirSync(srcDir, { recursive: true });

const NODES = [
    { id: 'k1', type: 'decision', label: 'Alpha', content: 'first body' },
    { id: 'k2', type: 'note', label: 'Beta café', content: 'second body 日本語' },
    { id: 'k3', type: 'convention', label: 'Gamma', content: 'third body' },
];

console.log('SqliteGraph online backup (backupTo) and restore');

let backupPath = '';

{
    const g = new SqliteGraph(srcDir, { workspaceId: 'src' });
    await g.initialize();
    for (const n of NODES) {
        await g.upsertNode({
            ...n, tags: ['t'], project: '*', ecosystem: '*', metadata: '{}',
        } as never);
    }
    await g.addEdge({ sourceId: 'k1', targetId: 'k2', relation: 'relates_to', confidence: 'extracted' });

    backupPath = path.join(root, 'graph-backup.sqlite');
    await test('backupTo() succeeds against a live, open handle', async () => {
        await g.backupTo(backupPath);
        assert.ok(fs.existsSync(backupPath), 'backup file produced');
    });

    await g.close();
}

await test('the source store is untouched by taking a backup', async () => {
    const g = new SqliteGraph(srcDir, { workspaceId: 'src' });
    await g.initialize();
    try {
        for (const n of NODES) {
            const back = await g.getNode(n.id);
            assert.ok(back, `${n.id} still present in the source store`);
        }
    } finally {
        await g.close();
    }
});

await test('opening the BACKUP file directly reproduces the graph data', async () => {
    // A better-sqlite3 backup is a self-contained database file — no
    // restore step is needed beyond pointing a fresh engine at it, unlike
    // SurrealGraph's directory-tree tarball.
    const destDir = path.join(root, 'dst');
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    fs.copyFileSync(backupPath, path.join(destDir, '.lore', 'graph.sqlite'));

    const g = new SqliteGraph(destDir, { workspaceId: 'dst' });
    await g.initialize();
    try {
        for (const n of NODES) {
            const back = await g.getNode(n.id);
            assert.ok(back, `${n.id} restored`);
            assert.equal(back!.label, n.label, `${n.id} label intact`);
            assert.equal(back!.content, n.content, `${n.id} content intact — not just the id`);
        }
        const edges = await g.queryEdges({ source: 'k1', limit: 10, offset: 0 });
        assert.equal(edges.length, 1, 'the edge survived too');
        assert.equal(edges[0]!.targetId, 'k2');
    } finally {
        await g.close();
    }
});

await test('a digest of canonicalized node+edge JSON matches source vs backup', async () => {
    function digest(nodes: unknown[], edges: unknown[]): string {
        return JSON.stringify({ nodes, edges });
    }

    const src = new SqliteGraph(srcDir, { workspaceId: 'src' });
    await src.initialize();
    const dst = new SqliteGraph(path.join(root, 'dst'), { workspaceId: 'dst' });
    await dst.initialize();
    try {
        const srcNodes = (await Promise.all(NODES.map((n) => src.getNode(n.id))))
            .map((n) => ({ ...n, createdAt: '#T', updatedAt: '#T' }));
        const dstNodes = (await Promise.all(NODES.map((n) => dst.getNode(n.id))))
            .map((n) => ({ ...n, createdAt: '#T', updatedAt: '#T' }));
        const srcEdges = await src.queryEdges({ limit: 100, offset: 0 });
        const dstEdges = await dst.queryEdges({ limit: 100, offset: 0 });
        assert.equal(digest(srcNodes, srcEdges), digest(dstNodes, dstEdges));
    } finally {
        await src.close();
        await dst.close();
    }
});

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
