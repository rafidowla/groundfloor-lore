#!/usr/bin/env tsx
/**
 * test/atomic-bulk-unit.ts - 3.35.0 (S2): `POST /api/nodes/bulk` with `atomic: true`.
 *
 * Plan 3.1/3.2: every item lands or none does. Covers
 *   wiring   one `commitNodeBatch` call carries the whole batch (FAILS if the route bypasses the
 *            `hasNodeBatchSupport` branch); an engine without the primitive answers 501 not_supported and writes nothing;
 *            atomic omitted / false keeps today's per-chunk behaviour (zero primitive calls for plain items)
 *   outcomes 200 / 409 already_exists, revision_mismatch, precondition_failed (judged BEFORE the commit and moved
 *            DURING it) / 422 refusals (D3-D6, duplicate ids, invalid item, lock cap) / 503 contention, lock_timeout,
 *            outcome_unknown - each with the failing index and NOTHING written
 *   outbox   pending_commit while the batch runs, ready after; zero rows after any abort; a plain item whose revision a
 *            rival moved is re-stamped and the batch lands; an unproven unknown keeps the rows for the sweep
 *   settle   a MIXED unknown outcome (some writes show this batch's stamp, some not) is never reported as success/failure
 *
 * Run: npx tsx test/atomic-bulk-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { withNodeLocks } from '../packages/lore/src/core/nodeWriteLock.js';
import { commitNodeBatchWithRetry } from '../packages/lore/src/engines/graphShared/nodeBatchRetry.js';
import { OutcomeUnknownError } from '../packages/lore/src/engines/graphShared/writeOutcome.js';
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
    ws: string; graph: SqliteGraph; outbox: FileOutboxStore; handle: any;
    calls: Array<{ checks: NodeBatchCheck[]; writes: NodeBatchWrite[] }>;
    /** Runs before the real commit of each call (a rival daemon moves a node here); receives the 1-based call number. */
    beforeCommit: ((call: number) => Promise<void>) | null;
    override: ((real: () => Promise<NodeBatchOutcome>, call: number) => Promise<NodeBatchOutcome>) | null;
    statusesDuring: string[][];
    getNodeFail: (() => Error) | null;
}
const nodeIn = (id: string, label = id) => ({ id, type: 'note', label, content: `content ${label}`, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });

