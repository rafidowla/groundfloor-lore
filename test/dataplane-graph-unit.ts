#!/usr/bin/env tsx
/**
 * dataplane-graph-unit.ts — Q2.2 DataplaneGraph unit tests.
 *
 * Covers the adapter in isolation with a fake TS-SDK client. The goal
 * isn't Dataplane end-to-end coverage (that's a later e2e slice) — it's
 * verifying the adapter's contract:
 *
 *   - initialize() pushes lore_node + lore_edge schemas and tolerates
 *     "already exists" errors (idempotent boot)
 *   - upsertNode uses updateByQuery, falls through to insert when 0 rows
 *     matched, and preserves the original created_at on updates
 *   - getNode + deleteNode roundtrip correctly; getNode returns null on
 *     404-ish errors
 *   - addEdge writes to lore_edge AND attempts graph.createEdge, ignoring
 *     501 "connector lacks graph support" failures
 *   - traverse tolerates non-graph connectors (empty array instead of throw)
 *   - listNodes / search / getStats / getTopology shape their filters
 *     correctly and carry org_id
 *   - createPluginGraphContext stubs refuse graph ops but expose
 *     detectLanguage
 *   - tenantProvider is called per-operation (multi-tenant routing works
 *     without reconstructing the adapter)
 *
 * No framework; exits non-zero on first failure to match the rest of test/.
 */

import assert from 'node:assert/strict';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';

interface Call {
    method: string;
    args: unknown[];
}

/**
 * FakeClient — records every call, lets tests pre-stage responses per
 * method, and surfaces the call log for assertions.
 */
class FakeClient {
    calls: Call[] = [];
    responses: Partial<Record<string, unknown | ((...args: unknown[]) => unknown)>> = {};
    throws: Partial<Record<string, Error>> = {};

    graph = {
        createEdge: (...args: unknown[]) => this.dispatch('graph.createEdge', args),
        traverse: (...args: unknown[]) => this.dispatch('graph.traverse', args),
    };

    private async dispatch(method: string, args: unknown[]): Promise<unknown> {
        this.calls.push({ method, args });
        if (this.throws[method]) throw this.throws[method];
        const r = this.responses[method];
        if (typeof r === 'function') return (r as (...a: unknown[]) => unknown)(...args);
        return r;
    }

    createCollection = (...args: unknown[]) => this.dispatch('createCollection', args);
    insert = (...args: unknown[]) => this.dispatch('insert', args);
    get = (...args: unknown[]) => this.dispatch('get', args);
    query = (...args: unknown[]) => this.dispatch('query', args);
    updateByQuery = (...args: unknown[]) => this.dispatch('updateByQuery', args);
    deleteByQuery = (...args: unknown[]) => this.dispatch('deleteByQuery', args);
    count = (...args: unknown[]) => this.dispatch('count', args);
}

function buildAdapter(overrides: { tenant?: string; orgId?: string } = {}): {
    adapter: DataplaneGraph;
    client: FakeClient;
} {
    const client = new FakeClient();
    const adapter = new DataplaneGraph({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        tenantProvider: () => overrides.tenant ?? 'tenant-alpha',
        orgId: overrides.orgId ?? 'org-main',
    });
    return { adapter, client };
}

function test(name: string, fn: () => Promise<void> | void): () => Promise<void> {
    return async () => {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            console.error(`  FAIL ${name}`);
            console.error((err as Error).stack ?? String(err));
            process.exit(1);
        }
    };
}

