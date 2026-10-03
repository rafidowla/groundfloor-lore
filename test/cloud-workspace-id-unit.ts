#!/usr/bin/env tsx
/**
 * cloud-workspace-id-unit.ts — cloud parity C review #6: cloud rows are keyed on the Lore workspace's
 * PERMANENT ID, not its name.
 *
 * Decision (Rafi, 2026-10-01): every registry entry has an immutable id. `lore_workspace`, the D2 row
 * key and every scope filter carry the id. Rename keeps the id (data stays reachable); delete then
 * recreate gets a NEW id (old rows stay in the Dataplane, unreachable); an alias resolves to its
 * target's id; an unknown name, or an entry with no id, fails closed.
 *
 * The route sweep (`probe`) reads EVERY surface for one workspace name: crud, vector, keyword,
 * traverse, verbatim history, version/changeset history, sync pull and topology.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_KEY, DP_WORKSPACE, ORG_ID, connectedClient, type CloudFixture } from './helpers/cloud-stores-fixture.js';
import { dataplaneRowKey, resolveDataplaneScope, scopeRowFields, DataplaneScopeError, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { TsSdkAdapter } from '../packages/lore/src/engines/tsSdkAdapter.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';
import { testRegistry } from './helpers/workspace-registry.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const NAME = 'tenant-app';
const ID_A = 'id-aaaaaaaa-0001';
const ID_B = 'id-bbbbbbbb-0002';
const scopeFor = (id: string, name: string): DataplaneScope => ({ orgId: ORG_ID, dataplaneWorkspaceId: DP_WORKSPACE, loreWorkspace: id, workspaceName: name });
const node = (id: string, label: string, content: string) => ({ id, type: 'note', label, content, tags: ['t'], project: 'proj', ecosystem: '*', metadata: '{}' });

console.log('cloud parity C review #6: permanent workspace id');
const fx: CloudFixture = await startCloudFixture();
try {
    const mc = connectedClient(fx.mock.url, DP_KEY);
    const rawSdk = {
        insert: (c: string, r: unknown) => mc.insert(DP_WORKSPACE, c, r),
        updateByQuery: (c: string, f: object, fields: object) => mc.updateByQuery(DP_WORKSPACE, c, f, fields),
        deleteByQuery: (c: string, f: object) => mc.deleteByQuery(DP_WORKSPACE, c, f),
        query: (c: string, o: unknown) => mc.query(DP_WORKSPACE, c, o),
        graph: mc.graph,
    };
    const syncAdapter = (ws: string) => {
        const a = new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: fx.registry, loreWorkspace: ws });
        (a as unknown as { client: unknown; connected: boolean }).client = rawSdk;
        (a as unknown as { connected: boolean }).connected = true;
        return a;
    };

    /** Everything one workspace name can see, route by route. */
    const probe = async (ws: string) => fx.as(ws, async () => {
        const hits = await fx.vector.search('zebra savanna', 50);
        const kw = await fx.vector.bm25Search('zebra', 50);
        const trav = await fx.graph.traverse('n1', 3);
        const topo = await fx.graph.getTopology(100);
        const pulled = await syncAdapter(ws).pull('1970-01-01T00:00:00.000Z');
        const cs = await fx.graph.versions.createChangeset(ws).then((id) => fx.graph.versions.getChangeset(id));
        return {
            getNode: (await fx.graph.getNode('n1'))?.label ?? null,
            listNodes: (await fx.graph.listNodes()).map((n) => n.id).sort(),
            search: (await fx.graph.search('zebra', 50)).map((n) => n.id).sort(),
            edges: (await fx.graph.queryEdges({ limit: 50, offset: 0 })).length,
            traverse: trav.map((t) => t.node.id).sort(),
            vector: hits.map((h) => h.id).sort(),
            keyword: kw.hits.map((h) => h.id).sort(),
            vectorCount: await fx.vector.count(),
            history: (await fx.vector.getHistory('n1')).length,
            versions: (await fx.graph.versions.getVersions('n1', ws, 50)).map((v) => v.versionId).sort(),
            changesetWorkspace: cs?.workspace ?? null,
            topologyNodes: topo.nodes.length,
            syncPull: pulled.nodes.map((n) => n.id).sort(),
        };
    });
    const emptyProbe = {
        getNode: null, listNodes: [], search: [], edges: 0, traverse: [], vector: [], keyword: [], vectorCount: 0,
        history: 0, versions: [], topologyNodes: 0, syncPull: [],
    };

    // ---- seed workspace NAME with permanent id ID_A ---------------------------------------------------
    fx.registry.addWithId(NAME, ID_A);
    const scopeA = scopeFor(ID_A, NAME);
    await fx.as(NAME, async () => {
        await fx.graph.upsertNode(node('n1', 'ONE zebra', 'zebra on the savanna') as never);
        await fx.graph.upsertNode(node('n2', 'TWO zebra', 'zebra again') as never);
        await fx.graph.addEdge({ sourceId: 'n1', targetId: 'n2', relation: 'links' } as never);
        await fx.vector.store({ id: 'n1', text: 'zebra grazing on the savanna', metadata: { type: 'note', project: 'proj' } });
        await fx.vector.store({ id: 'n2', text: 'zebra savanna again', metadata: { type: 'note', project: 'proj' } });
    });
    await fx.rawClient.insert(DP_WORKSPACE, 'lore_verbatim', {
        ...scopeRowFields(scopeA, 'n1#rev2026-09-01T00:00:00.000Z'), text: 'old zebra', vector: new Array(16).fill(0), updated_at: '2026-09-01T00:00:00.000Z',
    });
    await fx.rawClient.insert(DP_WORKSPACE, 'lore_version', {
        ...scopeRowFields(scopeA, 'v-1'), kind: 'node_version', node_id: 'n1', timestamp: '2026-09-01T00:00:00.000Z',
        principal: 'p', operation: 'upsert', new_state: JSON.stringify({ label: 'ONE zebra' }), compacted: false,
    });
    const base = await probe(NAME);

    await test('rows carry the permanent id (never the name) in lore_workspace and in the D2 row key', () => {
        const rows = fx.mock.rows(DP_WORKSPACE, 'lore_node').filter((r) => r['lore_id'] === 'n1');
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!['lore_workspace'], ID_A);
        assert.equal(rows[0]!['id'], dataplaneRowKey(scopeA, 'n1'));
        for (const coll of ['lore_node', 'lore_edge', 'lore_verbatim', 'lore_version']) {
            for (const r of fx.mock.rows(DP_WORKSPACE, coll)) assert.notEqual(r['lore_workspace'], NAME, `${coll} row keyed by the name`);
        }
    });
    await test('the row key depends on the id, not the name', () => {
        assert.equal(dataplaneRowKey(scopeFor(ID_A, 'x'), 'n1'), dataplaneRowKey(scopeFor(ID_A, 'y'), 'n1'));
        assert.notEqual(dataplaneRowKey(scopeFor(ID_A, NAME), 'n1'), dataplaneRowKey(scopeFor(ID_B, NAME), 'n1'));
    });
    await test('baseline: every route sees the seeded data under the original name', () => {
        assert.deepEqual(base.listNodes, ['n1', 'n2']);
        assert.equal(base.getNode, 'ONE zebra');
        assert.equal(base.edges, 1);
        assert.deepEqual(base.traverse, ['n2']);
        assert.deepEqual(base.vector, ['n1', 'n2']);
        assert.deepEqual(base.keyword, ['n1', 'n2']);
        assert.equal(base.vectorCount, 3, '2 canonical + 1 snapshot row');
        assert.equal(base.history, 2, 'canonical + 1 snapshot');
        assert.deepEqual(base.versions, ['v-1']);
        assert.deepEqual(base.syncPull, ['n1', 'n2']);
        assert.ok(base.topologyNodes >= 2);
    });

    await test('RENAME: the data is still readable under the new name on every route; the old name no longer resolves', async () => {
        fx.registry.rename(NAME, 'tenant-app-renamed');
        const after = await probe('tenant-app-renamed');
        const { changesetWorkspace: cw, ...rest } = after;
        const { changesetWorkspace: _bw, ...baseRest } = base;
        void _bw;
        assert.deepEqual(rest, baseRest);
        assert.equal(cw, 'tenant-app-renamed', 'versions report the name the caller addressed');
        // (bind directly: fx.as() would auto-register an unknown name)
        await assert.rejects(() => runWithWorkspace({ workspaceId: NAME }, () => fx.graph.getNode('n1')), (e: unknown) => e instanceof DataplaneScopeError && e.code === 'cloud_scope_workspace_not_allowed');
        // a write after the rename lands on the same row, not a second one
        await fx.as('tenant-app-renamed', () => fx.graph.upsertNode(node('n1', 'ONE renamed', 'zebra on the savanna') as never));
        assert.equal(fx.mock.rows(DP_WORKSPACE, 'lore_node').filter((r) => r['lore_id'] === 'n1').length, 1);
        assert.equal((await fx.as('tenant-app-renamed', () => fx.graph.getNode('n1')))!.label, 'ONE renamed');
    });

    await test('ALIAS: an alias resolves to the same id and sees / writes the same rows', async () => {
        fx.registry.alias('tenant-app-alias', 'tenant-app-renamed');
        const viaAlias = await fx.as('tenant-app-alias', () => fx.graph.listNodes());
        assert.deepEqual(viaAlias.map((n) => n.id).sort(), ['n1', 'n2']);
        await fx.as('tenant-app-alias', () => fx.graph.upsertNode(node('n3', 'THREE', 'via alias') as never));
        const n3 = fx.mock.rows(DP_WORKSPACE, 'lore_node').filter((r) => r['lore_id'] === 'n3');
        assert.equal(n3.length, 1);
        assert.equal(n3[0]!['lore_workspace'], ID_A);
        assert.equal((await fx.as('tenant-app-renamed', () => fx.graph.getNode('n3')))!.label, 'THREE');
        await fx.as('tenant-app-alias', () => fx.graph.deleteNode('n3'));
        fx.registry.remove('tenant-app-alias');
    });

    await test('DELETE then RECREATE under the same name: the new workspace has a new id and sees nothing on any route; the old rows stay, unreachable', async () => {
        const counts = (): Record<string, number> => Object.fromEntries(['lore_node', 'lore_edge', 'lore_verbatim', 'lore_version'].map((c) => [c, fx.mock.rows(DP_WORKSPACE, c).length]));
        const before = counts();
        fx.registry.remove('tenant-app-renamed');
        fx.registry.addWithId(NAME, ID_B); // the same name the old tenant used, a different tenant now
        const seen = await probe(NAME);
        const { changesetWorkspace: _c, ...rest } = seen;
        void _c;
        assert.deepEqual(rest, emptyProbe, 'a reused name must not see the previous tenant\'s rows');
        // the probe created one changeset row for ID_B; nothing else was added or removed
        const afterCounts = counts();
        assert.deepEqual({ ...afterCounts, lore_version: afterCounts['lore_version']! - 1 }, before);
        assert.equal(fx.mock.rows(DP_WORKSPACE, 'lore_node').filter((r) => r['lore_workspace'] === ID_A).length, 2, 'old rows are still in the Dataplane');
    });

    await test('a reused name writing the SAME logical ids creates distinct rows and never overwrites or deletes the old tenant\'s', async () => {
        await fx.as(NAME, async () => {
            await fx.graph.upsertNode(node('n1', 'NEW TENANT', 'fresh') as never);
            await fx.vector.store({ id: 'n1', text: 'new tenant zebra savanna', metadata: { type: 'note', project: 'proj' } });
        });
        await syncAdapter(NAME).push([{ id: 'n1', type: 'note', label: 'NEW PUSHED', content: 'x', tags: '', project: 'p', ecosystem: 'e', metadata: '{}', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' } as never], []);
        await syncAdapter(NAME).pushDeletes(['n2']);
        const rows = fx.mock.rows(DP_WORKSPACE, 'lore_node').filter((r) => r['lore_id'] === 'n1');
        assert.equal(rows.length, 2);
        assert.equal(rows.find((r) => r['lore_workspace'] === ID_A)!['label'], 'ONE renamed');
        assert.equal(fx.mock.rows(DP_WORKSPACE, 'lore_node').filter((r) => r['lore_workspace'] === ID_A && r['lore_id'] === 'n2').length, 1, 'a delete by the new tenant must not touch the old tenant\'s n2');
        assert.equal(fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').filter((r) => r['lore_workspace'] === ID_A).length, 3, 'old verbatim rows (2 canonical + 1 snapshot) untouched');
        // and the old tenant, if it were ever reattached by id, still reads its own data
        fx.registry.addWithId('old-tenant-by-id', ID_A);
        const old = await probe('old-tenant-by-id');
        assert.equal(old.getNode, 'ONE renamed');
        assert.deepEqual(old.listNodes, ['n1', 'n2']);
        assert.deepEqual(old.versions, ['v-1']);
        fx.registry.remove('old-tenant-by-id');
    });

    await test('an unknown name, or a registered entry with no id, fails closed with cloud_scope_workspace_not_allowed', () => {
        const mk = (reg: { has(n: string): boolean; resolveId(n: string): string | undefined }) => () =>
            resolveDataplaneScope({ orgId: ORG_ID, dataplaneWorkspaceId: DP_WORKSPACE, workspaceRegistry: reg, loreWorkspaceProvider: () => 'ghost' });
        const notAllowed = (e: unknown) => e instanceof DataplaneScopeError && e.code === 'cloud_scope_workspace_not_allowed';
        assert.throws(mk(testRegistry()), notAllowed);
        assert.throws(mk({ has: () => true, resolveId: () => undefined }), notAllowed);
        assert.throws(mk({ has: () => true, resolveId: () => '' }), notAllowed);
        assert.throws(mk({ has: () => true, resolveId: () => 'bad\u001fid' }), (e: unknown) => e instanceof DataplaneScopeError);
        const ok = resolveDataplaneScope({ orgId: ORG_ID, dataplaneWorkspaceId: DP_WORKSPACE, workspaceRegistry: testRegistry().addWithId('ghost', 'gid'), loreWorkspaceProvider: () => 'ghost' });
        assert.equal(ok.loreWorkspace, 'gid');
        assert.equal(ok.workspaceName, 'ghost');
    });
} finally {
    await fx.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