async function rig(opts: { hidePrimitive?: boolean } = {}): Promise<Rig> {
    const ws = `atb-${++seq}`;
    const graph = new SqliteGraph(mkTmp('atb-g-'), { workspaceId: ws });
    await graph.initialize();
    const outbox = new FileOutboxStore(mkTmp('atb-o-'));
    const r = { ws, graph, outbox, calls: [], beforeCommit: null, override: null, statusesDuring: [], getNodeFail: null } as unknown as Rig;
    r.handle = new Proxy(graph as object, {
        get(t, p) {
            if (p === 'commitNodeBatch') {
                if (opts.hidePrimitive) return undefined;
                return async (checks: NodeBatchCheck[], writes: NodeBatchWrite[]) => {
                    r.calls.push({ checks, writes });
                    const call = r.calls.length;
                    r.statusesDuring.push((await outbox.listUnfinished()).map((e) => String(e.status)));
                    await r.beforeCommit?.(call);
                    const real = () => graph.commitNodeBatch(checks, writes);
                    return r.override ? r.override(real, call) : real();
                };
            }
            if (p === 'getNode' && r.getNodeFail) return async () => { throw r.getNodeFail!(); };
            const v = (t as any)[p];
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
    return r;
}
const upsertRows = async (r: Rig) => (await r.outbox.listUnfinished()).filter((e) => e.operationKind === 'node.upsert');
const seed = async (r: Rig, id: string, n = 1) => { for (let i = 0; i < n; i++) await r.graph.upsertNode({ ...nodeIn(id, `${id}${i}`) } as never); };
const present = async (r: Rig, ...ids: string[]) => { const out: string[] = []; for (const id of ids) if (await r.graph.getNode(id)) out.push(id); return out; };

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
function res(): ServerResponse & { _status: number; _body: string; _headers: Record<string, string> } {
    return {
        _status: 0, _body: '', _headers: {},
        writeHead(s: number, h?: Record<string, string>) { (this as any)._status = s; (this as any)._headers = h ?? {}; return this; },
        end(b?: string) { (this as any)._body = b ?? ''; },
    } as never;
}
type Body = Record<string, any> & { results?: Array<Record<string, any>> };
async function bulk(r: Rig, nodes: unknown[], extra: Record<string, unknown> = { atomic: true }) {
    const out = res();
    await tryBulkWriteRoutes(req({ workspace: r.ws, nodes, embed: 'skip', ...extra }), out, '/api/nodes/bulk', '/api/nodes/bulk',
        { store: { loreGraph: r.handle, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: r.outbox });
    return { status: out._status, headers: out._headers, body: JSON.parse(out._body) as Body };
}
const clean = async (r: Rig, ...ids: string[]) => { assert.deepEqual(await upsertRows(r), [], 'zero outbox rows'); assert.deepEqual(await present(r, ...ids), [], 'nothing written'); };

console.log('\nsuccess + wiring');

await test('WIRING: atomic:true sends the WHOLE batch as ONE commitNodeBatch (fails if the hasNodeBatchSupport branch is bypassed)', async () => {
    const r = await rig();
    await seed(r, 'old', 2);
    const { status, body } = await bulk(r, [nodeIn('a'), nodeIn('b'), { ...nodeIn('old', 'old-new'), ifRevision: 2 }]);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body['ok'], true);
    assert.equal(body['atomic'], true);
    assert.equal(r.calls.length, 1, 'one primitive call for the whole batch');
    assert.deepEqual(r.calls[0]!.writes.map((w) => w.node.id), ['a', 'b', 'old']);
    assert.deepEqual(body.results!.map((x) => [x['id'], x['ok'], x['revision']]), [['a', true, 1], ['b', true, 1], ['old', true, 3]]);
    assert.deepEqual(r.statusesDuring[0], ['pending_commit', 'pending_commit', 'pending_commit'], 'rows existed, unreplayable, before the commit');
    assert.deepEqual((await upsertRows(r)).map((e) => e.status), ['pending', 'pending', 'pending'], 'flipped ready after');
    assert.deepEqual(await present(r, 'a', 'b'), ['a', 'b']);
});

await test('atomic:true with the default (queued) embed also queues the embeds after the commit', async () => {
    const r = await rig();
    const out = res();
    await tryBulkWriteRoutes(req({ workspace: r.ws, atomic: true, nodes: [nodeIn('a'), nodeIn('b')] }), out, '/api/nodes/bulk', '/api/nodes/bulk',
        { store: { loreGraph: r.handle, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: r.outbox });
    assert.equal(out._status, 200, out._body);
    const kinds = (await r.outbox.listUnfinished()).map((e) => e.operationKind).sort();
    assert.deepEqual(kinds, ['embed.batch', 'node.upsert', 'node.upsert']);
});

await test('atomic omitted and atomic:false keep today\'s behaviour: plain items never touch the primitive', async () => {
    for (const extra of [{}, { atomic: false }]) {
        const r = await rig();
        const { status, body } = await bulk(r, [nodeIn('a'), nodeIn('b')], extra);
        assert.equal(status, 200);
        assert.equal(r.calls.length, 0);
        assert.equal(body['atomic'], undefined);
        assert.deepEqual(await present(r, 'a', 'b'), ['a', 'b']);
    }
});

await test('D11: an engine WITHOUT the primitive answers 501 not_supported and writes nothing', async () => {
    const r = await rig({ hidePrimitive: true });
    const { status, body } = await bulk(r, [nodeIn('a')]);
    assert.equal(status, 501);
    assert.equal(body['code'], 'not_supported');
    assert.equal(body['ok'], false);
    await clean(r, 'a');
});

await test('atomic must be a boolean (400); atomic:false is accepted', async () => {
    const r = await rig();
    for (const bad of ['true', 1, null, {}]) {
        const { status, body } = await bulk(r, [nodeIn('a')], { atomic: bad });
        assert.equal(status, 400, JSON.stringify(body));
    }
    await clean(r, 'a');
});

console.log('\nrefusals (nothing read, nothing written)');

await test('D3: more than 100 items = 422 atomic_batch_too_large', async () => {
    const r = await rig();
    const ok100 = await bulk(r, Array.from({ length: 100 }, (_, i) => nodeIn(`n${i}`)));
    assert.equal(ok100.status, 200, JSON.stringify(ok100.body).slice(0, 300));
    const r2 = await rig();
    const { status, body } = await bulk(r2, Array.from({ length: 101 }, (_, i) => nodeIn(`n${i}`)));
    assert.equal(status, 422);
    assert.equal(body['code'], 'atomic_batch_too_large');
    assert.equal(r2.calls.length, 0);
    await clean(r2, 'n0');
});

await test('D3: more than 400 distinct lock ids (items + preconditions) = 422 atomic_lock_cap', async () => {
    const r = await rig();
    const items = Array.from({ length: 100 }, (_, i) => ({ ...nodeIn(`n${i}`), preconditions: Array.from({ length: 4 }, (_, j) => ({ id: `p${i}-${j}`, revision: 1 })) }));
    const { status, body } = await bulk(r, items);
    assert.equal(status, 422, JSON.stringify(body));
    assert.equal(body['code'], 'atomic_lock_cap');
    assert.equal(r.calls.length, 0);
    await clean(r, 'n0');
});

await test('D4: embed:"inline" (call level or item level) = 422', async () => {
    const r = await rig();
    const a = await bulk(r, [nodeIn('a')], { atomic: true, embed: 'inline' });
    assert.equal(a.status, 422); assert.equal(a.body['code'], 'atomic_inline_embed_unsupported');
    const b = await bulk(r, [nodeIn('a'), { ...nodeIn('b'), embed: true }]);
    assert.equal(b.status, 422); assert.equal(b.body['code'], 'atomic_inline_embed_unsupported'); assert.equal(b.body['failedIndex'], 1);
    await clean(r, 'a', 'b');
});

await test('D5: an item with supersedes = 422 (an empty supersedes is fine)', async () => {
    const r = await rig();
    await seed(r, 'x', 1);
    const a = await bulk(r, [nodeIn('a'), { ...nodeIn('b'), supersedes: ['x'] }]);
    assert.equal(a.status, 422); assert.equal(a.body['code'], 'atomic_supersedes_unsupported'); assert.equal(a.body['failedIndex'], 1);
    await clean(r, 'a', 'b');
    const b = await bulk(r, [{ ...nodeIn('c'), supersedes: [] }]);
    assert.equal(b.status, 200, JSON.stringify(b.body));
});

await test('D6: edges alongside an atomic batch = 422', async () => {
    const r = await rig();
    const { status, body } = await bulk(r, [nodeIn('a')], { atomic: true, edges: [{ sourceId: 'a', targetId: 'b', relation: 'x' }] });
    assert.equal(status, 422); assert.equal(body['code'], 'atomic_edges_unsupported');
    await clean(r, 'a');
});

await test('a repeated id in one atomic batch = 422 atomic_duplicate_ids (the later index is named)', async () => {
    const r = await rig();
    const { status, body } = await bulk(r, [nodeIn('a'), nodeIn('b'), nodeIn('a', 'again')]);
    assert.equal(status, 422); assert.equal(body['code'], 'atomic_duplicate_ids'); assert.equal(body['failedIndex'], 2);
    await clean(r, 'a', 'b');
});

await test('an invalid item fails the WHOLE batch: 422 invalid_item with its index, the valid items are not written', async () => {
    const r = await rig();
    const { status, body } = await bulk(r, [nodeIn('a'), { id: 'b', type: 'note' }, nodeIn('c')]);
    assert.equal(status, 422, JSON.stringify(body));
    assert.equal(body['code'], 'invalid_item');
    assert.equal(body['failedIndex'], 1);
    assert.equal(r.calls.length, 0);
    await clean(r, 'a', 'b', 'c');
});

console.log('\nconditions: 409, nothing written');

await test('ifAbsent on an existing id: 409 already_exists naming the item; the other items are not written', async () => {
    const r = await rig();
    await seed(r, 'b', 1);
    const { status, body } = await bulk(r, [nodeIn('a'), { ...nodeIn('b'), ifAbsent: true }, nodeIn('c')]);
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body['code'], 'already_exists'); assert.equal(body['failedIndex'], 1); assert.equal(body['id'], 'b');
    assert.equal(r.calls.length, 0, 'judged before the commit');
    await clean(r, 'a', 'c');
    assert.equal((await r.graph.getNode('b'))!.revision, 1, 'b untouched');
});

await test('ifAbsent that loses a race to another daemon (id appears between the read and the commit): 409 already_exists, zero rows', async () => {
    const r = await rig();
    r.beforeCommit = async () => { await seed(r, 'b', 1); };
    const { status, body } = await bulk(r, [nodeIn('a'), { ...nodeIn('b'), ifAbsent: true }]);
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body['code'], 'already_exists'); assert.equal(body['failedIndex'], 1);
    assert.deepEqual(await upsertRows(r), []);
    assert.deepEqual(await present(r, 'a'), []);
});

await test('ifRevision that is already wrong: 409 revision_mismatch with currentRevision, judged before the commit', async () => {
    const r = await rig();
    await seed(r, 'o', 3);
    const { status, body } = await bulk(r, [nodeIn('a'), { ...nodeIn('o'), ifRevision: 2 }]);
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body['code'], 'revision_mismatch'); assert.equal(body['failedIndex'], 1); assert.equal(body['currentRevision'], 3);
    assert.equal(r.calls.length, 0);
    await clean(r, 'a');
});

await test('ifRevision that a rival moves DURING the commit: 409 revision_mismatch (never retried), zero rows, nothing written', async () => {
    const r = await rig();
    await seed(r, 'o', 2);
    r.beforeCommit = async () => { await seed(r, 'o', 1); };
    const { status, body } = await bulk(r, [nodeIn('a'), { ...nodeIn('o'), ifRevision: 2 }]);
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body['code'], 'revision_mismatch'); assert.equal(body['failedIndex'], 1); assert.equal(body['currentRevision'], 3);
    assert.equal(r.calls.length, 1, 'an ifRevision miss is final');
    assert.deepEqual(await upsertRows(r), []);
    assert.deepEqual(await present(r, 'a'), []);
    assert.equal((await r.graph.getNode('o'))!.revision, 3);
});

