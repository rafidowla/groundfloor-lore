#!/usr/bin/env tsx
/**
 * nw-bulk-no-lost-writes-unit.ts — high-volume bulk reindex must land with
 * ZERO lost writes.
 *
 * Two pre-existing Lore-level defects combined to drop writes under a large
 * reindex:
 *
 *   1. runBulkIngest fanned out an unbounded Promise.all of upserts. Each
 *      upsert's read-decide-write getNode borrows an engine connection;
 *      thousands at once overflowed the pool (on the legacy graph engine:
 *      `LegacyConnectionPool: waiter queue full (200/200)`) and the writes
 *      FAILED. Fixed by bounding the fan-out (LORE_BULK_INGEST_CONCURRENCY) —
 *      an engine-agnostic fix, verified here against SurrealGraph.
 *
 *   2. addEdge silently created ZERO edges when an endpoint was absent (e.g.
 *      because its node write failed in #1) and returned success — a
 *      database silently dropping a write. Fixed on both engines: addEdge
 *      now throws `edge_endpoint_missing` on a no-op instead of succeeding.
 *
 * Guard: 2,000 nodes via the bulk API land with 0 failures; 5,000 edges over
 * them all land (no silent loss); and an edge to a missing endpoint throws
 * loudly instead of vanishing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { runBulkIngest, type BulkIngestDeps } from '../packages/lore/src/mcp/bulkIngest.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';

const N_NODES = 2000, N_EDGES = 5000;

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

/** Minimal deps for a graph-only bulk ingest (embed:'async' → no real ONNX;
 *  outbox/version absent → inline graph write only). The engine writes are the
 *  only thing under test. */
function makeDeps(graph: SurrealGraph): BulkIngestDeps {
    const noop = () => undefined;
    const stub = new Proxy({}, { get: () => noop }) as never;
    return {
        graph: graph as never,
        graphRegistry: null,                       // → resolvedGraphs = deps.graph
        activeWorkspaceName: () => '__not_active__', // isActive=false → no WAL append
        outboxStore: undefined,                    // inline path
        embedQueue: { enqueue: noop } as never,    // embed:'async' enqueues here
        verbatimStore: stub,                       // not called (skipEmbed in step 1b)
        storageClient: stub,
        loreVerbatim: stub,
        embeddingProvider: stub,                   // not called for embed:'async'
        getWal: () => stub,                        // not reached (isActive=false)
        versionStore: undefined,
        // REQUIRED field (BulkIngestDeps.autolinkTracker). These deps run with
        // autolink off, but the type refuses to let a call site omit the
        // tracker and silently land on the process-global one — so the
        // fallback is named here instead of hidden behind a `??`.
        autolinkTracker: defaultAutolinkTracker,
    };
}

console.log('NW-BULK — high-volume bulk reindex lands with 0 lost writes');

