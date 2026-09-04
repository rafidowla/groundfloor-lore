#!/usr/bin/env tsx
/**
 * test/diagnostics-consistency-unit.ts — tri-substrate consistency
 * diagnostic (gap #10 of the architecture backlog).
 *
 * All-in-memory fakes for graph + vector + table storage — keeps the
 * test substrate-independent and avoids the legacy graph engine/LanceDB init cost. The
 * real implementations satisfy the same narrow interfaces the
 * diagnostic uses.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    diagnoseConsistency,
    summarizeReport,
    type GraphReader,
} from '../packages/lore/src/diagnostics/consistency.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import type { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

/** Minimal GraphReader fake — only the `listNodes` overload the
 *  diagnostic uses. */
function fakeGraph(nodeIds: string[]): GraphReader {
    return {
        async listNodes() {
            return nodeIds.map(id => ({ id } as LoreNode));
        },
    };
}

/** Minimal VerbatimStore fake — only the `listIds(prefix, opts)` method
 *  the diagnostic uses. Returns ids that already include the prefix
 *  (mirroring the real LanceDB row shape).
 *
 *  `idsByProject` (2026-06-09) — when set, the fake honors the
 *  `opts.project` workspace-scope filter the diagnostic now passes.
 *  Each id is mapped to its owning project; only ids whose project
 *  matches `opts.project` are returned. Without idsByProject the fake
 *  is project-agnostic, back-compat with the original tests. */
function fakeVectorStore(
    idsWithPrefix: string[],
    idsByProject?: Record<string, string>,
): VerbatimStore {
    return {
        async listIds(prefix?: string, opts?: { project?: string }) {
            let pool = idsWithPrefix;
            if (opts?.project && idsByProject) {
                pool = pool.filter(id => idsByProject[id] === opts.project);
            }
            if (!prefix) return pool;
            return pool.filter(id => id.startsWith(prefix));
        },
    } as unknown as VerbatimStore;
}

