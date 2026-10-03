#!/usr/bin/env tsx
/**
 * cloud-connection-unit.ts — cloud parity Slice C review #1: ONE Dataplane connector on every route.
 *
 * The engine picks a connector PER ROUTE when none is named (sqlite for CRUD / vector, postgresql for
 * keyword search and /v1/transaction, surrealdb for traverse; handlers.rs:265-277, :5384, :5782,
 * :2898). The mock here applies those defaults (`defaultConnector: null`), so a store that does not
 * name its connection splits its data across stores exactly as the real engine would.
 *
 *   - `DATAPLANE_CONNECTION` is read once at boot (cloudBootConfig) and reaches graph, vector store,
 *     version store, transaction runner and the sync adapter;
 *   - SET: every request the stores make resolves to that one connector, transactions included;
 *   - UNSET: /v1/transaction is never sent (unavailable, one warning); writes still work through
 *     the separate-write path;
 *   - SET to a connector that cannot run transactions (sqlite): 501 once, then the fallback path.
 */
import assert from 'node:assert/strict';
import { startMockDataplane } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { bagOfWordsEmbedder } from './helpers/cloud-stores-fixture.js';
import { testRegistry } from './helpers/workspace-registry.js';
import { buildCloudStores } from '../packages/lore/src/mcp/cloudStores.js';
import { resolveCloudBootConfig, resolveDataplaneConnection } from '../packages/lore/src/mcp/cloudBootConfig.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';
import { DataplaneTransactionRunner, transactionRunnerFor } from '../packages/lore/src/engines/dataplaneTransaction.js';
import { TsSdkAdapter } from '../packages/lore/src/engines/tsSdkAdapter.js';
import { log } from '../packages/lore/src/logger.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DP_WS = 'dp-conn';
const KEY = 'conn-key';
const WS = 'conn-ws';
const node = (id: string, label: string) => ({ id, type: 'note', label, content: `${label} body`, tags: [] as string[], project: 'p', ecosystem: 'e' }) as never;
const meta = { type: 'note', label: 'l', tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [] };

const savedEnv = process.env['DATAPLANE_CONNECTION'];
const warnings: string[] = [];
const realWarn = log.warn;
(log as { warn: unknown }).warn = (m: string, ...r: unknown[]) => { warnings.push(m); return (realWarn as (...a: unknown[]) => unknown).call(log, m, ...r); };

async function scenario(conn: string | undefined, fn: (a: { mock: Awaited<ReturnType<typeof startMockDataplane>>; graph: any; vector: any; client: any }) => Promise<void>): Promise<void> {
    delete process.env['DATAPLANE_CONNECTION'];
    const mock = await startMockDataplane({ apiKeys: { [KEY]: DP_WS }, defaultConnector: null });
    const client = createMockDataplaneClient(mock.url, KEY);
    const registry = testRegistry(WS);
    const { graph, vectorStore } = await buildCloudStores({
        apiKey: KEY, baseUrl: mock.url, orgId: 'org-conn', dataplaneWorkspaceId: DP_WS, workspaceRegistry: registry,
        embeddingProvider: bagOfWordsEmbedder(), hasCapability: async () => true,
        clientFactory: () => client as never,
        ...(conn ? { connection: conn } : {}),
    });
    try { await fn({ mock, graph, vector: vectorStore, client }); } finally { await vectorStore.close(); await mock.close(); }
}
const as = <T>(fn: () => Promise<T>) => runWithWorkspace({ workspaceId: WS }, fn);
const txRequests = (mock: { requests: Array<{ path: string }> }) => mock.requests.filter((r) => r.path === '/v1/transaction');

console.log('cloud parity C review #1: one connector on every route');

await test('DATAPLANE_CONNECTION is read at boot, trimmed; blank means unset; an explicit option wins', () => {
    delete process.env['DATAPLANE_CONNECTION'];
    assert.equal(resolveDataplaneConnection(), undefined);
    process.env['DATAPLANE_CONNECTION'] = '  postgresql ';
    assert.equal(resolveDataplaneConnection(), 'postgresql');
    assert.equal(resolveCloudBootConfig({ orgId: 'o', workspaceRegistry: testRegistry() }).connection, 'postgresql');
    assert.equal(resolveCloudBootConfig({ orgId: 'o', workspaceRegistry: testRegistry(), connection: 'arangodb' }).connection, 'arangodb');
    process.env['DATAPLANE_CONNECTION'] = '   ';
    assert.equal(resolveCloudBootConfig({ orgId: 'o', workspaceRegistry: testRegistry() }).connection, undefined);
    delete process.env['DATAPLANE_CONNECTION'];
});

await test('SET: every request of graph + vector + version store resolves to the ONE connector; the transaction runs there', async () => {
    await scenario('postgresql', async ({ mock, graph, vector }) => {
        await as(() => graph.versions.runWithVersionIntent({ principal: 't' }, () => graph.upsertNode(node('n1', 'one'))));
        await as(() => graph.versions.runWithVersionIntent({ principal: 't' }, () => graph.upsertNode(node('n1', 'two'))));
        await as(() => vector.store({ id: 'lore:v1', text: 'apples and pears', metadata: meta }));
        await as(() => vector.store({ id: 'lore:v1', text: 'apples and plums', metadata: meta }));
        const env = (await as(() => vector.bm25Search('plums', 5))) as unknown as { hits: unknown[] };
        assert.ok(env.hits.length >= 1, 'keyword search (postgresql by engine default) finds the row stored through CRUD');
        const seen = mock.requests.filter((r) => r.path !== '/health' && r.path !== '/connectors');
        assert.ok(seen.length > 10);
        const bad = seen.filter((r) => r.connector !== 'postgresql');
        assert.deepEqual(bad.map((r) => `${r.method} ${r.path} -> ${r.connector}`), [], 'no request fell back to a per-route default');
        assert.ok(txRequests(mock).length >= 3, 'node+version and verbatim+snapshot went through /v1/transaction');
        for (const coll of ['lore_node', 'lore_version', 'lore_verbatim']) assert.deepEqual(mock.connectorsWith(DP_WS, coll), ['postgresql'], `${coll} lives on one connector`);
    });
});

