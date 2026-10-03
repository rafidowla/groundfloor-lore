#!/usr/bin/env tsx
/**
 * cloud-review-a1-unit.ts — regression tests for the Opus review of cloud parity Slice A1
 * (findings 1-9, 11). One section per finding; each test failed before its fix.
 *
 * Mock fidelity (D7): the mock mirrors the engine's Filter::matches on update/delete/count,
 * reads only `projection`, can emulate the SQLite connector's id-only query push-down
 * (`queryFilterMode: 'sqlite'`) and can return traverse vertices in non-engine shapes.
 */

import assert from 'node:assert/strict';
import { startCloudFixture, DP_KEY, DP_WORKSPACE, ORG_ID, connectedClient, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import {
    DataplaneScopeError,
    buildDataplaneScopeFilter,
    dataplaneRowKey,
    resolveDataplaneScope,
    scopeRowFields,
    type DataplaneScope,
} from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { isConflictError, scopedDelete } from '../packages/lore/src/engines/dataplaneScopedIo.js';
import { DataplaneCollectionStorage } from '../packages/lore/src/engines/dataplaneCollectionStorage.js';
import { TsSdkAdapter } from '../packages/lore/src/engines/tsSdkAdapter.js';
import { registryAcceptingAny, testRegistry } from './helpers/workspace-registry.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'lore-ws-one';
const W2 = 'lore-ws-two';
const scope = (ws: string): DataplaneScope => ({ orgId: ORG_ID, loreWorkspace: ws, dataplaneWorkspaceId: DP_WORKSPACE });
const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: 'e', metadata: '{}', ...extra,
});
void DP_KEY;

/* ─── #8 row-key separator ─── */
console.log('review A1 #8: row-key separator collision');
await test('dataplaneRowKey rejects U+001F in org / workspace / id', () => {
    const base = scope('w');
    assert.throws(() => dataplaneRowKey({ ...base, orgId: `o${'\u001f'}x` }, 'id'), DataplaneScopeError);
    assert.throws(() => dataplaneRowKey({ ...base, loreWorkspace: `w${'\u001f'}x` }, 'id'), DataplaneScopeError);
    assert.throws(() => dataplaneRowKey(base, `i${'\u001f'}d`), DataplaneScopeError);
    assert.throws(() => scopeRowFields(base, `i${'\u001f'}d`), DataplaneScopeError);
});
await test('the colliding pair from the review can no longer be constructed', () => {
    // (org, "a\u001fb", "c") and (org, "a", "b\u001fc") hashed identically before the fix.
    const a = { orgId: 'o', loreWorkspace: 'a\u001fb', dataplaneWorkspaceId: 'dp' };
    const b = { orgId: 'o', loreWorkspace: 'a', dataplaneWorkspaceId: 'dp' };
    assert.throws(() => dataplaneRowKey(a, 'c'), DataplaneScopeError);
    assert.throws(() => dataplaneRowKey(b, 'b\u001fc'), DataplaneScopeError);
});
await test('resolveDataplaneScope rejects a workspace or org containing U+001F', () => {
    assert.throws(() => resolveDataplaneScope({ orgId: 'o', dataplaneWorkspaceId: 'dp', workspaceRegistry: registryAcceptingAny(), loreWorkspaceProvider: () => 'a\u001fb' }), DataplaneScopeError);
    assert.throws(() => resolveDataplaneScope({ orgId: 'o\u001f', dataplaneWorkspaceId: 'dp', workspaceRegistry: registryAcceptingAny(), loreWorkspaceProvider: () => 'ok' }), DataplaneScopeError);
});
await test('ordinary ids still hash (stable lw1_ key)', () => {
    assert.match(dataplaneRowKey(scope('w'), 'some-id'), /^lw1_[0-9a-f]{64}$/);
});

/* ─── #9 isConflictError ─── */
console.log('review A1 #9: isConflictError matches status/code only');
await test('status / statusCode 409 is a conflict', () => {
    assert.equal(isConflictError({ status: 409 }), true);
    assert.equal(isConflictError({ statusCode: 409 }), true);
});
await test('a message that merely mentions conflict / duplicate / 409 is NOT a conflict', () => {
    assert.equal(isConflictError(new Error('connection reset (409 bytes read)')), false);
    assert.equal(isConflictError(new Error('schema already exists')), false);
    assert.equal(isConflictError({ status: 500, message: 'duplicate key value violates unique constraint' }), false);
    assert.equal(isConflictError({ status: 400, message: 'conflict in filter' }), false);
});
await test('non-error inputs are not conflicts', () => {
    assert.equal(isConflictError(undefined), false);
    assert.equal(isConflictError(null), false);
    assert.equal(isConflictError('409'), false);
});

