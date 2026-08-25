#!/usr/bin/env tsx
/**
 * search-route-gate-unit.ts — verifies gateRoute wire-up on
 * GET /api/recall, /api/search, /api/nodes (all read endpoints
 * served by trySearchRoutes).
 *
 * Same approach as audit-route-gate-unit.ts: fake req/res, deny path
 * proves the gate is invoked. Local mode → allowed; cloud + actor +
 * no Dataplane → 503 no_dataplane.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { trySearchRoutes } from '../packages/lore/src/mcp/http/routes/search.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

function fakeReq(method: string, url?: string): IncomingMessage {
    return { method, url, on: () => { /* */ } } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0,
        _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

// Storage stub — enough surface for the three handlers' read paths
// when the gate allows. The deny paths short-circuit before any
// storage call, so the deny tests don't need a full stub.
function stubDeps(deploymentMode: 'local' | 'cloud'): Parameters<typeof trySearchRoutes>[4] {
    return {
        deploymentMode,
        dataplane: null,
        detectedScope: { workspace: '*', ecosystem: '*' },
        store: {
            loreVerbatim: {
                count: async () => 0,
                search: async () => [],
            },
            loreGraph: {
                getNode: async () => null,
                search: async () => [],
                listNodes: async () => [],
            },
            // Sprint 15+ — /api/recall reads through the storageClient
            // facade (verbatimCount → seed loop; verbatimSearch → seeds).
            // count=0 short-circuits to the graph keyword fallback.
            storageClient: {
                verbatimCount: async () => 0,
                verbatimSearch: async () => [],
            },
        } as never,
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('search routes — gate behavior');

    // Sprint L1d — every read route now requires `?workspace=` (no
    // silent active-workspace fallback). Tests pass `workspace=dev`
    // so the gate proves it forwards to gateRoute instead of 400ing
    // on workspace_required.

    await test('local: GET /api/recall?topic=x&workspace=dev → 200', async () => {
        const res = fakeRes();
        await trySearchRoutes(fakeReq('GET'), res, '/api/recall?topic=x&workspace=dev', '/api/recall', stubDeps('local'));
        assert.equal(res._status, 200);
    });

    await test('local: GET /api/search?q=x&workspace=dev → 200', async () => {
        const res = fakeRes();
        await trySearchRoutes(fakeReq('GET'), res, '/api/search?q=x&workspace=dev', '/api/search', stubDeps('local'));
        assert.equal(res._status, 200);
    });

    await test('local: GET /api/nodes?type=note&workspace=dev → 200', async () => {
        const res = fakeRes();
        await trySearchRoutes(fakeReq('GET', '/api/nodes?type=note&workspace=dev'), res, '/api/nodes?type=note&workspace=dev', '/api/nodes', stubDeps('local'));
        assert.equal(res._status, 200);
    });

    await test('local: GET /api/recall without workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        await trySearchRoutes(fakeReq('GET'), res, '/api/recall?topic=x', '/api/recall', stubDeps('local'));
        assert.equal(res._status, 400);
        assert.match(res._body, /workspace_required/);
    });

    await test('local: GET /api/search without workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        await trySearchRoutes(fakeReq('GET'), res, '/api/search?q=x', '/api/search', stubDeps('local'));
        assert.equal(res._status, 400);
        assert.match(res._body, /workspace_required/);
    });

    await test('local: GET /api/search with empty q → 400 q required', async () => {
        const res = fakeRes();
        await trySearchRoutes(fakeReq('GET'), res, '/api/search?q=&workspace=dev', '/api/search', stubDeps('local'));
        assert.equal(res._status, 400);
        assert.match(res._body, /q.*required/);
    });

    await test('local: GET /api/search with absent q → 400 q required', async () => {
        const res = fakeRes();
        await trySearchRoutes(fakeReq('GET'), res, '/api/search?workspace=dev', '/api/search', stubDeps('local'));
        assert.equal(res._status, 400);
        assert.match(res._body, /q.*required/);
    });

    await test('local: GET /api/nodes without workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        await trySearchRoutes(fakeReq('GET', '/api/nodes?type=note'), res, '/api/nodes?type=note', '/api/nodes', stubDeps('local'));
        assert.equal(res._status, 400);
        assert.match(res._body, /workspace_required/);
    });

    await test('cloud + actor + workspace, no dataplane: GET /api/recall → 503', async () => {
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'ws-1' }, () =>
            runWithActor({ portalUserId: 'u1', scopes: [] }, () =>
                trySearchRoutes(fakeReq('GET'), res, '/api/recall?topic=x&workspace=dev', '/api/recall', stubDeps('cloud')),
            ),
        );
        assert.equal(res._status, 503);
        assert.match(res._body, /no_dataplane/);
    });

    await test('cloud + actor + workspace, no dataplane: GET /api/search → 503', async () => {
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'ws-1' }, () =>
            runWithActor({ portalUserId: 'u1', scopes: [] }, () =>
                trySearchRoutes(fakeReq('GET'), res, '/api/search?q=x&workspace=dev', '/api/search', stubDeps('cloud')),
            ),
        );
        assert.equal(res._status, 503);
    });

    await test('cloud + actor + workspace, no dataplane: GET /api/nodes → 503', async () => {
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'ws-1' }, () =>
            runWithActor({ portalUserId: 'u1', scopes: [] }, () =>
                trySearchRoutes(fakeReq('GET', '/api/nodes?type=note&workspace=dev'), res, '/api/nodes?type=note&workspace=dev', '/api/nodes', stubDeps('cloud')),
            ),
        );
        assert.equal(res._status, 503);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
