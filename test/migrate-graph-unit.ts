#!/usr/bin/env tsx
/**
 * migrate-graph-unit.ts — 3.21 step 1e: `lore migrate-graph`.
 *
 * Covers the design doc's migration test list:
 *   - fixture migrate → digest equal (migrateGraphToSqlite's own
 *     verification, asserted via the returned report);
 *   - → backup → restore → digest equal (the pre-migration backup the
 *     migration itself takes, restored into a fresh directory, compared
 *     against the original fixture);
 *   - --rollback;
 *   - refusal when a daemon holds the workspace (child process, real HTTP
 *     server standing in for the daemon's `/api/health`);
 *   - a crash mid-migration (kill BEFORE the flip, via
 *     `simulateCrashBeforeFlip`) leaves the workspace on surreal and usable.
 *
 * Run: npx tsx test/migrate-graph-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createWorkspace, loadWorkspaces, setWorkspaceGraphEngine, type WorkspaceEntry } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceGraphEngine } from '../packages/lore/src/engines/graphEngineSelector.js';
import { migrateGraphToSqlite, rollbackGraphMigration } from '../packages/lore/src/engines/migrateGraphToSqlite.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { LoreEdge, LoreNode } from '../packages/lore/src/providers/types.js';

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migrategraph-home-'));
}
function outDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migrategraph-out-'));
    return d;
}

function canonicalStringify(value: unknown): string {
    const sortKeys = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sortKeys);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
            return out;
        }
        return v;
    };
    return JSON.stringify(sortKeys(value));
}
function digestOf(nodes: LoreNode[], edges: LoreEdge[]): string {
    const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    const sortedEdges = [...edges].sort((a, b) => `${a.sourceId}|${a.targetId}|${a.relation}`.localeCompare(`${b.sourceId}|${b.targetId}|${b.relation}`));
    return canonicalStringify({ nodes: sortedNodes, edges: sortedEdges });
}
async function readAllNodesAndEdges(g: SurrealGraph): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }> {
    const nodes = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
    const edges: LoreEdge[] = [];
    let offset = 0;
    for (;;) {
        const page = await g.queryEdges({ limit: 1000, offset });
        if (page.length === 0) break;
        edges.push(...page);
        offset += 1000;
    }
    return { nodes, edges };
}

/** A fixture with a diamond, a supersede chain, an archived node, and an ephemeral node. */
async function loadFixture(g: SurrealGraph): Promise<void> {
    const nodes = [
        { id: 'hub', type: 'note', label: 'Hub node', content: 'central', tags: ['graph'] },
        { id: 'near1', type: 'note', label: 'Near one', content: 'n1', tags: ['graph'] },
        { id: 'near2', type: 'note', label: 'Near two', content: 'n2', tags: ['graph'] },
        { id: 'old', type: 'decision', label: 'Old decision', content: 'superseded', tags: ['chain'] },
        { id: 'new', type: 'decision', label: 'New decision', content: 'current', tags: ['chain'] },
        { id: 'archived-node', type: 'note', label: 'Archived', content: 'archived body', tags: [] },
        { id: 'scratch', type: 'note', label: 'Scratch', content: 'ephemeral body', tags: [] },
    ];
    for (const n of nodes) {
        await g.upsertNode({
            ...n, project: '*', ecosystem: '*', metadata: '{}',
            ephemeral: n.id === 'scratch', ttl_ms: n.id === 'scratch' ? 3_600_000 : undefined,
        } as never);
    }
    await g.addEdge({ sourceId: 'hub', targetId: 'near1', relation: 'related_to' });
    await g.addEdge({ sourceId: 'hub', targetId: 'near2', relation: 'related_to' });
    await g.addEdge({ sourceId: 'near1', targetId: 'near2', relation: 'cites', confidence: 'inferred', confidenceScore: 0.42 });
    await g.supersedeNode('old', 'new', 'fixture supersede');
    await g.archiveNode('archived-node');
    await g.markStaleByTags(['graph']);
}


/** createWorkspace() now defaults new workspaces to 'sqlite' (3.21 step 1d) — these tests are about MIGRATING FROM surreal, so every fixture workspace here starts explicitly on 'surreal' regardless of that default. */
function createSurrealWorkspace(name: string, home: string): WorkspaceEntry {
    const entry = createWorkspace(name, {}, home);
    setWorkspaceGraphEngine(name, 'surreal', home);
    return entry;
}

console.log('MIGRATE-GRAPH — 3.21 step 1e');
console.log('='.repeat(72));

