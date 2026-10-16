#!/usr/bin/env tsx
/**
 * bulkIngest pre-embed skip (3.35.0, PR #199 follow-up).
 *
 * Atlas re-indexes through `bulkIngest(nodes, { autolink:false, embed:'sync' })` on every `git pull`. A node whose
 * verbatim row is already stored identically (content hash, metadata, an embedded vector; `updatedAt` ignored) must
 * not be embedded again, and its row must stay byte-flat. SQLite engine: skip. Lance engine: documented exclusion
 * (it keeps the old behaviour: everything is embedded again), asserted below so a change is deliberate.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { makeVerbatimStore, testVectorEngine } from './helpers/testVerbatimStore.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import { runBulkIngest, type BulkIngestDeps } from '../packages/lore/src/mcp/bulkIngest.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';

const ENGINE = testVectorEngine();
const SKIPS = ENGINE === 'sqlite';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

/** Deterministic embedder; counts every text embedded through `embedDocumentBatch` (what bulkIngest calls). */
class Embedder {
    readonly dimension = 8;
    readonly modelId = 'bulk-skip-det';
    readonly dtype = 'fp32';
    texts = 0;
    batches = 0;
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / n);
    }
    async initialize(): Promise<void> {}
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { this.batches++; this.texts += ts.length; return ts.map((t) => this.vec(t)); }
    dispose(): void {}
}

const nodeArgs = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
    id,
    workspace: 'w',
    ecosystem: '*',
    nodeData: { id, type: 'note', label: id, content, tags: [], project: 'w', ecosystem: '*', metadata: '{}', ...extra },
});
const batch = (n: number, tag = 'v1') => Array.from({ length: n }, (_, i) => nodeArgs(`n${i}`, `content of node ${i} ${tag}`));

type Env = { graph: SurrealGraph; verbatim: VerbatimStoreApi; emb: Embedder; enqueued: string[]; deps: BulkIngestDeps; done: () => Promise<void> };
async function fresh(): Promise<Env> {
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-skip-g-'));
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-skip-v-'));
    const emb = new Embedder();
    const graph = new SurrealGraph(gdir);
    await graph.initialize();
    const verbatim = makeVerbatimStore(vdir, emb as never);
    await verbatim.initialize();
    const noop = () => undefined;
    const stub = new Proxy({}, { get: () => noop }) as never;
    const enqueued: string[] = [];
    const deps: BulkIngestDeps = {
        graph: graph as never,
        graphRegistry: null,
        activeWorkspaceName: () => '__not_active__',
        outboxStore: undefined,
        embedQueue: { enqueue: (id: string) => { enqueued.push(id); } } as never,
        verbatimStore: verbatim as never,
        storageClient: stub,
        loreVerbatim: verbatim as never,
        embeddingProvider: emb as never,
        getWal: () => stub,
        versionStore: undefined,
        autolinkTracker: defaultAutolinkTracker,
    };
    return {
        graph, verbatim, emb, enqueued, deps,
        done: async () => {
            await graph.close();
            await verbatim.close();
            fs.rmSync(gdir, { recursive: true, force: true });
            fs.rmSync(vdir, { recursive: true, force: true });
        },
    };
}

async function snapshot(env: Env, n: number): Promise<{ rows: number; stamps: string[] }> {
    let rows = 0;
    const stamps: string[] = [];
    for (let i = 0; i < n; i++) {
        rows += (await env.verbatim.getHistory(`lore:n${i}`)).length;
        stamps.push(String((await env.verbatim.getById(`lore:n${i}`))?.updatedAt));
    }
    return { rows, stamps };
}

console.log(`bulkIngest pre-embed skip (3.35.0) — engine: ${ENGINE}`);

await test('sync: identical batch twice → second call embeds nothing, rows and updatedAt flat, recall unchanged', async () => {
    const env = await fresh();
    try {
        const N = 12;
        const r1 = await runBulkIngest(batch(N) as never, { autolink: false, embed: 'sync' }, env.deps);
        assert.equal(r1.succeeded, N);
        assert.equal(env.emb.texts, N, 'first call embeds every node');
        assert.equal(r1.skippedUnchanged, undefined, 'nothing skipped the first time');
        const snap1 = await snapshot(env, N);
        const recall1 = (await env.verbatim.search('content of node 3 v1', 5)).map((r) => [r.id, r.score]);
        assert.equal(recall1.length, 5);

        await new Promise((r) => setTimeout(r, 15)); // so a rewritten row would carry a newer updatedAt
        env.emb.texts = 0;
        const r2 = await runBulkIngest(batch(N) as never, { autolink: false, embed: 'sync' }, env.deps);
        assert.equal(r2.succeeded, N);
        assert.ok(r2.results.every((r) => r.ok));
        const snap2 = await snapshot(env, N);
        const recall2 = (await env.verbatim.search('content of node 3 v1', 5)).map((r) => [r.id, r.score]);
        assert.deepEqual(recall2, recall1, 'same ids, same scores, same order');
        if (SKIPS) {
            assert.equal(env.emb.texts, 0, 'second call makes 0 embed calls');
            assert.equal(env.emb.batches, 1, 'and no batch at all');
            assert.equal(r2.skippedUnchanged, N);
            assert.deepEqual(snap2, snap1, 'rows and updatedAt byte-flat');
        } else {
            // Documented exclusion: the Lance store exposes no cheap "stored identically + has a vector" probe, so it
            // keeps the pre-3.35 behaviour (re-embed). Row history still does not grow (PR #199 skip-identical).
            assert.equal(env.emb.texts, N);
            assert.equal(r2.skippedUnchanged, undefined);
            assert.equal(snap2.rows, snap1.rows);
        }
    } finally { await env.done(); }
});

