#!/usr/bin/env tsx
/**
 * test/link-optout-lifetime-unit.ts - lifetime of the durable `autolink:false` opt-out through the real write paths
 * (embedded Lore, SQLite). The flag lives in the workspace's graph store.
 *
 *   keeps     a later write that OMITS autolink (nodeUpsert, nodeUpsertBatch, bulkIngest sync + queued) keeps the "no"
 *   clears    an explicit autolink:true clears it, and the node links again
 *   delete    deleting the node removes the flag; a re-created node with the same id is linkable
 *   restart   the flag survives dispose + reopen of the same data dir
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/link-optout-lifetime-unit.ts
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
    readonly modelId = 'link-optout-life-det';
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
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-optout-life-')); dirs.push(d); return d; };
const BASE = 'the quarterly lease renewal for the downtown office building was approved by the board';
const TEXT = (n: number): string => `${BASE} variant ${n}`;
const nodeArg = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
    id, workspace: 'default', ecosystem: '*',
    nodeData: { id, type: 'note', label: id, content: TEXT(n), project: 'default', ecosystem: '*' }, ...extra,
});

async function open(dataDir = tmp()) {
    const { createLore } = await import('../packages/lore/src/index.js');
    return (createLore as any)({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
}
async function settle(lore: any): Promise<void> {
    await lore.awaitEmbeds?.();
    await lore.store.autolinkTracker?.drain?.(5000);
    await lore.store.linkService.flush();
}
async function pairs(lore: any): Promise<string[]> {
    const edges = await lore.store.loreGraph.queryEdges({ limit: 1000, offset: 0, relation: 'semantic_neighbor' });
    return edges.map((e: any) => [e.sourceId, e.targetId].sort().join('|')).sort();
}
const flagged = async (lore: any, ids: string[]): Promise<string[]> => [...await lore.store.loreGraph.getLinkOptOuts(ids)].sort();
async function inLore(fn: (lore: any) => Promise<void>): Promise<void> {
    const lore = await open();
    try { await fn(lore); } finally { await lore.dispose(); }
}

await test('a write that omits autolink keeps the opt-out: nodeUpsert, nodeUpsertBatch, bulkIngest (sync and queued)', async () => inLore(async (lore) => {
    await lore.nodeUpsert(nodeArg('k', 1, { autolink: false })); await settle(lore);
    assert.deepEqual(await flagged(lore, ['k']), ['k']);
    await lore.nodeUpsert(nodeArg('k', 1)); await settle(lore);
    assert.deepEqual(await flagged(lore, ['k']), ['k'], 'plain re-save');
    await lore.nodeUpsertBatch([nodeArg('k', 2)] as any); await settle(lore);
    assert.deepEqual(await flagged(lore, ['k']), ['k'], 'batch re-save');
    for (const embed of ['sync', 'queued'] as const) {
        await lore.bulkIngest([nodeArg('k', 3)] as any, { embed }); await settle(lore);
        assert.deepEqual(await flagged(lore, ['k']), ['k'], `bulkIngest ${embed} without autolink`);
    }
    await lore.nodeUpsert(nodeArg('peer', 1)); await settle(lore);
    assert.deepEqual(await pairs(lore), [], 'still no links in either direction');
}));

await test('an explicit autolink:true clears the flag and the node links again', async () => inLore(async (lore) => {
    await lore.nodeUpsert(nodeArg('c', 1, { autolink: false })); await settle(lore);
    await lore.nodeUpsert(nodeArg('c', 1, { autolink: true })); await settle(lore);
    assert.deepEqual(await flagged(lore, ['c']), []);
    await lore.nodeUpsert(nodeArg('d', 2)); await settle(lore);
    assert.ok((await pairs(lore)).includes('c|d'));
}));

await test('bulkIngest autolink:true clears; a later omitted write does not re-set it', async () => inLore(async (lore) => {
    await lore.bulkIngest([nodeArg('b', 1)] as any, { embed: 'sync', autolink: false }); await settle(lore);
    assert.deepEqual(await flagged(lore, ['b']), ['b']);
    await lore.bulkIngest([nodeArg('b', 1)] as any, { embed: 'sync', autolink: true }); await settle(lore);
    assert.deepEqual(await flagged(lore, ['b']), []);
    await lore.bulkIngest([nodeArg('b', 1)] as any, { embed: 'sync' }); await settle(lore);
    assert.deepEqual(await flagged(lore, ['b']), []);
}));

await test('deleting the node removes the flag; a re-created node with the same id links', async () => inLore(async (lore) => {
    await lore.nodeUpsert(nodeArg('g', 1, { autolink: false })); await settle(lore);
    assert.deepEqual(await flagged(lore, ['g']), ['g']);
    await lore.nodeDelete({ id: 'g', workspace: 'default' });
    assert.deepEqual(await flagged(lore, ['g']), [], 'flag gone with the node');
    await lore.nodeUpsert(nodeArg('g', 1)); await lore.awaitEmbeds?.();
    await lore.nodeUpsert(nodeArg('h', 2)); await settle(lore);
    assert.ok((await pairs(lore)).includes('g|h'), 'a node re-created after delete is linkable');
}));

await test('the flag survives dispose + reopen of the same data dir', async () => {
    const dir = tmp();
    const a = await open(dir);
    try { await a.nodeUpsert(nodeArg('p', 1, { autolink: false })); await settle(a); } finally { await a.dispose(); }
    const b = await open(dir);
    try {
        assert.deepEqual(await flagged(b, ['p']), ['p']);
        await b.nodeUpsert(nodeArg('p', 1)); await b.nodeUpsert(nodeArg('q', 2)); await settle(b);
        assert.deepEqual(await pairs(b), []);
    } finally { await b.dispose(); }
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
