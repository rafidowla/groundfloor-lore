#!/usr/bin/env tsx
/**
 * maintain-retention-engines-unit.ts — 3.25.2 Defect 2.
 *
 * Node retention did nothing on a SQLite graph: `maintain`'s selection
 * projects `legalHold`, the SQLite `nodes` table has no such column, so
 * `bulkListProjected` threw "no such column", `maintain` swallowed it into
 * `operations[nodeRetention].errors`, reported `inspected: 0`, and still said
 * `ok: true`.
 *
 * Fix under test:
 *   (b) `bulkListProjected` returns `null` for a requested column the SQLite
 *       `nodes` table lacks (legalHold is not persistable on EITHER engine);
 *   an ENABLED operation that records errors now makes the top-level maintain
 *   result `ok: false` + `failedOperations`, and the MCP tool result `isError`.
 *
 * Covers, against BOTH SurrealGraph and SqliteGraph:
 *   - bulkListProjected with the retention columns (incl. legalHold) works;
 *   - nodeRetention inspects > 0 nodes (dry-run), skips protected + recent;
 *   - apply with action=archive and action=delete;
 *   - the retentionSweep age rule's own projection call + a sweep() run;
 *   - a failing retention step surfaces at the top level (core helper and the
 *     real MCP `maintain` tool handler).
 *
 * Run: npx tsx test/maintain-retention-engines-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { resolveMaintainPolicy } from '../packages/lore/src/engines/maintain/policy.js';
import { runMaintenance, failedOperations } from '../packages/lore/src/engines/maintain/maintain.js';
import { formatMaintainReport } from '../packages/lore/src/engines/maintain/format.js';
import { GraphNodeStore, AlwaysSafe, type GraphLike } from '../packages/lore/src/engines/maintain/adapters.js';
import { RetentionSweeper } from '../packages/lore/src/engines/retentionSweep.js';
import { registerMaintainTools } from '../packages/lore/src/mcp/tools/maintain.js';

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

const DAY = 86_400_000;
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const base = { type: 'note', label: 'L', content: 'body', project: '*', ecosystem: '*', metadata: '{}' };

type Engine = 'surreal' | 'sqlite';
async function openGraph(engine: Engine): Promise<SurrealGraph | SqliteGraph> {
    const dir = tmp(`lore-retention-${engine}-`);
    const g = engine === 'surreal'
        ? new SurrealGraph(dir, { workspaceId: 'ws', cacheDisabled: true })
        : new SqliteGraph(dir, { workspaceId: 'ws', cacheDisabled: true });
    await g.initialize();
    return g;
}

interface Seeded { graph: SurrealGraph | SqliteGraph; now: number }
/**
 * 3 cold + unprotected, 1 cold + tagged `pinned` (protected), 2 recent.
 * `now` is chosen between the two write batches so with retentionDays=1 and
 * coldSignal 'update' the first batch is older than the cutoff and the second
 * is not — no waiting for real days.
 */
async function seed(engine: Engine): Promise<Seeded> {
    const graph = await openGraph(engine);
    for (const id of ['cold1', 'cold2', 'cold3']) await graph.upsertNode({ id, ...base, tags: ['t'] } as never);
    await graph.upsertNode({ id: 'held', ...base, tags: ['pinned'] } as never);
    await sleep(60);
    const mid = Date.now();
    await sleep(60);
    for (const id of ['recent1', 'recent2']) await graph.upsertNode({ id, ...base, tags: ['t'] } as never);
    return { graph, now: mid + DAY };
}

const policyFor = (over: Parameters<typeof resolveMaintainPolicy>[0] = {}) => resolveMaintainPolicy({
    retentionDays: 1, coldSignal: 'update',
    enabled: { compaction: false, versionCleanup: false, nodeRetention: true, ephemeralExpiry: false },
    ...over,
}, { skipEnv: true });

console.log('MAINTAIN + RETENTION ON BOTH GRAPH ENGINES — 3.25.2 Defect 2');
console.log('='.repeat(72));

