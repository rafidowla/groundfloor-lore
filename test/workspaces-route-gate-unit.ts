#!/usr/bin/env tsx
/**
 * workspaces-route-gate-unit.ts — pins the ReBAC gate wire-up on the read
 * endpoints in routes/workspaces.ts.
 *
 * Workspaces reads gated:
 *   GET /api/workspaces
 *
 * Cloud + actor + no dataplane → 503 (no_dataplane).
 *
 * History:
 *   - Was workspaces-plugins-route-gate-unit.ts. The plugins half tested
 *     routes/plugins.ts, removed with the plugin system in v3.11.0; those
 *     cases were dropped 2026-06-08.
 *   - NW-6a (Round 2 audit, 2026-06-13) deleted routes/workspaces/repos.ts
 *     entirely (307 lines of permanent 503 dead code); the three /api/repos*
 *     cases here were removed accordingly. The /api/workspaces gate case
 *     remains — that route is live and the gate still applies.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryWorkspacesRoutes } from '../packages/lore/src/mcp/http/routes/workspaces.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

function fakeReq(method: string, url?: string): IncomingMessage {
    return { method, url, on: () => { /* */ } } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function wsDenyDeps(): Parameters<typeof tryWorkspacesRoutes>[4] {
    return {
        deploymentMode: 'cloud',
        dataplane: null,
        auditLog: {} as never,
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

// Helper: cloud + actor + workspace + no dataplane → 503 with no_dataplane
async function expect503(handler: () => Promise<void>, res: { _status: number; _body: string }) {
    await runWithWorkspace({ workspaceId: 'ws' }, () =>
        runWithActor({ portalUserId: 'u', scopes: [] }, handler),
    );
    assert.equal(res._status, 503);
    assert.match(res._body, /no_dataplane/);
}

(async () => {
    console.log('workspaces routes — gate behavior');

    await test('GET /api/workspaces → 503', async () => {
        const res = fakeRes();
        await expect503(
            () => tryWorkspacesRoutes(fakeReq('GET'), res, '/api/workspaces', '/api/workspaces', wsDenyDeps()).then(() => undefined),
            res,
        );
    });

    // NW-6a: /api/repos* routes (formerly permanent 503 dead code) were removed
    // along with workspaces/repos.ts. No /api/repos* gate cases remain here.

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
