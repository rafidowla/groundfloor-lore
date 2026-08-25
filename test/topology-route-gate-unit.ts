#!/usr/bin/env tsx
/**
 * topology-route-gate-unit.ts — verifies gateRoute wire-up on
 * GET /api/topology + /api/topology/overview.
 *
 * Same pattern as audit + search route-gate tests: deny path proves
 * the gate is invoked; we don't need a full storage stub because the
 * deny short-circuits before the route reads anything.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryTopologyRoutes } from '../packages/lore/src/mcp/http/routes/topology.js';
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

function denyDeps(): Parameters<typeof tryTopologyRoutes>[4] {
    // Cloud + no actor/workspace → gate denies before any storage call.
    return {
        deploymentMode: 'cloud',
        dataplane: null,
        store: {} as never,
        pluginRegistry: {} as never,
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('topology routes — gate behavior');

    await test('cloud + no actor: GET /api/topology denied (401/403)', async () => {
        const res = fakeRes();
        await tryTopologyRoutes(fakeReq('GET'), res, '/api/topology', '/api/topology', denyDeps());
        assert.ok(res._status === 401 || res._status === 403, `expected 401/403, got ${res._status}`);
        assert.match(res._body, /no_actor|denied/);
    });

    await test('cloud + actor + workspace, no dataplane: GET /api/topology → 503 no_dataplane', async () => {
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'ws-1' }, () =>
            runWithActor({ portalUserId: 'u1', scopes: [] }, () =>
                tryTopologyRoutes(fakeReq('GET'), res, '/api/topology', '/api/topology', denyDeps()),
            ),
        );
        assert.equal(res._status, 503);
        assert.match(res._body, /no_dataplane/);
    });

    await test('cloud + actor + workspace, no dataplane: GET /api/topology/overview → 503', async () => {
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'ws-1' }, () =>
            runWithActor({ portalUserId: 'u1', scopes: [] }, () =>
                tryTopologyRoutes(fakeReq('GET'), res, '/api/topology/overview', '/api/topology/overview', denyDeps()),
            ),
        );
        assert.equal(res._status, 503);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
