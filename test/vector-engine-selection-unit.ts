#!/usr/bin/env tsx
/**
 * vector-engine-selection-unit.ts — 3.21 step 2 part 2: vectorEngine
 * selection/default/backup/restore/search-worker-suppression.
 *
 * Mirrors graph-engine-selection-unit.ts's structure and coverage shape for
 * the VECTOR substrate (design: 321-STEP2-SQLITE-VECTOR-AND-PROMOTION-DESIGN.md
 * section 2, "Selection and default"):
 *
 *   - a NEW local workspace's `vectorEngine` is written explicitly as
 *     'sqlite' (createWorkspace() and fresh-home seeding);
 *   - an EXISTING workspace with an ABSENT `vectorEngine` field still
 *     resolves to 'lance' — a pre-3.21 workspace never silently changes
 *     substrate;
 *   - the `LORE_DEFAULT_VECTOR_ENGINE=lance` operator escape hatch;
 *   - an embedded end-to-end store/search against a `vectorEngine: 'sqlite'`
 *     workspace opened through `openWorkspaceVerbatim` (the real selection
 *     path, not a direct `new SqliteVerbatimStore`);
 *   - the search worker is never spawned for a sqlite-vector workspace, even
 *     with LORE_SEARCH_WORKER=1;
 *   - backup -> restore round trip of a SQLite-only workspace (graph.sqlite
 *     AND verbatim.sqlite both travel, both survive);
 *   - restore engine-mismatch refusal for the vector substrate specifically.
 *
 * Run: npx tsx test/vector-engine-selection-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createWorkspace, loadWorkspaces, setWorkspaceVectorEngine } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine, resolveNewWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { openWorkspaceVerbatim } from '../packages/lore/src/engines/openWorkspaceVerbatim.js';
import { resolveSearchWorkerIsolation } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { openWorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { backupWorkspace } from '../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-selection-home-'));
}

/** Deterministic char-code embedding — no ONNX/model download, fast and
 *  reproducible. Mirrors the pattern used across the sqlite-verbatim-store
 *  and promotion test suites. */
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'vector-selection-unit-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
}

console.log('VECTOR-ENGINE-SELECTION — 3.21 step 2 part 2');
console.log('='.repeat(72));

await test('createWorkspace() writes vectorEngine: sqlite (alongside graphEngine: sqlite) for a new workspace', () => {
    const home = freshHome();
    loadWorkspaces(home); // seeds "default" first, same reasoning as the graph twin
    const entry = createWorkspace('brand-new-vec', {}, home);
    assert.equal(entry.vectorEngine, 'sqlite', 'new workspace defaults to sqlite vectors');
    assert.equal(entry.graphEngine, 'sqlite', 'new workspace still defaults to sqlite graph too');
    assert.equal(resolveWorkspaceVectorEngine('brand-new-vec', home), 'sqlite');
});

await test('fresh-home seeding (no prior workspaces.json, no legacy .lore) writes vectorEngine: sqlite', () => {
    const home = freshHome();
    const file = loadWorkspaces(home);
    const defaultEntry = file.workspaces.find((w) => w.name === 'default');
    assert.ok(defaultEntry);
    assert.equal(defaultEntry!.vectorEngine, 'sqlite');
});

await test('fresh-home seeding that ADOPTS an existing legacy .lore leaves vectorEngine absent (stays lance)', () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    const file = loadWorkspaces(home);
    const defaultEntry = file.workspaces.find((w) => w.name === 'default');
    assert.ok(defaultEntry);
    assert.equal(defaultEntry!.vectorEngine, undefined, 'adopted legacy home: field stays absent');
    assert.equal(resolveWorkspaceVectorEngine('default', home), 'lance', 'absent still resolves to lance');
});

await test('an EXISTING workspace with an absent vectorEngine field resolves to lance, never silently switches', () => {
    const home = freshHome();
    loadWorkspaces(home);
    const controlPath = path.join(home, 'workspaces.json');
    const file = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    file.workspaces.push({ name: 'legacy-style-vec', path: path.join(home, 'legacy-style-vec'), createdAt: new Date().toISOString() });
    fs.writeFileSync(controlPath, JSON.stringify(file, null, 2));
    assert.equal(resolveWorkspaceVectorEngine('legacy-style-vec', home), 'lance');
});