await test('sync: changing one node embeds exactly that node', async () => {
    const env = await fresh();
    try {
        const N = 12;
        await runBulkIngest(batch(N) as never, { autolink: false, embed: 'sync' }, env.deps);
        env.emb.texts = 0;
        const changed = batch(N);
        changed[5] = nodeArgs('n5', 'content of node 5 EDITED');
        const r = await runBulkIngest(changed as never, { autolink: false, embed: 'sync' }, env.deps);
        assert.equal(r.succeeded, N);
        assert.equal(env.emb.texts, SKIPS ? 1 : N);
        if (SKIPS) assert.equal(r.skippedUnchanged, N - 1);
        const hit = (await env.verbatim.search('content of node 5 EDITED', N)).find((x) => x.id === 'lore:n5');
        assert.match(String(hit?.text), /EDITED/, 'the edited node was rewritten with its new text');
    } finally { await env.done(); }
});

await test('a metadata change (tags) on identical content still rewrites the row', async () => {
    const env = await fresh();
    try {
        await runBulkIngest([nodeArgs('n0', 'same body')] as never, { autolink: false, embed: 'sync' }, env.deps);
        env.emb.texts = 0;
        const r = await runBulkIngest([nodeArgs('n0', 'same body', { tags: ['new-tag'] })] as never, { autolink: false, embed: 'sync' }, env.deps);
        assert.equal(r.succeeded, 1);
        // Tags are part of the verbatim text, so the hash differs: embedded either way.
        assert.equal(env.emb.texts, 1);
        assert.match(String((await env.verbatim.getById('lore:n0'))?.tags ?? ''), /new-tag/);
    } finally { await env.done(); }
});

await test('async: unchanged nodes are not enqueued, changed ones are', async () => {
    const env = await fresh();
    try {
        const N = 6;
        await runBulkIngest(batch(N) as never, { autolink: false, embed: 'sync' }, env.deps);
        const changed = batch(N);
        changed[2] = nodeArgs('n2', 'content of node 2 EDITED');
        env.enqueued.length = 0;
        const r = await runBulkIngest(changed as never, { autolink: false, embed: 'async' }, env.deps);
        assert.equal(r.succeeded, N);
        if (SKIPS) assert.deepEqual(env.enqueued, ['n2']);
        else assert.equal(env.enqueued.length, N);
    } finally { await env.done(); }
});

await test('precomputed keeps current behaviour: caller vectors are written, nothing is skipped', async () => {
    const env = await fresh();
    try {
        const vec = (n: number) => new Array(8).fill(0).map((_, i) => (i === n % 8 ? 1 : 0));
        const mk = () => Array.from({ length: 4 }, (_, i) => ({ ...nodeArgs(`n${i}`, `pre ${i}`), embedding: vec(i) }));
        const r1 = await runBulkIngest(mk() as never, { autolink: false, embed: 'precomputed' }, env.deps);
        assert.equal(r1.succeeded, 4);
        const r2 = await runBulkIngest(mk() as never, { autolink: false, embed: 'precomputed' }, env.deps);
        assert.equal(r2.succeeded, 4);
        assert.equal(r2.skippedUnchanged, undefined);
        assert.equal(env.emb.texts, 0, 'precomputed never calls the embedder');
    } finally { await env.done(); }
});

await test('one lookup per workspace, not per node', async () => {
    const env = await fresh();
    try {
        const N = 30;
        await runBulkIngest(batch(N) as never, { autolink: false, embed: 'sync' }, env.deps);
        const store = env.verbatim as unknown as { findUnchangedRowIds?: (r: unknown[]) => Promise<string[]> };
        if (typeof store.findUnchangedRowIds !== 'function') { assert.equal(ENGINE, 'lance'); return; }
        let calls = 0;
        const orig = store.findUnchangedRowIds.bind(store);
        store.findUnchangedRowIds = async (r) => { calls++; return orig(r); };
        await runBulkIngest(batch(N) as never, { autolink: false, embed: 'sync' }, env.deps);
        assert.equal(calls, 1);
    } finally { await env.done(); }
});

await test('cancel before any embed still rolls back unchanged nodes alongside fresh ones', async () => {
    const env = await fresh();
    try {
        await runBulkIngest([nodeArgs('n0', 'keep me')] as never, { autolink: false, embed: 'sync' }, env.deps);
        let polls = 0;
        const res = await runBulkIngest(
            [nodeArgs('n0', 'keep me'), nodeArgs('n1', 'brand new')] as never,
            // Abort once the graph writes are done, before the embed stage.
            { autolink: false, embed: 'sync', shouldAbort: () => ++polls > 2 },
            env.deps,
        );
        // Whatever the poll timing, the invariant is: result shape intact and no half-written new node.
        assert.equal(res.results.length, 2);
        if (!res.results[1]!.ok) assert.equal(await env.graph.getNode('n1'), null);
    } finally { await env.done(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
