#!/usr/bin/env tsx
/**
 * cloud-transaction-outcomes-unit.ts — cloud parity Slice C review #3, #4, #5: what a
 * `/v1/transaction` response (or failure) means, judged only from what the REAL engine and SDK give.
 *
 *   #3  an update op that matched 0 rows is silent in the engine (postgres.rs / arangodb.rs report
 *       `matched: 0` and still commit). Lore must not leave the history rows of a change that did
 *       not happen: it removes what that transaction created and writes the group the separate way.
 *   #4  success is `committed === true`. An older engine routes the call to a record create (201, no
 *       `committed`): that is "route absent" on first use and a failure afterwards. `committed:false`
 *       is always a failure.
 *   #5  the SDK's GroundfloorError carries `message` + `statusCode` only (no `.code`). A create is
 *       retried as an update ONLY for 409 + a duplicate-key message; IN_FLIGHT and every other op
 *       failure is surfaced without a second request.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE, DP_KEY, ORG_ID, connectedClient } from './helpers/cloud-stores-fixture.js';
import { startMockDataplane } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { DataplaneTransactionRunner } from '../packages/lore/src/engines/dataplaneTransaction.js';
import { engineField } from '../packages/lore/src/engines/dataplaneScopeFilter.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS = 'outcomes-ws';
const node = (id: string, label: string) => ({ id, type: 'note', label, content: `${label} body`, tags: [] as string[], project: 'p', ecosystem: 'e' }) as never;

const hooks = {
    beforeTx: undefined as undefined | (() => Promise<void>),
    mutate: undefined as undefined | ((res: unknown) => unknown),
    failNodeInsert: false,
};
function wrap(c: any): any {
    return new Proxy(c, {
        get(t, k) {
            const v = t[k];
            if (k === 'transaction') return async (...a: unknown[]) => {
                if (hooks.beforeTx) { const f = hooks.beforeTx; hooks.beforeTx = undefined; await f(); }
                const res = await v.apply(t, a);
                return hooks.mutate ? hooks.mutate(res) : res;
            };
            if (k === 'insert') return async (tenant: string, coll: string, ...r: unknown[]) => {
                if (hooks.failNodeInsert && coll === 'lore_node') throw Object.assign(new Error('node insert refused'), { statusCode: 500 });
                return v.call(t, tenant, coll, ...r);
            };
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
}

console.log('cloud parity C review #3/#4/#5: transaction outcomes');
const intent = { principal: 'tester' };

/* ─── #3 ─────────────────────────────────────────────────── */
{
    const fx = await startCloudFixture({}, { wrapClient: wrap });
    const rows = (coll: string) => fx.mock.rows(DP_WORKSPACE, coll).filter((r) => r['lore_workspace'] === WS);
    const upsert = (n: ReturnType<typeof node>) => fx.as(WS, () => fx.graph.versions.runWithVersionIntent(intent, () => fx.graph.upsertNode(n)));
    const dropNodeRow = async (id: string): Promise<void> => {
        await fx.rawClient.deleteByQuery(DP_WORKSPACE, 'lore_node', engineField('lore_id', 'eq', id) as object);
    };
    try {
        await upsert(node('n1', 'first'));
        await test('#3 a 0-match update (row vanished after the pre-read) still ends with the change applied and ONE version row for it', async () => {
            hooks.beforeTx = () => dropNodeRow('n1');
            await upsert(node('n1', 'second'));
            const nodes = rows('lore_node');
            assert.equal(nodes.length, 1, 'the node row exists again (change applied, not just its history)');
            const versions = rows('lore_version').filter((r) => r['node_id'] === 'n1');
            assert.equal(versions.length, 2, 'first + second, no duplicate or orphan');
            assert.ok(versions.some((v) => JSON.parse(String(v['new_state'])).label === 'second'));
        });
        await test('#3 when the separate change then fails, no version row of the unapplied change remains', async () => {
            const before = rows('lore_version').length;
            hooks.beforeTx = () => dropNodeRow('n1');
            hooks.failNodeInsert = true;
            await assert.rejects(() => upsert(node('n1', 'third')), /node insert refused/);
            hooks.failNodeInsert = false;
            assert.equal(rows('lore_version').length, before, 'the transaction\'s version row was compensated away');
        });
    } finally { await fx.close(); }
}