for (const engine of ['surreal', 'sqlite'] as const) {
    await test(`${engine}: bulkListProjected with the retention columns (incl. legalHold) works`, async () => {
        const { graph } = await seed(engine);
        try {
            const cols = ['tags', 'status', 'legalHold', 'createdAt', 'lastAccessedAt', 'last_retrieved_at'];
            const page = await graph.bulkListProjected('*', cols, 100, null);
            assert.equal(page.rows.length, 6);
            for (const r of page.rows) {
                assert.ok(r['legalHold'] === null || r['legalHold'] === undefined, 'legalHold is never set (not persistable)');
                assert.equal(typeof r['id'], 'string');
            }
            // An unknown-but-valid column is also tolerated, not a throw.
            const page2 = await graph.bulkListProjected('*', ['definitelyNotAColumn'], 100, null);
            assert.equal(page2.rows.length, 6);
            // assertIdent still guards the interpolated names.
            await assert.rejects(() => graph.bulkListProjected('*', ['id; DROP TABLE nodes'], 10, null));
        } finally {
            await graph.close();
        }
    });

    await test(`${engine}: nodeRetention dry-run inspects > 0, skips protected and recent`, async () => {
        const { graph, now } = await seed(engine);
        try {
            const report = await runMaintenance(policyFor(), { nodes: new GraphNodeStore(graph as unknown as GraphLike), safety: new AlwaysSafe() }, { dryRun: true, now });
            const op = report.operations.find((o) => o.operation === 'nodeRetention')!;
            assert.deepEqual(op.errors, [], `no errors: ${op.errors.join('; ')}`);
            assert.equal(op.ran, true);
            assert.equal(report.nodes.inspected, 6);
            assert.equal(report.nodes.protectedSkipped, 1, 'pinned node is protected');
            assert.equal(report.nodes.recentSkipped, 2, 'two recent nodes skipped');
            assert.equal(report.nodes.candidates, 3);
            assert.equal(report.nodes.archived + report.nodes.deleted, 0, 'dry-run writes nothing');
            assert.deepEqual(failedOperations([report]), []);
        } finally {
            await graph.close();
        }
    });

    await test(`${engine}: nodeRetention apply (archive) archives only the cold unprotected nodes`, async () => {
        const { graph, now } = await seed(engine);
        try {
            const report = await runMaintenance(policyFor({ nodeRetentionAction: 'archive' }), { nodes: new GraphNodeStore(graph as unknown as GraphLike), safety: new AlwaysSafe() }, { dryRun: false, now });
            assert.deepEqual(report.operations.find((o) => o.operation === 'nodeRetention')!.errors, []);
            assert.equal(report.nodes.archived, 3);
            for (const id of ['cold1', 'cold2', 'cold3']) assert.equal((await graph.getNode(id))?.status, 'archived', id);
            for (const id of ['held', 'recent1', 'recent2']) assert.notEqual((await graph.getNode(id))?.status, 'archived', `${id} untouched`);
        } finally {
            await graph.close();
        }
    });

    await test(`${engine}: nodeRetention apply (delete) deletes only the cold unprotected nodes`, async () => {
        const { graph, now } = await seed(engine);
        try {
            const report = await runMaintenance(policyFor({ nodeRetentionAction: 'delete' }), { nodes: new GraphNodeStore(graph as unknown as GraphLike), safety: new AlwaysSafe() }, { dryRun: false, now });
            assert.deepEqual(report.operations.find((o) => o.operation === 'nodeRetention')!.errors, []);
            assert.equal(report.nodes.deleted, 3);
            for (const id of ['cold1', 'cold2', 'cold3']) assert.equal(await graph.getNode(id), null, `${id} deleted`);
            for (const id of ['held', 'recent1', 'recent2']) assert.ok(await graph.getNode(id), `${id} kept`);
        } finally {
            await graph.close();
        }
    });

    await test(`${engine}: retentionSweep age rule's projection works and sweep() reports no errors`, async () => {
        const { graph } = await seed(engine);
        try {
            // The exact projection retentionSweep's age rule issues (retentionSweep.ts).
            const page = await graph.bulkListProjected('*', ['type', 'label', 'content', 'legalHold', 'updatedAt'], 1000, null);
            assert.equal(page.rows.length, 6);
            assert.ok(page.rows.every((r) => r['type'] === 'note' && typeof r['updatedAt'] === 'string' && !r['legalHold']));
            // Rules are sourced from a plugin registry that no longer exists, so
            // sweep() evaluates zero rules today; it must still run cleanly on this engine.
            const sweeper = new RetentionSweeper(graph as never, { log: () => undefined } as never);
            const result = await sweeper.sweep({ dryRun: true });
            assert.equal(result.errors, 0);
        } finally {
            await graph.close();
        }
    });
}

