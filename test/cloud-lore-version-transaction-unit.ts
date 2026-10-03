#!/usr/bin/env tsx
/**
 * cloud-lore-version-transaction-unit.ts — cloud parity Slice C item 8: node version history in the
 * `lore_version` collection, written ATOMICALLY with the node over `/v1/transaction`.
 *
 *   - an upsert under a version intent writes the node row AND its version row in ONE transaction;
 *   - a failed transaction writes neither (no node, no version row);
 *   - an unchanged re-upsert, a skipped type, and an upsert without an intent record no version;
 *   - a create that loses a duplicate-key race retries as an update, still one version row;
 *   - versions and changesets are per Lore workspace: B cannot read A's history or changeset;
 *   - changeset round trip (header, buffered writes in seq order, write_count, commit);
 *   - recordVersion (rollback / restore / outcome) is a separate best-effort row.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE, ORG_ID } from './helpers/cloud-stores-fixture.js';
import { nodeUpsert as nodeServiceUpsert } from '../packages/lore/src/core/nodeService.js';
import { scopeRowFields } from '../packages/lore/src/engines/dataplaneScopeFilter.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const A = 'ver-ws-a';
const B = 'ver-ws-b';
const node = (id: string, label: string, type = 'note') => ({ id, type, label, content: `${label} body`, tags: [] as string[], project: 'p', ecosystem: 'e' }) as never;

const hooks = { failTx: false, beforeTx: undefined as undefined | (() => Promise<void>) };
function wrap(c: any): any {
    return new Proxy(c, {
        get(t, k) {
            const v = t[k];
            if (k === 'transaction') return async (...a: unknown[]) => {
                if (hooks.beforeTx) { const f = hooks.beforeTx; hooks.beforeTx = undefined; await f(); }
                if (hooks.failTx) throw Object.assign(new Error('transaction refused'), { status: 500 });
                return v.apply(t, a);
            };
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
}

console.log('cloud parity C item 8: lore_version + atomic node/version transaction');
const fx = await startCloudFixture({}, { wrapClient: wrap });
const rows = (coll: string, ws: string) => fx.mock.rows(DP_WORKSPACE, coll).filter((r) => r['lore_workspace'] === ws);
const txs = () => fx.mock.requests.filter((r) => r.path === '/v1/transaction');
const intent = { principal: 'tester' };
const upsert = (ws: string, n: ReturnType<typeof node>, i: { principal: string; policy?: { skipTypes?: string[] } } | null = intent) =>
    fx.as(ws, () => (i ? fx.graph.versions.runWithVersionIntent(i, () => fx.graph.upsertNode(n)) : fx.graph.upsertNode(n)));

try {
    await test('an upsert under an intent writes the node and its version row in ONE transaction', async () => {
        const before = txs().length;
        await upsert(A, node('n1', 'first'));
        assert.equal(txs().length - before, 1, 'one transaction');
        const body = JSON.stringify(txs().at(-1)!.body);
        assert.ok(body.includes('lore_node') && body.includes('lore_version'), 'node and version ops in the same request');
        assert.equal(rows('lore_node', A).length, 1);
        const v = rows('lore_version', A);
        assert.equal(v.length, 1);
        assert.equal(v[0]!['kind'], 'node_version');
        assert.equal(v[0]!['node_id'], 'n1');
        assert.equal(v[0]!['principal'], 'tester');
        assert.equal(v[0]!['operation'], 'upsert');
        assert.equal(v[0]!['previous_state'], undefined);
        assert.equal(JSON.parse(String(v[0]!['new_state'])).label, 'first');
    });
    await test('a changed re-upsert records previous and new state; getVersions is newest first', async () => {
        await upsert(A, node('n1', 'second'));
        const vs = await fx.as(A, async () => fx.graph.versions.getVersions('n1', A));
        assert.equal(vs.length, 2);
        assert.equal((vs[0]!.newState as { label: string }).label, 'second');
        assert.equal((vs[0]!.previousState as { label: string }).label, 'first');
        assert.equal(vs[0]!.principal, 'tester');
        assert.equal(vs[0]!.workspace, A);
        assert.equal((vs[1]!.newState as { label: string }).label, 'first');
        assert.equal(vs[1]!.previousState, null);
        assert.ok(vs[0]!.timestamp >= vs[1]!.timestamp);
    });
    await test('an unchanged re-upsert, a skipped type, and a write without an intent record no version', async () => {
        const n = rows('lore_version', A).length;
        await upsert(A, node('n1', 'second')); // identical content
        await upsert(A, node('n2', 'skipme', 'noisy'), { principal: 'tester', policy: { skipTypes: ['noisy'] } });
        await upsert(A, node('n3', 'plain'), null);
        assert.equal(rows('lore_version', A).length, n);
        assert.equal(rows('lore_node', A).length, 3, 'all three nodes were still written');
    });
    await test('a failed transaction writes neither the node nor the version row', async () => {
        const nodes = rows('lore_node', A).length;
        const vers = rows('lore_version', A).length;
        hooks.failTx = true;
        try { await assert.rejects(upsert(A, node('n4', 'doomed')), /transaction refused/); } finally { hooks.failTx = false; }
        assert.equal(rows('lore_node', A).length, nodes);
        assert.equal(rows('lore_version', A).length, vers);
        assert.equal(await fx.as(A, () => fx.graph.getNode('n4')), null);
    });
    await test('a create that loses a duplicate-key race retries as an update: one node, one version row', async () => {
        hooks.beforeTx = async () => { // a concurrent writer inserts the same node first
            const scope = { orgId: ORG_ID, dataplaneWorkspaceId: DP_WORKSPACE, loreWorkspace: A } as never;
            await fx.rawClient.insert(DP_WORKSPACE, 'lore_node', { ...scopeRowFields(scope, 'n5'), type: 'note', label: 'racer' });
        };
        const vers = rows('lore_version', A).length;
        await upsert(A, node('n5', 'mine'));
        const n5 = rows('lore_node', A).filter((r) => r['lore_id'] === 'n5');
        assert.equal(n5.length, 1);
        assert.equal(n5[0]!['label'], 'mine');
        assert.equal(rows('lore_version', A).length, vers + 1);
    });
    await test('workspace B cannot read workspace A\'s versions, diff or changeset', async () => {
        const cs = await fx.as(A, () => fx.graph.versions.createChangeset(A));
        await upsert(B, node('n1', 'b-first')); // same node id in B has its own history
        const bv = await fx.as(B, async () => fx.graph.versions.getVersions('n1', B));
        assert.equal(bv.length, 1);
        assert.equal((bv[0]!.newState as { label: string }).label, 'b-first');
        const bd = await fx.as(B, async () => fx.graph.versions.getDiff(B, '1970-01-01T00:00:00.000Z'));
        assert.ok(bd.every((r) => r.workspace === B && r.nodeId === 'n1'));
        assert.equal(await fx.as(B, async () => fx.graph.versions.getChangeset(cs)), null);
        assert.deepEqual(await fx.as(B, async () => fx.graph.versions.getVersions('n1', A)), [], 'naming A explicitly returns nothing');
        const av = await fx.as(A, async () => fx.graph.versions.getVersions('n1', A));
        assert.ok(av.every((r) => (r.newState as { label: string }).label !== 'b-first'));
    });
    await test('changeset round trip: header, buffered writes in seq order, write_count, commit', async () => {
        const versions = fx.graph.versions;
        const cs = await fx.as(A, async () => versions.createChangeset(A));
        assert.match(cs, /^cs-/);
        const open = await fx.as(A, async () => versions.getChangeset(cs));
        assert.equal(open?.status, 'open');
        assert.equal(open?.writeCount, 0);
        assert.equal(open?.committedAt, null);
        const seqs: number[] = [];
        for (const [i, opName] of ['upsert', 'delete', 'upsert'].entries()) seqs.push(await fx.as(A, async () => versions.addChangesetWrite(cs, opName, { id: `w${i}` })));
        assert.deepEqual(seqs, [0, 1, 2]);
        const writes = await fx.as(A, async () => versions.getChangesetWrites(cs));
        assert.deepEqual(writes.map((w) => [w.seq, w.operation, (w.payload as { id: string }).id]), [[0, 'upsert', 'w0'], [1, 'delete', 'w1'], [2, 'upsert', 'w2']]);
        assert.equal((await fx.as(A, async () => versions.getChangeset(cs)))?.writeCount, 3);
        await fx.as(A, async () => versions.updateChangeset(cs, 'committed'));
        const done = await fx.as(A, async () => versions.getChangeset(cs));
        assert.equal(done?.status, 'committed');
        assert.ok(done?.committedAt);
        assert.deepEqual(await fx.as(B, async () => versions.getChangesetWrites(cs)), []);
    });
    await test('concurrent addChangesetWrite calls get distinct seqs', async () => {
        const versions = fx.graph.versions;
        const cs = await fx.as(A, async () => versions.createChangeset(A));
        const got = await Promise.all([0, 1, 2, 3].map((i) => fx.as(A, async () => versions.addChangesetWrite(cs, 'upsert', { i }))));
        assert.deepEqual([...got].sort(), [0, 1, 2, 3]);
        assert.equal((await fx.as(A, async () => versions.getChangesetWrites(cs))).length, 4);
    });
    await test('recordVersion (rollback / restore / outcome) writes a separate version row, by changeset too', async () => {
        const versions = fx.graph.versions;
        const cs = await fx.as(A, async () => versions.createChangeset(A));
        await fx.as(A, async () => versions.recordVersion({
            versionId: 'v-rollback-1', nodeId: 'n1', workspace: A, timestamp: new Date().toISOString(), principal: 'rollback',
            operation: 'upsert', previousState: { label: 'x' }, newState: { label: 'y' }, changesetId: cs,
        }));
        const byCs = await fx.as(A, async () => versions.getVersionsByChangeset(cs));
        assert.equal(byCs.length, 1);
        assert.equal(byCs[0]!.versionId, 'v-rollback-1');
        assert.equal(byCs[0]!.principal, 'rollback');
        assert.deepEqual(byCs[0]!.previousState, { label: 'x' });
        assert.deepEqual(await fx.as(B, async () => versions.getVersionsByChangeset(cs)), []);
    });
    await test('nodeServiceUpsert with the cloud version store: ONE version row per change, written atomically (no second recordVersion)', async () => {
        const call = (label: string) => fx.as(A, () => nodeServiceUpsert(
            { id: 'svc1', workspace: A, ecosystem: 'e', nodeData: { id: 'svc1', type: 'note', label, content: `${label} body`, tags: [], project: 'p', ecosystem: 'e' }, targetGraph: fx.graph as never, initiator: 'lib:nodeUpsert', skipEmbed: true },
            { versionStore: fx.graph.versions, versionPrincipal: 'lib' } as never,
        ));
        const before = txs().length;
        const r1 = await call('svc one');
        assert.ok((r1 as { ok?: boolean }).ok !== false, JSON.stringify(r1));
        assert.equal(txs().length - before, 1, 'node + version in one transaction');
        await call('svc one'); // unchanged
        await call('svc two');
        const vs = rows('lore_version', A).filter((r) => r['node_id'] === 'svc1');
        assert.equal(vs.length, 2, 'two changes, two versions');
        assert.ok(vs.every((r) => r['principal'] === 'lib'));
    });
    await test('review C #2: a write whose later (verbatim) step fails and is rolled back leaves NO version row to resurrect', async () => {
        const entries: Array<{ id: string; operationKind: string }> = [];
        const store = {
            async record(e: { id: string; operationKind: string }) { if (e.operationKind === 'verbatim.upsert') throw new Error('injected verbatim record failure'); entries.push(e); },
            async markStep() {}, async markCompleted() {},
            async remove(id: string) { const i = entries.findIndex((e) => e.id === id); if (i >= 0) entries.splice(i, 1); },
            async listUnfinished() { return entries.slice(); },
        };
        const call = (label: string) => fx.as(A, () => nodeServiceUpsert(
            { id: 'rb1', workspace: A, ecosystem: 'e', nodeData: { id: 'rb1', type: 'note', label, content: `${label} body`, tags: [], project: 'p', ecosystem: 'e' }, targetGraph: fx.graph as never, initiator: 'lib:nodeUpsert', skipEmbed: false },
            { versionStore: fx.graph.versions, versionPrincipal: 'lib', outboxStore: store } as never,
        ));
        const r = await call('rolled back');
        assert.equal((r as { ok?: boolean }).ok, false, 'the write is reported as failed');
        assert.equal(rows('lore_node', A).filter((x) => x['lore_id'] === 'rb1').length, 0, 'node rolled back');
        assert.equal(rows('lore_version', A).filter((x) => x['node_id'] === 'rb1').length, 0, 'and its version row with it');
        assert.deepEqual(await fx.as(A, async () => fx.graph.versions.getVersions('rb1', A)), []);
    });
    await test('history policy and countPrunable: set/get round trip; cloud has nothing prunable', () => {
        const versions = fx.graph.versions;
        versions.setHistoryPolicy({ skipTypes: ['x'] });
        assert.deepEqual(versions.getHistoryPolicy(), { skipTypes: ['x'] });
        assert.deepEqual(versions.countPrunable(30), { eligibleForCompact: 0, alreadyCompacted: 0 });
        versions.setHistoryPolicy(undefined);
    });
} finally { await fx.close(); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
