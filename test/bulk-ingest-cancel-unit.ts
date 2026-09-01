#!/usr/bin/env tsx
/**
 * Cooperative cancel for bulkIngest (WP3a).
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

const DIM = 8;
const vec = (): number[] => new Array(DIM).fill(0.2);

function nodeArgs(id: string, content: string) {
    return {
        id,
        workspace: 'w',
        ecosystem: '*',
        nodeData: {
            id, type: 'note', label: id, content, tags: [], project: 'w', ecosystem: '*', metadata: '{}',
        },
    };
}

function makeDeps(
    graph: SurrealGraph,
    verbatim: VerbatimStore,
    embed: { calls: number; disposeCalls: number; embedDocumentBatch: (texts: string[]) => Promise<number[][]> },
): BulkIngestDeps {
    const noop = () => undefined;
    const stub = new Proxy({}, { get: () => noop }) as never;
    return {
        graph: graph as never,
        graphRegistry: null,
        activeWorkspaceName: () => '__not_active__',
        outboxStore: undefined,
        embedQueue: { enqueue: noop } as never,
        verbatimStore: verbatim as never,
        storageClient: stub,
        loreVerbatim: verbatim as never,
        embeddingProvider: {
            dimension: DIM,
            embedDocumentBatch: async (texts: string[]) => {
                embed.calls++;
                return embed.embedDocumentBatch(texts);
            },
            dispose: () => { embed.disposeCalls++; },
        } as never,
        getWal: () => stub,
        versionStore: undefined,
        autolinkTracker: defaultAutolinkTracker,
    };
}

console.log('WP3a — bulkIngest cooperative cancel');

await test('abort before graph writes leaves zero nodes and all cancelled', async () => {
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-g-'));
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-v-'));
    try {
        const graph = new SurrealGraph(gdir);
        await graph.initialize();
        const verbatim = new VerbatimStore(vdir);
        await verbatim.initialize();
        const embed = { calls: 0, disposeCalls: 0, embedDocumentBatch: async (t: string[]) => t.map(() => vec()) };
        const res = await runBulkIngest(
            [nodeArgs('n1', 'one'), nodeArgs('n2', 'two')] as never,
            { autolink: false, shouldAbort: () => true },
            makeDeps(graph, verbatim, embed),
        );
        assert.equal(res.succeeded, 0);
        assert.ok(res.results.every(r => !r.ok && r.error === 'cancelled'));
        assert.equal(await graph.getNode('n1'), null);
        assert.equal(await graph.getNode('n2'), null);
        assert.equal(embed.disposeCalls, 0);
        await graph.close();
        await verbatim.close();
    } finally {
        fs.rmSync(gdir, { recursive: true, force: true });
        fs.rmSync(vdir, { recursive: true, force: true });
    }
});

await test('abort after graph before embed deletes new ids and restores existing', async () => {
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-g-'));
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-v-'));
    try {
        const graph = new SurrealGraph(gdir);
        await graph.initialize();
        const verbatim = new VerbatimStore(vdir);
        await verbatim.initialize();
        const embed = { calls: 0, disposeCalls: 0, embedDocumentBatch: async (t: string[]) => t.map(() => vec()) };
        const deps = makeDeps(graph, verbatim, embed);
        await runBulkIngest(
            [nodeArgs('old', 'healthy-original')] as never,
            { autolink: false, embed: 'precomputed', ...{ } },
            { ...deps, embeddingProvider: { dimension: DIM } as never },
        );
        // precomputed without embedding fails; write via graph upsert instead
        await graph.upsertNode({
            id: 'old', type: 'note', label: 'old', content: 'healthy-original',
            tags: [], project: 'w', ecosystem: '*', metadata: '{}',
        } as never);
        const before = await graph.getNode('old');
        assert.equal(before?.content, 'healthy-original');

        let polls = 0;
        const res = await runBulkIngest(
            [
                nodeArgs('old', 'clobber'),
                nodeArgs('brand-new', 'fresh'),
            ] as never,
            {
                autolink: false,
                shouldAbort: () => ++polls > 2,
            },
            deps,
        );
        assert.ok(res.results.every(r => !r.ok && r.error === 'cancelled'));
        assert.equal(await graph.getNode('brand-new'), null);
        const restored = await graph.getNode('old');
        assert.equal(restored?.content, 'healthy-original');
        assert.equal(embed.disposeCalls, 0);
        const retry = await runBulkIngest(
            [nodeArgs('brand-new', 'fresh')] as never,
            { autolink: false, embed: 'async' },
            deps,
        );
        assert.equal(retry.succeeded, 1);
        assert.ok(await graph.getNode('brand-new'));
        await graph.close();
        await verbatim.close();
    } finally {
        fs.rmSync(gdir, { recursive: true, force: true });
        fs.rmSync(vdir, { recursive: true, force: true });
    }
});

await test('abort mid-embed keeps finished chunks and rolls back the rest', async () => {
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-g-'));
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-v-'));
    try {
        const graph = new SurrealGraph(gdir);
        await graph.initialize();
        const verbatim = new VerbatimStore(vdir);
        await verbatim.initialize();
        await graph.upsertNode({
            id: 'old', type: 'note', label: 'old', content: 'healthy-original',
            tags: [], project: 'w', ecosystem: '*', metadata: '{}',
        } as never);
        let embedBatches = 0;
        const embed = {
            calls: 0,
            disposeCalls: 0,
            embedDocumentBatch: async (texts: string[]) => {
                embedBatches++;
                return texts.map(() => vec());
            },
        };
        const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'old'];
        const res = await runBulkIngest(
            ids.map((id, i) => nodeArgs(id, id === 'old' ? 'clobber' : `n${i}`)) as never,
            {
                autolink: false,
                embedBatchSize: 2,
                shouldAbort: () => embedBatches >= 2,
            },
            makeDeps(graph, verbatim, embed),
        );
        const cancelled = res.results.filter(r => !r.ok && r.error === 'cancelled').map(r => r.id).sort();
        assert.ok(cancelled.includes('c5'));
        assert.ok(cancelled.includes('old'));
        assert.ok(await verbatim.getById('lore:c1'));
        assert.ok(await verbatim.getById('lore:c2'));
        assert.ok(await verbatim.getById('lore:c3'));
        assert.ok(await verbatim.getById('lore:c4'));
        assert.equal(await graph.getNode('c5'), null);
        assert.equal((await graph.getNode('old'))?.content, 'healthy-original');
        assert.equal(embed.disposeCalls, 0);
        await graph.close();
        await verbatim.close();
    } finally {
        fs.rmSync(gdir, { recursive: true, force: true });
        fs.rmSync(vdir, { recursive: true, force: true });
    }
});

await test('cancelled run does not report success', async () => {
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-g-'));
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-v-'));
    try {
        const graph = new SurrealGraph(gdir);
        await graph.initialize();
        const verbatim = new VerbatimStore(vdir);
        await verbatim.initialize();
        const embed = { calls: 0, disposeCalls: 0, embedDocumentBatch: async (t: string[]) => t.map(() => vec()) };
        const res = await runBulkIngest(
            [nodeArgs('x', 'x')] as never,
            { autolink: false, shouldAbort: () => true },
            makeDeps(graph, verbatim, embed),
        );
        assert.equal(res.ok, false);
        assert.equal(res.succeeded, 0);
        await graph.close();
        await verbatim.close();
    } finally {
        fs.rmSync(gdir, { recursive: true, force: true });
        fs.rmSync(vdir, { recursive: true, force: true });
    }
});

// Plan item 4: do not SIGKILL / interrupt native Lance mid-`add`. This
// test only proves cooperative abort waits for an in-flight JS write to
// finish. Native mid-add interrupt remains skipped by design.
await test('abort during in-flight Lance write waits for the write to finish (no mid-write kill)', async () => {
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-g-'));
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cancel-v-'));
    try {
        const graph = new SurrealGraph(gdir);
        await graph.initialize();
        const verbatim = new VerbatimStore(vdir);
        await verbatim.initialize();
        let enteredWrite = false;
        let writeFinished = false;
        let releaseWrite!: () => void;
        const writeGate = new Promise<void>((r) => { releaseWrite = r; });
        const orig = verbatim.bulkUpsertPrebuiltRows.bind(verbatim);
        verbatim.bulkUpsertPrebuiltRows = async (rows) => {
            enteredWrite = true;
            await writeGate;
            const out = await orig(rows);
            writeFinished = true;
            return out;
        };
        let abort = false;
        const embed = { calls: 0, disposeCalls: 0, embedDocumentBatch: async (t: string[]) => t.map(() => vec()) };
        const nodes = [
            { ...nodeArgs('hang1', 'one'), embedding: vec() },
            { ...nodeArgs('hang2', 'two'), embedding: vec() },
        ];
        const ingestP = runBulkIngest(
            nodes as never,
            { autolink: false, embed: 'precomputed', shouldAbort: () => abort },
            makeDeps(graph, verbatim, embed),
        );
        const deadline = Date.now() + 8_000;
        while (!enteredWrite && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        assert.equal(enteredWrite, true, 'must reach Lance write');
        abort = true;
        assert.equal(writeFinished, false, 'must not complete the write until the hang lifts');
        releaseWrite();
        await ingestP;
        assert.equal(writeFinished, true, 'in-flight Lance write must finish; cancel does not interrupt it');
        assert.equal(embed.disposeCalls, 0);
        assert.ok(await verbatim.getById('lore:hang1'), 'completed write stays (property 1)');
        assert.ok(await verbatim.getById('lore:hang2'));
        await graph.close();
        await verbatim.close();
    } finally {
        fs.rmSync(gdir, { recursive: true, force: true });
        fs.rmSync(vdir, { recursive: true, force: true });
    }
});

await Promise.all([]);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