await test('ifRevision on a missing node: 409 revision_mismatch, never creates', async () => {
    const r = await rig();
    const { status, body } = await bulk(r, [{ ...nodeIn('ghost'), ifRevision: 1 }]);
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body['code'], 'revision_mismatch');
    await clean(r, 'ghost');
});

await test('precondition that does not hold: 409 precondition_failed with failedPreconditions, nothing written', async () => {
    const r = await rig();
    await seed(r, 'x', 2);
    const { status, body } = await bulk(r, [nodeIn('a'), { ...nodeIn('b'), preconditions: [{ id: 'x', revision: 1 }] }]);
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body['code'], 'precondition_failed'); assert.equal(body['failedIndex'], 1);
    assert.deepEqual(body['failedPreconditions'], [{ id: 'x', expected: 1, found: 2 }]);
    await clean(r, 'a', 'b');
});

await test('precondition that moves DURING the commit: 409 precondition_failed naming the item, zero rows, nothing written', async () => {
    const r = await rig();
    await seed(r, 'x', 2);
    r.beforeCommit = async () => { await seed(r, 'x', 1); };
    const { status, body } = await bulk(r, [nodeIn('a'), { ...nodeIn('b'), preconditions: [{ id: 'x', revision: 2 }] }]);
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body['code'], 'precondition_failed'); assert.equal(body['failedIndex'], 1);
    assert.deepEqual(body['failedPreconditions'], [{ id: 'x', expected: 2, found: 3 }]);
    assert.deepEqual(await upsertRows(r), []);
    assert.deepEqual(await present(r, 'a', 'b'), []);
});