function mkTmpSqlite(): { dbPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-diag-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

console.log('diagnostics/consistency');

/* ---------- happy path ---------- */

test('all-in-sync: no issues, hasIssues is false', async () => {
    const graph = fakeGraph(['a', 'b', 'c']);
    const vector = fakeVectorStore(['lore:a', 'lore:b', 'lore:c']);
    const report = await diagnoseConsistency(graph, vector, null, { workspace: 'dev' });
    assert.equal(report.graphNodeCount, 3);
    assert.equal(report.vectorEmbeddingCount, 3);
    assert.equal(report.missingEmbeddings.length, 0);
    assert.equal(report.orphanEmbeddings.length, 0);
    assert.equal(report.hasIssues, false);
    assert.match(summarizeReport(report), /OK/);
});

/* ---------- missing embeddings (graph has more than vector) ---------- */

test('missingEmbeddings lists graph nodes with no matching embedding', async () => {
    const graph = fakeGraph(['a', 'b', 'c', 'd']);
    const vector = fakeVectorStore(['lore:a', 'lore:b']);
    const report = await diagnoseConsistency(graph, vector, null, { workspace: 'dev' });
    assert.deepEqual(report.missingEmbeddings.sort(), ['c', 'd']);
    assert.equal(report.orphanEmbeddings.length, 0);
    assert.equal(report.hasIssues, true);
});

/* ---------- orphan embeddings (vector has more than graph) ---------- */

test('orphanEmbeddings lists embeddings with no matching graph node', async () => {
    const graph = fakeGraph(['a']);
    const vector = fakeVectorStore(['lore:a', 'lore:ghost', 'lore:zombie']);
    const report = await diagnoseConsistency(graph, vector, null, { workspace: 'dev' });
    assert.equal(report.missingEmbeddings.length, 0);
    assert.deepEqual(report.orphanEmbeddings.sort(), ['ghost', 'zombie']);
    assert.equal(report.hasIssues, true);
});

/* ---------- snapshot revs and non-prefixed ids are ignored ---------- */

test('snapshot revs (#rev) and non-lore-prefixed ids are skipped', async () => {
    const graph = fakeGraph(['a']);
    const vector = fakeVectorStore([
        'lore:a',
        'lore:a#rev2026-01-01T00:00:00.000Z', // snapshot rev — skip
        'lore:b#rev2026-02-01T00:00:00.000Z', // snapshot rev — skip
        'unrelated-id',                       // wrong prefix — skip
    ]);
    const report = await diagnoseConsistency(graph, vector, null, { workspace: 'dev' });
    assert.equal(report.vectorEmbeddingCount, 1);
    assert.equal(report.orphanEmbeddings.length, 0);
    assert.equal(report.hasIssues, false);
});

/* ---------- absent vector store: graph-only report ---------- */

test('null vector store yields zero vector counts but does not crash', async () => {
    const graph = fakeGraph(['a', 'b']);
    const report = await diagnoseConsistency(graph, null, null, { workspace: 'dev' });
    assert.equal(report.graphNodeCount, 2);
    assert.equal(report.vectorEmbeddingCount, 0);
    // Every graph node counts as "missing" relative to an empty vector store.
    assert.deepEqual(report.missingEmbeddings.sort(), ['a', 'b']);
});

/* ---------- SQLite orphan walk ---------- */

test('sqliteOrphans flags rows whose node_id is absent from the graph', async () => {
    const t = mkTmpSqlite();
    try {
        const storage = new SqliteTableStorage(t.dbPath);
        await storage.createTable({
            name: 'code_change_event',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'node_id', type: 'string', indexed: true },
            ],
        });
        await storage.insertBatch('code_change_event', [
            { id: 'e1', node_id: 'a' },        // alive
            { id: 'e2', node_id: 'b' },        // alive
            { id: 'e3', node_id: 'ghost' },    // dead
            { id: 'e4', node_id: 'zombie' },   // dead
            { id: 'e5', node_id: 'ghost' },    // dead, duplicate
        ]);

        const graph = fakeGraph(['a', 'b']);
        const report = await diagnoseConsistency(graph, null, storage, {
            workspace: 'dev',
            sqliteChecks: [{ table: 'code_change_event', column: 'node_id' }],
        });
        assert.equal(report.sqliteOrphans.length, 1);
        const r = report.sqliteOrphans[0];
        assert.equal(r.table, 'code_change_event');
        assert.equal(r.column, 'node_id');
        assert.deepEqual([...r.orphans].sort(), ['ghost', 'zombie'], 'distinct orphans only');
        assert.equal(r.truncated, false);
        assert.equal(report.hasIssues, true);
        storage.close();
    } finally { t.cleanup(); }
});

test('sqliteOrphans respects the cap and reports truncated=true', async () => {
    const t = mkTmpSqlite();
    try {
        const storage = new SqliteTableStorage(t.dbPath);
        await storage.createTable({
            name: 'evt',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'node_id', type: 'string' },
            ],
        });
        const rows = Array.from({ length: 20 }, (_, i) => ({
            id: `e${i}`, node_id: `ghost-${i}`,
        }));
        await storage.insertBatch('evt', rows);

        const graph = fakeGraph([]);
        const report = await diagnoseConsistency(graph, null, storage, {
            workspace: 'dev',
            sqliteChecks: [{ table: 'evt', column: 'node_id' }],
            sqliteOrphanCap: 5,
        });
        assert.equal(report.sqliteOrphans[0].orphans.length, 5);
        assert.equal(report.sqliteOrphans[0].truncated, true);
        storage.close();
    } finally { t.cleanup(); }
});

test('sqliteOrphans handles non-existent table gracefully', async () => {
    const t = mkTmpSqlite();
    try {
        const storage = new SqliteTableStorage(t.dbPath);
        const graph = fakeGraph(['a']);
        const report = await diagnoseConsistency(graph, null, storage, {
            workspace: 'dev',
            sqliteChecks: [{ table: 'does_not_exist', column: 'node_id' }],
        });
        // Doesn't crash; reports an empty orphan list for the missing table.
        assert.equal(report.sqliteOrphans.length, 1);
        assert.equal(report.sqliteOrphans[0].orphans.length, 0);
        storage.close();
    } finally { t.cleanup(); }
});

