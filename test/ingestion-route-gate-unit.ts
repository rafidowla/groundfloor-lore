#!/usr/bin/env tsx
/**
 * ingestion-route-gate-unit.ts — pins gate wire-up on the live endpoints
 * in routes/ingestion.ts. Two writes (reconnect, reconsume) + one read
 * (extract is a plan-only endpoint that doesn't mutate the graph).
 *
 * NOTE: /api/graph/ingest-files was removed with the plugin system in
 * v3.11.0 (commit cf007e6 deleted the now-empty developer plugin that
 * backed it via ingestFilesFromSymbols). It is intentionally not tested
 * here — the route handler no longer exists.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryIngestionRoutes } from '../packages/lore/src/mcp/http/routes/ingestion.js';
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

function denyDeps(): Parameters<typeof tryIngestionRoutes>[4] {
    return {
        deploymentMode: 'cloud',
        dataplane: null,
        store: {} as never,
        consentManager: {} as never,
        auditLog: {} as never,
        configManager: {} as never,
        graphBasePath: '/tmp/g',
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
    const endpoints: Array<{ method: string; path: string }> = [
        { method: 'POST', path: '/api/graph/reconnect' },
        { method: 'POST', path: '/api/graph/reconsume' },
        { method: 'POST', path: '/api/extract' },
    ];

    console.log('ingestion routes — gate behavior');

    for (const ep of endpoints) {
        await test(`${ep.method} ${ep.path} → 503`, async () => {
            const res = fakeRes();
            await expect503(
                () => tryIngestionRoutes(fakeReq(ep.method), res, ep.path, ep.path, denyDeps()).then(() => undefined),
                res,
            );
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
