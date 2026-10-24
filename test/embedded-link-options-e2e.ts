#!/usr/bin/env tsx
/**
 * test/embedded-link-options-e2e.ts - link-on-arrival and link-aware recall ordering through the public
 * `createLore()` options (no LORE_LINK_* env at all), real SqliteGraph + SqliteVerbatimStore, deterministic embedder.
 *
 *   off by default     no options + no env => no link service, no link-queue file, ingestion handle is null, clean dispose
 *   option on          `linkOnArrival: true` links arrivals; an object overrides settings; bad values throw at construction
 *   option vs env      false beats LORE_LINK_ON_ARRIVAL=1; options beat env tunables
 *   opt-out            `autolink:false` is never queued; a durable opt-out survives a restart
 *   recall ordering    `recallLinkOrdering` reaches recall (and wins over LORE_RECALL_LINK_ORDERING)
 *   process safety     createLore with the options adds no process-wide listeners and mutates no env
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/embedded-link-options-e2e.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

for (const k of Object.keys(process.env)) if (k.startsWith('LORE_LINK_') || k === 'LORE_RECALL_LINK_ORDERING' || k.startsWith('LORE_INGEST_')) delete process.env[k];

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'embedded-link-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { return ts.map((t) => this.vec(t)); }
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-emb-link-'));
function findFile(dir: string, name: string): string | null {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; } else if (e.name === name) return p;
    }
    return null;
}
const node = (id: string, content: string, label = id) => ({
    id, workspace: 'default', ecosystem: '*',
    nodeData: { id, type: 'note', label, content, project: 'default', ecosystem: '*' },
});
const BASE = 'the quarterly lease renewal for the downtown office building was approved by the board';
const SIMILAR = (n: number) => `${BASE} variant ${n}`;
const FAST = { minSim: 0.9, dupSim: 0.999999, quietMs: 20, yieldMs: 1 };

async function open(dataDir: string, extra: Record<string, unknown> = {}): Promise<any> {
    const { createLore } = await import('../packages/lore/src/index.js');
    return createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider(), modelServer: false, ...extra } as never);
}
async function settle(lore: any): Promise<void> {
    await lore.awaitEmbeds?.();
    await lore.store.autolinkTracker?.drain?.(5000);
    await lore.store.linkService.flush();
}
async function semanticEdges(lore: any): Promise<string[]> {
    const edges = await lore.store.loreGraph.queryEdges({ limit: 1000, offset: 0, relation: 'semantic_neighbor' });
    return edges.map((e: any) => `${e.sourceId}|${e.targetId}`).sort();
}

console.log('\nembedded link options e2e\n');

await test('off by default: no link service, no queue file, no ingestion handle, clean dispose', async () => {
    const dir = tmp();
    const lore = await open(dir);
    try {
        assert.equal(lore.store.linkService ?? null, null, 'no link service without the option or env');
        assert.equal(lore.ingestion, null, 'ingestion handle is null when off');
        await lore.nodeUpsert(node('o1', SIMILAR(1)));
        await lore.nodeUpsert(node('o2', SIMILAR(2)));
        await lore.awaitEmbeds?.();
        assert.equal(findFile(dir, 'link-queue.sqlite'), null, 'no link-queue.sqlite is created');
        assert.equal(findFile(dir, 'ingestion.sqlite'), null, 'no ingestion store is created');
    } finally { await lore.dispose(); }
    await lore.dispose(); // idempotent
});

await test('linkOnArrival:true links arrivals with no LORE_LINK_* env, and the env stays untouched', async () => {
    const before = JSON.stringify(Object.entries(process.env).sort());
    const lore = await open(tmp(), { linkOnArrival: { enabled: true, ...FAST } });
    try {
        assert.ok(lore.store.linkService, 'link service is wired by the option');
        await lore.nodeUpsert(node('a1', SIMILAR(1)));
        await lore.awaitEmbeds?.();
        await lore.nodeUpsert(node('a2', SIMILAR(2)));
        await settle(lore);
        assert.ok((await semanticEdges(lore)).includes('a1|a2'));
        assert.equal(lore.store.linkService.stats().queue.ready, 0);
        assert.equal(process.env.LORE_LINK_ON_ARRIVAL, undefined, 'process.env is not mutated');
    } finally { await lore.dispose(); }
    assert.equal(JSON.stringify(Object.entries(process.env).sort()), before, 'env is byte-identical after dispose');
});

await test('plain `true` enables with defaults; `false` beats LORE_LINK_ON_ARRIVAL=1; the option never reads a stale env flag', async () => {
    const on = await open(tmp(), { linkOnArrival: true });
    try { assert.ok(on.store.linkService); } finally { await on.dispose(); }
    process.env.LORE_LINK_ON_ARRIVAL = '1';
    try {
        const off = await open(tmp(), { linkOnArrival: false });
        try { assert.equal(off.store.linkService ?? null, null, 'explicit false wins over the env flag'); } finally { await off.dispose(); }
        const envOn = await open(tmp());
        try { assert.ok(envOn.store.linkService, 'no option => env flag still decides (daemon-identical)'); } finally { await envOn.dispose(); }
    } finally { delete process.env.LORE_LINK_ON_ARRIVAL; }
});

await test('option settings win over LORE_LINK_* tunables; bad values throw RangeError at construction', async () => {
    process.env.LORE_LINK_MIN_SIM = '0.99999';
    try {
        const lore = await open(tmp(), { linkOnArrival: { ...FAST, minSim: 0.9 } });
        try {
            await lore.nodeUpsert(node('p1', SIMILAR(1)));
            await lore.awaitEmbeds?.();
            await lore.nodeUpsert(node('p2', SIMILAR(2)));
            await settle(lore);
            assert.ok((await semanticEdges(lore)).includes('p1|p2'), 'minSim 0.9 from the option beat env 0.99999');
        } finally { await lore.dispose(); }
    } finally { delete process.env.LORE_LINK_MIN_SIM; }
    for (const bad of [{ minSim: 2 }, { k: 0 }, { quietMs: Number.NaN }, { nope: 1 }, { policyVersion: '' }]) {
        await assert.rejects(() => open(tmp(), { linkOnArrival: bad }), RangeError, JSON.stringify(bad));
    }
});

await test('autolink:false is never queued, and the durable opt-out survives a restart', async () => {
    const dir = tmp();
    let lore = await open(dir, { linkOnArrival: { ...FAST } });
    try {
        await lore.nodeUpsert(node('x1', SIMILAR(1)));
        const r = await lore.bulkIngest([node('x2', SIMILAR(2)), node('x3', SIMILAR(3))] as any, { embed: 'sync', autolink: false });
        assert.equal(r.succeeded, 2);
        await settle(lore);
        const touched = new Set((await semanticEdges(lore)).flatMap((e) => e.split('|')));
        assert.ok(!touched.has('x2') && !touched.has('x3'), `opted-out nodes got no edges: ${[...touched]}`);
    } finally { await lore.dispose(); }
    lore = await open(dir, { linkOnArrival: { ...FAST } });
    try {
        await lore.nodeUpsert(node('x4', SIMILAR(4)));
        await settle(lore);
        const touched = new Set((await semanticEdges(lore)).flatMap((e) => e.split('|')));
        assert.ok(!touched.has('x2') && !touched.has('x3'), 'opt-out is durable: still no edges to x2/x3 after restart');
        assert.ok(touched.has('x4') && touched.has('x1'), 'eligible nodes still link');
    } finally { await lore.dispose(); }
});

async function related(lore: any): Promise<string[]> {
    const g = lore.store.loreGraph;
    const hub: any = node('seed', 'zebra crossing safety audit report', 'seed');
    await lore.nodeUpsert(hub);
    for (const [id, label] of [['n1', 'alpha'], ['n2', 'bravo'], ['n3', 'charlie']] as const) await lore.nodeUpsert({ ...node(id, `${'q'.repeat(60)} ${id}`, label), skipEmbed: true }); // never a direct match: they can only arrive as related hops
    await lore.awaitEmbeds?.();
    for (const [id, score] of [['n1', 0.3], ['n2', 0.6], ['n3', 0.9]] as const) {
        await g.addEdge({ sourceId: 'seed', targetId: id, relation: 'semantic_neighbor', confidence: 'inferred', confidenceScore: score });
    }
    const r = await lore.recall('zebra crossing safety audit report', { workspace: 'default', depth: 1, mode: 'full', max: 1 });
    const rel: any[] = (r as any).related ?? [];
    return rel.map((x) => String(x.id ?? x.node?.id));
}

await test('recallLinkOrdering reaches recall and wins over LORE_RECALL_LINK_ORDERING in both directions', async () => {
    const on = await open(tmp(), { recallLinkOrdering: true });
    let onOrder: string[];
    try { onOrder = await related(on); } finally { await on.dispose(); }
    assert.deepEqual(onOrder, ['n3', 'n2', 'n1'], 'strongest link first');
    process.env.LORE_RECALL_LINK_ORDERING = '1';
    try {
        const off = await open(tmp(), { recallLinkOrdering: false });
        let offOrder: string[];
        try { offOrder = await related(off); } finally { await off.dispose(); }
        assert.notDeepEqual(offOrder, ['n3', 'n2', 'n1'], 'explicit false beats the env flag');
        assert.deepEqual([...offOrder].sort(), ['n1', 'n2', 'n3'], 'same set');
        const envOnly = await open(tmp());
        try { assert.deepEqual(await related(envOnly), ['n3', 'n2', 'n1'], 'no option => env flag decides'); } finally { await envOnly.dispose(); }
    } finally { delete process.env.LORE_RECALL_LINK_ORDERING; }
});

await test('options add no process-wide listeners', async () => {
    const events = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM', 'exit', 'beforeExit'] as const;
    const count = () => events.map((e) => process.listenerCount(e));
    const before = count();
    const lore = await open(tmp(), { linkOnArrival: { ...FAST }, recallLinkOrdering: true });
    const during = count();
    await lore.dispose();
    assert.deepEqual(during, before, 'createLore with the options registers nothing on process');
    assert.deepEqual(count(), before, 'dispose leaves the listener set unchanged');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
