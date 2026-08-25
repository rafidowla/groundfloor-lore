#!/usr/bin/env tsx
/**
 * audit-bulk-dedup-unit.ts — R3 audit #2 (high). runBulkIngest's sync &
 * precomputed paths wrote vectors via verbatimStore.bulkAddPrebuiltRows, a raw
 * LanceDB table.add() APPEND with no dedup. Re-ingesting an already-present id
 * (bulkIngest's documented primary use: repo re-index, memory import,
 * migration) appended a SECOND canonical lore:<id> row, so the vector tier
 * diverged from the last-write-wins graph: getById returned the STALE first
 * row and semantic search could return the node twice. The fix routes both
 * paths through bulkUpsertPrebuiltRows (mergeInsert on id).
 *
 * Driven via precomputed mode (passes vectors → no real ONNX needed).
 * Run: npm run test:unit:audit-bulk-dedup
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { runBulkIngest, type BulkIngestDeps } from '../packages/lore/src/mcp/bulkIngest.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 384;

function makeDeps(graph: SurrealGraph, verbatim: VerbatimStore): BulkIngestDeps {
    const noop = () => undefined;
    const stub = new Proxy({}, { get: () => noop }) as never;
    return {
        graph: graph as never,
        graphRegistry: null,
        activeWorkspaceName: () => '__not_active__', // isActive=false → no WAL
        outboxStore: undefined,
        embedQueue: { enqueue: noop } as never,
        verbatimStore: verbatim as never,            // REAL — precomputed step 3 writes here
        storageClient: stub,
        loreVerbatim: verbatim as never,
        embeddingProvider: { dimension: DIM } as never, // precomputed only reads .dimension
        getWal: () => stub,
        versionStore: undefined,
        // REQUIRED field (BulkIngestDeps.autolinkTracker). These deps run with
        // autolink off, but the type refuses to let a call site omit the
        // tracker and silently land on the process-global one — so the
        // fallback is named here instead of hidden behind a `??`.
        autolinkTracker: defaultAutolinkTracker,
    };
}

console.log('R3 #2 — bulk re-ingest must not duplicate canonical vectors');

await test('R3#2 re-ingesting the same id (precomputed) keeps ONE canonical row + last-write-wins (no stale/dup)', async () => {
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-dedup-g-'));
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-dedup-v-'));
    try {
        const graph = new SurrealGraph(gdir);
        await graph.initialize();
        const verbatim = new VerbatimStore(vdir);
        await verbatim.initialize();
        const deps = makeDeps(graph, verbatim);

        const vec = new Array(DIM).fill(0.1);
        const node = (content: string) => ({
            id: 'note:dup', workspace: 'w', ecosystem: '*', embedding: vec,
            nodeData: { id: 'note:dup', type: 'note', label: 'L', content, tags: [], project: 'w', ecosystem: '*', metadata: '{}' },
        });

        const first = await runBulkIngest([node('content-A')] as never, { embed: 'precomputed', autolink: false }, deps);
        assert.equal(first.succeeded, 1, 'first ingest succeeds');
        const second = await runBulkIngest([node('content-B')] as never, { embed: 'precomputed', autolink: false }, deps);
        assert.equal(second.succeeded, 1, 're-ingest succeeds');

        // last-write-wins: getById returns the NEW content, not the stale first row
        const row = await verbatim.getById('lore:note:dup') as { text?: string } | null;
        assert.ok(row, 'canonical row exists');
        assert.match(String(row!.text), /content-B/, 'getById returns the latest content (not the stale first row)');
        assert.doesNotMatch(String(row!.text), /content-A/, 'stale first-row content is gone');

        // exactly ONE physical row for the id (no duplicate canonical vector)
        const count = await (verbatim as unknown as { count: () => Promise<number> }).count();
        assert.equal(count, 1, `exactly one canonical row after re-ingest (got ${count}) — no duplicate append`);

        // graph holds the new content too (vector tier ↔ graph parity)
        assert.equal((await graph.getNode('note:dup'))?.content, 'content-B', 'graph also last-write-wins');

        await graph.close();
    } finally {
        fs.rmSync(gdir, { recursive: true, force: true });
        fs.rmSync(vdir, { recursive: true, force: true });
    }
});

// ── R4 #4 — bulk ingest routes each node's vector to ITS workspace's LanceDB ──
// Before: step 3 wrote every vector to deps.verbatimStore (boot/active), so a
// node ingested to workspace B landed its vector in A's LanceDB — broken
// semantic read-your-writes for B + a cross-workspace vector leak. The
// workspaceVerbatimResolver now routes per node.workspace.
await test('R4#4 bulk vectors land in each node workspace store (no cross-workspace leak)', async () => {
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4bulk-g-'));
    const vAdir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4bulk-va-'));
    const vBdir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4bulk-vb-'));
    try {
        const graph = new SurrealGraph(gdir); await graph.initialize();
        const vsA = new VerbatimStore(vAdir); await vsA.initialize();
        const vsB = new VerbatimStore(vBdir); await vsB.initialize();
        const noop = () => undefined;
        const stub = new Proxy({}, { get: () => noop }) as never;
        const deps = {
            graph: graph as never, graphRegistry: null, activeWorkspaceName: () => 'wsA',
            outboxStore: undefined, embedQueue: { enqueue: noop } as never,
            verbatimStore: vsA as never, // boot/fallback
            storageClient: stub, loreVerbatim: vsA as never,
            embeddingProvider: { dimension: DIM } as never, getWal: () => stub, versionStore: undefined,
            // route vectors per workspace
            workspaceVerbatimResolver: { getOrOpen: async (ws: string) => (ws === 'wsB' ? vsB : vsA) as never },
        };
        const vec = new Array(DIM).fill(0.2);
        const node = (id: string, ws: string) => ({ id, workspace: ws, ecosystem: '*', embedding: vec, nodeData: { id, type: 'note', label: id, content: 'c', tags: [], project: ws, ecosystem: '*', metadata: '{}' } });
        const r = await runBulkIngest([node('a', 'wsA'), node('b', 'wsB')] as never, { embed: 'precomputed', autolink: false }, deps as never);
        assert.equal(r.succeeded, 2, 'both nodes ingest');

        assert.ok(await vsA.getById('lore:a'), "A's vector is in A's store");
        assert.ok(await vsB.getById('lore:b'), "B's vector is in B's store");
        assert.equal(await vsA.getById('lore:b'), null, "B's vector must NOT leak into A's store");
        assert.equal(await vsB.getById('lore:a'), null, "A's vector must NOT leak into B's store");
        await graph.close();
    } finally {
        for (const d of [gdir, vAdir, vBdir]) fs.rmSync(d, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