const tests = [
    test('initialize() is a no-op (slice-2: per-tenant lazy push)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        await adapter.initialize();
        const createCalls = client.calls.filter((c) => c.method === 'createCollection');
        assert.equal(createCalls.length, 0, 'boot-time initialize must not hit Dataplane');
    }),

    test('first op per tenant pushes both collections (lazy)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['get'] = null;
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.upsertNode({
            id: 'n-init', type: 'note', label: 'x', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}',
        });
        const createCalls = client.calls.filter((c) => c.method === 'createCollection');
        assert.equal(createCalls.length, 2, 'expected lore_node + lore_edge createCollection on first op');
        const names = createCalls.map((c) => (c.args[1] as { name: string }).name);
        assert.deepEqual(names.sort(), ['lore_edge', 'lore_node']);
        for (const c of createCalls) assert.equal(c.args[0], 'tenant-alpha');
    }),

    test('second op on same tenant does NOT re-push schema', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['get'] = null;
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.upsertNode({ id: 'a', type: 't', label: 'a', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const firstCount = client.calls.filter((c) => c.method === 'createCollection').length;
        await adapter.upsertNode({ id: 'b', type: 't', label: 'b', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const secondCount = client.calls.filter((c) => c.method === 'createCollection').length;
        assert.equal(secondCount, firstCount, 'schema push must be memoized per tenant');
    }),

    test('lazy push tolerates "already exists" on createCollection', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['createCollection'] = new Error('collection already exists');
        client.responses['get'] = null;
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        // Must not throw — "already exists" is swallowed.
        await adapter.upsertNode({ id: 'a', type: 't', label: 'a', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const inserts = client.calls.filter((c) => c.method === 'insert');
        assert.equal(inserts.length, 1, 'op should proceed past idempotent schema push');
    }),

    test('lazy push rethrows non-"already exists" createCollection errors and retries next time', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['createCollection'] = new Error('auth failure');
        let threw = false;
        try {
            await adapter.upsertNode({ id: 'a', type: 't', label: 'a', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        } catch (err) {
            threw = true;
            assert.match((err as Error).message, /auth failure/);
        }
        assert.ok(threw, 'expected non-exists error to propagate');
        // Retry must actually re-attempt (the cached promise is dropped on failure).
        delete client.throws['createCollection'];
        client.responses['createCollection'] = {};
        client.responses['get'] = null;
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.upsertNode({ id: 'a', type: 't', label: 'a', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const createCount = client.calls.filter((c) => c.method === 'createCollection').length;
        assert.ok(createCount >= 3, `expected retry after failure (≥3 total createCollection calls), got ${createCount}`);
    }),

    test('upsertNode inserts when updateByQuery matches 0', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = null; // no prior row
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        const node = await adapter.upsertNode({
            id: 'n1',
            type: 'note',
            label: 'hello',
            content: 'c',
            tags: 'a,b',
            project: 'p',
            ecosystem: 'e',
            metadata: '{}',
        });
        assert.equal(node.id, 'n1');
        assert.ok(node.createdAt.length > 0);
        assert.equal(node.createdAt, node.updatedAt, 'new node createdAt=updatedAt');
        const methods = client.calls.map((c) => c.method);
        assert.ok(methods.includes('updateByQuery'));
        assert.ok(methods.includes('insert'), 'expected insert fallback on updated=0');
        // updateByQuery filter shape sanity.
        const upd = client.calls.find((c) => c.method === 'updateByQuery')!;
        assert.deepEqual(upd.args[2], { id_eq: 'n1' });
    }),

    test('upsertNode skips insert when updateByQuery updated a row', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = { id: 'n2', created_at: '2020-01-01T00:00:00Z' };
        client.responses['updateByQuery'] = { updated: 1 };
        const node = await adapter.upsertNode({
            id: 'n2', type: 'note', label: 'x', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}',
        });
        assert.equal(node.createdAt, '2020-01-01T00:00:00Z', 'must preserve original created_at on update');
        const inserts = client.calls.filter((c) => c.method === 'insert');
        assert.equal(inserts.length, 0, 'no insert when update matched');
    }),

    test('getNode returns null on 404', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['get'] = new Error('not found 404');
        client.responses['query'] = { records: [] };
        const n = await adapter.getNode('missing');
        assert.equal(n, null);
    }),

    test('getNode roundtrips when record present', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = {
            id: 'n3', type: 'note', label: 'L', content: 'C', tags: 't',
            project: 'p', ecosystem: 'e',
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-02T00:00:00Z',
            language: 'en',
        };
        const n = await adapter.getNode('n3');
        assert.ok(n);
        assert.equal(n!.id, 'n3');
        assert.equal(n!.label, 'L');
        assert.equal(n!.language, 'en');
        assert.equal(n!.createdAt, '2026-04-01T00:00:00Z');
    }),

    test('deleteNode reports truthy only when row actually deleted', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['deleteByQuery'] = { deleted: 1 };
        assert.equal(await adapter.deleteNode('n4'), true);
        client.responses['deleteByQuery'] = { deleted: 0 };
        assert.equal(await adapter.deleteNode('nope'), false);
    }),

    test('addEdge writes lore_edge row AND attempts graph.createEdge', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['insert'] = {};
        client.responses['graph.createEdge'] = { edge_id: 'e1' };
        await adapter.addEdge({ sourceId: 'a', targetId: 'b', relation: 'related_to' });
        const insertCall = client.calls.find((c) => c.method === 'insert');
        assert.ok(insertCall, 'expected edge insert');
        const row = insertCall!.args[2] as Record<string, unknown>;
        assert.equal(row['source_id'], 'a');
        assert.equal(row['target_id'], 'b');
        assert.equal(row['relation'], 'related_to');
        assert.equal(row['org_id'], 'org-main');
        assert.ok(client.calls.some((c) => c.method === 'graph.createEdge'));
    }),

    test('addEdge tolerates 501 from connectors without graph support', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['insert'] = {};
        client.throws['graph.createEdge'] = new Error('501 not supported');
        // Must not throw.
        await adapter.addEdge({ sourceId: 'a', targetId: 'b', relation: 'rel' });
        // But non-501 errors still bubble.
        client.throws['graph.createEdge'] = new Error('boom 500');
        let threw = false;
        try {
            await adapter.addEdge({ sourceId: 'c', targetId: 'd', relation: 'rel' });
        } catch { threw = true; }
        assert.ok(threw, 'expected non-501 graph error to propagate');
    }),

    test('addBidirectionalEdge writes both directions', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['insert'] = {};
        client.responses['graph.createEdge'] = { edge_id: 'e' };
        await adapter.addBidirectionalEdge({ sourceId: 'a', targetId: 'b', relation: 'peer' });
        const inserts = client.calls.filter((c) => c.method === 'insert');
        assert.equal(inserts.length, 2);
        const row0 = inserts[0]!.args[2] as Record<string, unknown>;
        const row1 = inserts[1]!.args[2] as Record<string, unknown>;
        assert.equal(row0['source_id'], 'a');
        assert.equal(row1['source_id'], 'b');
    }),

    test('traverse returns [] when connector lacks graph', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['graph.traverse'] = new Error('501 not supported');
        const out = await adapter.traverse('start');
        assert.deepEqual(out, []);
    }),

    test('traverse maps records to TraversalResult', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['graph.traverse'] = {
            records: [
                { id: 'n2', type: 'note', label: 'L2', relation: 'related_to' },
                { id: 'n3', type: 'note', label: 'L3', relation: 'cites' },
            ],
        };
        const out = await adapter.traverse('n1', 2);
        assert.equal(out.length, 2);
        assert.equal(out[0]!.node.id, 'n2');
        assert.equal(out[0]!.relation, 'related_to');
    }),

    test('search carries org_id + label_contains filter', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = { records: [{ id: 'x', type: 'note', label: 'Lx' }] };
        await adapter.search('hello', 5, 'proj', 'eco');
        const q = client.calls.find((c) => c.method === 'query')!;
        const opts = q.args[2] as { filter: Record<string, unknown>; limit: number };
        assert.equal(opts.limit, 5);
        assert.equal(opts.filter['org_id'], 'org-main');
        assert.equal(opts.filter['project'], 'proj');
        assert.equal(opts.filter['ecosystem'], 'eco');
        assert.equal(opts.filter['label_contains'], 'hello');
    }),

    test('listNodes filter includes tag substring match', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = { records: [] };
        await adapter.listNodes('note', 'urgent', 'proj', 'eco');
        const q = client.calls.find((c) => c.method === 'query')!;
        const opts = q.args[2] as { filter: Record<string, unknown> };
        assert.equal(opts.filter['type'], 'note');
        assert.equal(opts.filter['tags_contains'], 'urgent');
    }),

    test('getStats collects counts for both collections', async () => {
        const { adapter, client } = buildAdapter();
        let call = 0;
        client.responses['count'] = (..._args: unknown[]) => {
            call++;
            return call === 1 ? 42 : 17;
        };
        const stats = await adapter.getStats();
        assert.equal(stats.nodeCount, 42);
        assert.equal(stats.edgeCount, 17);
        assert.deepEqual(stats.typeBreakdown, {});
        assert.deepEqual(stats.pluginStats, {});
    }),

    test('getStats survives count errors (per-collection)', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['count'] = new Error('connector down');
        const stats = await adapter.getStats();
        assert.equal(stats.nodeCount, 0);
        assert.equal(stats.edgeCount, 0);
    }),

    test('getTopology shapes nodes + edges for graph viz', async () => {
        const { adapter, client } = buildAdapter();
        let q = 0;
        client.responses['query'] = (..._args: unknown[]) => {
            q++;
            return q === 1
                ? { records: [{ id: 'n1', type: 'note', label: 'L' }] }
                : { records: [{ id: 'e1', source_id: 'n1', target_id: 'n2', relation: 'r' }] };
        };
        const topo = await adapter.getTopology(50);
        assert.equal(topo.nodes.length, 1);
        assert.equal(topo.edges.length, 1);
        const e = topo.edges[0] as { source: string; target: string; relation: string };
        assert.equal(e.source, 'n1');
        assert.equal(e.target, 'n2');
    }),

    test('createPluginGraphContext refuses graph ops, allows detectLanguage', async () => {
        const { adapter } = buildAdapter();
        const ctx = adapter.createPluginGraphContext();
        let threw = false;
        try { await ctx.executeQuery('RETURN 1'); } catch { threw = true; }
        assert.ok(threw, 'executeQuery must refuse in cloud mode');
        threw = false;
        try { await ctx.queryRows('MATCH (n) RETURN n'); } catch { threw = true; }
        assert.ok(threw, 'queryRows must refuse in cloud mode');
        // bumpEpoch is a no-op (no throw).
        ctx.bumpEpoch();
        // detectLanguage delegates to core detector (pure function).
        const det = ctx.detectLanguage('Hello there, this is an English sentence for testing.');
        assert.ok(det !== null && typeof det === 'object');
        assert.ok('language' in det && 'confidence' in det);
    }),

    test('getLanguageBreakdown returns empty stub', async () => {
        const { adapter } = buildAdapter();
        const b = await adapter.getLanguageBreakdown();
        assert.deepEqual(b, {});
    }),

    test('tenantProvider is read per-operation (multi-tenant safe)', async () => {
        const client = new FakeClient();
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        client.responses['get'] = null;
        let current = 'tenant-a';
        const adapter = new DataplaneGraph({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: client as any,
            tenantProvider: () => current,
            orgId: 'org',
        });
        await adapter.upsertNode({ id: 'x', type: 'note', label: 'L', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        current = 'tenant-b';
        await adapter.upsertNode({ id: 'y', type: 'note', label: 'L', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const tenantsSeen = new Set(client.calls.filter((c) => c.method === 'updateByQuery').map((c) => c.args[0]));
        assert.ok(tenantsSeen.has('tenant-a'));
        assert.ok(tenantsSeen.has('tenant-b'));
    }),
];

async function main(): Promise<void> {
    console.log('Q2.2 — DataplaneGraph unit tests');
    console.log('='.repeat(60));
    for (const t of tests) await t();
    console.log('');
    console.log(`all ${tests.length} DataplaneGraph unit tests passed ✓`);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});
