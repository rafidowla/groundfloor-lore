#!/usr/bin/env tsx
/**
 * purge-version-lock-race-unit.ts — every MCP/HTTP path that writes a version row records it INSIDE the
 * per-(workspace,id) node lock the embedded purge (`deleteNodeEverywhere`) takes. If the row were written after
 * the lock was released, a purge queued behind the write could run in between and the erased content would be
 * re-inserted into versions.sqlite with a timestamp later than the purge's bound.
 *
 * Shape (test/helpers/purgeRaceHarness.ts): real SurrealGraph + real VersionStore + the REAL handlers. The graph
 * write fires the purge (queued on the node lock) and recordVersion is slowed down, which would let a purge that
 * is NOT blocked by the lock slip in. After both settle: node absent => zero version rows.
 *
 * The changeset-delete case fires the purge right after the prior-node READ instead (round 3): its version row
 * carries that read, so the read itself must be under the lock — fired after the delete, the test could not tell.
 *
 * Run: npx tsx test/purge-version-lock-race-unit.ts
 */
import assert from 'node:assert/strict';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { applyChangesetDelete } from '../packages/lore/src/mcp/changesetWrite.js';
import { applyRecallOutcome } from '../packages/lore/src/recall/recallOutcome.js';
import { registerLifecycleTools, type LifecycleDeps } from '../packages/lore/src/mcp/tools/lifecycle.js';
import { tryLifecycleRoutes, type LifecycleRouteDeps } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';
import { WS, test, finish, withStack, racingGraph, seed, noVersions, assertErased, fakeReq, fakeRes, toolCapture, type Stack } from './helpers/purgeRaceHarness.js';

const bundle = (s: Stack, graph: unknown): StorageBundle => ({ loreGraph: graph, loreVerbatim: s.store, storageClient: { verbatimDelete: async () => undefined } }) as unknown as StorageBundle;
const pruneAux = () => ({ createPruneJob: () => 'job-1', updatePruneJob: () => undefined, incrementCounter: () => undefined });

await test('MCP restore_node: purge racing the restore leaves no version row', async () => {
    await withStack(async (s) => {
        await seed(s, 'r-mcp', 'archived');
        const { graph, purge } = racingGraph(s, 'r-mcp', 'upsertNode');
        const t = toolCapture();
        registerLifecycleTools(t.server, { store: bundle(s, graph), auxStore: {} as never, detectedScope: { workspace: WS }, versionStore: s.versions } as unknown as LifecycleDeps);
        await t.call('restore_node', { id: 'r-mcp', workspace: WS });
        await purge();
        await assertErased(s, 'r-mcp');
    });
});

await test('HTTP POST /api/nodes/:id/restore: purge racing the restore leaves no version row', async () => {
    await withStack(async (s) => {
        await seed(s, 'r-http', 'archived');
        const { graph, purge } = racingGraph(s, 'r-http', 'upsertNode');
        const deps = { store: bundle(s, graph), auxStore: {} as never, deploymentMode: 'local', dataplane: null, versionStore: s.versions } as unknown as LifecycleRouteDeps;
        const res = fakeRes();
        await tryLifecycleRoutes(fakeReq(JSON.stringify({ workspace: WS })), res, '/api/nodes/r-http/restore', '/api/nodes/r-http/restore', deps);
        assert.equal(res._status, 200, res._body);
        await purge();
        await assertErased(s, 'r-http');
    });
});

await test('MCP prune_nodes (archive): purge racing the archive leaves no version row', async () => {
    await withStack(async (s) => {
        await seed(s, 'r-prm');
        const { graph, purge } = racingGraph(s, 'r-prm', 'upsertNode');
        const t = toolCapture();
        registerLifecycleTools(t.server, { store: bundle(s, graph), auxStore: pruneAux() as never, detectedScope: { workspace: WS }, versionStore: s.versions } as unknown as LifecycleDeps);
        const r = await t.call('prune_nodes', { workspace: WS, dry_run: false, tags: 't', hard_delete: false });
        assert.notEqual(r.isError, true, r.content[0]?.text);
        assert.match(r.content[0]!.text, /"archived":\s*1/);
        await purge();
        await assertErased(s, 'r-prm');
    });
});

