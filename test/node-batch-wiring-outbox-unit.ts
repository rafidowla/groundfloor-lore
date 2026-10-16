#!/usr/bin/env tsx
/**
 * test/node-batch-wiring-outbox-unit.ts - 3.35.0 (S1): preconditioned writes go through `commitNodeBatch`,
 * and the outbox follows the commit.
 *
 *   wiring   a graph with the primitive: nodeUpsert, POST /api/nodes/bulk and POST /api/node (D8) call
 *            `commitNodeBatch` for a write that carries preconditions. This FAILS if a route bypasses the
 *            `hasNodeBatchSupport` branch (section 6.3 of the plan). A graph without the primitive keeps the
 *            old single-daemon path and still works.
 *   outbox   pending_commit while the batch runs, ready after the commit; an aborted write (precondition
 *            moved, contention exhausted) leaves ZERO rows; an unproven `unknown` keeps the row for the sweep;
 *            an `unknown` that did commit settles and flips the row ready.
 *   D8       single POST /api/node: preconditions validated like bulk (400), refused with 409
 *            precondition_failed + failedPreconditions, contention exhausted = 503 {code:'contention',retryable:true}
 *
 * Run: npx tsx test/node-batch-wiring-outbox-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { handlePostNode } from '../packages/lore/src/mcp/http/routes/nodes/postNode.js';
import type { NodeBatchCheck, NodeBatchOutcome, NodeBatchWrite } from '../packages/lore/src/engines/graphShared/nodeBatch.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

let seq = 0;
interface Rig {
    ws: string; graph: SqliteGraph; outbox: FileOutboxStore;
    /** The handle the code under test sees (a proxy whose commitNodeBatch is spied / overridable). */
    handle: any;
    calls: Array<{ checks: NodeBatchCheck[]; writes: NodeBatchWrite[] }>;
    /** Runs before the real commit of each call (a rival daemon moves a node here). */
    beforeCommit: (() => Promise<void>) | null;
    /** Replace the real commit for one call. */
    override: ((real: () => Promise<NodeBatchOutcome>) => Promise<NodeBatchOutcome>) | null;
    statusesDuring: string[][];
    /** (B) Makes every getNode on the handle fail with this error. */
    getNodeFail: (() => Error) | null;
}
const nodeIn = (id: string, label = id) => ({ id, type: 'note', label, content: `content ${label}`, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });

