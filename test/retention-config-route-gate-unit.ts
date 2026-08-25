#!/usr/bin/env tsx
/**
 * retention-config-route-gate-unit.ts — pins gate wire-up on the read
 * endpoints in routes/retention.ts + routes/config.ts.
 *
 * Reads gated:
 *   retention.ts:  GET /api/workspace/retention, GET /api/verbatim/history
 *   config.ts:     GET /api/orphan,              GET /api/config
 *
 * Writes/PATCH/POST in these files deferred — they need a separate
 * per-endpoint write-permission audit (administer vs delete vs write).
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
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

function retentionDenyDeps(): Parameters<typeof tryRetentionRoutes>[4] {
    return {
        deploymentMode: 'cloud',
        dataplane: null,
        store: {} as never,
        auditLog: {} as never,
        runRetentionSweep: async () => ({ policy: { autoArchiveSupersededAfterDays: null }, eligible: 0, archived: 0, sample: [], dryRun: true }),
    };
}
function configDenyDeps(): Parameters<typeof tryConfigRoutes>[4] {
    return {
        deploymentMode: 'cloud',
        dataplane: null,
        store: {} as never,
        configManager: {} as never,
        pluginRegistry: { getOrphanState: () => ({}) } as never,
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
    console.log('retention routes — gate behavior');

    await test('GET /api/workspace/retention → 503', async () => {
        const res = fakeRes();
        await expect503(
            () => tryRetentionRoutes(fakeReq('GET'), res, '/api/workspace/retention', '/api/workspace/retention', retentionDenyDeps()).then(() => undefined),
            res,
        );
    });

    await test('GET /api/verbatim/history → 503', async () => {
        const res = fakeRes();
        await expect503(
            () => tryRetentionRoutes(fakeReq('GET'), res, '/api/verbatim/history?id=lore:x', '/api/verbatim/history', retentionDenyDeps()).then(() => undefined),
            res,
        );
    });

    console.log('\nconfig routes — gate behavior');

    await test('GET /api/orphan → 503', async () => {
        const res = fakeRes();
        await expect503(
            () => tryConfigRoutes(fakeReq('GET'), res, '/api/orphan', '/api/orphan', configDenyDeps()).then(() => undefined),
            res,
        );
    });

    await test('GET /api/config → 503', async () => {
        const res = fakeRes();
        await expect503(
            () => tryConfigRoutes(fakeReq('GET'), res, '/api/config', '/api/config', configDenyDeps()).then(() => undefined),
            res,
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
