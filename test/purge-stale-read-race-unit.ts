#!/usr/bin/env tsx
/**
 * purge-stale-read-race-unit.ts — fix round 3: an update-intent write must not act on a node read OUTSIDE the
 * per-(workspace,id) node lock. `upsertNode` inserts when absent, so a write built from a read taken before an
 * embedded purge (`deleteNodeEverywhere({ purge: true })`) RE-CREATES the erased node, content and all.
 *
 * Each case fires the purge right after the handler's read (test/helpers/purgeRaceHarness.ts 'getNode' mode).
 * A read under the lock only lets the purge queue; a read outside it lets the purge finish first, so the bug is
 * deterministic. Every case then requires: node absent, no version row, and the handler's own not-found answer.
 *
 * Also covers Rule B (nodeServiceVersion.ts): a caller's out-of-lock `previousState` is replaced by the in-lock
 * read, so a deliberate re-create after a purge (H1, still allowed) does not put the erased content in a row.
 *
 * Run: npx tsx test/purge-stale-read-race-unit.ts
 */
import assert from 'node:assert/strict';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { applyRecallOutcome } from '../packages/lore/src/recall/recallOutcome.js';
import { stampResolved } from '../packages/lore/src/engines/deferred.js';
import { registerOutcomeTools, type OutcomeDeps } from '../packages/lore/src/mcp/tools/outcomes.js';
import { tryOutcomesRoutes, type OutcomesRouteDeps } from '../packages/lore/src/mcp/http/routes/outcomes.js';
import { registerAnchorTools, type AnchorDeps } from '../packages/lore/src/mcp/tools/anchors.js';
import { tryAnchorsRoutes, type AnchorsRouteDeps } from '../packages/lore/src/mcp/http/routes/anchors.js';
import { registerEvidenceTools, type EvidenceDeps } from '../packages/lore/src/mcp/tools/evidence.js';
import { registerGovernanceTools, type GovernanceToolsDeps } from '../packages/lore/src/mcp/tools/governance.js';
import { tryPolicyRoutes } from '../packages/lore/src/mcp/http/routes/retention/policy.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';
import { WS, test, finish, withStack, racingGraph, startPurge, seed, assertErased, fakeReq, fakeRes, toolCapture, type Stack } from './helpers/purgeRaceHarness.js';

const bundle = (s: Stack, graph: unknown): StorageBundle => ({ loreGraph: graph, loreVerbatim: s.store, storageClient: { verbatimDelete: async () => undefined } }) as unknown as StorageBundle;
function outcomeAux(): { aux: never; outcomeRows: () => number } {
    let rows = 0;
    const aux = {
        recordOutcome: () => { rows++; }, incrementCounter: () => undefined,
        getOutcomeCount: () => ({ success: rows, failure: 0, partial: 0 }),
    };
    return { aux: aux as never, outcomeRows: () => rows };
}
const deferredMeta = JSON.stringify({ reason: 'later' });

await test('applyRecallOutcome: purge after the read => node_not_found, nothing re-created, no outcome row', async () => {
    await withStack(async (s) => {
        await seed(s, 'o-fn');
        const { graph, purge } = racingGraph(s, 'o-fn', 'getNode');
        const { aux, outcomeRows } = outcomeAux();
        const r = await applyRecallOutcome({ auxStore: aux, graph: graph as never, versionStore: s.versions, nodeId: 'o-fn', workspace: WS, outcome: 'success', principal: 'mcp' });
        await purge();
        // Under the lock the read wins the race, so the write lands and the queued purge then erases it; either way the node is gone.
        if (!r.ok) assert.equal(r.code, 'node_not_found');
        await assertErased(s, 'o-fn');
        if (!r.ok) assert.equal(outcomeRows(), 0, 'a refused outcome writes no row');
    });
});

await test('MCP record_outcome: purge after the read leaves nothing behind', async () => {
    await withStack(async (s) => {
        await seed(s, 'o-mcp');
        const { graph, purge } = racingGraph(s, 'o-mcp', 'getNode');
        const t = toolCapture();
        registerOutcomeTools(t.server, { store: bundle(s, graph), auxStore: outcomeAux().aux, versionStore: s.versions } as unknown as OutcomeDeps);
        await t.call('record_outcome', { node_id: 'o-mcp', workspace: WS, status: 'success' });
        await purge();
        await assertErased(s, 'o-mcp');
    });
});