await test('HTTP POST /api/nodes/prune (archive): purge racing the archive leaves no version row', async () => {
    await withStack(async (s) => {
        await seed(s, 'r-prh');
        const { graph, purge } = racingGraph(s, 'r-prh', 'upsertNode');
        const deps = { store: bundle(s, graph), auxStore: pruneAux() as never, deploymentMode: 'local', dataplane: null, versionStore: s.versions } as unknown as LifecycleRouteDeps;
        const res = fakeRes();
        await tryLifecycleRoutes(fakeReq(JSON.stringify({ workspace: WS, dry_run: false, tags: 't' })), res, '/api/nodes/prune', '/api/nodes/prune', deps);
        assert.equal(res._status, 200, res._body);
        assert.match(res._body, /"archived":\s*1/);
        await purge();
        await assertErased(s, 'r-prh');
    });
});

await test('applyRecallOutcome: purge racing the outcome write leaves no version row', async () => {
    await withStack(async (s) => {
        await seed(s, 'r-out');
        const { graph, purge } = racingGraph(s, 'r-out', 'upsertNode');
        const aux = { recordOutcome: () => undefined, getOutcomeCount: () => ({ success: 1, failure: 0, partial: 0 }), incrementCounter: () => undefined };
        const r = await applyRecallOutcome({ auxStore: aux as never, graph: graph as never, versionStore: s.versions, nodeId: 'r-out', workspace: WS, outcome: 'success', principal: 'mcp' });
        assert.equal(r.ok, true);
        await purge();
        await assertErased(s, 'r-out');
    });
});

await test('changeset delete: purge right after the prior-node read cannot leave that content in a version row', async () => {
    await withStack(async (s) => {
        await seed(s, 'r-csd');
        const { graph, purge } = racingGraph(s, 'r-csd', 'getNode');
        await applyChangesetDelete({ verbatim: {} as never, bootVerbatim: s.store, activeWorkspace: 'other', initiator: 'test:cs' } as never,
            graph, WS, 'r-csd', 'test', { versionStore: s.versions, changesetId: 'cs-1' });
        await purge();
        await assertErased(s, 'r-csd');
    });
});

await test('changeset delete without a purge still records the prior node (control for the case above)', async () => {
    await withStack(async (s) => {
        await seed(s, 'r-csd2');
        await applyChangesetDelete({ verbatim: {} as never, bootVerbatim: s.store, activeWorkspace: 'other', initiator: 'test:cs' } as never,
            s.graph as never, WS, 'r-csd2', 'test', { versionStore: s.versions, changesetId: 'cs-1b' });
        const v = s.versions.getVersions('r-csd2', WS, 10);
        assert.equal(v.length, 1);
        assert.equal((v[0]!.previousState as { content?: string } | null)?.content, 'secret-r-csd2');
    });
});

await test('changeset upsert (nodeUpsert changesetVersion): row recorded in-lock; purge afterwards removes it', async () => {
    await withStack(async (s) => {
        const { graph, purge } = racingGraph(s, 'r-csu', 'upsertNode');
        const res = await nodeUpsert({
            id: 'r-csu', workspace: WS, ecosystem: '*', initiator: 'test:cs',
            nodeData: { id: 'r-csu', type: 'note', label: 'r', content: 'secret-r-csu', tags: ['t'], security_scopes: [] as string[] }, targetGraph: graph,
        }, { inlineVerbatim: { verbatimStore: (w) => s.store.store(w) }, changesetVersion: { versionStore: s.versions, changesetId: 'cs-2' } });
        assert.equal(res.ok, true);
        await purge();
        await assertErased(s, 'r-csu');
    });
});

await test('changeset upsert records principal changeset + changesetId with the in-lock prior node', async () => {
    await withStack(async (s) => {
        await seed(s, 'r-csp');
        await nodeUpsert({
            id: 'r-csp', workspace: WS, ecosystem: '*', initiator: 'test:cs',
            nodeData: { id: 'r-csp', type: 'note', label: 'r', content: 'v2', tags: ['t'], security_scopes: [] as string[] }, targetGraph: s.graph,
        }, { inlineVerbatim: { verbatimStore: (w) => s.store.store(w) }, changesetVersion: { versionStore: s.versions, changesetId: 'cs-3' } });
        const v = s.versions.getVersions('r-csp', WS, 10);
        assert.equal(v.length, 1);
        assert.equal(v[0]!.principal, 'changeset'); assert.equal(v[0]!.changesetId, 'cs-3'); assert.equal(v[0]!.operation, 'upsert');
        assert.equal((v[0]!.previousState as { content?: string } | null)?.content, 'secret-r-csp');
        noVersions(s, 'never-written');
    });
});

finish();
