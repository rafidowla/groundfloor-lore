#!/usr/bin/env tsx
/**
 * admin-reconciliation-unit.ts — pins the rename + gate wire-up on
 * admin.ts after the /api/approvals namespace was claimed by the HITL
 * approval queue.
 *
 * Before: admin.ts had GET /api/approvals + POST /api/approval/:id
 *         (both shadowed by my approvals.ts routes after PR #46).
 * After:  GET  /api/consent/pending
 *         POST /api/consent/:id/resolve
 *
 * Tests cover:
 *   - GET /api/consent/pending returns 200 with the consent list in
 *     local mode + denies in cloud + no-dataplane
 *   - POST /api/consent/:id/resolve calls consentManager.resolve and
 *     denies in cloud
 *   - the legacy /api/approvals + /api/approval/:id paths are no
 *     longer claimed by admin (return false → dispatcher falls
 *     through to the HITL routes, or 404)
 *   - other admin reads/writes gated correctly
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryAdminRoutes } from '../packages/lore/src/mcp/http/routes/admin.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

function fakeReq(method: string): IncomingMessage {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const req = {
        method,
        on(event: string, h: (...args: unknown[]) => void) {
            (handlers[event] ||= []).push(h);
            if (event === 'end') {
                setImmediate(() => {
                    (handlers['data'] ?? []).forEach((h2) => h2(Buffer.from('{"approved":true}')));
                    (handlers['end'] ?? []).forEach((h2) => h2());
                });
            }
            return this;
        },
    };
    return req as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string; _done: Promise<void> } {
    let resolveDone!: () => void;
    const doneP = new Promise<void>((r) => { resolveDone = r; });
    const r = {
        _status: 0, _body: '', _done: doneP,
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; resolveDone(); },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string; _done: Promise<void> };
}

function makeDeps(deploymentMode: 'local' | 'cloud'): {
    deps: Parameters<typeof tryAdminRoutes>[4];
    resolveCalls: Array<{ id: string; approved: boolean; reason: string | undefined }>;
} {
    const calls: Array<{ id: string; approved: boolean; reason: string | undefined }> = [];
    return {
        resolveCalls: calls,
        deps: {
            deploymentMode, dataplane: null,
            pluginRegistry: { collectRetentionPolicies: () => [] } as never,
            consentManager: {
                list: () => [{ id: 'c-1', tool: 'forget_person' }],
                resolve: (id: string, approved: boolean, reason?: string) => {
                    calls.push({ id, approved, reason });
                    return true;
                },
            } as never,
            retentionSweeper: {} as never,
            archiveSink: {} as never,
            mcpClientRuntime: { list: () => [] } as never,
            connectorRegistry: { listStatus: () => [], healthOf: async () => ({ ok: true }) } as never,
            auditLog: {} as never,
        },
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('admin routes — consent rename');

    await test('GET /api/consent/pending (local) → 200 with list', async () => {
        const { deps } = makeDeps('local');
        const res = fakeRes();
        await tryAdminRoutes(fakeReq('GET'), res, '/api/consent/pending', '/api/consent/pending', deps);
        assert.equal(res._status, 200);
        assert.match(res._body, /forget_person/);
    });

    await test('POST /api/consent/c-1/resolve (local) → calls resolve(approved=true)', async () => {
        const { deps, resolveCalls } = makeDeps('local');
        const res = fakeRes();
        await tryAdminRoutes(fakeReq('POST'), res, '/api/consent/c-1/resolve', '/api/consent/c-1/resolve', deps);
        await res._done;
        assert.equal(res._status, 200);
        assert.deepEqual(resolveCalls, [{ id: 'c-1', approved: true, reason: undefined }]);
    });

    await test('GET /api/approvals (legacy) NOT claimed by admin anymore', async () => {
        const { deps } = makeDeps('local');
        const res = fakeRes();
        const handled = await tryAdminRoutes(fakeReq('GET'), res, '/api/approvals', '/api/approvals', deps);
        assert.equal(handled, false, 'admin should not claim /api/approvals; the HITL route family owns it');
        assert.equal(res._status, 0);
    });

    await test('POST /api/approval/foo (legacy) NOT claimed by admin anymore', async () => {
        const { deps } = makeDeps('local');
        const res = fakeRes();
        const handled = await tryAdminRoutes(fakeReq('POST'), res, '/api/approval/foo', '/api/approval/foo', deps);
        assert.equal(handled, false);
    });

    console.log('\nadmin routes — gate behavior in cloud mode');

    async function expect503(method: string, path: string) {
        const { deps } = makeDeps('cloud');
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'ws' }, () =>
            runWithActor({ portalUserId: 'u', scopes: [] }, () =>
                tryAdminRoutes(fakeReq(method), res, path, path, deps),
            ),
        );
        await new Promise<void>((r) => setImmediate(r));
        assert.equal(res._status, 503, `${method} ${path} expected 503, got ${res._status}`);
    }

    await test('GET /api/consent/pending → 503', () => expect503('GET',  '/api/consent/pending'));
    await test('POST /api/consent/c-1/resolve → 503', () => expect503('POST', '/api/consent/c-1/resolve'));
    await test('GET /api/retention → 503', () => expect503('GET',  '/api/retention'));
    await test('GET /api/mcp-clients → 503', () => expect503('GET',  '/api/mcp-clients'));
    await test('GET /api/connectors → 503', () => expect503('GET',  '/api/connectors'));
    await test('POST /api/connectors/foo/health → 503', () => expect503('POST', '/api/connectors/foo/health'));
    await test('POST /api/retention/sweep → 503', () => expect503('POST', '/api/retention/sweep'));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