await test(`bulk-ingest ${N_NODES} nodes → 0 failures (no pool saturation)`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-nwbulk-'));
    try {
        const graph = new SurrealGraph(dir);
        await graph.initialize();
        const nodes = Array.from({ length: N_NODES }, (_, i) => ({
            id: `code-file:f${i}.ts`, workspace: 'default', ecosystem: '*',
            nodeData: {
                id: `code-file:f${i}.ts`, type: 'note', label: `f${i}`,
                // every 50th is "large" (mimics cli.ts/daemon.ts) to stress content size too
                content: i % 50 === 0 ? 'x'.repeat(200_000) : 'c',
                tags: ['atlas', 'code-file'], project: 'lorebase', ecosystem: '*', metadata: '{}',
            },
        }));

        const res = await runBulkIngest(nodes as never, { embed: 'async', autolink: false }, makeDeps(graph));
        const failures = res.results.filter((r) => !r.ok);
        assert.equal(res.succeeded, N_NODES, `all ${N_NODES} nodes must succeed; got ${res.succeeded}. sample failures: ${JSON.stringify(failures.slice(0, 3))}`);
        assert.equal(failures.length, 0, 'no per-node failures');

        // 5,000 edges over the 2,000 committed nodes → all unique pairs land,
        // none silently dropped. (formula repeats every 2,000 → 2,000 unique.)
        let threw = 0;
        for (let k = 0; k < N_EDGES; k++) {
            const s = k % N_NODES, t = (k * 7 + 1) % N_NODES;
            await graph.addEdge({ sourceId: `code-file:f${s}.ts`, targetId: `code-file:f${t}.ts`, relation: 'imports' } as never)
                .catch(() => { threw++; });
        }
        assert.equal(threw, 0, 'no valid edge should throw (all endpoints exist)');
        const stats = await graph.getStats();
        assert.equal(stats.edgeCount, N_NODES, `all ${N_NODES} unique edges must be in the graph (no silent loss); got ${stats.edgeCount}`);

        await graph.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('addEdge to a missing endpoint throws edge_endpoint_missing (no silent drop)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-nwbulk-edge-'));
    try {
        const graph = new SurrealGraph(dir);
        await graph.initialize();
        const mk = (id: string) => ({ id, type: 'note', label: 'L', content: 'c', tags: ['x'], project: 'p', ecosystem: 'e', metadata: '{}', security_scopes: [] as string[], language: null, ephemeral: false, ttl_ms: null, stale: false });
        await graph.upsertNode(mk('exists') as never);
        await assert.rejects(
            () => graph.addEdge({ sourceId: 'exists', targetId: 'NOT_THERE', relation: 'rel' } as never),
            /edge_endpoint_missing.*NOT_THERE/,
            'addEdge must reject loudly when an endpoint is absent',
        );
        await graph.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── R5 #3 — one bad workspace must not abort the whole batch ──────────────────
// Step 1a resolved ALL nodes' graphs in a bare Promise.all over getOrOpen, so a
// single node naming an unregistered workspace rejected the batch: runBulkIngest
// threw before any write, silently losing every valid sibling and returning no
// results[]. Now a resolve failure is isolated per-node.
await test('R5#3 one unregistered-workspace node fails alone; valid siblings still land + complete results[]', async () => {
    const { WorkspaceNotFoundError } = await import('../packages/lore/src/engines/localGraphRegistry.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-r5bulk-'));
    try {
        const graph = new SurrealGraph(dir);
        await graph.initialize();
        const openWs = async (ws: string) => { if (ws === 'bad-ws') throw new WorkspaceNotFoundError('bad-ws', ['good-ws']); return graph; };
    const reg = { getOrOpen: openWs, getGraphHandle: openWs };
        const deps = { ...makeDeps(graph), graphRegistry: reg as never, activeWorkspaceName: () => 'good-ws' };
        const nd = (id: string, ws: string) => ({ id, workspace: ws, ecosystem: '*', nodeData: { id, type: 'note', label: id, content: 'c', tags: ['t'], project: ws, ecosystem: '*', metadata: '{}' } });

        const res = await runBulkIngest([nd('good1', 'good-ws'), nd('bad', 'bad-ws'), nd('good2', 'good-ws')] as never, { embed: 'async', autolink: false }, deps);

        assert.equal(res.results.length, 3, 'caller gets a complete results[] (no thrown exception)');
        assert.equal(res.results[0]!.ok, true, 'good1 landed');
        assert.equal(res.results[2]!.ok, true, 'good2 landed');
        assert.equal(res.results[1]!.ok, false, 'the bad-workspace node failed alone');
        assert.match(String((res.results[1] as { error?: string }).error), /workspace_not_found/);
        assert.ok(await graph.getNode('good1'), 'good1 written despite the sibling failure');
        assert.ok(await graph.getNode('good2'), 'good2 written despite the sibling failure');
        assert.equal(await graph.getNode('bad'), null, 'the bad node was not written');
        await graph.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
