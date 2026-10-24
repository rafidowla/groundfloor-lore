#!/usr/bin/env tsx
/**
 * test/link-on-arrival-flag-off-unit.ts - with LORE_LINK_ON_ARRIVAL unset the
 * engine behaves exactly as before link-on-arrival existed:
 *   - no link service, no link-queue file, no `link` stats;
 *   - the legacy ingest-time autolink still draws semantic_neighbor edges on a
 *     single write;
 *   - bulkIngest draws edges only when the caller asks (autolink:true);
 *   - the flag accepts only explicit opt-in values.
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/link-on-arrival-flag-off-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { isLinkOnArrivalEnabled } from '../packages/lore/src/link/linkConfig.js';
import { createLinkService } from '../packages/lore/src/link/createLinkService.js';
import { signalCommitted } from '../packages/lore/src/link/signalCommitted.js';

delete process.env.LORE_LINK_ON_ARRIVAL;

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'link-off-det';
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
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-link-off-'));
function hasFile(dir: string, name: string): boolean {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() ? hasFile(p, name) : e.name === name) return true;
    }
    return false;
}
const node = (id: string, content: string) => ({
    id, workspace: 'default', ecosystem: '*',
    nodeData: { id, type: 'note', label: id, content, project: 'default', ecosystem: '*' },
});
const TEXT = (n: number) => `the quarterly lease renewal for the downtown office building was approved by the board variant ${n}`;
async function open(dataDir: string) {
    const { createLore } = await import('../packages/lore/src/index.js');
    return createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() }) as Promise<any>;
}
const edgeCount = async (lore: any): Promise<number> =>
    (await lore.store.loreGraph.queryEdges({ limit: 1000, offset: 0, relation: 'semantic_neighbor' })).length;

console.log('\nlink-on-arrival flag OFF\n');

await test('the flag is opt-in: unset, empty, 0 and junk are all off', async () => {
    for (const v of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) {
        assert.equal(isLinkOnArrivalEnabled(v === undefined ? {} : { LORE_LINK_ON_ARRIVAL: v }), false, String(v));
    }
    for (const v of ['1', 'true', 'on']) assert.equal(isLinkOnArrivalEnabled({ LORE_LINK_ON_ARRIVAL: v }), true, v);
});

await test('createLinkService returns null and opens no file when off; signalCommitted is a no-op', async () => {
    const dir = tmp();
    const svc = createLinkService({ loreDir: dir, resolveHandles: async () => null, env: {} });
    assert.equal(svc, null);
    assert.equal(fs.readdirSync(dir).length, 0, 'nothing created');
    signalCommitted(null, 'ws', [{ id: 'x' }]);
    signalCommitted(undefined, 'ws', [{ id: 'x' }]);
});

await test('createLore: no link service, no queue file, no link stats', async () => {
    const dataDir = tmp();
    const lore = await open(dataDir);
    try {
        await lore.nodeUpsert(node('o1', TEXT(1)));
        await lore.awaitEmbeds?.();
        assert.equal(lore.store.linkService, undefined);
        assert.equal(hasFile(dataDir, 'link-queue.sqlite'), false);
    } finally { await lore.dispose(); }
});

await test('single write: the legacy ingest-time autolink still draws edges', async () => {
    const lore = await open(tmp());
    try {
        await lore.nodeUpsert(node('p1', TEXT(1)));
        await lore.awaitEmbeds?.();
        await lore.nodeUpsert(node('p2', TEXT(2)));
        await lore.awaitEmbeds?.();
        await lore.store.autolinkTracker?.drain?.(5000);
        assert.ok(await edgeCount(lore) >= 1, 'legacy autolink produced a semantic_neighbor edge');
    } finally { await lore.dispose(); }
});

await test('bulkIngest: autolink:false draws no edges, autolink:true does (unchanged contract)', async () => {
    const off = await open(tmp());
    try {
        await off.bulkIngest([1, 2, 3].map((n) => node(`q${n}`, TEXT(n))), { embed: 'sync', autolink: false });
        await off.store.autolinkTracker?.drain?.(5000);
        assert.equal(await edgeCount(off), 0, 'no edges when the caller did not ask');
    } finally { await off.dispose(); }
    const on = await open(tmp());
    try {
        await on.bulkIngest([1, 2, 3].map((n) => node(`r${n}`, TEXT(n))), { embed: 'sync', autolink: true });
        await on.store.autolinkTracker?.drain?.(5000);
        assert.ok(await edgeCount(on) >= 1, 'edges when autolink:true');
    } finally { await on.dispose(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
