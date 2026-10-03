#!/usr/bin/env tsx
/**
 * cloud-workspace-binding-unit.ts — cloud parity C item 7 (R2/R5, Rafi 2026-09-30).
 *
 * Which Lore workspaces an instance serves is decided by the instance's OWN workspace
 * registry (workspaces.json), per operation, with no env allowlist and no '*' default.
 *
 *   1. boot gates          — org id and Dataplane workspace id are required in cloud mode;
 *                            a store or adapter built without a registry serves nothing.
 *   2. registered served   — a workspace in the registry works on every route.
 *   3. unregistered denied — crud, vector, keyword, traverse, verbatim and sync all fail
 *                            closed with `cloud_scope_workspace_not_allowed`, and the
 *                            mock Dataplane sees NO request for the rejected call.
 *   4. live registry       — a REAL registry view over a temp workspaces.json: a workspace
 *                            created or deleted takes effect with no restart; an absent or
 *                            corrupt registry serves nothing.
 *   5. local mode          — untouched: no cloud gates.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { startMockDataplane } from './helpers/mock-dataplane.js';
import { bagOfWordsEmbedder, DP_KEY, DP_WORKSPACE, ORG_ID, connectedClient, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { testRegistry } from './helpers/workspace-registry.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';
import { TsSdkAdapter } from '../packages/lore/src/engines/tsSdkAdapter.js';
import { DataplaneScopeError } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { buildCloudStores } from '../packages/lore/src/mcp/cloudStores.js';
import {
    createWorkspaceRegistry,
    requireDataplaneOrgId,
    resolveDataplaneWorkspaceId,
    resolveCloudBootConfig,
} from '../packages/lore/src/mcp/cloudBootConfig.js';
import { resolveSyncAdapterFromEnv } from '../packages/lore/src/mcp/services.js';
import { createWorkspace, deleteWorkspace, loadWorkspaces, writeControl, type WorkspacesFile } from '../packages/lore/src/config/workspaces.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';
import * as workspaceContext from '../packages/lore/src/security/workspaceContext.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const CODE = 'cloud_scope_workspace_not_allowed';
const notAllowed = (e: unknown): boolean => e instanceof DataplaneScopeError && e.code === CODE;
/** Stores and the sync adapter wrap the scope error in their own error type; the registry message always survives. */
const refusedByRegistry = (e: unknown): boolean => notAllowed(e) || /is not registered in this Lore instance/.test((e as Error)?.message ?? '');
const node = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: 'e', metadata: '{}' }) as never;

const OK = 'ws-registered';
const NO = 'ws-unregistered';
const as = <T>(ws: string, fn: () => Promise<T>): Promise<T> => runWithWorkspace({ workspaceId: ws }, fn);

const savedEnv = { ...process.env };
const restoreEnv = (): void => {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
};
const writeRegistry = (home: string, names: string[]): void => {
    const file: WorkspacesFile = {
        active: names[0] ?? 'default',
        workspaces: names.map((n) => ({ name: n, path: path.join(home, n), createdAt: new Date().toISOString() })),
    };
    writeControl(file, home);
};
const tmpHomes: string[] = [];
const mkHome = (names: string[]): string => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-binding-home-'));
    tmpHomes.push(home);
    if (names.length) writeRegistry(home, names);
    return home;
};

const mock = await startMockDataplane({ apiKeys: { [DP_KEY]: DP_WORKSPACE } });
const client = connectedClient(mock.url, DP_KEY);
const reg = testRegistry(OK);
const graph = new DataplaneGraph({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: reg });
const vector = new DataplaneVectorStore({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: reg, embeddingProvider: bagOfWordsEmbedder(), hasCapability: async () => null });
// Sync adapter over the same mock (same wiring as cloud-sync-pull-order-unit).
const raw = {
    insert: (c: string, r: unknown) => client.insert(DP_WORKSPACE, c, r),
    updateByQuery: (c: string, f: object, fields: object) => client.updateByQuery(DP_WORKSPACE, c, f, fields),
    deleteByQuery: (c: string, f: object) => client.deleteByQuery(DP_WORKSPACE, c, f),
    query: (c: string, o: unknown) => client.query(DP_WORKSPACE, c, o),
    graph: client.graph,
};
const wire = (a: TsSdkAdapter): TsSdkAdapter => {
    (a as unknown as { client: unknown; connected: boolean }).client = raw;
    (a as unknown as { connected: boolean }).connected = true;
    return a;
};
const adapter = (ws: string): TsSdkAdapter =>
    wire(new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: reg, loreWorkspace: ws }));
const requestCount = (): number => mock.requests.length;