/* ---------- summarizeReport ---------- */

test('summarizeReport produces a one-line digest', async () => {
    const graph = fakeGraph(['a', 'b']);
    const vector = fakeVectorStore(['lore:a', 'lore:ghost']);
    const report = await diagnoseConsistency(graph, vector, null, { workspace: 'dev' });
    const summary = summarizeReport(report);
    assert.match(summary, /workspace=dev/);
    assert.match(summary, /graph=2/);
    assert.match(summary, /vector=2/);
    assert.match(summary, /missing_embeddings=1/);
    assert.match(summary, /orphan_embeddings=1/);
    assert.ok(!summary.includes('OK'));
});

/* ---------- L5b workspace-aliasing (2026-06-09) ----------
 * Sprint L5b registers extra workspace names (e.g. `atlas`) that
 * physically share the default workspace's the legacy graph engine+LanceDB store; per-
 * workspace separation is via the `project` column. Pre-fix, the
 * diagnostic compared THIS workspace's graph nodes against the WHOLE
 * lance table — so every cross-aliased vector was reported as orphan.
 * Fixed by passing `project: opts.workspace` to listIds so both sides
 * of the set-difference are workspace-scoped.
 */

test('L5b alias: workspace-scoped listIds → cross-aliased vectors are not flagged as orphans', async () => {
    // Default workspace has 2 nodes (a, b) + 2 matching vectors.
    // Atlas workspace ALSO shares the same physical lance table and
    // contributes 3 vectors (x, y, z) — atlas-owned, not default-owned.
    // Pre-fix: orphans=[x,y,z]. Post-fix: orphans=[].
    const graph = fakeGraph(['a', 'b']);
    const vector = fakeVectorStore(
        ['lore:a', 'lore:b', 'lore:x', 'lore:y', 'lore:z'],
        {
            'lore:a': 'default', 'lore:b': 'default',
            'lore:x': 'atlas', 'lore:y': 'atlas', 'lore:z': 'atlas',
        },
    );
    const report = await diagnoseConsistency(graph, vector, null, { workspace: 'default' });
    assert.equal(report.graphNodeCount, 2);
    assert.equal(report.vectorEmbeddingCount, 2, 'vector view is project-scoped to default only');
    assert.equal(report.orphanEmbeddings.length, 0, 'atlas-owned vectors must not be reported as default orphans');
    assert.equal(report.missingEmbeddings.length, 0);
    assert.equal(report.hasIssues, false);
});

test('L5b alias: a TRUE orphan in this workspace is still reported (project filter doesn’t hide real defects)', async () => {
    // 'ghost' belongs to default (project=default) but has no graph node →
    // it IS a true orphan and MUST be flagged.
    const graph = fakeGraph(['a']);
    const vector = fakeVectorStore(
        ['lore:a', 'lore:ghost', 'lore:atlas-x'],
        { 'lore:a': 'default', 'lore:ghost': 'default', 'lore:atlas-x': 'atlas' },
    );
    const report = await diagnoseConsistency(graph, vector, null, { workspace: 'default' });
    assert.deepEqual(report.orphanEmbeddings, ['ghost']);
    assert.equal(report.hasIssues, true);
});

test('L5b alias: project-agnostic store (no idsByProject map) returns full set — back-compat', async () => {
    // Confirms readers that ignore the new opts (e.g. older dataplane
    // stub) still satisfy the interface and return the unfiltered set.
    const graph = fakeGraph(['a']);
    const vector = fakeVectorStore(['lore:a', 'lore:b']); // no project map → opts ignored
    const report = await diagnoseConsistency(graph, vector, null, { workspace: 'default' });
    assert.deepEqual(report.orphanEmbeddings, ['b']);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
