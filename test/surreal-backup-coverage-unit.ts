#!/usr/bin/env tsx
/**
 * surreal-backup-coverage-unit.ts — Phase 3 item 5: a Surreal-backed workspace
 * must be backup-able and restorable (docs/SURREALDB_BUILD_PLAN.md).
 *
 * The plan flags this as a real risk: "the existing auto-snapshot-before-
 * destructive mechanism and backup sweeper know the legacy graph engine's
 * on-disk file layout. A SurrealDB-backed workspace gets zero backup
 * coverage unless this phase adds it."
 *
 * Reading the code says otherwise for the TARBALL path — `engines/backup.ts`
 * treats `.lore/` as an opaque bag and copies it whole, so `.lore/surreal`
 * should ride along for free. "Should" is the problem: an untested assumption
 * about a backup path is how people discover their backups were empty. So this
 * proves it end to end, with real data and a real restore.
 *
 * It also pins the one place where the assumption genuinely does NOT hold:
 *   - a backup taken while the store is OPEN is not asserted to be consistent,
 *     because it is not — the same caveat the legacy-engine path carried.
 * (The pre-destructive-change data snapshotter used to be Cypher-only
 * and gated on a Surreal-backed workspace; Phase 2 rewired it onto the
 * engine-agnostic SchemaGraphOps port, so it now snapshots for real instead
 * of failing closed — see the dedicated test below.)
 *
 * Run: npx tsx test/surreal-backup-coverage-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { backupWorkspace } from '../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { LocalGraphSnapshotter } from '../packages/lore/src/schemas/dataSnapshot.js';
import { surrealDataPath } from '../packages/lore/src/engines/surreal/surrealConnection.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

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

function node(id: string, over: Partial<LoreNode> = {}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'decision',
        label: `Label ${id}`,
        content: `Content for ${id}`,
        tags: ['backup'],
        project: 'p',
        ecosystem: 'e',
        metadata: '{}',
        ...over,
    };
}

/** A workspace directory with a populated, CLOSED SurrealDB graph. */
async function seededWorkspace(): Promise<{ dir: string; cleanup: () => void }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bk-ws-'));
    const g = new SurrealGraph(dir, { workspaceId: 'bk', cacheDisabled: true });
    await g.initialize();
    for (const id of ['n1', 'n2', 'n3']) await g.upsertNode(node(id));
    await g.addEdge({ sourceId: 'n1', targetId: 'n2', relation: 'refers_to' });
    await g.addEdge({ sourceId: 'n2', targetId: 'n3', relation: 'cites' });
    // CLOSED before the backup: a live surrealkv store is mid-write by
    // definition, and copying one is the same caveat the legacy engine carried.
    await g.close();
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

console.log('Phase 3 — backup coverage for a Surreal-backed workspace');