await test('LORE_DEFAULT_VECTOR_ENGINE=lance escape hatch — resolveNewWorkspaceVectorEngine() and createWorkspace()', () => {
    const prior = process.env['LORE_DEFAULT_VECTOR_ENGINE'];
    process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
    try {
        assert.equal(resolveNewWorkspaceVectorEngine(), 'lance');
        const home = freshHome();
        loadWorkspaces(home);
        const entry = createWorkspace('escape-hatch-vec-ws', {}, home);
        assert.equal(entry.vectorEngine, 'lance');
    } finally {
        if (prior === undefined) delete process.env['LORE_DEFAULT_VECTOR_ENGINE'];
        else process.env['LORE_DEFAULT_VECTOR_ENGINE'] = prior;
    }
});

await test('an unrecognised LORE_DEFAULT_VECTOR_ENGINE value is treated as sqlite (only "lance" opts out)', () => {
    const prior = process.env['LORE_DEFAULT_VECTOR_ENGINE'];
    process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'bogus';
    try {
        assert.equal(resolveNewWorkspaceVectorEngine(), 'sqlite');
    } finally {
        if (prior === undefined) delete process.env['LORE_DEFAULT_VECTOR_ENGINE'];
        else process.env['LORE_DEFAULT_VECTOR_ENGINE'] = prior;
    }
});

await test('setWorkspaceVectorEngine() atomically flips the field (the promotion hook\'s primitive)', () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('flip-vec-ws', {}, home);
    assert.equal(entry.vectorEngine, 'sqlite');
    const updated = setWorkspaceVectorEngine('flip-vec-ws', 'lance', home);
    assert.equal(updated.vectorEngine, 'lance');
    assert.equal(resolveWorkspaceVectorEngine('flip-vec-ws', home), 'lance');
});

await test('embedded end-to-end: openWorkspaceVerbatim() on a sqlite-selected workspace — store, keyword (bm25) + semantic search', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('e2e-sqlite-vec', {}, home);
    assert.equal(entry.vectorEngine, 'sqlite');

    const store = openWorkspaceVerbatim(entry.path, new DetEmbedProvider(), { workspaceId: 'e2e-sqlite-vec', home });
    assert.ok(store instanceof SqliteVerbatimStore, 'openWorkspaceVerbatim resolved to SqliteVerbatimStore');
    await store.initialize();
    try {
        await store.store({ id: 'v1', text: 'a distinctive marker phrase about lighthouses', metadata: { type: 'note', label: 'Lighthouse' } });
        await store.store({ id: 'v2', text: 'an unrelated document about kitchens', metadata: { type: 'note', label: 'Kitchen' } });

        const bm25 = await store.bm25Search('lighthouses', 5);
        assert.ok(bm25.hits.some((h) => h.id === 'v1'), 'bm25 keyword search finds the stored row');

        const semantic = await store.search('a distinctive marker phrase about lighthouses', 5);
        assert.ok(semantic.some((h) => h.id === 'v1'), 'vector search finds the stored row via its own text');
    } finally {
        await store.close();
    }
});

await test('a lance-selected workspace still resolves to VerbatimStore through the same openWorkspaceVerbatim() call', () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('e2e-lance-vec', {}, home);
    setWorkspaceVectorEngine('e2e-lance-vec', 'lance', home);
    const store = openWorkspaceVerbatim(entry.path, new DetEmbedProvider(), { workspaceId: 'e2e-lance-vec', home });
    assert.ok(store instanceof VerbatimStore, 'openWorkspaceVerbatim resolved to VerbatimStore for a lance workspace');
});

await test('the search worker is NEVER spawned for a sqlite-vector workspace, even with LORE_SEARCH_WORKER=1', () => {
    const prior = process.env['LORE_SEARCH_WORKER'];
    process.env['LORE_SEARCH_WORKER'] = '1';
    try {
        assert.equal(resolveSearchWorkerIsolation('/tmp/whatever', undefined, 'sqlite'), false, 'sqlite engineKind must short-circuit to false ahead of the env gate');
        // A lance workspace, by contrast, DOES honour the env gate — proves
        // the sqlite short-circuit is engine-specific, not a global override.
        assert.equal(resolveSearchWorkerIsolation('/tmp/whatever', undefined, 'lance'), true);
    } finally {
        if (prior === undefined) delete process.env['LORE_SEARCH_WORKER'];
        else process.env['LORE_SEARCH_WORKER'] = prior;
    }
});