/* ─── #4 ─────────────────────────────────────────────────── */
{
    const fx = await startCloudFixture({ transactions: 'fallthrough' }, { wrapClient: wrap });
    const rows = (coll: string) => fx.mock.rows(DP_WORKSPACE, coll).filter((r) => r['lore_workspace'] === WS);
    const upsert = (n: ReturnType<typeof node>) => fx.as(WS, () => fx.graph.versions.runWithVersionIntent(intent, () => fx.graph.upsertNode(n)));
    try {
        await test('#4 a 201 without `committed` on first use is "route absent": the write goes through the separate path', async () => {
            await upsert(node('f1', 'old engine'));
            assert.equal(rows('lore_node').length, 1, 'the node row was written');
            assert.equal(rows('lore_version').length, 1, 'and its version row');
            const sent = fx.mock.requests.filter((r) => r.path === '/v1/transaction').length;
            assert.equal(sent, 1, 'the one first-use attempt');
            await upsert(node('f2', 'again'));
            assert.equal(fx.mock.requests.filter((r) => r.path === '/v1/transaction').length, sent, 'detected once: no further transaction is sent');
            assert.equal(rows('lore_version').length, 2);
        });
        await test('follow-up C: the junk row the fall-through create left in collection "transaction" is deleted again (and only that row)', async () => {
            assert.equal(fx.mock.rows(DP_WORKSPACE, 'transaction').length, 0, 'no junk row remains in "transaction"');
            const del = fx.mock.requests.filter((r) => r.method === 'DELETE' && r.path === '/v1/transaction/delete-by-query');
            assert.equal(del.length, 1, 'one targeted delete, by the id the create answered with');
            assert.equal(rows('lore_node').length, 2, 'real data untouched');
        });
        await test('follow-up C: a failed cleanup is logged, never fails the write, and a runner whose client cannot delete just leaves the row', async () => {
            const noDelete = new DataplaneTransactionRunner({ transaction: async () => ({ id: 'junk-1', fields: {} }) } as never, 'postgresql');
            assert.equal(await noDelete.tryCommit(DP_WORKSPACE, [{ op: 'delete', collection: 'lore_node', filter: {} }], 'k-c1'), 'unavailable');
            assert.equal(noDelete.health().transactions, 'absent');
            const failing = new DataplaneTransactionRunner({
                transaction: async () => ({ id: 'junk-2', fields: {} }),
                deleteByQuery: async () => { throw new Error('delete refused'); },
            } as never, 'postgresql');
            assert.equal(await failing.tryCommit(DP_WORKSPACE, [{ op: 'delete', collection: 'lore_node', filter: {} }], 'k-c2'), 'unavailable');
            assert.equal(failing.health().transactions, 'absent');
        });
    } finally { await fx.close(); }
}
{
    const fx = await startCloudFixture({}, { wrapClient: wrap });
    const rows = (coll: string) => fx.mock.rows(DP_WORKSPACE, coll).filter((r) => r['lore_workspace'] === WS);
    const upsert = (n: ReturnType<typeof node>) => fx.as(WS, () => fx.graph.versions.runWithVersionIntent(intent, () => fx.graph.upsertNode(n)));
    try {
        await upsert(node('p1', 'present'));
        await test('#4 once the route is known present, a response without `committed:true` is a FAILURE, never a silent success', async () => {
            hooks.mutate = () => ({ results: [] });
            await assert.rejects(() => upsert(node('p2', 'x')), /committed/);
            hooks.mutate = undefined;
        });
        await test('#4 `committed:false` is always a failure (also on first use: it does not mean "absent")', async () => {
            hooks.mutate = (r) => ({ ...(r as object), committed: false });
            await assert.rejects(() => upsert(node('p3', 'x')), /committed/);
            hooks.mutate = undefined;
            const c = connectedClient(fx.mock.url, DP_KEY);
            const fresh = new DataplaneTransactionRunner({ transaction: async () => ({ results: [], committed: false, duration_ms: 0 }) } as never, 'postgresql');
            await assert.rejects(() => fresh.tryCommit(DP_WORKSPACE, [{ op: 'delete', collection: 'lore_node', filter: {} }], 'k-false'), /committed/);
            assert.equal(fresh.health().transactions, 'unknown');
            void c;
        });
    } finally { await fx.close(); }
}

/* ─── #5 ─────────────────────────────────────────────────── */
{
    const mock = await startMockDataplane({ apiKeys: { k5: 'dp5' } });
    const client = createMockDataplaneClient(mock.url, 'k5');
    const conn = connectedClient(mock.url, 'k5');
    const txs = () => mock.requests.filter((r) => r.path === '/v1/transaction').length;
    try {
        await conn.createCollection('dp5', { name: 'probe', fields: [{ name: 'id', type: 'string' }, { name: 'v', type: 'string' }] });
        await conn.insert('dp5', 'probe', { id: 'existing', v: 'old' });
        const create = (id: string, v: string) => ({ op: 'create' as const, collection: 'probe', fields: { id, v } });
        const update = (id: string, v: string) => ({ op: 'update' as const, collection: 'probe', filter: engineField('id', 'eq', id) as object, fields: { v } });
        await test('#5 the SDK error has no `.code`: that is what the real client throws', async () => {
            const err = await client.transaction('dp5', [create('existing', 'x')], { connection: 'postgresql', idempotencyKey: 'probe-0' }).catch((e) => e);
            assert.equal(err.statusCode, 409);
            assert.equal((err as { code?: unknown }).code, undefined);
        });
        await test('#5 a duplicate-key create is retried ONCE as an update, under a new key', async () => {
            const n = txs();
            const r = new DataplaneTransactionRunner(client as never, 'postgresql');
            assert.equal(await r.tryCommit('dp5', [create('existing', 'new')], 'dup-1', [update('existing', 'new')]), 'committed');
            assert.equal(txs() - n, 2);
            assert.equal(mock.rows('dp5', 'probe', 'postgresql').find((x) => x['id'] === 'existing')!['v'], 'new');
        });
        await test('#5 "still in flight" is NOT retried: one request, the failure surfaces', async () => {
            const n = txs();
            const release = mock.holdInFlight('dp5', 'busy-1');
            const r = new DataplaneTransactionRunner(client as never, 'postgresql');
            await assert.rejects(() => r.tryCommit('dp5', [create('existing', 'z')], 'busy-1', [update('existing', 'z')]), /in flight/);
            release();
            assert.equal(txs() - n, 1, 'no "-u" retry for an in-flight 409');
        });
        await test('#5 any other op failure (relation missing) is NOT retried as an update', async () => {
            const n = txs();
            const r = new DataplaneTransactionRunner(client as never, 'postgresql');
            const ghost = { op: 'create' as const, collection: 'no_such_table', fields: { id: 'a' } };
            await assert.rejects(() => r.tryCommit('dp5', [ghost], 'ghost-1', [{ op: 'update', collection: 'no_such_table', filter: {}, fields: { id: 'a' } }]), /does not exist/);
            assert.equal(txs() - n, 1);
        });
    } finally { await mock.close(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