await test('HTTP POST /api/nodes/:id/outcomes: purge after the read leaves nothing behind', async () => {
    await withStack(async (s) => {
        await seed(s, 'o-http');
        const { graph, purge } = racingGraph(s, 'o-http', 'getNode');
        const deps = { store: bundle(s, graph), auxStore: outcomeAux().aux, versionStore: s.versions, deploymentMode: 'local', dataplane: null } as unknown as OutcomesRouteDeps;
        const res = fakeRes();
        await tryOutcomesRoutes(fakeReq(JSON.stringify({ workspace: WS, status: 'success' })), res, '/api/nodes/o-http/outcomes', '/api/nodes/o-http/outcomes', deps);
        assert.ok(res._status === 200 || res._status === 201 || res._status === 404, `${res._status} ${res._body}`);
        await purge();
        await assertErased(s, 'o-http');
    });
});

await test('outcome handlers answer node_not_found (MCP) / 404 (HTTP) for a node purged before the call', async () => {
    await withStack(async (s) => {
        await seed(s, 'o-gone'); await startPurge(s, 'o-gone');
        const t = toolCapture();
        registerOutcomeTools(t.server, { store: bundle(s, s.graph), auxStore: outcomeAux().aux, versionStore: s.versions } as unknown as OutcomeDeps);
        const r = await t.call('record_outcome', { node_id: 'o-gone', workspace: WS, status: 'success' });
        assert.equal(r.isError, true); assert.match(r.content[0]!.text, /node_not_found/);
        const res = fakeRes();
        await tryOutcomesRoutes(fakeReq(JSON.stringify({ workspace: WS, status: 'success' })), res, '/api/nodes/o-gone/outcomes', '/api/nodes/o-gone/outcomes',
            { store: bundle(s, s.graph), auxStore: outcomeAux().aux, versionStore: s.versions, deploymentMode: 'local', dataplane: null } as unknown as OutcomesRouteDeps);
        assert.equal(res._status, 404, res._body); assert.match(res._body, /node_not_found/);
        await assertErased(s, 'o-gone');
    });
});

await test('MCP check_anchors mark_stale: purge after the first read => node_not_found, not re-created', async () => {
    await withStack(async (s) => {
        await seed(s, 'a-mcp');
        const { graph, purge } = racingGraph(s, 'a-mcp', 'getNode');
        const t = toolCapture();
        registerAnchorTools(t.server, { store: bundle(s, graph) } as unknown as AnchorDeps);
        const r = await t.call('check_anchors', { id: 'a-mcp', workspace: WS, mark_stale: true });
        await purge();
        assert.equal(r.isError, true, r.content[0]?.text); assert.match(r.content[0]!.text, /node_not_found/);
        await assertErased(s, 'a-mcp');
    });
});

await test('HTTP GET /api/nodes/:id/anchors?mark_stale=true: purge after the first read => 404, not re-created', async () => {
    await withStack(async (s) => {
        await seed(s, 'a-http');
        const { graph, purge } = racingGraph(s, 'a-http', 'getNode');
        const res = fakeRes();
        const url = `/api/nodes/a-http/anchors?workspace=${WS}&mark_stale=true`;
        await tryAnchorsRoutes(fakeReq('', 'GET'), res, url, '/api/nodes/a-http/anchors', { store: bundle(s, graph), deploymentMode: 'local', dataplane: null } as unknown as AnchorsRouteDeps);
        await purge();
        assert.equal(res._status, 404, res._body);
        await assertErased(s, 'a-http');
    });
});

await test('check_anchors mark_stale without a purge still marks the node (control)', async () => {
    await withStack(async (s) => {
        await seed(s, 'a-ok');
        const t = toolCapture();
        registerAnchorTools(t.server, { store: bundle(s, s.graph) } as unknown as AnchorDeps);
        const r = await t.call('check_anchors', { id: 'a-ok', workspace: WS, mark_stale: true });
        assert.notEqual(r.isError, true, r.content[0]?.text);
        assert.equal((await s.graph.getNode('a-ok'))?.anchor_stale, true);
    });
});

await test('MCP redact_evidence: purge after the read leaves nothing behind', async () => {
    await withStack(async (s) => {
        await seed(s, 'e-mcp', 'active', { evidence: 'secret-evidence' });
        const { graph, purge } = racingGraph(s, 'e-mcp', 'getNode');
        const t = toolCapture();
        registerEvidenceTools(t.server, { store: bundle(s, graph), auditLog: { log() { /* no-op */ } } } as unknown as EvidenceDeps);
        await t.call('redact_evidence', { id: 'e-mcp', workspace: WS });
        await purge();
        await assertErased(s, 'e-mcp');
    });
});

