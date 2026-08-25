#!/usr/bin/env tsx
/**
 * nodes-route-gate-unit.ts — pins gate wire-up on all 8 endpoints
 * in routes/nodes.ts. Reads use 'read', writes use 'write'.
 *
 * Cloud + actor + workspace + no Dataplane should 503 each.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

function fakeReq(method: string): IncomingMessage {
    return { method, on: () => { /* */ } } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function denyDeps(): Parameters<typeof tryNodesRoutes>[4] {
    return {
        deploymentMode: 'cloud',
        dataplane: null,
        store: {} as never,
        auditLog: {} as never,
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

async function expect503(handler: () => Promise<void>, res: { _status: number; _body: string }) {
    await runWithWorkspace({ workspaceId: 'ws' }, () =>
        runWithActor({ portalUserId: 'u', scopes: [] }, handler),
    );
    assert.equal(res._status, 503);
    assert.match(res._body, /no_dataplane/);
}

(async () => {
    const endpoints: Array<{ method: string; path: string; url?: string }> = [
        { method: 'GET',  path: '/api/node' },
        { method: 'GET',  path: '/api/subgraph', url: '/api/subgraph?id=x' },
        { method: 'POST', path: '/api/node/supersede' },
        { method: 'POST', path: '/api/node/unsupersede' },
        { method: 'GET',  path: '/api/node/supersession-candidates', url: '/api/node/supersession-candidates' },
        { method: 'GET',  path: '/api/node/lineage', url: '/api/node/lineage?id=x' },
        { method: 'GET',  path: '/api/node-full', url: '/api/node-full?id=x' },
        { method: 'POST', path: '/api/node' },
    ];

    console.log('nodes routes — gate behavior on each endpoint');

    for (const ep of endpoints) {
        await test(`${ep.method} ${ep.path} → 503`, async () => {
            const res = fakeRes();
            await expect503(
                () => tryNodesRoutes(fakeReq(ep.method), res, ep.url ?? ep.path, ep.path, denyDeps()).then(() => undefined),
                res,
            );
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