async function rig(opts: { hidePrimitive?: boolean } = {}): Promise<Rig> {
    const ws = `nbw-${++seq}`;
    const graph = new SqliteGraph(mkTmp('nbw-g-'), { workspaceId: ws });
    await graph.initialize();
    const outbox = new FileOutboxStore(mkTmp('nbw-o-'));
    const r = { ws, graph, outbox, calls: [], beforeCommit: null, override: null, statusesDuring: [], getNodeFail: null } as unknown as Rig;
    r.handle = new Proxy(graph as object, {
        get(t, p) {
            if (p === 'commitNodeBatch') {
                if (opts.hidePrimitive) return undefined;
                return async (checks: NodeBatchCheck[], writes: NodeBatchWrite[]) => {
                    r.calls.push({ checks, writes });
                    r.statusesDuring.push((await outbox.listUnfinished()).map((e) => String(e.status)));
                    await r.beforeCommit?.();
                    const real = () => graph.commitNodeBatch(checks, writes);
                    return r.override ? r.override(real) : real();
                };
            }
            if (p === 'getNode' && r.getNodeFail) return async () => { throw r.getNodeFail!(); };
            const v = (t as any)[p];
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
    return r;
}
const rows = async (r: Rig) => (await r.outbox.listUnfinished()).filter((e) => e.operationKind === 'node.upsert');
const seed = async (r: Rig, id: string, n = 1) => { for (let i = 0; i < n; i++) await r.graph.upsertNode({ ...nodeIn(id, `${id}${i}`) } as never); };
const args = (r: Rig, id: string, preconditions: Array<{ id: string; revision: number }>, extra: Record<string, unknown> = {}) =>
    ({ id, workspace: r.ws, ecosystem: '*', initiator: 'nbw-test', skipEmbed: true, targetGraph: r.handle, nodeData: nodeIn(id, `${id}-new`), preconditions, ...extra });

console.log('\nnodeUpsert');

await test('preconditions go through commitNodeBatch; the row is pending_commit during the batch and ready after', async () => {
    const r = await rig();
    await seed(r, 'x', 2);
    const out = await nodeUpsert(args(r, 'a', [{ id: 'x', revision: 2 }]) as never, { outboxStore: r.outbox } as never);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(r.calls.length, 1, 'the primitive ran');
    assert.deepEqual(r.calls[0]!.checks, [{ id: 'x', revision: 2 }]);
    assert.deepEqual(r.statusesDuring[0], ['pending_commit'], 'the row existed, unreplayable, before the commit');
    const rs = await rows(r);
    assert.deepEqual(rs.map((e) => e.status), ['pending'], 'flipped ready after the commit');
    assert.equal((rs[0]!.payload as { revision: number }).revision, 1);
    assert.equal((await r.graph.getNode('x'))!.revision, 2, 'the checked node was not bumped');
});

await test('the same write on a graph WITHOUT the primitive keeps the single-daemon path (and works)', async () => {
    const r = await rig({ hidePrimitive: true });
    await seed(r, 'x', 2);
    const out = await nodeUpsert(args(r, 'a', [{ id: 'x', revision: 2 }]) as never, { outboxStore: r.outbox } as never);
    assert.equal(out.ok, true);
    assert.equal(r.calls.length, 0);
    const bad = await nodeUpsert(args(r, 'b', [{ id: 'x', revision: 1 }]) as never, { outboxStore: r.outbox } as never);
    assert.equal(bad.ok, false);
    assert.equal((bad as { code: string }).code, 'precondition_failed');
});

await test('aborted write: a precondition that moves between the fast judge and the commit leaves ZERO rows and no node', async () => {
    const r = await rig();
    await seed(r, 'x', 2);
    r.beforeCommit = async () => { await seed(r, 'x', 1); }; // a rival daemon bumps X right before our commit
    const out = await nodeUpsert(args(r, 'a', [{ id: 'x', revision: 2 }]) as never, { outboxStore: r.outbox } as never);
    assert.equal(out.ok, false);
    assert.equal((out as { code: string }).code, 'precondition_failed');
    assert.deepEqual((out as { failedPreconditions?: unknown[] }).failedPreconditions, [{ id: 'x', expected: 2, found: 3 }]);
    assert.deepEqual(await rows(r), [], 'the pending_commit row was retracted');
    assert.equal(await r.graph.getNode('a'), null);
});

await test('contention exhausted: NodeBatchContentionError is thrown, the row is retracted, nothing written', async () => {
    const r = await rig();
    await seed(r, 'x', 1);
    r.override = async () => ({ ok: false, code: 'contention' });
    await assert.rejects(nodeUpsert(args(r, 'a', [{ id: 'x', revision: 1 }]) as never, { outboxStore: r.outbox } as never), /contention/);
    assert.equal(r.calls.length, 4);
    assert.deepEqual(await rows(r), []);
    assert.equal(await r.graph.getNode('a'), null);
});

await test('unknown and unproven: the row stays pending_commit for the sweep (not claimable, not retracted)', async () => {
    const r = await rig();
    await seed(r, 'x', 1);
    r.override = async () => ({ ok: false, code: 'unknown' }); // did not commit, and the re-read shows the old state
    await assert.rejects(nodeUpsert(args(r, 'a', [{ id: 'x', revision: 1 }]) as never, { outboxStore: r.outbox } as never), /outcome_unknown|unknown/i);
    assert.deepEqual((await rows(r)).map((e) => e.status), ['pending_commit']);
    assert.deepEqual(await r.outbox.listPendingForWorkspace(r.ws, 100), []);
});

await test('unknown that DID commit settles by re-reading: success, row flipped ready', async () => {
    const r = await rig();
    await seed(r, 'x', 1);
    r.override = async (real) => { await real(); return { ok: false, code: 'unknown' }; };
    const out = await nodeUpsert(args(r, 'a', [{ id: 'x', revision: 1 }]) as never, { outboxStore: r.outbox } as never);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(r.calls.length, 1, 'never replayed');
    assert.deepEqual((await rows(r)).map((e) => e.status), ['pending']);
});

console.log('\nPOST /api/nodes/bulk');

function req(body: unknown): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST', headers: {},
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(JSON.stringify(body), 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function res(): ServerResponse & { _status: number; _body: string } {
    return { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } } as never;
}
async function bulk(r: Rig, nodes: Array<Record<string, unknown>>) {
    const out = res();
    await tryBulkWriteRoutes(req({ workspace: r.ws, nodes, embed: 'skip' }), out, '/api/nodes/bulk', '/api/nodes/bulk',
        { store: { loreGraph: r.handle, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: r.outbox });
    return { status: out._status, body: JSON.parse(out._body) as { results: Array<Record<string, any>> } };
}

await test('WIRING: a bulk item with preconditions calls commitNodeBatch (fails if the hasNodeBatchSupport branch is bypassed)', async () => {
    const r = await rig();
    await seed(r, 'x', 2);
    const { body } = await bulk(r, [{ ...nodeIn('a'), preconditions: [{ id: 'x', revision: 2 }] }, nodeIn('plain')]);
    assert.equal(body.results[0]!['ok'], true, JSON.stringify(body));
    assert.equal(body.results[1]!['ok'], true);
    assert.equal(r.calls.length, 1, 'exactly the conditional item used the primitive; the plain item did not');
    assert.equal(r.calls[0]!.writes[0]!.node.id, 'a');
    assert.deepEqual(r.statusesDuring[0], ['pending_commit']);
});

await test('bulk without the primitive keeps working on the old path (0 primitive calls)', async () => {
    const r = await rig({ hidePrimitive: true });
    await seed(r, 'x', 2);
    const { body } = await bulk(r, [{ ...nodeIn('a'), preconditions: [{ id: 'x', revision: 2 }] }]);
    assert.equal(body.results[0]!['ok'], true);
    assert.equal(r.calls.length, 0);
});

await test('bulk: a precondition that moves before the commit refuses the item with failedPreconditions and leaves zero rows', async () => {
    const r = await rig();
    await seed(r, 'x', 2);
    r.beforeCommit = async () => { await seed(r, 'x', 1); };
    const { body } = await bulk(r, [{ ...nodeIn('a'), preconditions: [{ id: 'x', revision: 2 }] }]);
    const item = body.results[0]!;
    assert.equal(item['ok'], false);
    assert.deepEqual(item['failedPreconditions'], [{ id: 'x', expected: 2, found: 3 }]);
    assert.deepEqual(await rows(r), []);
    assert.equal(await r.graph.getNode('a'), null);
});

await test('bulk: contention exhausted reports the item as a retryable contention error, nothing written, zero rows', async () => {
    const r = await rig();
    await seed(r, 'x', 1);
    r.override = async () => ({ ok: false, code: 'contention' });
    const { body } = await bulk(r, [{ ...nodeIn('a'), preconditions: [{ id: 'x', revision: 1 }] }]);
    assert.equal(body.results[0]!['ok'], false);
    assert.match(String(body.results[0]!['error']), /^contention/);
    assert.deepEqual(await rows(r), []);
    assert.equal(await r.graph.getNode('a'), null);
});

console.log('\nPOST /api/node (D8)');

const routeNode = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}` });
async function postNode(r: Rig, body: Record<string, unknown>) {
    const out = res();
    await handlePostNode(req({ workspace: r.ws, ...body }), out, '/api/node',
        { store: { loreGraph: r.handle } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: r.outbox } as never);
    return { status: out._status, body: JSON.parse(out._body) as Record<string, any> };
}

await test('D8: preconditions on the single write - holds: 201 via the primitive; fails: 409 precondition_failed with failedPreconditions', async () => {
    const r = await rig();
    await seed(r, 'x', 2);
    const ok = await postNode(r, { ...routeNode('a'), preconditions: [{ id: 'x', revision: 2 }] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(r.calls.length, 1, 'POST /api/node used the primitive');
    const no = await postNode(r, { ...routeNode('b'), preconditions: [{ id: 'x', revision: 1 }] });
    assert.equal(no.status, 409, JSON.stringify(no.body));
    assert.equal(no.body['code'], 'precondition_failed');
    assert.deepEqual(no.body['failedPreconditions'], [{ id: 'x', expected: 1, found: 2 }]);
    assert.equal(await r.graph.getNode('b'), null);
});

await test('D8: invalid preconditions are a 400 (same validation as bulk); the field is never stored on the node', async () => {
    const r = await rig();
    const bad = await postNode(r, { ...routeNode('a'), preconditions: [{ id: 'a', revision: 1 }] });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body['code'], 'invalid_preconditions');
    const bad2 = await postNode(r, { ...routeNode('a'), preconditions: 'nope' });
    assert.equal(bad2.status, 400);
    await seed(r, 'x', 1);
    assert.equal((await postNode(r, { ...routeNode('c'), preconditions: [{ id: 'x', revision: 1 }] })).status, 201);
    assert.ok(!('preconditions' in ((await r.graph.getNode('c')) as object)));
});

await test('D8: contention exhausted is a retryable 503 {code:"contention", retryable:true}; zero rows, nothing written', async () => {
    const r = await rig();
    await seed(r, 'x', 1);
    r.override = async () => ({ ok: false, code: 'contention' });
    const out = await postNode(r, { ...routeNode('a'), preconditions: [{ id: 'x', revision: 1 }] });
    assert.equal(out.status, 503, JSON.stringify(out.body));
    assert.equal(out.body['code'], 'contention');
    assert.equal(out.body['retryable'], true);
    assert.deepEqual(await rows(r), []);
    assert.equal(await r.graph.getNode('a'), null);
});

console.log('\nPOST /api/node pre-write read (B)');

const readTimeout = () => new Error('[ArcadeHttp] request timeout after 30000ms');
await test('B: the read before the write times out -> retryable 503 {code:"timeout"} with Retry-After, nothing written, zero rows', async () => {
    const r = await rig();
    r.getNodeFail = readTimeout;
    const out = await postNode(r, routeNode('a'));
    assert.equal(out.status, 503, JSON.stringify(out.body));
    assert.equal(out.body['code'], 'timeout');
    assert.equal(out.body['retryable'], true);
    assert.equal(out.body['retryAfterSeconds'], 5);
    assert.match(String(out.body['message']), /could not read the current state[\s\S]*nothing was written/);
    r.getNodeFail = null;
    assert.deepEqual(await rows(r), []);
    assert.equal(await r.graph.getNode('a'), null);
});

await test('B: the read before the write cannot reach the database (502/503/504, refused) -> 503 {code:"arcade_unavailable"}', async () => {
    const { ArcadeHttpError } = await import('../packages/lore/src/engines/arcade/arcadeHttp.js');
    for (const mk of [() => new ArcadeHttpError(503, 'down'), () => new ArcadeHttpError(502, 'bad gateway'), () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2480'), { code: 'ECONNREFUSED' })]) {
        const r = await rig();
        r.getNodeFail = mk;
        const out = await postNode(r, routeNode('a'));
        assert.equal(out.status, 503, JSON.stringify(out.body));
        assert.equal(out.body['code'], 'arcade_unavailable');
        assert.equal(out.body['retryable'], true);
    }
});

await test('B: any other pre-write-read failure stays a 500 internal_error (unchanged)', async () => {
    const { ArcadeHttpError } = await import('../packages/lore/src/engines/arcade/arcadeHttp.js');
    for (const mk of [() => new Error('graph exploded'), () => new ArcadeHttpError(500, '{"exception":"java.lang.NullPointerException"}'), () => new ArcadeHttpError(400, 'bad sql')]) {
        const r = await rig();
        r.getNodeFail = mk;
        const out = await postNode(r, routeNode('a'));
        assert.equal(out.status, 500, JSON.stringify(out.body));
        assert.equal(out.body['code'], 'internal_error');
    }
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
