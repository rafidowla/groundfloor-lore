#!/usr/bin/env tsx
/**
 * cross-workspace-relationship-unit.ts — workspace isolation for bulk writes
 * and relationships.
 *
 * Each Lore workspace is a SEPARATE SurrealDB store (+ LanceDB). Two
 * invariants this locks down:
 *
 *   (1) BULK ISOLATION — a bulk ingest routed to workspace A lands ONLY in A's
 *       graph; B never sees A's nodes and vice versa. (CLAUDE.md: every
 *       workspace-taking op MUST route to the requested workspace — the
 *       isolation boundary between apps.)
 *
 *   (2) CROSS-WORKSPACE RELATIONSHIPS FAIL LOUD — an edge cannot span two
 *       graphs. Creating an edge in A whose endpoint lives only in B finds no
 *       endpoint and, since the NW-BULK fix, throws `edge_endpoint_missing`
 *       instead of silently creating nothing. No silent cross-workspace link,
 *       no silently-dropped write.
 *
 * Uses two SurrealGraph instances kept open concurrently (the registry's
 * per-workspace model); both are closed only at the end.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

import { runBulkIngest, type BulkIngestDeps } from '../packages/lore/src/mcp/bulkIngest.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';

const N = 300; // nodes per workspace (bulk)

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function makeDeps(graph: SurrealGraph): BulkIngestDeps {
    const noop = () => undefined;
    const stub = new Proxy({}, { get: () => noop }) as never;
    return {
        graph: graph as never,
        graphRegistry: null,
        activeWorkspaceName: () => '__not_active__',
        outboxStore: undefined,
        embedQueue: { enqueue: noop } as never,
        verbatimStore: stub,
        storageClient: stub,
        loreVerbatim: stub,
        embeddingProvider: stub,
        getWal: () => stub,
        versionStore: undefined,
        // REQUIRED field (BulkIngestDeps.autolinkTracker). These deps run with
        // autolink off, but the type refuses to let a call site omit the
        // tracker and silently land on the process-global one — so the
        // fallback is named here instead of hidden behind a `??`.
        autolinkTracker: defaultAutolinkTracker,
    };
}

const bulkNodes = (prefix: string) => Array.from({ length: N }, (_, i) => ({
    id: `${prefix}:n${i}`, workspace: prefix, ecosystem: '*',
    nodeData: { id: `${prefix}:n${i}`, type: 'note', label: `${prefix}-${i}`, content: 'c', tags: ['atlas'], project: prefix, ecosystem: '*', metadata: '{}' },
}));

console.log('CROSS-WORKSPACE — bulk isolation + relationships fail loud across workspaces');

await test('bulk routes to its workspace; nodes are isolated; cross-workspace edges throw', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-xwsA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-xwsB-'));
    const A = new SurrealGraph(dirA, { workspaceId: 'wsA' });
    const B = new SurrealGraph(dirB, { workspaceId: 'wsB' });
    try {
        await A.initialize();
        await B.initialize();

        // (1) bulk-write N nodes to each workspace's own graph
        const resA = await runBulkIngest(bulkNodes('wsA') as never, { embed: 'async' }, makeDeps(A));
        const resB = await runBulkIngest(bulkNodes('wsB') as never, { embed: 'async' }, makeDeps(B));
        assert.equal(resA.succeeded, N, `all ${N} A nodes land; got ${resA.succeeded}`);
        assert.equal(resB.succeeded, N, `all ${N} B nodes land; got ${resB.succeeded}`);

        // isolation: each graph holds only its own nodes
        assert.equal((await A.getStats()).nodeCount, N, 'A holds exactly its own nodes');
        assert.equal((await B.getStats()).nodeCount, N, 'B holds exactly its own nodes');
        assert.equal(await A.getNode('wsB:n0'), null, 'A cannot see a B node');
        assert.equal(await B.getNode('wsA:n0'), null, 'B cannot see an A node');

        // sanity: a WITHIN-workspace edge succeeds
        await A.addEdge({ sourceId: 'wsA:n0', targetId: 'wsA:n1', relation: 'imports' } as never);
        assert.equal((await A.getStats()).edgeCount, 1, 'within-workspace edge created');

        // (2) cross-workspace edge fails LOUD (target lives only in B)
        await assert.rejects(
            () => A.addEdge({ sourceId: 'wsA:n0', targetId: 'wsB:n0', relation: 'imports' } as never),
            /edge_endpoint_missing.*wsB:n0/,
            'cross-workspace edge must throw edge_endpoint_missing, not silently no-op',
        );
        // and the reverse (source lives only in B)
        await assert.rejects(
            () => A.addEdge({ sourceId: 'wsB:n5', targetId: 'wsA:n2', relation: 'imports' } as never),
            /edge_endpoint_missing.*wsB:n5/,
            'cross-workspace edge (foreign source) must also throw',
        );

        // (3) a BULK of cross-workspace edges: every one fails, none silently created
        let xwsThrew = 0;
        for (let k = 0; k < 50; k++) {
            await A.addEdge({ sourceId: `wsA:n${k}`, targetId: `wsB:n${k}`, relation: 'imports' } as never)
                .catch(() => { xwsThrew++; });
        }
        assert.equal(xwsThrew, 50, 'all 50 cross-workspace edges must throw');
        assert.equal((await A.getStats()).edgeCount, 1, 'A still has only the 1 valid within-workspace edge — no silent cross-workspace links');

        await A.close();
        await B.close();
    } finally {
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
