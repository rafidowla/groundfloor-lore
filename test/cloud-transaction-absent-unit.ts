#!/usr/bin/env tsx
/**
 * cloud-transaction-absent-unit.ts — cloud parity Slice C item 8 (R3): when the Dataplane has no
 * `/v1/transaction` (404 from a server without the route; 501 from a connector that cannot run one),
 * the change is written FIRST and its history SEPARATELY; a history failure never fails the change,
 * it is counted and surfaced in health (`getCloudHistoryHealth`).
 *
 *   - detection happens once, on first use, by trying the real transaction (no probe write);
 *   - verbatim re-store: canonical row updated, snapshot row written separately;
 *   - a failing snapshot write: the re-store still succeeds, canonical row is the new content,
 *     historyWriteFailures is counted and lastHistoryFailure names the row;
 *   - a failing CHANGE write propagates and writes no history;
 *   - storeBatch keeps the per-row path with snapshots;
 *   - lore_version: a node upsert (with a version intent) writes the node then the version row separately;
 *     a failing version write is counted, the node stays.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE } from './helpers/cloud-stores-fixture.js';
import { DataplaneTransactionRunner, getCloudHistoryHealth } from '../packages/lore/src/engines/dataplaneTransaction.js';
import { isRevisionHistoryId } from '../packages/lore/src/engines/verbatimHistory.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS = 'absent-ws';
const meta = { type: 'note', label: 'l', tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [] };
const doc = (id: string, text: string) => ({ id, text, metadata: meta });

console.log('cloud parity C item 8: transaction route absent (R3)');

type Fx = Awaited<ReturnType<typeof startCloudFixture>>;
const failing = { history: false, change: false };
/** Wrap the client: inserts/updates of `<id>#rev…` rows (history) or of the canonical row (change) can be made to fail. */
function wrap(c: any): any {
    return new Proxy(c, {
        get(t, k) {
            const v = t[k];
            if (k === 'insert') return async (tenant: string, coll: string, rec: Record<string, unknown>, ...r: unknown[]) => {
                if (failing.history && coll === 'lore_verbatim' && isRevisionHistoryId(String(rec['lore_id']))) throw Object.assign(new Error('history insert refused'), { status: 500 });
                if (failing.history && coll === 'lore_version') throw Object.assign(new Error('version insert refused'), { status: 500 });
                return v.call(t, tenant, coll, rec, ...r);
            };
            if (k === 'updateByQuery') return async (tenant: string, coll: string, filter: unknown, fields: Record<string, unknown>, ...r: unknown[]) => {
                if (failing.change && coll === 'lore_verbatim' && fields['text'] === 'will fail') throw Object.assign(new Error('change update refused'), { status: 500 });
                return v.call(t, tenant, coll, filter, fields, ...r);
            };
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
}
const rows = (fx: Fx, coll: string) => fx.mock.rows(DP_WORKSPACE, coll).filter((r) => r['lore_workspace'] === WS);

for (const status of ['absent-404'] as const) {
    const fx = await startCloudFixture({ transactions: false }, { wrapClient: wrap });
    try {
        const txCount = () => fx.mock.requests.filter((r) => r.path === '/v1/transaction').length;
        await test(`[${status}] first use tries the transaction once, then never again (cached)`, async () => {
            await fx.as(WS, () => fx.vector.store(doc('lore:t1', 'one')));
            await fx.as(WS, () => fx.vector.store(doc('lore:t1', 'two')));
            assert.equal(txCount(), 1, 'exactly one attempt reached the server');
            await fx.as(WS, () => fx.vector.store(doc('lore:t1', 'three')));
            assert.equal(txCount(), 1, 'the absence is cached');
            assert.equal(getCloudHistoryHealth()?.transactions, 'absent');
        });
        await test(`[${status}] the change is written and the history row is written separately`, async () => {
            const canon = rows(fx, 'lore_verbatim').find((r) => r['lore_id'] === 'lore:t1')!;
            assert.equal(canon['text'], 'three');
            const hist = rows(fx, 'lore_verbatim').filter((r) => isRevisionHistoryId(String(r['lore_id'])));
            assert.equal(hist.length, 2);
            assert.deepEqual(hist.map((h) => h['text']).sort(), ['one', 'two']);
        });
        await test(`[${status}] a failing history write is counted; the change is kept; the call does not throw`, async () => {
            const before = getCloudHistoryHealth()!.historyWriteFailures;
            failing.history = true;
            try { await fx.as(WS, () => fx.vector.store(doc('lore:t1', 'four'))); } finally { failing.history = false; }
            assert.equal(rows(fx, 'lore_verbatim').find((r) => r['lore_id'] === 'lore:t1')!['text'], 'four');
            const h = getCloudHistoryHealth()!;
            assert.equal(h.historyWriteFailures, before + 1);
            assert.ok(h.lastHistoryFailure && /history insert refused/.test(h.lastHistoryFailure.message));
            assert.ok(h.lastHistoryFailure!.what.includes('lore:t1'));
            assert.ok(h.separateWrites >= 3);
        });
        await test(`[${status}] a failing CHANGE write propagates and writes no history`, async () => {
            const histBefore = rows(fx, 'lore_verbatim').filter((r) => isRevisionHistoryId(String(r['lore_id']))).length;
            failing.change = true;
            try { await assert.rejects(fx.as(WS, () => fx.vector.store(doc('lore:t1', 'will fail'))), /change update refused/); } finally { failing.change = false; }
            assert.equal(rows(fx, 'lore_verbatim').filter((r) => isRevisionHistoryId(String(r['lore_id']))).length, histBefore);
            assert.equal(rows(fx, 'lore_verbatim').find((r) => r['lore_id'] === 'lore:t1')!['text'], 'four');
        });
        await test(`[${status}] storeBatch keeps the per-row path and snapshots changed rows`, async () => {
            await fx.as(WS, () => fx.vector.storeBatch([doc('lore:b1', 'b one'), doc('lore:b2', 'b two')]));
            const before = rows(fx, 'lore_verbatim').length;
            await fx.as(WS, () => fx.vector.storeBatch([doc('lore:b1', 'b one v2'), doc('lore:b2', 'b two'), doc('lore:b3', 'b three')]));
            // b1 changed (+1 snapshot), b2 identical, b3 new (+1 canonical) => +2
            assert.equal(rows(fx, 'lore_verbatim').length, before + 2);
            assert.equal(rows(fx, 'lore_verbatim').find((r) => r['lore_id'] === 'lore:b1')!['text'], 'b one v2');
        });
        const gnode = (id: string, label: string) => ({ id, type: 'note', label, content: `${label} body`, tags: [] as string[], project: 'p', ecosystem: 'e' }) as never;
        const gup = (n: ReturnType<typeof gnode>) => fx.as(WS, () => fx.graph.versions.runWithVersionIntent({ principal: 'tester' }, () => fx.graph.upsertNode(n)));
        await test(`[${status}] lore_version: the node is written, then its version row separately`, async () => {
            await gup(gnode('g1', 'first'));
            assert.equal(rows(fx, 'lore_node').filter((r) => r['lore_id'] === 'g1').length, 1);
            const v = rows(fx, 'lore_version').filter((r) => r['node_id'] === 'g1');
            assert.equal(v.length, 1);
            assert.equal(v[0]!['principal'], 'tester');
            await gup(gnode('g1', 'second'));
            assert.equal(rows(fx, 'lore_version').filter((r) => r['node_id'] === 'g1').length, 2);
        });
        await test(`[${status}] lore_version: a failing version write is counted; the node is kept; no throw`, async () => {
            const before = getCloudHistoryHealth()!.historyWriteFailures;
            failing.history = true;
            try { await gup(gnode('g2', 'kept')); } finally { failing.history = false; }
            assert.equal(rows(fx, 'lore_node').filter((r) => r['lore_id'] === 'g2').length, 1, 'node written');
            assert.equal(rows(fx, 'lore_version').filter((r) => r['node_id'] === 'g2').length, 0, 'no version row');
            const h = getCloudHistoryHealth()!;
            assert.equal(h.historyWriteFailures, before + 1);
            assert.ok(h.lastHistoryFailure!.what.includes('g2'));
        });
    } finally { await fx.close(); }
}

// ── detection rules, at the runner level (a fake client; what a real engine answers is in the mock-fidelity test) ──
const op = [{ op: 'create', collection: 'c', fields: { a: 1 } }] as never;
const err = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
await test('501 (a connector that cannot run transactions) is "absent": nothing applied, the caller writes the group itself', async () => {
    let calls = 0;
    const r = new DataplaneTransactionRunner({ transaction: async () => { calls++; throw err(501); } }, 'postgresql');
    assert.equal(await r.tryCommit('t', op, 'k1'), 'unavailable');
    assert.equal(await r.tryCommit('t', op, 'k2'), 'unavailable');
    assert.equal(calls, 1, 'cached after the first answer');
    assert.equal(r.health().transactions, 'absent');
});
await test('an SDK build without transaction() is absent with NO request', async () => {
    const r = new DataplaneTransactionRunner({}, 'postgresql');
    assert.equal(await r.tryCommit('t', op, 'k'), 'unavailable');
    assert.equal(r.health().transactions, 'absent');
});
await test('a 500 / network error is a FAILED write, not "absent" (never cached as absent)', async () => {
    let calls = 0;
    const r = new DataplaneTransactionRunner({ transaction: async () => { calls++; throw err(500); } }, 'postgresql');
    await assert.rejects(r.tryCommit('t', op, 'k'), /HTTP 500/);
    await assert.rejects(r.tryCommit('t', op, 'k2'), /HTTP 500/);
    assert.equal(calls, 2);
    assert.equal(r.health().transactions, 'unknown');
});
await test('once the route has answered, a later 404 is a failure, not a downgrade', async () => {
    let n = 0;
    const r = new DataplaneTransactionRunner({ transaction: async () => { if (n++ === 0) return { committed: true } as never; throw err(404); } }, 'postgresql');
    assert.equal(await r.tryCommit('t', op, 'k'), 'committed');
    await assert.rejects(r.tryCommit('t', op, 'k2'), /HTTP 404/);
    assert.equal(r.health().transactions, 'present');
});
await test('an alias-shaped top-level value ($x.id) never goes through the transaction route (counted)', async () => {
    let calls = 0;
    const r = new DataplaneTransactionRunner({ transaction: async () => { calls++; return { committed: true } as never; } }, 'postgresql');
    const bad = [{ op: 'create', collection: 'c', fields: { label: '$a.id' } }] as never;
    assert.equal(await r.tryCommit('t', bad, 'k'), 'unavailable');
    assert.equal(calls, 0);
    assert.equal(r.health().aliasFallbacks, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