try {
    /* ─── 1. boot gates ─── */
    console.log('cloud workspace binding: boot gates');
    await test('DATAPLANE_ORG_ID is required (no default)', () => {
        delete process.env['DATAPLANE_ORG_ID'];
        assert.throws(() => requireDataplaneOrgId(), /DATAPLANE_ORG_ID is required/);
        assert.throws(() => resolveCloudBootConfig({ dataplaneWorkspaceId: 'x', workspaceRegistry: reg }), /DATAPLANE_ORG_ID/);
        process.env['DATAPLANE_ORG_ID'] = 'o1';
        assert.equal(requireDataplaneOrgId(), 'o1');
        restoreEnv();
    });
    await test('the Dataplane workspace id is credential context, not a gate: preferred name, legacy alias, historic default', () => {
        delete process.env['DATAPLANE_WORKSPACE_ID'];
        delete process.env['DATAPLANE_TENANT_ID'];
        assert.equal(resolveDataplaneWorkspaceId(), 'groundfloor_lore');
        process.env['DATAPLANE_TENANT_ID'] = 'legacy';
        assert.equal(resolveDataplaneWorkspaceId(), 'legacy');
        process.env['DATAPLANE_WORKSPACE_ID'] = 'preferred';
        assert.equal(resolveDataplaneWorkspaceId(), 'preferred', 'the new name wins over the alias');
        restoreEnv();
    });
    await test('buildCloudStores refuses to boot without an org id', async () => {
        const opts = { apiKey: DP_KEY, baseUrl: mock.url, embeddingProvider: bagOfWordsEmbedder(), clientFactory: createMockDataplaneClient as never, workspaceRegistry: reg };
        delete process.env['DATAPLANE_ORG_ID'];
        await assert.rejects(() => buildCloudStores(opts), /DATAPLANE_ORG_ID/);
        restoreEnv();
    });
    await test('a graph or vector store constructed without a registry is refused (no implicit allow-all)', () => {
        assert.throws(() => new DataplaneGraph({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID } as never), /workspaceRegistry/);
        assert.throws(() => new DataplaneVectorStore({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, embeddingProvider: bagOfWordsEmbedder() } as never), /workspaceRegistry/);
    });
    await test("a sync adapter built without a registry serves nothing (the old '*' default is gone)", async () => {
        const a = wire(new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: DP_WORKSPACE, orgId: ORG_ID, loreWorkspace: OK } as never));
        await assert.rejects(() => a.push([], []), notAllowed);
    });
    await test('there is no tenant-id accessor left in the workspace context', () => {
        const ns = workspaceContext as unknown as Record<string, unknown>;
        assert.equal(ns['getCurrentTenantId'], undefined);
        assert.equal(ns['requireCurrentTenantId'], undefined);
    });

    /* ─── 2. registered workspace is served ─── */
    console.log('cloud workspace binding: a registered workspace is served on every route');
    await test('crud + vector + keyword + traverse + verbatim + sync all work for a registered workspace', async () => {
        await as(OK, async () => {
            await graph.upsertNode(node('a'));
            await graph.upsertNode(node('b'));
            await graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'related_to', metadata: '{}', createdAt: new Date().toISOString() } as never);
            assert.equal((await graph.getNode('a'))?.id, 'a');
            assert.ok((await graph.traverse('a', 1)).length >= 1);
            await vector.store({ id: 'v1', text: 'registered workspace hello', metadata: { type: 'note' } });
            assert.equal((await vector.search('hello', 5)).length, 1);
            assert.equal((await vector.bm25Search('registered', 5)).hits.length, 1);
            assert.match((await vector.getById('v1'))?.text ?? '', /registered workspace hello/);
        });
        const now = new Date().toISOString();
        const r = await adapter(OK).push([{ id: 's1', type: 'note', label: 's1', content: 'c', tags: [], project: 'p', ecosystem: 'e', createdAt: now, updatedAt: now } as never], []);
        assert.equal(r.nodesPushed, 1);
        assert.ok((await adapter(OK).pull('1970-01-01T00:00:00.000Z')).nodes.some((n) => n.id === 's1'));
    });

    /* ─── 3. unregistered workspace denied on every route ─── */
    console.log('cloud workspace binding: an unregistered workspace is denied on every route');
    const edge = { sourceId: 'a', targetId: 'b', relation: 'related_to', metadata: '{}', createdAt: new Date().toISOString() } as never;
    // 'throws' routes surface the refusal. 'soft' routes keep their historic best-effort contract
    // (bm25Search -> [], getById -> null, delete -> no-op): they still fail closed — no data returned or
    // changed, and no Dataplane request issued — they just do not raise.
    type Denial = ['throws' | 'soft', string, () => Promise<unknown>];
    const denied: Denial[] = [
        ['throws', 'crud: upsertNode', () => as(NO, () => graph.upsertNode(node('x')))],
        ['throws', 'crud: getNode', () => as(NO, () => graph.getNode('a'))],
        ['throws', 'crud: deleteNode', () => as(NO, () => graph.deleteNode('a'))],
        ['throws', 'crud: addEdge', () => as(NO, () => graph.addEdge(edge))],
        ['throws', 'crud: listNodes', () => as(NO, () => graph.listNodes({} as never))],
        ['throws', 'graph keyword search', () => as(NO, () => graph.search('content', {} as never))],
        ['throws', 'traverse', () => as(NO, () => graph.traverse('a', 1))],
        ['throws', 'vector: search', () => as(NO, () => vector.search('hello', 5))],
        ['soft', 'keyword: bm25Search (returns nothing)', () => as(NO, () => vector.bm25Search('registered', 5))],
        ['throws', 'verbatim: store', () => as(NO, () => vector.store({ id: 'v9', text: 'nope', metadata: {} }))],
        ['soft', 'verbatim: getById (returns null)', () => as(NO, () => vector.getById('v1'))],
        ['throws', 'verbatim: delete (a tombstone, refused like local errors)', () => as(NO, () => vector.delete('v1'))],
        ['throws', 'verbatim: physicalDelete', () => as(NO, () => vector.physicalDelete('v1'))],
        ['throws', 'verbatim: storeBatch', () => as(NO, () => vector.storeBatch([{ id: 'v8', text: 'nope', metadata: {} }]))],
        ['throws', 'sync: push', () => adapter(NO).push([], [])],
        ['throws', 'sync: pull', () => adapter(NO).pull('1970-01-01T00:00:00.000Z')],
        ['throws', 'sync: pushDeletes', () => adapter(NO).pushDeletes(['s1'])],
    ];
    for (const [kind, name, call] of denied) {
        await test(`${name} fails closed and nothing reaches the Dataplane`, async () => {
            const before = requestCount();
            if (kind === 'throws') await assert.rejects(call, refusedByRegistry);
            else {
                const r = await call();
                const hits = (r as { hits?: unknown[] } | null)?.hits;
                assert.ok(r === null || r === undefined || (hits !== undefined && hits.length === 0), 'a soft route must return nothing');
            }
            assert.equal(requestCount(), before, 'a rejected call must not issue a Dataplane request');
        });
    }
    await test('the refused registered-workspace data is intact (the soft delete really did nothing)', async () => {
        assert.match((await as(OK, () => vector.getById('v1')))?.text ?? '', /registered workspace hello/);
    });
    await test('an operation with no workspace bound is a different, equally closed failure', async () => {
        await assert.rejects(() => graph.getNode('a'), (e: unknown) => e instanceof DataplaneScopeError && e.code === 'cloud_scope_missing_workspace');
    });
    await test("the literal '*' is never a registered workspace", async () => {
        await assert.rejects(() => as('*', () => graph.getNode('a')), notAllowed);
    });

    /* ─── 4. the registry decides, live ─── */
    console.log('cloud workspace binding: a real registry view over workspaces.json, live');
    await test('a workspace added to the registry is served on the next call, with no restart', async () => {
        const home = mkHome(['alpha']);
        const g = new DataplaneGraph({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: createWorkspaceRegistry(home) });
        await assert.rejects(() => as('beta', () => g.getNode('n')), notAllowed);
        assert.equal(await as('alpha', () => g.getNode('n')), null, 'a registered workspace is served (miss -> null)');
        writeRegistry(home, ['alpha', 'beta']);
        assert.equal(await as('beta', () => g.getNode('n')), null, 'now registered');
    });
    await test('a workspace removed from the registry is denied on the next call', async () => {
        const home = mkHome(['alpha', 'beta']);
        const g = new DataplaneGraph({ connection: FIXTURE_CONNECTION, client: client as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: createWorkspaceRegistry(home) });
        await as('beta', () => g.upsertNode(node('keep')));
        writeRegistry(home, ['alpha']);
        await assert.rejects(() => as('beta', () => g.getNode('keep')), notAllowed);
        assert.equal(await as('alpha', () => g.getNode('keep')), null, "and another workspace still cannot see the removed workspace's data");
    });
    await test('the same registry file follows the real create/delete workspace helpers', () => {
        const home = mkHome(['default']);
        const live = createWorkspaceRegistry(home);
        assert.equal(live.has('fresh'), false);
        createWorkspace('fresh', {}, home);
        assert.equal(live.has('fresh'), true);
        assert.ok(loadWorkspaces(home).workspaces.some((w) => w.name === 'fresh'));
        deleteWorkspace('fresh', home);
        assert.equal(live.has('fresh'), false);
    });
    await test('an absent registry file serves nothing, and creating it afterwards takes effect', () => {
        const home = mkHome([]);
        const live = createWorkspaceRegistry(home);
        assert.equal(live.has('anything'), false);
        assert.equal(live.names().size, 0);
        assert.equal(fs.existsSync(path.join(home, 'workspaces.json')), false, 'reading must not create the file');
        writeRegistry(home, ['anything']);
        assert.equal(live.has('anything'), true);
    });
    await test('a corrupt registry file serves nothing (fail closed), and recovers when fixed', () => {
        const home = mkHome(['alpha']);
        const live = createWorkspaceRegistry(home);
        assert.equal(live.has('alpha'), true);
        fs.writeFileSync(path.join(home, 'workspaces.json'), '{ not json');
        assert.equal(live.has('alpha'), false);
        writeRegistry(home, ['alpha']);
        assert.equal(live.has('alpha'), true);
    });
    await test('the view is cached while the file is unchanged and re-reads on change or invalidate()', () => {
        const home = mkHome(['alpha']);
        const live = createWorkspaceRegistry(home);
        const first = live.names();
        assert.equal(live.names(), first, 'same Set instance while the file is unchanged');
        writeRegistry(home, ['alpha', 'gamma']);
        const second = live.names();
        assert.notEqual(second, first);
        live.invalidate();
        assert.notEqual(live.names(), second, 'invalidate() forces a re-read');
        assert.deepEqual([...live.names()].sort(), ['alpha', 'gamma']);
    });
    await test('buildCloudStores wires the instance registry: the data home decides, not env', async () => {
        const home = mkHome(['alpha']);
        process.env['DATAPLANE_ORG_ID'] = ORG_ID;
        process.env['DATAPLANE_WORKSPACE_ID'] = DP_WORKSPACE;
        process.env['LORE_CLOUD_ALLOWED_WORKSPACES'] = '*'; // must be ignored: there is no env allowlist
        try {
            const { graph: g } = await buildCloudStores({ apiKey: DP_KEY, baseUrl: mock.url, embeddingProvider: bagOfWordsEmbedder(), clientFactory: createMockDataplaneClient as never, hasCapability: async () => null, home });
            assert.equal(await as('alpha', () => g.getNode('n')), null);
            await assert.rejects(() => as('beta', () => g.getNode('n')), notAllowed);
        } finally { restoreEnv(); }
    });

    /* ─── 5. local mode untouched ─── */
    console.log('cloud workspace binding: local mode is untouched');
    await test('local opportunistic sync needs no org id: no cloud gate, no registry lookup at boot', () => {
        delete process.env['DATAPLANE_ORG_ID'];
        delete process.env['DATAPLANE_WORKSPACE_ID'];
        delete process.env['DATAPLANE_TENANT_ID'];
        try {
            delete process.env['DATAPLANE_API_KEY'];
            assert.equal(resolveSyncAdapterFromEnv('local', mkHome([])), null);
            process.env['DATAPLANE_API_KEY'] = 'k';
            assert.ok(resolveSyncAdapterFromEnv('local', mkHome([])), 'local mode builds the adapter with no org id and no registry file');
        } finally { restoreEnv(); }
    });
    await test('cloud mode with the same env DOES gate on the org id', () => {
        delete process.env['DATAPLANE_ORG_ID'];
        process.env['DATAPLANE_API_KEY'] = 'k';
        try {
            assert.throws(() => resolveSyncAdapterFromEnv('cloud', mkHome(['alpha'])), /DATAPLANE_ORG_ID/);
        } finally { restoreEnv(); }
    });
    await test("the boot sync adapter is registry-backed too: an unregistered workspace is denied, a registered one is not", async () => {
        process.env['DATAPLANE_API_KEY'] = 'k';
        process.env['DATAPLANE_ORG_ID'] = ORG_ID;
        try {
            const a = resolveSyncAdapterFromEnv('cloud', mkHome(['alpha']))!;
            await assert.rejects(() => wire(a.forWorkspace('beta')).push([], []), notAllowed);
            const ok = await wire(a.forWorkspace('alpha')).push([], []);
            assert.equal(ok.nodesPushed, 0);
        } finally { restoreEnv(); }
    });
} finally {
    restoreEnv();
    await vector.close();
    await mock.close();
    for (const h of tmpHomes) fs.rmSync(h, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