/* ─── #5 crud client predicate re-checks the caller clauses ─── */
console.log('review A1 #5: crud predicate covers caller clauses');
await test('builder crud predicate rejects rows that fail type/project/ecosystem/tags/ids/revision/extra', () => {
    const s = scope(W1);
    const row = (over: Record<string, unknown> = {}) => ({
        ...scopeRowFields(s, 'n1'), type: 'note', project: 'p', ecosystem: 'e', tags: 'alpha,beta', revision_state: 'current', updated_at: '2026-01-02T00:00:00Z', ...over,
    });
    const b = buildDataplaneScopeFilter(s, {
        type: 'note', project: 'p', ecosystem: 'e', tags: ['ALPHA'], loreId: ['n1', 'n2'], revision: 'current',
        extra: [{ field: 'updated_at', op: 'lt', value: '2026-01-03T00:00:00Z' }],
    }, 'crud', 0);
    assert.equal(b.clientPredicate(row()), true);
    assert.equal(b.clientPredicate(row({ type: 'decision' })), false);
    assert.equal(b.clientPredicate(row({ project: 'other' })), false);
    assert.equal(b.clientPredicate(row({ ecosystem: 'other' })), false);
    assert.equal(b.clientPredicate(row({ tags: 'gamma' })), false);
    assert.equal(b.clientPredicate(row({ tags: ['alpha', 'x'] })), true);
    assert.equal(b.clientPredicate(row({ revision_state: 'old' })), false);
    assert.equal(b.clientPredicate(row({ updated_at: '2026-02-01T00:00:00Z' })), false);
    assert.equal(b.clientPredicate({ ...row(), lore_id: 'n3', id: dataplaneRowKey(s, 'n3') }), false);
    // scope is still enforced
    assert.equal(b.clientPredicate({ ...row(), lore_workspace: W2 }), false);
});
await test('crud predicate with no caller clauses is scope-only (unchanged)', () => {
    const s = scope(W1);
    const b = buildDataplaneScopeFilter(s, {}, 'crud', 0);
    assert.equal(b.clientPredicate({ ...scopeRowFields(s, 'x'), anything: 1 }), true);
});