await test('a precondition that holds is checked, not bumped', async () => {
    const r = await rig();
    await seed(r, 'x', 2);
    const { status, body } = await bulk(r, [{ ...nodeIn('a'), preconditions: [{ id: 'x', revision: 2 }] }]);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(r.calls[0]!.checks, [{ id: 'x', revision: 2 }]);
    assert.equal((await r.graph.getNode('x'))!.revision, 2);
});

console.log('\ncontention, locks, unknown');

await test('a plain item whose revision a rival moves is re-stamped and the batch LANDS (rows follow the real revision)', async () => {
    const r = await rig();
    await seed(r, 'p', 1);
    r.beforeCommit = async (call) => { if (call === 1) await seed(r, 'p', 1); }; // rival bumps p once, before our first commit
    const { status, body } = await bulk(r, [nodeIn('a'), nodeIn('p', 'p-new')]);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(r.calls.length, 2, 're-submitted once');
    assert.equal((r.calls[1]!.writes[1] as { expectedRevision: number }).expectedRevision, 2, 're-stamped on top of the rival\'s write');
    assert.deepEqual(body.results!.map((x) => x['revision']), [1, 3]);
    const rs = await upsertRows(r);
    assert.equal(rs.length, 2, 'one row per item, none duplicated');
    assert.deepEqual(rs.map((e) => e.status), ['pending', 'pending']);
    assert.deepEqual(rs.map((e) => (e.payload as { revision: number }).revision).sort(), [1, 3]);
});

await test('contention exhausted (4 attempts): 503 contention retryable, Retry-After, zero rows, nothing written', async () => {
    const r = await rig();
    r.override = async () => ({ ok: false, code: 'contention' });
    const { status, body, headers } = await bulk(r, [nodeIn('a'), nodeIn('b')]);
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body['code'], 'contention'); assert.equal(body['retryable'], true);
    assert.ok(headers['Retry-After']);
    assert.equal(r.calls.length, 4);
    await clean(r, 'a', 'b');
});