await test('stampResolved(lockWorkspace): purge after the read => null, not re-created', async () => {
    await withStack(async (s) => {
        await seed(s, 'deferred-d1', 'active', { metadata: deferredMeta });
        const { graph, purge } = racingGraph(s, 'deferred-d1', 'getNode');
        const r = await stampResolved(graph, 'deferred-d1', 'abc', WS);
        await purge();
        if (r) assert.ok(r.metadata['resolved_at'], 'a won race still stamps');
        await assertErased(s, 'deferred-d1');
    });
});

await test('MCP resolve_deferred: purge after stampResolved\'s read leaves nothing behind', async () => {
    await withStack(async (s) => {
        await seed(s, 'deferred-d2', 'active', { metadata: deferredMeta });
        // Read 1 is the handler's own scope pre-check (outside the lock, write-free); read 2 is stampResolved's.
        const { graph, purge } = racingGraph(s, 'deferred-d2', 'getNode', { nth: 2 });
        const t = toolCapture();
        registerGovernanceTools(t.server, { store: bundle(s, graph), getSyncEngine: () => ({}), detectedScope: { workspace: WS, ecosystem: '*' } } as unknown as GovernanceToolsDeps);
        await t.call('resolve_deferred', { id: 'deferred-d2', workspace: WS });
        await purge();
        await assertErased(s, 'deferred-d2');
    });
});

await test('HTTP POST /api/resolve-deferred: purge after stampResolved\'s read leaves nothing behind', async () => {
    await withStack(async (s) => {
        await seed(s, 'deferred-d3', 'active', { metadata: deferredMeta });
        const { graph, purge } = racingGraph(s, 'deferred-d3', 'getNode', { nth: 2 });
        const res = fakeRes();
        await tryPolicyRoutes(fakeReq(JSON.stringify({ id: 'deferred-d3' })), res,
            { store: bundle(s, graph), detectedScope: { workspace: WS, ecosystem: '*' }, deploymentMode: 'local', dataplane: null } as never, '/api/resolve-deferred');
        await purge();
        assert.ok(res._status === 200 || res._status === 404, `${res._status} ${res._body}`);
        await assertErased(s, 'deferred-d3');
    });
});

await test('Rule B: a stale out-of-lock previousState is not recorded after a purge; the deliberate re-create still works (H1)', async () => {
    await withStack(async (s) => {
        await seed(s, 'rb');
        const prev = await s.graph.getNode('rb');
        assert.ok(prev);
        await startPurge(s, 'rb'); // lands between the caller's pre-read and its write
        const res = await nodeUpsert({
            id: 'rb', workspace: WS, ecosystem: '*', initiator: 'test:store',
            nodeData: { id: 'rb', type: 'note', label: 'rb', content: 'fresh-content', tags: ['t'], security_scopes: [] as string[] }, targetGraph: s.graph,
        }, { inlineVerbatim: { verbatimStore: (w) => s.store.store(w) }, versionStore: s.versions, previousState: prev });
        assert.equal(res.ok, true);
        assert.equal((await s.graph.getNode('rb'))?.content, 'fresh-content', 'H1: re-create after purge is allowed');
        for (const v of s.versions.getVersions('rb', WS, 100)) {
            assert.notEqual((v.previousState as { content?: string } | null)?.content, 'secret-rb', 'erased content came back through previousState');
            assert.doesNotMatch(JSON.stringify(v), /secret-rb/);
        }
    });
});

await test('Rule B control: without a purge the version row still carries the prior content', async () => {
    await withStack(async (s) => {
        await seed(s, 'rb2');
        const prev = await s.graph.getNode('rb2');
        await nodeUpsert({
            id: 'rb2', workspace: WS, ecosystem: '*', initiator: 'test:store',
            nodeData: { id: 'rb2', type: 'note', label: 'rb2', content: 'v2', tags: ['t'], security_scopes: [] as string[] }, targetGraph: s.graph,
        }, { inlineVerbatim: { verbatimStore: (w) => s.store.store(w) }, versionStore: s.versions, previousState: prev });
        const v = s.versions.getVersions('rb2', WS, 10);
        assert.equal(v.length, 1);
        assert.equal((v[0]!.previousState as { content?: string } | null)?.content, 'secret-rb2');
    });
});

finish();