const fx = await startCloudFixture();
try {
    await fx.as(W1, async () => {
        await fx.graph.upsertNode(node('a1', { type: 'note', project: 'p1', tags: ['red'] }) as never);
        await fx.graph.upsertNode(node('a2', { type: 'decision', project: 'p2', tags: ['blue'] }) as never);
    });
    await test('e2e on a filter-ignoring connector: listNodes / search / bulkList honour type+project+tag', async () => {
        fx.mock.options.queryFilterMode = 'sqlite';
        try {
            const byType = await fx.as(W1, () => fx.graph.listNodes('decision'));
            assert.deepEqual(byType.map((n) => n.id), ['a2']);
            const byProject = await fx.as(W1, () => fx.graph.listNodes(undefined, undefined, 'p1'));
            assert.deepEqual(byProject.map((n) => n.id), ['a1']);
            const byTag = await fx.as(W1, () => fx.graph.listNodes(undefined, 'blue'));
            assert.deepEqual(byTag.map((n) => n.id), ['a2']);
            const s = await fx.as(W1, () => fx.graph.search('content', 10, 'p2'));
            assert.deepEqual(s.map((n) => n.id), ['a2']);
            const page = await fx.as(W1, () => fx.graph.bulkList({ limit: 10, types: ['note'] } as never));
            assert.deepEqual(page.nodes.map((n) => n['id']), ['a1']);
        } finally { fx.mock.options.queryFilterMode = 'full'; }
    });
    /* ─── #2 + #3 topology overviews ─── */
    console.log('review A1 #2/#3: topology overviews are scope-checked and use `projection`');
    await fx.as(W1, async () => {
        await fx.graph.upsertNode(node('t1', { project: 'alpha', type: 'note', metadata: JSON.stringify({}), language: 'en' }) as never);
        await fx.graph.upsertNode(node('t2', { project: 'alpha', type: 'decision' }) as never);
    });
    await fx.as(W2, async () => {
        for (const id of ['u1', 'u2', 'u3']) await fx.graph.upsertNode(node(id, { project: 'beta', type: 'bug_pattern' }) as never);
    });
    await test('#3: overview queries send `projection` (engine key), never `fields`', async () => {
        const before = fx.mock.requests.length;
        await fx.as(W1, () => fx.graph.getTopologyOverview());
        await fx.as(W1, () => fx.graph.getTopologyOverviewByType());
        await fx.as(W1, () => fx.graph.getLanguageBreakdown());
        const qs = fx.mock.requests.slice(before).filter((r) => r.method === 'POST' && r.path.endsWith('/lore_node/query'));
        assert.ok(qs.length >= 3, `expected >=3 lore_node queries, saw ${qs.length}`);
        for (const q of qs) {
            assert.ok(!('fields' in q.body), 'no `fields` key');
            assert.ok(Array.isArray(q.body['projection']), 'projection present');
        }
    });
    await test('#2: on a filter-ignoring connector the overviews count only the bound workspace', async () => {
        fx.mock.options.queryFilterMode = 'sqlite';
        try {
            const o = await fx.as(W1, () => fx.graph.getTopologyOverview());
            assert.equal(o.totalNodes, 4, 'W1 has exactly its own 4 nodes (a1,a2,t1,t2)');
            assert.ok(!o.blobs.some((b) => b.project === 'beta'), 'no foreign project leaks into blobs');
            const byType = await fx.as(W1, () => fx.graph.getTopologyOverviewByType());
            assert.equal(byType.totalNodes, o.totalNodes);
            assert.ok(!byType.blobs.some((b) => b.project === 'bug_pattern'), 'no foreign type leaks');
            const lang = await fx.as(W1, () => fx.graph.getLanguageBreakdown());
            assert.equal(Object.values(lang).reduce((a, b) => a + b, 0), 4, 'language tally covers W1 rows only');
            const o2 = await fx.as(W2, () => fx.graph.getTopologyOverview());
            assert.equal(o2.totalNodes, 3);
        } finally { fx.mock.options.queryFilterMode = 'full'; }
    });
    /* ─── #7 traverse vertex shapes ─── */
    console.log('review A1 #7: traverse tolerates engine vertex-id shapes');
    await fx.as(W1, async () => {
        for (const id of ['v1', 'v2', 'v3']) await fx.graph.upsertNode(node(id) as never);
        await fx.graph.addEdge({ sourceId: 'v1', targetId: 'v2', relation: 'links' });
        await fx.graph.addEdge({ sourceId: 'v2', targetId: 'v3', relation: 'links' });
    });
    for (const shape of ['bare', 'prefixed', 'key'] as const) {
        await test(`traverse returns in-scope vertices when the engine ids are '${shape}'`, async () => {
            fx.mock.options.traverseVertexShape = shape;
            try {
                const r = await fx.as(W1, () => fx.graph.traverse('v1', 3));
                assert.deepEqual(r.map((x) => x.node.id).sort(), ['v2', 'v3']);
            } finally { fx.mock.options.traverseVertexShape = 'bare'; }
        });
    }
    await test('a prefixed vertex that belongs to another workspace is still dropped', async () => {
        fx.mock.options.traverseVertexShape = 'prefixed';
        try {
            const r = await fx.as(W2, () => fx.graph.traverse('v1', 3));
            assert.deepEqual(r, []);
        } finally { fx.mock.options.traverseVertexShape = 'bare'; }
    });
    /* ─── #4 storage bulk ops with clauses the engine matcher cannot evaluate ─── */
    console.log('review A1 #4: storage count/deleteWhere with startsWith/contains');
    {
        const client = connectedClient(fx.mock.url, DP_KEY);
        const ws = { current: W1 };
        const storage = new DataplaneCollectionStorage({ client: client as never, scopeProvider: () => scope(ws.current) });
        const fieldNames = ['org_id', 'lore_workspace', 'lore_id', 'name', 'source_id', 'target_id', 'relation'];
        for (const coll of ['a1_items', 'a1_edges']) {
            await client.createCollection(DP_WORKSPACE, { name: coll, fields: fieldNames.map((n) => ({ name: n, type: 'string' })) });
        }
        const seed = async (w: string) => {
            ws.current = w;
            for (const n of ['pre-a', 'pre-b', 'other']) await storage.upsert('a1_items', 'name', { name: n });
            await storage.upsert('a1_edges', 'name', { name: 'e1', source_id: 's', target_id: 't1', relation: 'pre-x' });
            await storage.upsert('a1_edges', 'name', { name: 'e2', source_id: 's', target_id: 't2', relation: 'pre-y' });
            await storage.upsert('a1_edges', 'name', { name: 'e3', source_id: 's', target_id: 't3', relation: 'zzz' });
        };
        await seed(W1);
        await seed(W2);
        ws.current = W1;
        await test('count with startsWith counts only matching rows in this workspace', async () => {
            assert.equal(await storage.count('a1_items', { startsWith: { name: 'pre' } }), 2);
            assert.equal(await storage.count('a1_items', { contains: { name: 'PRE' } }), 2);
            assert.equal(await storage.count('a1_items'), 3);
        });
        await test('countEdges with startsWith on relation', async () => {
            assert.equal(await storage.countEdges('a1_edges', { startsWith: { relation: 'pre' } }), 2);
        });
        await test('deleteEdgesWhere startsWith deletes the matches only, in this workspace only', async () => {
            assert.equal(await storage.deleteEdgesWhere('a1_edges', { startsWith: { relation: 'pre' } }), 2);
            assert.equal(await storage.countEdges('a1_edges'), 1);
            ws.current = W2;
            assert.equal(await storage.countEdges('a1_edges'), 3);
            ws.current = W1;
        });
        await test('deleteWhere startsWith deletes 2 and leaves the other workspace untouched', async () => {
            assert.equal(await storage.deleteWhere('a1_items', { startsWith: { name: 'pre' } }), 2);
            assert.equal(await storage.count('a1_items'), 1);
            ws.current = W2;
            assert.equal(await storage.count('a1_items'), 3);
            ws.current = W1;
        });
        await test('eq/in deletes still use the single server-side delete', async () => {
            assert.equal(await storage.deleteWhere('a1_items', { eq: { name: 'other' } }), 1);
        });
        await test('works when the engine honours no query filter (sqlite mode)', async () => {
            ws.current = W2;
            fx.mock.options.queryFilterMode = 'sqlite';
            try {
                assert.equal(await storage.count('a1_items', { startsWith: { name: 'pre' } }), 2);
                assert.equal(await storage.deleteWhere('a1_items', { startsWith: { name: 'pre' } }), 2);
            } finally { fx.mock.options.queryFilterMode = 'full'; ws.current = W1; }
            ws.current = W2;
            assert.equal(await storage.count('a1_items'), 1);
            ws.current = W1;
        });
        await test('an oversized scan throws before deleting anything', async () => {
            ws.current = W2;
            await storage.upsert('a1_items', 'name', { name: 'pre-1' });
            await storage.upsert('a1_items', 'name', { name: 'pre-2' });
            const before = await storage.count('a1_items');
            await assert.rejects(
                scopedDelete(client as never, scope(W2), 'a1_items', { extra: [{ field: 'name', op: 'starts_with', value: 'pre' }] }, undefined, 1),
                /narrow the filter/,
            );
            assert.equal(await storage.count('a1_items'), before);
            ws.current = W1;
        });
    }
    /* ─── #1 TsSdkAdapter (local -> cloud sync) is workspace-scoped ─── */
    console.log('review A1 #1: TsSdkAdapter scopes push / pushDeletes / pull by lore_workspace');
    {
        const mc = connectedClient(fx.mock.url, DP_KEY);
        // Collection-first raw client, as the real GroundfloorClient (adapter wraps it).
        const raw = {
            insert: (c: string, r: unknown) => mc.insert(DP_WORKSPACE, c, r),
            updateByQuery: (c: string, f: object, fields: object) => mc.updateByQuery(DP_WORKSPACE, c, f, fields),
            deleteByQuery: (c: string, f: object) => mc.deleteByQuery(DP_WORKSPACE, c, f),
            query: (c: string, o: unknown) => mc.query(DP_WORKSPACE, c, o),
            graph: mc.graph,
        };
        const mk = (ws: string | undefined) => {
            const a = new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: testRegistry('sync-a', 'sync-b', 'a1-ws'), ...(ws ? { loreWorkspace: ws } : {}) });
            (a as unknown as { client: unknown; connected: boolean }).client = raw;
            (a as unknown as { connected: boolean }).connected = true;
            return a;
        };
        const sn = (id: string, label: string, updatedAt = '2026-09-01T00:00:00.000Z') => ({
            id, type: 'note', label, content: 'c', tags: '', project: 'p', ecosystem: 'e', metadata: '{}',
            createdAt: updatedAt, updatedAt, syncedAt: '',
        });
        // Initialise the cloud collections through the real graph (schema + indexes).
        await fx.as('sync-init', () => fx.graph.upsertNode(node('init') as never));
        const a1 = mk('sync-a');
        const a2 = mk('sync-b');
        await test('an unbound adapter fails closed on push / pushDeletes / pull', async () => {
            const u = mk(undefined);
            await assert.rejects(u.push([sn('x', 'x') as never], []), /workspace/i);
            await assert.rejects(u.pushDeletes(['x']), /workspace/i);
            await assert.rejects(u.pull('1970-01-01T00:00:00.000Z'), /workspace/i);
            const star = mk('*');
            await assert.rejects(star.push([sn('x', 'x') as never], []), /workspace/i);
        });
        await test('the same node id pushed from two workspaces stays two separate rows', async () => {
            await a1.push([sn('shared', 'from-a') as never], []);
            await a2.push([sn('shared', 'from-b') as never], []);
            const r1 = await fx.as('sync-a', () => fx.graph.getNode('shared'));
            const r2 = await fx.as('sync-b', () => fx.graph.getNode('shared'));
            assert.equal(r1?.label, 'from-a');
            assert.equal(r2?.label, 'from-b');
        });
        await test('pushDeletes removes only the bound workspace row', async () => {
            await a1.pushDeletes(['shared']);
            assert.equal(await fx.as('sync-a', () => fx.graph.getNode('shared')), null);
            assert.equal((await fx.as('sync-b', () => fx.graph.getNode('shared')))?.label, 'from-b');
        });
        await test('pull returns only the bound workspace rows', async () => {
            await a1.push([sn('pa', 'pa', '2026-09-02T00:00:00.000Z') as never], []);
            await a2.push([sn('pb', 'pb', '2026-09-02T00:00:00.000Z') as never], []);
            const p1 = await a1.pull('2026-01-01T00:00:00.000Z');
            assert.deepEqual(p1.nodes.map((n) => n.id).sort(), ['pa']);
            const p2 = await a2.pull('2026-01-01T00:00:00.000Z');
            assert.deepEqual(p2.nodes.map((n) => n.id).sort(), ['pb', 'shared']);
        });
        await test('pull drops rows of another workspace when the engine ignores the filter (sqlite mode)', async () => {
            fx.mock.options.queryFilterMode = 'sqlite';
            try {
                const p1 = await a1.pull('2026-01-01T00:00:00.000Z');
                assert.deepEqual(p1.nodes.map((n) => n.id).sort(), ['pa']);
            } finally { fx.mock.options.queryFilterMode = 'full'; }
        });
        await test('edges reference row keys, so a same-named node in another workspace is not linked', async () => {
            const calls: Array<{ fromId: string; toId: string; properties: Record<string, unknown> }> = [];
            const orig = raw.graph.createEdge;
            (raw.graph as { createEdge: unknown }).createEdge = async (t: string, c: string, o: never) => { calls.push(o); return orig(t, c, o); };
            try {
                await a1.push([], [{ sourceId: 'pa', targetId: 'shared', relation: 'links' } as never]);
            } finally { (raw.graph as { createEdge: unknown }).createEdge = orig; }
            assert.equal(calls.length, 1);
            assert.equal(calls[0]!.fromId, `lore_node/${dataplaneRowKey(scope('sync-a'), 'pa')}`);
            assert.equal(calls[0]!.toId, `lore_node/${dataplaneRowKey(scope('sync-a'), 'shared')}`);
            assert.equal(calls[0]!.properties['lore_workspace'], 'sync-a');
        });
        await test('forWorkspace() binds a workspace provider read per operation', async () => {
            let cur = 'sync-a';
            const bound = mk(undefined).forWorkspace(() => cur);
            (bound as unknown as { client: unknown; connected: boolean }).client = raw;
            (bound as unknown as { connected: boolean }).connected = true;
            cur = 'sync-b';
            assert.deepEqual((await bound.pull('2026-01-01T00:00:00.000Z')).nodes.map((n) => n.id).sort(), ['pb', 'shared']);
        });
    }
} finally {
    await fx.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