await test('the surreal store lives under .lore/, which is what backup copies', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bk-path-'));
    try {
        const dataPath = surrealDataPath(base);
        assert.equal(dataPath, path.join(base, '.lore', 'surreal'));
        // This is the whole reason the tarball path works unchanged. If the
        // engine ever moved its files outside .lore/, backup would silently
        // stop capturing the graph — hence asserting the location, not just
        // that a backup succeeded.
        assert.ok(dataPath.includes(`${path.sep}.lore${path.sep}`), 'inside the backed-up subtree');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

await test('backupWorkspace captures the surreal store in the tarball', async () => {
    const ws = await seededWorkspace();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bk-out-'));
    try {
        const result = await backupWorkspace({ workspaceDir: ws.dir, workspaceName: 'bk', outDir });
        assert.ok(fs.existsSync(result.tarballPath), 'a tarball was produced');
        assert.ok(result.bytesWritten > 0, 'and it is not empty');
        // The catalog is the authoritative list of what was captured; assert the
        // surreal files are IN it rather than inferring from the archive size.
        const captured = result.catalog.files.map((f) => f.relPath);
        const surrealFiles = captured.filter((f) => f.includes('surreal'));
        assert.ok(surrealFiles.length > 0,
            `no surreal files in the backup catalog — captured: ${captured.slice(0, 20).join(', ')}`);
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
        ws.cleanup();
    }
});

await test('restoreWorkspace round-trips the graph: nodes, edges and traversal survive', async () => {
    const ws = await seededWorkspace();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bk-out-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bk-target-'));
    try {
        const { tarballPath } = await backupWorkspace({ workspaceDir: ws.dir, workspaceName: 'bk', outDir });
        await restoreWorkspace({ tarballPath, workspaceDir: target });

        // Open the RESTORED directory with a fresh engine — the only honest
        // proof that the bytes are a usable database and not just present.
        const restored = new SurrealGraph(target, { workspaceId: 'bk', cacheDisabled: true });
        try {
            await restored.initialize();
            const stats = await restored.getStats();
            assert.equal(stats.nodeCount, 3, 'every node came back');
            assert.equal(stats.edgeCount, 2, 'every edge came back');
            assert.equal((await restored.getNode('n2'))?.label, 'Label n2', 'field-level fidelity');

            // Graph STRUCTURE, not just row counts: a restore that dropped the
            // adjacency would still pass a count check.
            const hops = await restored.traverse('n1', 2);
            assert.deepEqual(hops.map((h) => h.node.id).sort(), ['n2', 'n3'],
                'traversal works on the restored store');
            assert.equal(hops.find((h) => h.node.id === 'n3')?.depth, 2, 'and depths are intact');

            // Writable, not just readable.
            await restored.upsertNode(node('post-restore'));
            assert.ok(await restored.getNode('post-restore'));
        } finally {
            await restored.close().catch(() => undefined);
        }
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
        ws.cleanup();
    }
});

await test('a mixed workspace backs up BOTH substrates (surreal graph + legacy on-disk sidecars)', async () => {
    // An older workspace directory can still carry a leftover `.lore/graph`
    // file from before the legacy graph engine was removed, alongside the
    // SQLite substrates used today for collections, analytical storage,
    // pending-ops and ReBAC. A backup that skipped either would restore an
    // incomplete workspace.
    const ws = await seededWorkspace();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bk-out-'));
    try {
        // Stand in for a leftover on-disk artefact from a pre-removal
        // workspace, alongside the files the real runtime writes today.
        fs.writeFileSync(path.join(ws.dir, '.lore', 'graph'), 'legacy-graph-placeholder');
        fs.writeFileSync(path.join(ws.dir, '.lore', 'tables.sqlite'), '');

        const result = await backupWorkspace({ workspaceDir: ws.dir, workspaceName: 'bk', outDir });
        const captured = result.catalog.files.map((f) => f.relPath);
        assert.ok(captured.some((f) => f.includes('surreal')), 'surreal graph captured');
        assert.ok(captured.some((f) => f.endsWith('graph')), 'legacy graph-engine artefact file captured');
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
        ws.cleanup();
    }
});

await test('the pre-destructive-change data snapshotter works end-to-end against a real SurrealGraph', async () => {
    // Was 'KNOWN GAP: the pre-destructive-change snapshotter has no Surreal
    // path' — stale since Phase 2 rewired dataSnapshot.ts's
    // LocalGraphSnapshotter onto the engine-agnostic SchemaGraphOps port
    // (dataSnapshot.ts no longer contains raw legacy-engine Cypher) and
    // removed the legacy engine's graph-substrate assertion gate from
    // bootSteps.ts that used to fail the
    // approval closed on a Surreal-backed workspace. This is the positive
    // replacement: a real embedded SurrealGraph, a real destructive-change
    // snapshot, real rows on disk — not a fake SchemaGraphOps (that's
    // schema-data-snapshot-unit.ts's job) and not a source-text grep.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bk-snapshot-'));
    try {
        const g = new SurrealGraph(dir, { workspaceId: 'snap', cacheDisabled: true });
        await g.initialize();
        await g.upsertNode(node('victim1', { type: 'decision' }));
        await g.upsertNode(node('victim2', { type: 'decision' }));
        await g.upsertNode(node('bystander', { type: 'convention' }));

        const snapper = new LocalGraphSnapshotter(g.getSchemaGraphOps());
        const snapshotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bk-snapdir-'));
        const result = await snapper.snapshotForChange(
            { kind: 'node_type.removed', target: 'decision', migration: 'dual-shape' },
            { sandboxId: 'sb-real', snapshotsDir, isoTimestamp: '2026-08-21T00:00:00.000Z' },
        );

        assert.equal(result.status, 'applied', 'a Surreal-backed workspace snapshots, not gates');
        assert.equal(result.rowCount, 2, 'exactly the two decision-type victims, not the bystander');
        assert.ok(fs.existsSync(result.file), 'the snapshot file genuinely exists on disk');
        const lines = fs.readFileSync(result.file, 'utf8').trim().split('\n');
        assert.equal(lines.length, 3, '1 _snapshotMetadata header line + one JSONL line per captured row');
        const metadata = JSON.parse(lines[0]);
        assert.equal(metadata._snapshotMetadata.rowCount, 2);
        const captured = lines.slice(1).map((l) => JSON.parse(l));
        assert.deepEqual(captured.map((r) => r.id).sort(), ['victim1', 'victim2']);

        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