await test('contention that clears on the 3rd attempt lands the batch (D10), the rows recorded once', async () => {
    const r = await rig();
    r.override = async (real, call) => (call < 3 ? { ok: false, code: 'contention' } : real());
    const { status, body } = await bulk(r, [nodeIn('a'), nodeIn('b')]);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(r.calls.length, 3);
    assert.equal((await upsertRows(r)).length, 2);
});

await test('lock_timeout: another write holds one of the batch\'s ids -> 503 lock_timeout, nothing read or written, zero rows', async () => {
    const r = await rig();
    process.env['LORE_NODE_LOCK_WAIT_MS'] = '150';
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withNodeLocks(r.ws, ['b'], () => held);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
        const { status, body, headers } = await bulk(r, [nodeIn('a'), nodeIn('b')]);
        assert.equal(status, 503, JSON.stringify(body));
        assert.equal(body['code'], 'lock_timeout'); assert.equal(body['retryable'], true);
        assert.ok(headers['Retry-After']);
        assert.equal(r.calls.length, 0);
    } finally { release(); await holder; delete process.env['LORE_NODE_LOCK_WAIT_MS']; }
    await clean(r, 'a', 'b');
});

await test('a pre-commit read failure is a 503 (transient) with nothing written, not a 200 with failed items', async () => {
    const { ArcadeHttpError } = await import('../packages/lore/src/engines/arcade/arcadeHttp.js');
    const r = await rig();
    r.getNodeFail = () => new ArcadeHttpError(503, 'Service Unavailable');
    const { status, body } = await bulk(r, [nodeIn('a')]);
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body['ok'], false);
    await clean(r, 'a');
});

await test('unknown outcome that did NOT commit and cannot be proven: 503 outcome_unknown (not retryable), rows stay pending_commit', async () => {
    const r = await rig();
    r.override = async () => ({ ok: false, code: 'unknown' });
    const { status, body } = await bulk(r, [nodeIn('a'), nodeIn('b')]);
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body['code'], 'outcome_unknown'); assert.equal(body['retryable'], false);
    assert.deepEqual((await upsertRows(r)).map((e) => e.status), ['pending_commit', 'pending_commit']);
    assert.deepEqual(await r.outbox.listPendingForWorkspace(r.ws, 100), [], 'not claimable until the sweep settles them');
});

await test('unknown outcome that DID commit is settled by re-reading: 200, rows ready', async () => {
    const r = await rig();
    r.override = async (real) => { await real(); return { ok: false, code: 'unknown' }; };
    const { status, body } = await bulk(r, [nodeIn('a'), nodeIn('b')]);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual((await upsertRows(r)).map((e) => e.status), ['pending', 'pending']);
});

console.log('\nsettle');

await test('a MIXED unknown outcome (some writes carry this batch\'s stamp, some do not) throws OutcomeUnknownError - never ok, never a clean failure', async () => {
    const at = '2026-10-16T00:00:00.000Z';
    const rows: Record<string, unknown> = { a: { ...nodeIn('a'), revision: 1, updatedAt: at } };
    const graph = {
        commitNodeBatch: async () => ({ ok: false, code: 'unknown' } as NodeBatchOutcome),
        getNode: async (id: string) => (rows[id] ?? null) as never,
    };
    await assert.rejects(
        commitNodeBatchWithRetry(graph as never, async () => ({ checks: [], writes: [
            { kind: 'insert', node: nodeIn('a') as never, updatedAt: at },
            { kind: 'insert', node: nodeIn('b') as never, updatedAt: at },
        ] })),
        (e: unknown) => e instanceof OutcomeUnknownError && /mixed outcome/.test((e as Error).message),
    );
});

await test('settle: every write shows the stamp = ok; none and a different row at the first write = a clean conflict', async () => {
    const at = '2026-10-16T00:00:00.000Z';
    const mk = (rows: Record<string, unknown>) => ({
        commitNodeBatch: async () => ({ ok: false, code: 'unknown' } as NodeBatchOutcome),
        getNode: async (id: string) => (rows[id] ?? null) as never,
    });
    const plan = async () => ({ checks: [], writes: [
        { kind: 'insert', node: nodeIn('a') as never, updatedAt: at },
        { kind: 'insert', node: nodeIn('b') as never, updatedAt: at },
    ] as NodeBatchWrite[] });
    const all = await commitNodeBatchWithRetry(mk({ a: { revision: 1, updatedAt: at }, b: { revision: 1, updatedAt: at } }) as never, plan);
    assert.equal(all.ok, true);
    const other = await commitNodeBatchWithRetry(mk({ a: { revision: 1, updatedAt: 'someone else' } }) as never, plan);
    assert.equal(other.ok, false);
    assert.equal((other as { code: string }).code, 'exists');
    assert.equal((other as { index: number }).index, 0);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