await test('migrateGraphToSqlite: fixture migrate reports matching digest + read probes', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createSurrealWorkspace('migrate-fixture', home);
    // Not `entry.graphEngine` — `entry` is the object createWorkspace()
    // returned BEFORE createSurrealWorkspace's setWorkspaceGraphEngine call
    // mutated the on-disk file via a separately-loaded copy; the registry
    // (not this stale in-memory reference) is the source of truth.
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'surreal');

    const g = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await g.initialize();
    await loadFixture(g);
    const { nodes, edges } = await readAllNodesAndEdges(g);
    await g.close();

    const report = await migrateGraphToSqlite({ workspaceName: entry.name, home, backupOutDir: outDir() });
    assert.ok(report.digestMatched, 'digest matched');
    assert.ok(report.readProbesMatched, `read probes matched: ${report.readProbeDetails.join('; ')}`);
    assert.equal(report.nodeCount, nodes.length);
    assert.equal(report.edgeCount, edges.length);
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'sqlite');
});

await test('the pre-migration backup, restored, reproduces the ORIGINAL fixture digest', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createSurrealWorkspace('migrate-backup-restore', home);

    const g = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await g.initialize();
    await loadFixture(g);
    const { nodes, edges } = await readAllNodesAndEdges(g);
    const originalDigest = digestOf(nodes, edges);
    await g.close();

    const report = await migrateGraphToSqlite({ workspaceName: entry.name, home, backupOutDir: outDir() });

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migrategraph-restored-'));
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    await restoreWorkspace({ tarballPath: report.backup.tarballPath, workspaceDir: destDir, expectedEngine: 'surreal' });

    const restored = new SurrealGraph(destDir, { workspaceId: 'restored' });
    await restored.initialize();
    try {
        const { nodes: rNodes, edges: rEdges } = await readAllNodesAndEdges(restored);
        const restoredDigest = digestOf(rNodes, rEdges);
        assert.equal(restoredDigest, originalDigest, 'restored backup matches the PRE-migration fixture exactly');
    } finally {
        await restored.close();
    }
});

await test('--rollback flips graphEngine back to surreal; data untouched', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createSurrealWorkspace('migrate-rollback', home);
    const g = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await g.initialize();
    await loadFixture(g);
    await g.close();

    await migrateGraphToSqlite({ workspaceName: entry.name, home, backupOutDir: outDir() });
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'sqlite');

    const result = await rollbackGraphMigration({ workspaceName: entry.name, home });
    assert.equal(result.revertedTo, 'surreal');
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'surreal');

    // The workspace is USABLE again on surreal — the store was never touched.
    const reopened = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await reopened.initialize();
    try {
        const hub = await reopened.getNode('hub');
        assert.ok(hub, 'surreal data survives a migrate + rollback cycle');
    } finally {
        await reopened.close();
    }
});

await test('rollback of a non-sqlite workspace is refused', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createSurrealWorkspace('migrate-rollback-refuse', home);
    void entry;
    await assert.rejects(() => rollbackGraphMigration({ workspaceName: 'migrate-rollback-refuse', home }), /not 'sqlite'/);
});

await test('migrateGraphToSqlite refuses when a daemon serves the workspace home', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createSurrealWorkspace('migrate-daemon-refuse', home);
    const g = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await g.initialize();
    await g.upsertNode({ id: 'x', type: 'note', label: 'X', content: 'c', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    await g.close();

    const here = path.dirname(fileURLToPath(import.meta.url));
    const childPath = path.join(here, 'helpers', 'migrate-graph-daemon-refuse-child.ts');
    const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
    const result = spawnSync(tsxBin, [childPath, entry.name, home, outDir()], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`child failed (exit ${result.status}): ${result.stdout}\n${result.stderr}`);
    }
    assert.ok(result.stdout.includes('PASS'), `child reported: ${result.stdout}`);
});

await test('a crash BEFORE the flip (simulateCrashBeforeFlip) leaves the workspace on surreal and usable', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createSurrealWorkspace('migrate-crash', home);
    const g = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await g.initialize();
    await loadFixture(g);
    await g.close();

    const here = path.dirname(fileURLToPath(import.meta.url));
    const childPath = path.join(here, 'helpers', 'migrate-graph-crash-child.ts');
    const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
    const result = spawnSync(tsxBin, [childPath, entry.name, home, outDir()], { encoding: 'utf8' });
    assert.equal(result.status, 137, `child should have exited 137 (simulated crash); got ${result.status}: ${result.stdout}\n${result.stderr}`);

    // The registry must be COMPLETELY unaware anything happened.
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'surreal', 'graphEngine never flipped');

    // And the surreal store must still be fully readable — importRaw wrote
    // into graph.sqlite, a SEPARATE file; the crash happened after that
    // write succeeded, so this also proves the (now orphaned, harmless)
    // sqlite copy did not touch the surreal source.
    const reopened = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await reopened.initialize();
    try {
        const hub = await reopened.getNode('hub');
        assert.ok(hub, 'source workspace fully usable after the simulated crash');
        const stats = await reopened.getStats();
        assert.equal(stats.nodeCount, 7, 'no data loss on the surreal side');
    } finally {
        await reopened.close();
    }
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