/** A graph whose paged scan always throws: the shape of the original SQLite failure. */
const failingGraph = {
    listNodes: async () => [],
    deleteNode: async () => true,
    archiveNode: async () => undefined,
    bulkListProjected: async () => { throw new Error('no such column: legalHold'); },
} as unknown as GraphLike;

await test('a failing retention step is reported at the top level (core helper + format)', async () => {
    const report = await runMaintenance(policyFor(), { nodes: new GraphNodeStore(failingGraph), safety: new AlwaysSafe() }, { dryRun: true, now: Date.now() });
    const op = report.operations.find((o) => o.operation === 'nodeRetention')!;
    assert.equal(op.ran, false);
    assert.ok(op.errors.length > 0, 'per-op errors[] kept');
    assert.deepEqual(failedOperations([report]), ['nodeRetention']);
    const text = formatMaintainReport(report, policyFor());
    assert.match(text, /FAILED: nodeRetention/);
    assert.match(text, /no such column: legalHold/);
});

await test('failedOperations: disabled ops never count; ops are de-duplicated across reports', async () => {
    const failing = await runMaintenance(policyFor(), { nodes: new GraphNodeStore(failingGraph), safety: new AlwaysSafe() }, { dryRun: true, now: Date.now() });
    const disabled = await runMaintenance(policyFor({ enabled: { nodeRetention: false } }), { nodes: new GraphNodeStore(failingGraph), safety: new AlwaysSafe() }, { dryRun: true, now: Date.now() });
    assert.deepEqual(failedOperations([disabled]), []);
    assert.deepEqual(failedOperations([failing, failing, disabled]), ['nodeRetention']);
});

/** Drive the REAL `maintain` MCP tool handler with a stub server. */
async function callMaintainTool(graph: unknown, args: Record<string, unknown>): Promise<{ isError?: boolean; body: any }> {
    let handler: ((a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | undefined;
    const server = { tool: (_name: string, _desc: string, _schema: unknown, h: typeof handler) => { handler = h; } };
    const home = tmp('lore-maintain-tool-home-');
    registerMaintainTools(server as never, {
        store: { loreGraph: graph } as never, graphBasePath: home, dataHome: home, deploymentMode: 'local',
    });
    const res = await handler!({ disable: ['compaction', 'versionCleanup', 'ephemeralExpiry'], ...args });
    return { isError: res.isError, body: JSON.parse(res.content[0]!.text) };
}

await test('MCP maintain: a failing enabled retention step => ok:false, failedOperations, isError', async () => {
    const { isError, body } = await callMaintainTool(failingGraph, { dry_run: true });
    assert.equal(isError, true);
    assert.equal(body.ok, false);
    assert.deepEqual(body.failedOperations, ['nodeRetention']);
    const wsOps = body.reports[0].operations as Array<{ operation: string; errors: string[] }>;
    assert.ok(wsOps.find((o) => o.operation === 'nodeRetention')!.errors.length > 0, 'per-op errors[] still present');
});

for (const engine of ['surreal', 'sqlite'] as const) {
    await test(`MCP maintain on ${engine}: healthy retention => ok:true, empty failedOperations, no isError`, async () => {
        const { graph } = await seed(engine);
        try {
            const { isError, body } = await callMaintainTool(graph, { dry_run: true });
            assert.equal(isError, undefined);
            assert.equal(body.ok, true);
            assert.deepEqual(body.failedOperations, []);
            assert.equal(body.reports[0].nodes.inspected, 6, 'retention actually inspected the nodes');
        } finally {
            await graph.close();
        }
    });
}

await test('MCP maintain: a failing step that is DISABLED does not fail the call', async () => {
    const { isError, body } = await callMaintainTool(failingGraph, { dry_run: true, disable: ['compaction', 'versionCleanup', 'ephemeralExpiry', 'nodeRetention'] });
    assert.equal(isError, undefined);
    assert.equal(body.ok, true);
    assert.deepEqual(body.failedOperations, []);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