await test('UNSET: no /v1/transaction is ever sent; writes use the separate-write path; one warning; health says absent', async () => {
    warnings.length = 0;
    await scenario(undefined, async ({ mock, graph, vector, client }) => {
        await as(() => graph.versions.runWithVersionIntent({ principal: 't' }, () => graph.upsertNode(node('n1', 'one'))));
        await as(() => graph.versions.runWithVersionIntent({ principal: 't' }, () => graph.upsertNode(node('n1', 'two'))));
        await as(() => vector.store({ id: 'lore:v1', text: 'one', metadata: meta }));
        await as(() => vector.store({ id: 'lore:v1', text: 'two', metadata: meta }));
        assert.equal(txRequests(mock).length, 0, 'nothing was sent to /v1/transaction');
        assert.equal((transactionRunnerFor(client)).health().transactions, 'absent');
        const rows = mock.rows(DP_WS, 'lore_verbatim', 'sqlite');
        assert.ok(rows.some((r) => r['lore_id'] === 'lore:v1' && r['text'] === 'two'), 'the change was written');
        assert.ok(rows.some((r) => String(r['lore_id']).startsWith('lore:v1#rev')), 'and its history row, separately');
        assert.equal(mock.rows(DP_WS, 'lore_version', 'sqlite').length, 2, 'the create and the changed upsert each recorded a version row');
        assert.equal(warnings.filter((w) => w === 'cloud_transactions_absent').length, 1, 'logged once');
        assert.equal(warnings.filter((w) => w === 'cloud_connection_unset').length, 1, 'boot warns that no connection is configured');
    });
});

await test('SET to a connector that cannot run transactions (sqlite): the 501 is cached as absent after ONE attempt, writes still land on sqlite', async () => {
    await scenario('sqlite', async ({ mock, graph, vector }) => {
        await as(() => vector.store({ id: 'lore:v1', text: 'one', metadata: meta }));
        await as(() => vector.store({ id: 'lore:v1', text: 'two', metadata: meta }));
        await as(() => vector.store({ id: 'lore:v1', text: 'three', metadata: meta }));
        assert.equal(txRequests(mock).length, 1);
        assert.equal(mock.requests.filter((r) => r.path === '/v1/transaction')[0]!.connector, 'sqlite');
        assert.deepEqual(mock.connectorsWith(DP_WS, 'lore_verbatim'), ['sqlite']);
        void graph;
    });
});

await test('runner: with no connection it never calls transaction() and warns exactly once', async () => {
    warnings.length = 0;
    let called = 0;
    const r = new DataplaneTransactionRunner({ transaction: async () => { called++; return { results: [], committed: true, duration_ms: 0 }; } });
    const op = [{ op: 'create', collection: 'c', fields: { id: 'x' } }] as never;
    assert.equal(await r.tryCommit('t', op, 'k1'), 'unavailable');
    assert.equal(await r.tryCommit('t', op, 'k2'), 'unavailable');
    assert.equal(called, 0);
    assert.equal(warnings.filter((w) => w === 'cloud_transactions_absent').length, 1);
});

await test('sync adapter names the connection on push / pushDeletes / pull / edges', async () => {
    const mock = await startMockDataplane({ apiKeys: { [KEY]: DP_WS }, defaultConnector: null });
    try {
        const c = createMockDataplaneClient(mock.url, KEY);
        const raw = {
            insert: (coll: string, r: unknown, k?: string) => c.insert(DP_WS, coll, r, k),
            updateByQuery: (coll: string, f: object, fields: object, k?: string) => c.updateByQuery(DP_WS, coll, f, fields, k),
            deleteByQuery: (coll: string, f: object, k?: string) => c.deleteByQuery(DP_WS, coll, f, k),
            query: (coll: string, o: unknown, k?: string) => c.query(DP_WS, coll, o, k),
            graph: c.graph,
        };
        const a = new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: DP_WS, orgId: 'org-conn', workspaceRegistry: testRegistry(WS), loreWorkspace: WS, connection: 'arangodb' });
        (a as unknown as { client: unknown; connected: boolean }).client = raw;
        (a as unknown as { connected: boolean }).connected = true;
        const n = (id: string) => ({ id, type: 'note', label: id, content: 'c', tags: [], project: 'p', ecosystem: 'e', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }) as never;
        const res = await a.push([n('s1'), n('s2')], [{ sourceId: 's1', targetId: 's2', relation: 'related_to' } as never]);
        assert.equal(res.failures, 0, JSON.stringify(res.errors));
        await a.pull('1970-01-01T00:00:00.000Z');
        await a.pushDeletes(['s2']);
        const seen = mock.requests.filter((r) => r.path !== '/health');
        assert.ok(seen.length >= 5);
        assert.deepEqual(seen.filter((r) => r.connector !== 'arangodb').map((r) => `${r.method} ${r.path} -> ${r.connector}`), []);
    } finally { await mock.close(); }
});

if (savedEnv === undefined) delete process.env['DATAPLANE_CONNECTION']; else process.env['DATAPLANE_CONNECTION'] = savedEnv;
(log as { warn: unknown }).warn = realWarn;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
