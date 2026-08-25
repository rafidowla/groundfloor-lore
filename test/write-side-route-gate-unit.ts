#!/usr/bin/env tsx
/**
 * write-side-route-gate-unit.ts — pins gate wire-up on the write
 * endpoints across workspaces.ts, retention.ts, config.ts.
 *
 * Permission tiers chosen:
 *   write       - POST /api/workspaces/switch + /rename
 *                 POST /api/mark-stale, /api/workspace/retention/sweep
 *                 PUT  /api/workspace/retention
 *   delete      - DELETE /api/workspaces/:name
 *                 POST  /api/verbatim/reap, /api/verbatim/tombstone
 *   administer  - POST /api/workspaces (create)
 *                 PATCH /api/config
 *   read        - POST /api/language/detect
 *
 * Cloud + actor + no Dataplane → 503 for every gated endpoint.
 *
 * NW-6a (Round 2 audit, 2026-06-13): /api/repos* routes (PATCH tags,
 * POST discover/batch/create, DELETE) were removed with workspaces/repos.ts
 * (307 lines of permanent dead 503). The write-side cases here were removed
 * along with them.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryWorkspacesRoutes } from '../packages/lore/src/mcp/http/routes/workspaces.js';
import { tryRetentionRoutes } from '../packages/lore/src/mcp/http/routes/retention.js';
import { tryConfigRoutes } from '../packages/lore/src/mcp/http/routes/config.js';
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

const wsDeps = (): Parameters<typeof tryWorkspacesRoutes>[4] => ({
    deploymentMode: 'cloud', dataplane: null,
    pluginRegistry: { active: () => [] } as never,
    auditLog: {} as never,
});
const retDeps = (): Parameters<typeof tryRetentionRoutes>[4] => ({
    deploymentMode: 'cloud', dataplane: null,
    store: {} as never, auditLog: {} as never,
    runRetentionSweep: async () => ({ policy: { autoArchiveSupersededAfterDays: null }, eligible: 0, archived: 0, sample: [], dryRun: true }),
});
const cfgDeps = (): Parameters<typeof tryConfigRoutes>[4] => ({
    deploymentMode: 'cloud', dataplane: null,
    store: {} as never, configManager: {} as never,
    pluginRegistry: {} as never,
});

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
    console.log('workspaces writes');

    const wsEndpoints: Array<{ method: string; path: string; url?: string }> = [
        { method: 'POST',   path: '/api/workspaces' },
        { method: 'POST',   path: '/api/workspaces/switch' },
        { method: 'POST',   path: '/api/workspaces/rename' },
        { method: 'DELETE', path: '/api/workspaces/x', url: '/api/workspaces/x' },
        // NW-6a removed the /api/repos* write endpoints (workspaces/repos.ts deleted).
    ];
    for (const ep of wsEndpoints) {
        await test(`${ep.method} ${ep.path} → 503`, async () => {
            const res = fakeRes();
            await expect503(
                () => tryWorkspacesRoutes(fakeReq(ep.method), res, ep.url ?? ep.path, ep.path, wsDeps()).then(() => undefined),
                res,
            );
        });
    }

    console.log('\nretention writes');

    const retEndpoints: Array<{ method: string; path: string }> = [
        { method: 'POST', path: '/api/verbatim/reap' },
        { method: 'POST', path: '/api/mark-stale' },
        { method: 'PUT',  path: '/api/workspace/retention' },
        { method: 'POST', path: '/api/workspace/retention/sweep' },
        { method: 'POST', path: '/api/verbatim/tombstone' },
    ];
    for (const ep of retEndpoints) {
        await test(`${ep.method} ${ep.path} → 503`, async () => {
            const res = fakeRes();
            await expect503(
                () => tryRetentionRoutes(fakeReq(ep.method), res, ep.path, ep.path, retDeps()).then(() => undefined),
                res,
            );
        });
    }

    console.log('\nconfig writes / utilities');

    const cfgEndpoints: Array<{ method: string; path: string }> = [
        { method: 'PATCH', path: '/api/config' },
        { method: 'POST',  path: '/api/language/detect' },
    ];
    for (const ep of cfgEndpoints) {
        await test(`${ep.method} ${ep.path} → 503`, async () => {
            const res = fakeRes();
            await expect503(
                () => tryConfigRoutes(fakeReq(ep.method), res, ep.path, ep.path, cfgDeps()).then(() => undefined),
                res,
            );
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
