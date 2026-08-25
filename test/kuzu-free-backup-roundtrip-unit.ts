#!/usr/bin/env tsx
/**
 * kuzu-free-backup-roundtrip-unit.ts — a workspace with NO Kùzu database can
 * be backed up and restored, and its data survives.
 *
 * ── WHY THIS IS NOT A TAUTOLOGY ─────────────────────────────────────────────
 *
 * `.lore/` is treated as an opaque tree, so it is tempting to assume a
 * Kùzu-free workspace "obviously" round-trips. That assumption has already been
 * wrong twice on this branch: `backup.ts` special-cased the literal filename
 * `tables.sqlite`, so the ReBAC and pending-ops stores shipped mismatched WAL
 * sidecars; and `storageInspector` categorised `.lore/surreal/` as "other", so
 * a disk report showed a graph of ~0 bytes. Both were opaque-tree assumptions
 * that a hardcoded name quietly broke.
 *
 * So this test does the thing rather than asserting the property:
 *   - builds a workspace whose graph is REAL SurrealDB, written through
 *     SurrealGraph, with no `.lore/graph` anywhere;
 *   - carries the three SQLite substrates and a LanceDB-shaped directory;
 *   - closes the Surreal handle before copying, because surrealkv holds a
 *     file lock and a live copy is not safe (surrealConnection.ts:30-56);
 *   - restores into a DIFFERENT directory and reads the nodes back out of a
 *     freshly-opened SurrealGraph — the proof is data, not file presence.
 *
 * It also covers the engine-mismatch guard, which is new and is the one thing
 * here that can fail loudly rather than silently.
 *
 * Run: npx tsx test/kuzu-free-backup-roundtrip-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { backupWorkspace } from '../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-kfree-'));
const ws = path.join(root, 'src');
const loreDir = path.join(ws, '.lore');
fs.mkdirSync(loreDir, { recursive: true });
fs.mkdirSync(path.join(root, 'out'), { recursive: true });

const NODES = [
    { id: 'k1', type: 'decision', label: 'Alpha', content: 'first body' },
    { id: 'k2', type: 'note', label: 'Beta', content: 'second body' },
    { id: 'k3', type: 'convention', label: 'Gamma', content: 'third body' },
];

console.log('Kùzu-free workspace: backup and restore');

// ── build a genuinely Surreal-backed workspace ──────────────────────────────
{
    const g = new SurrealGraph(ws, { workspaceId: 'src' });
    await g.initialize();
    const now = new Date().toISOString();
    for (const n of NODES) {
        await g.upsertNode({
            ...n, tags: [], project: '*', ecosystem: '*', metadata: {},
            createdAt: now, updatedAt: now,
        } as never);
    }
    await g.addEdge({ sourceId: 'k1', targetId: 'k2', relation: 'relates_to', confidence: 'extracted' } as never);
    // surrealkv holds a file lock and releases it asynchronously after close();
    // copying a live store is not safe. The existing Surreal backup test closes
    // first for the same reason.
    await g.close();
}

// The other substrates a real workspace carries.
for (const [file, table] of [
    ['tables.sqlite', 'invoice'],
    ['rebac.sqlite', 'lore_rebac_edge'],
    ['pending-ops.sqlite', 'lore_pending_op'],
] as const) {
    const db = new Database(path.join(loreDir, file));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, v TEXT)`);
    db.prepare(`INSERT OR REPLACE INTO ${table} (id, v) VALUES (?, ?)`).run('row1', `in-${file}`);
    db.close();
}
fs.mkdirSync(path.join(loreDir, 'lancedb'), { recursive: true });
fs.writeFileSync(path.join(loreDir, 'lancedb', 'embedding_model.json'), '{"model":"test"}');
fs.writeFileSync(path.join(loreDir, 'config.json'), '{"workspace":"src"}');

let tarball = '';

await test('the fixture really has NO Kùzu database', () => {
    const entries = fs.readdirSync(loreDir);
    assert.ok(!entries.includes('graph'), `unexpected Kùzu graph: ${entries.join(', ')}`);
    assert.ok(!entries.includes('graph.wal'), 'no Kùzu WAL');
    assert.ok(entries.includes('surreal'), 'and it does have a Surreal store');
});

await test('backup succeeds and records the archive as surreal', async () => {
    const res = await backupWorkspace({ workspaceDir: ws, workspaceName: 'src', outDir: path.join(root, 'out') });
    tarball = res.tarballPath;
    assert.ok(fs.existsSync(tarball), 'tarball produced');
    assert.ok(res.files.includes('surreal/'), `the Surreal store travelled (${res.files.join(', ')})`);
    for (const f of ['tables.sqlite', 'rebac.sqlite', 'pending-ops.sqlite']) {
        assert.ok(res.files.includes(f), `${f} travelled`);
    }
    assert.ok(res.files.includes('lancedb/'), 'vectors travelled');
});

await test('restore into a fresh directory reproduces the SURREAL GRAPH data', async () => {
    // The real assertion: nodes read back out of a freshly-opened engine, not
    // file presence. A tarball can contain a directory and still be useless.
    const dest = path.join(root, 'dst');
    fs.mkdirSync(path.join(dest, '.lore'), { recursive: true });
    await restoreWorkspace({ tarballPath: tarball, workspaceDir: dest, expectedEngine: 'surreal' });

    const g = new SurrealGraph(dest, { workspaceId: 'dst' });
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

await test('the SQLite substrates survive alongside it', () => {
    for (const [file, table, expected] of [
        ['tables.sqlite', 'invoice', 'in-tables.sqlite'],
        ['rebac.sqlite', 'lore_rebac_edge', 'in-rebac.sqlite'],
        ['pending-ops.sqlite', 'lore_pending_op', 'in-pending-ops.sqlite'],
    ] as const) {
        const db = new Database(path.join(root, 'dst', '.lore', file), { readonly: true });
        try {
            const row = db.prepare(`SELECT v FROM ${table} WHERE id = 'row1'`).get() as { v: string };
            assert.equal(row.v, expected, `${file} content intact`);
        } finally {
            db.close();
        }
    }
});

await test('restoring a surreal archive into a kuzu-registered workspace is REFUSED', async () => {
    // Without this the daemon would open Kùzu, find no store, read an empty
    // graph and report success — a workspace that looks fine and has no data.
    const dest = path.join(root, 'mismatch');
    fs.mkdirSync(path.join(dest, '.lore'), { recursive: true });
    await assert.rejects(
        () => restoreWorkspace({ tarballPath: tarball, workspaceDir: dest, expectedEngine: 'kuzu' }),
        /engine mismatch/i,
    );
    assert.equal(fs.readdirSync(path.join(dest, '.lore')).length, 0,
        'and it refused BEFORE touching the destination');
});

await test('an unspecified expectedEngine still restores — no registry, no check', () => {
    // restoreWorkspace is also called with a bare directory (ad-hoc recovery).
    // Absent must skip the check rather than invent an answer.
    const dest = path.join(root, 'bare');
    fs.mkdirSync(path.join(dest, '.lore'), { recursive: true });
    return restoreWorkspace({ tarballPath: tarball, workspaceDir: dest }).then(() => {
        assert.ok(fs.existsSync(path.join(dest, '.lore', 'surreal')), 'restored without a registry');
    });
});

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
