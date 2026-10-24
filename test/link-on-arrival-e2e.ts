#!/usr/bin/env tsx
/**
 * test/link-on-arrival-e2e.ts - link-on-arrival (design P0) through the public
 * embeddable API, flag ON. Real SqliteGraph + SqliteVerbatimStore, deterministic
 * embedding provider (no model download).
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/link-on-arrival-e2e.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env.LORE_LINK_ON_ARRIVAL = '1';
process.env.LORE_LINK_MIN_SIM = '0.9';
process.env.LORE_LINK_DUP_SIM = '0.999999';
process.env.LORE_LINK_QUIET_MS = '20';
process.env.LORE_LINK_YIELD_MS = '1';

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'link-e2e-det';
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

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-link-e2e-'));
function findFile(dir: string, name: string): string | null {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; } else if (e.name === name) return p;
    }
    return null;
}
const node = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
    id, workspace: 'default', ecosystem: '*',
    nodeData: { id, type: 'note', label: id, content, project: 'default', ecosystem: '*' }, ...extra,
});
const BASE = 'the quarterly lease renewal for the downtown office building was approved by the board';
const SIMILAR = (n: number) => `${BASE} variant ${n}`;

async function open(dataDir: string) {
    const { createLore } = await import('../packages/lore/src/index.js');
    return createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
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

console.log('\nlink-on-arrival e2e (flag on)\n');

await test('a single write is linked from its stored vector, without the caller waiting', async () => {
    const lore: any = await open(tmp());
    try {
        assert.ok(lore.store.linkService, 'link service is wired when the flag is on');
        await lore.nodeUpsert(node('a1', SIMILAR(1)));
        await lore.awaitEmbeds?.();
        await lore.nodeUpsert(node('a2', SIMILAR(2)));
        await settle(lore);
        const edges = await semanticEdges(lore);
        assert.ok(edges.includes('a1|a2'), `expected a1|a2 in ${JSON.stringify(edges)}`);
        const s = lore.store.linkService.stats();
        assert.equal(s.queue.ready, 0);
        assert.ok(s.linkedTotal >= 2);
        assert.ok(s.recentLagMs && s.recentLagMs.samples >= 2, 'lag samples recorded');
    } finally { await lore.dispose(); }
});

await test('bulkIngest links every node when autolink is absent; an explicit autolink:false is never queued', async () => {
    const lore: any = await open(tmp());
    try {
        const nodes = [1, 2, 3, 4].map((n) => node(`b${n}`, SIMILAR(n)));
        const r = await lore.bulkIngest(nodes as any, { embed: 'sync' });
        assert.equal(r.succeeded, 4);
        await settle(lore);
        const edges = await semanticEdges(lore);
        assert.ok(edges.length >= 3, `expected a connected set of edges, got ${JSON.stringify(edges)}`);
        const touched = new Set(edges.flatMap((e) => e.split('|')));
        for (const n of [1, 2, 3, 4]) assert.ok(touched.has(`b${n}`), `b${n} has at least one link`);
        const r2 = await lore.bulkIngest([5, 6].map((n) => node(`z${n}`, `unrelated topic ${'x'.repeat(n)} zebra giraffe`)) as any, { embed: 'sync', autolink: false });
        assert.equal(r2.succeeded, 2);
        await settle(lore);
        const after = new Set((await semanticEdges(lore)).flatMap((e) => e.split('|')));
        assert.ok(!after.has('z5') && !after.has('z6'), 'autolink:false nodes are never queued (see link-autolink-optout-unit)');
    } finally { await lore.dispose(); }
});

await test('nodeUpsertBatch (outbox embed.batch path) produces links', async () => {
    const lore: any = await open(tmp());
    try {
        await lore.nodeUpsertBatch([1, 2, 3].map((n) => node(`c${n}`, SIMILAR(n))) as any);
        await lore.awaitEmbeds?.();
        await new Promise((r) => setTimeout(r, 300));
        await settle(lore);
        const edges = await semanticEdges(lore);
        assert.ok(edges.length >= 2, `got ${JSON.stringify(edges)}`);
    } finally { await lore.dispose(); }
});

await test('caller-supplied edges on the same pair are never overwritten', async () => {
    const lore: any = await open(tmp());
    try {
        await lore.nodeUpsert(node('d1', SIMILAR(1)));
        await lore.nodeUpsert(node('d2', SIMILAR(2)));
        await lore.awaitEmbeds?.();
        await lore.store.loreGraph.addEdge({ sourceId: 'd1', targetId: 'd2', relation: 'semantic_neighbor', confidence: 'explicit', confidenceScore: 1 });
        await settle(lore);
        await lore.store.linkService.flush();
        const edges = await lore.store.loreGraph.queryEdges({ limit: 100, offset: 0, relation: 'semantic_neighbor' });
        const e = edges.find((x: any) => x.sourceId === 'd1' && x.targetId === 'd2') ?? edges.find((x: any) => x.sourceId === 'd2' && x.targetId === 'd1');
        assert.ok(e, 'edge exists');
        assert.notEqual(e.confidence, 'inferred', 'caller edge stays caller-owned');
        assert.equal(e.confidenceScore, 1);
    } finally { await lore.dispose(); }
});

await test('queued work survives a restart and is linked by the next process', async () => {
    const dataDir = tmp();
    process.env.LORE_LINK_QUIET_MS = '60000'; // hold the worker back so the rows are still queued at shutdown
    let lore: any = await open(dataDir);
    process.env.LORE_LINK_QUIET_MS = '20';
    await lore.nodeUpsert(node('e1', SIMILAR(1)));
    await lore.nodeUpsert(node('e2', SIMILAR(2)));
    await lore.awaitEmbeds?.();
    assert.ok(lore.store.linkService.stats().queue.ready >= 2, 'rows are queued, not yet linked');
    assert.deepEqual(await semanticEdges(lore), [], 'nothing linked before the restart');
    await lore.dispose();
    lore = await open(dataDir);
    try {
        await settle(lore);
        const edges = await semanticEdges(lore);
        assert.ok(edges.includes('e1|e2'), `expected e1|e2 after restart, got ${JSON.stringify(edges)}`);
    } finally { await lore.dispose(); }
});

await test('link backlog never counts toward the outbox: the queue is its own file', async () => {
    const dataDir = tmp();
    const lore: any = await open(dataDir);
    try {
        await lore.nodeUpsert(node('f1', SIMILAR(1)));
        assert.ok(findFile(dataDir, 'link-queue.sqlite'), 'link-queue.sqlite exists beside the other stores');
    } finally { await lore.dispose(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
