#!/usr/bin/env tsx
/**
 * test/link-autolink-optout-unit.ts - an explicit `autolink:false` means the memory is never queued for
 * link-on-arrival, at every write entry point. Absent `autolink` on a never-opted-out node leaves the decision
 * to the flag (linked); the opt-out itself is durable (see test/link-optout-durable-unit.ts for the lifetime rules).
 *
 *   entry     nodeUpsert, nodeUpsertBatch, bulkIngest (embed sync + queued), HTTP bulk lane (call-level + per-item),
 *             POST /api/node, /api/load row routing
 *   control   the same writes without the field ARE linked
 *
 * The opt-out is stored in the workspace's own graph database; the engine-level (Postgres) behaviour is covered
 * by test/link-optout-durable-pg.ts.
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/link-autolink-optout-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { handlePostNode } from '../packages/lore/src/mcp/http/routes/nodes/postNode.js';
import { routeJsonlObject } from '../packages/lore/src/storage/loadJobsRunner.js';

process.env.LORE_LINK_ON_ARRIVAL = '1';
process.env.LORE_LINK_MIN_SIM = '0.9';
process.env.LORE_LINK_DUP_SIM = '0.999999';
process.env.LORE_LINK_QUIET_MS = '20';
process.env.LORE_LINK_YIELD_MS = '1';

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'link-optout-det';
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
const tmp = (p = 'lore-link-optout-'): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const BASE = 'the quarterly lease renewal for the downtown office building was approved by the board';
const TEXT = (n: number): string => `${BASE} variant ${n}`;
const nodeArg = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
    id, workspace: 'default', ecosystem: '*',
    nodeData: { id, type: 'note', label: id, content: TEXT(n), project: 'default', ecosystem: '*' }, ...extra,
});

async function open() {
    const { createLore } = await import('../packages/lore/src/index.js');
    return (createLore as any)({ dataDir: tmp(), deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
}
async function settle(lore: any, pauseMs = 0): Promise<void> {
    await lore.awaitEmbeds?.();
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    await lore.store.autolinkTracker?.drain?.(5000);
    await lore.store.linkService.flush();
}
async function pairs(lore: any): Promise<string[]> {
    const edges = await lore.store.loreGraph.queryEdges({ limit: 1000, offset: 0, relation: 'semantic_neighbor' });
    return edges.map((e: any) => [e.sourceId, e.targetId].sort().join('|')).sort();
}
async function inLore(fn: (lore: any) => Promise<void>): Promise<void> {
    const lore = await open();
    try { await fn(lore); } finally { await lore.dispose(); }
}

console.log('\nentry points\n');

await test('control: nodeUpsert without autolink is linked', async () => inLore(async (lore) => {
    await lore.nodeUpsert(nodeArg('c1', 1)); await lore.awaitEmbeds?.();
    await lore.nodeUpsert(nodeArg('c2', 2)); await settle(lore);
    assert.ok((await pairs(lore)).includes('c1|c2'));
}));

await test('nodeUpsert autolink:false writes no automatic edges', async () => inLore(async (lore) => {
    await lore.nodeUpsert(nodeArg('s1', 1, { autolink: false })); await lore.awaitEmbeds?.();
    await lore.nodeUpsert(nodeArg('s2', 2, { autolink: false })); await settle(lore);
    assert.deepEqual(await pairs(lore), []);
    // The rows are still enqueued (the opt-out is checked at link time) and settle as done without writing edges.
    assert.equal(lore.store.linkService.stats().failedTotal, 0);
}));

await test('nodeUpsert: a later write without the field keeps the opt-out; an explicit autolink:true clears it', async () => inLore(async (lore) => {
    await lore.nodeUpsert(nodeArg('r1', 1, { autolink: false })); await settle(lore);
    await lore.nodeUpsert(nodeArg('r1', 1)); await lore.awaitEmbeds?.();
    await lore.nodeUpsert(nodeArg('r2', 2)); await settle(lore);
    assert.deepEqual(await pairs(lore), [], 'omitting autolink keeps the durable no, in both directions');
    await lore.nodeUpsert(nodeArg('r1', 1, { autolink: true })); await settle(lore);
    await lore.nodeUpsert(nodeArg('r2', 2)); await settle(lore);
    assert.ok((await pairs(lore)).includes('r1|r2'), 'explicit true re-enables linking');
}));

await test('nodeUpsert: explicit autolink:true links', async () => inLore(async (lore) => {
    await lore.nodeUpsert(nodeArg('t1', 1, { autolink: true })); await lore.awaitEmbeds?.();
    await lore.nodeUpsert(nodeArg('t2', 2, { autolink: true })); await settle(lore);
    assert.ok((await pairs(lore)).includes('t1|t2'));
}));

await test('nodeUpsertBatch autolink:false writes no automatic edges; the control batch is', async () => inLore(async (lore) => {
    await lore.nodeUpsertBatch([1, 2, 3].map((n) => nodeArg(`b${n}`, n, { autolink: false })) as any);
    await settle(lore, 400);
    assert.deepEqual(await pairs(lore), []);
    await lore.nodeUpsertBatch([1, 2, 3].map((n) => nodeArg(`k${n}`, n)) as any);
    await settle(lore, 400);
    assert.ok((await pairs(lore)).length >= 2, 'control batch linked');
}));

for (const embed of ['sync', 'queued'] as const) {
    await test(`bulkIngest embed:${embed} autolink:false writes no automatic edges; absent autolink links`, async () => inLore(async (lore) => {
        const off = [1, 2, 3, 4].map((n) => nodeArg(`i${n}`, n));
        const r = await lore.bulkIngest(off as any, { embed, autolink: false });
        assert.equal(r.succeeded, 4);
        await settle(lore, 400);
        assert.deepEqual(await pairs(lore), []);
        const on = [1, 2, 3, 4].map((n) => nodeArg(`j${n}`, n));
        const r2 = await lore.bulkIngest(on as any, { embed });
        assert.equal(r2.succeeded, 4);
        await settle(lore, 400);
        assert.ok((await pairs(lore)).length >= 3, 'control linked');
    }));
}

function req(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST', headers: {},
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function res(): ServerResponse & { _status: number; _body: string } {
    return {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        setHeader() { return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    } as unknown as ServerResponse & { _status: number; _body: string };
}
function httpDeps(lore: any): any {
    const registry = lore._daemon.getGraphRegistry();
    return {
        deploymentMode: 'local', dataplane: null, store: lore.store,
        auditLog: { log: () => undefined }, graphRegistry: registry,
        workspaceVerbatimResolver: lore._daemon.getVerbatimResolver(),
        outboxStore: lore._daemon.outboxWiring?.store, outboxLagCache: lore._daemon.outboxWiring?.lagCache,
    };
}
async function bulk(lore: any, payload: Record<string, unknown>): Promise<void> {
    const workspace: string = lore._daemon.getGraphRegistry().activeName();
    const r = res();
    await tryBulkWriteRoutes(req(JSON.stringify({ workspace, ...payload })), r, '/api/nodes/bulk', '/api/nodes/bulk', httpDeps(lore));
    assert.equal(r._status, 200, `status ${r._status} ${r._body.slice(0, 300)}`);
}
const plain = (id: string, n: number, extra: Record<string, unknown> = {}) => ({ id, type: 'note', label: id, content: TEXT(n), ...extra });

for (const embed of ['inline', 'queued'] as const) {
    await test(`HTTP bulk lane embed:${embed} call-level autolink:false writes no automatic edges`, async () => inLore(async (lore) => {
        await bulk(lore, { embed, autolink: false, nodes: [1, 2, 3].map((n) => plain(`h${n}`, n)) });
        await settle(lore, 500);
        assert.deepEqual(await pairs(lore), []);
        await bulk(lore, { embed, nodes: [1, 2, 3].map((n) => plain(`g${n}`, n)) });
        await settle(lore, 500);
        assert.ok((await pairs(lore)).length >= 2, 'control linked');
    }));
    await test(`HTTP bulk lane embed:${embed} per-item autolink:false excludes that item in both directions`, async () => inLore(async (lore) => {
        await bulk(lore, { embed, nodes: [plain('m1', 1, { autolink: false }), plain('m2', 2, { autolink: false }), plain('m3', 3)] });
        await settle(lore, 500);
        const p = await pairs(lore);
        assert.deepEqual(p, [], `m3 is linkable but its only neighbours are opted out: ${JSON.stringify(p)}`);
    }));
}

await test('POST /api/node autolink:false writes no automatic edges; a non-boolean is a 400; absent links', async () => inLore(async (lore) => {
    const workspace: string = lore._daemon.getGraphRegistry().activeName();
    const post = async (body: Record<string, unknown>) => {
        const r = res();
        await handlePostNode(req(JSON.stringify({ workspace, ...body })), r, '/api/node', httpDeps(lore));
        return r;
    };
    const bad = await post({ ...plain('pbad', 1), autolink: 'no' });
    assert.equal(bad._status, 400); assert.match(bad._body, /invalid_autolink/);
    for (const n of [1, 2]) { const r = await post({ ...plain(`p${n}`, n), autolink: false }); assert.ok(r._status < 300, r._body); }
    await settle(lore, 500);
    assert.deepEqual(await pairs(lore), []);
    for (const n of [3, 4]) { const r = await post(plain(`p${n}`, n)); assert.ok(r._status < 300, r._body); }
    await settle(lore, 500);
    assert.ok((await pairs(lore)).includes('p3|p4'), 'control linked');
}));

await test('/api/load JSONL rows carry autolink:false into the routed row (verbatim + vector); absent stays undefined', () => {
    const v = routeJsonlObject({ id: 'l1', text: 'x', autolink: false }, 'ws');
    assert.equal(v?.target, 'verbatim'); assert.equal((v as any).row.autolink, false);
    const w = routeJsonlObject({ target: 'vector', id: 'l2', text: 'x', autolink: false }, 'ws');
    assert.equal((w as any).row.autolink, false);
    const u = routeJsonlObject({ id: 'l3', text: 'x' }, 'ws');
    assert.equal('autolink' in (u as any).row, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