await test('backup -> restore round trip of a SQLite-only workspace (graph.sqlite AND verbatim.sqlite both travel)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('backup-roundtrip-sqlite-vec', {}, home);
    assert.equal(entry.graphEngine, 'sqlite');
    assert.equal(entry.vectorEngine, 'sqlite');

    const graph = openWorkspaceGraph(entry.path, { workspaceId: entry.name, home });
    await graph.initialize();
    await graph.upsertNode({ id: 'k1', type: 'decision', label: 'Alpha', content: 'first body', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    await graph.close();

    const verbatim = openWorkspaceVerbatim(entry.path, new DetEmbedProvider(), { workspaceId: entry.name, home });
    await verbatim.initialize();
    await verbatim.store({ id: 'k1', text: 'first body', metadata: { type: 'decision', label: 'Alpha' } });
    await verbatim.close();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-selection-out-'));
    const backupResult = await backupWorkspace({ workspaceDir: entry.path, workspaceName: entry.name, outDir });
    assert.ok(backupResult.files.includes('graph.sqlite'), `graph.sqlite travelled (${backupResult.files.join(', ')})`);
    assert.ok(backupResult.files.includes('verbatim.sqlite'), `verbatim.sqlite travelled (${backupResult.files.join(', ')})`);

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-selection-dst-'));
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    await restoreWorkspace({
        tarballPath: backupResult.tarballPath, workspaceDir: destDir,
        expectedEngine: 'sqlite', expectedVectorEngine: 'sqlite',
    });

    const restoredGraph = new SqliteGraph(destDir, { workspaceId: 'restored' });
    await restoredGraph.initialize();
    try {
        const node = await restoredGraph.getNode('k1');
        assert.ok(node, 'graph node survived backup+restore');
        assert.equal(node!.label, 'Alpha');
    } finally {
        await restoredGraph.close();
    }

    const restoredVerbatim = new SqliteVerbatimStore(destDir, new DetEmbedProvider());
    await restoredVerbatim.initialize();
    try {
        const row = await restoredVerbatim.getById('k1');
        assert.ok(row, 'verbatim row survived backup+restore');
        assert.equal(row!.text, 'first body');
    } finally {
        await restoredVerbatim.close();
    }
});

await test('restore refuses a sqlite-vector archive into a workspace registered as lance', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('mismatch-sqlite-vec-src', {}, home);
    const verbatim = openWorkspaceVerbatim(entry.path, new DetEmbedProvider(), { workspaceId: entry.name, home });
    await verbatim.initialize();
    await verbatim.store({ id: 'x', text: 'c', metadata: {} });
    await verbatim.close();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-mismatch-out-'));
    const backupResult = await backupWorkspace({ workspaceDir: entry.path, workspaceName: entry.name, outDir });

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-mismatch-dst-'));
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    await assert.rejects(
        () => restoreWorkspace({ tarballPath: backupResult.tarballPath, workspaceDir: destDir, expectedVectorEngine: 'lance' }),
        /engine mismatch/i,
    );
});

await test('restore refuses a lance-vector archive into a workspace registered as sqlite', async () => {
    const home = freshHome();
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-lance-src-'));
    fs.mkdirSync(path.join(workspaceDir, '.lore'), { recursive: true });
    const store = new VerbatimStore(workspaceDir, new DetEmbedProvider());
    await store.initialize();
    await store.store({ id: 'y', text: 'c', metadata: {} });
    await store.close();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-lance-out-'));
    const backupResult = await backupWorkspace({ workspaceDir, workspaceName: 'lance-src', outDir });

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-lance-dst-'));
    fs.mkdirSync(path.join(destDir, '.lore'), { recursive: true });
    await assert.rejects(
        () => restoreWorkspace({ tarballPath: backupResult.tarballPath, workspaceDir: destDir, expectedVectorEngine: 'sqlite' }),
        /engine mismatch/i,
    );
    void home;
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
