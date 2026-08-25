#!/usr/bin/env tsx
/**
 * audit-route-gate-unit.ts — verifies the gateRoute wire-up on the
 * audit read endpoints. Drives the route's `tryAuditRoutes` with fake
 * req/res and asserts the gate's pass/deny behavior:
 *
 *   local mode      → always allowed (no actor, no Dataplane)
 *   cloud + actor   → goes through requirePermission → denied with
 *                     no_dataplane (the cheapest deny path; we just
 *                     need to prove the gate is invoked)
 *
 * No live HTTP server. We synthesize the IncomingMessage/ServerResponse
 * surface narrowly — just `method`, `on('data'/'end')` for body reads,
 * `writeHead`, and `end`. The audit GET handlers don't read bodies, so
 * the `on` hookups are stubs.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryAuditRoutes } from '../packages/lore/src/mcp/http/routes/audit.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

interface AuditLogStub {
    tail(n: number): unknown[];
    since(iso: string): unknown[];
}
interface FeedbackStoreStub {
    aggregate(days: number): { up: number; down: number };
}

function fakeReq(method: string): IncomingMessage {
    return { method, on: () => {/* */} } as unknown as IncomingMessage;
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

const stubAuditLog: AuditLogStub = { tail: () => [], since: () => [] };
const stubFeedback: FeedbackStoreStub = { aggregate: () => ({ up: 0, down: 0 }) };

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('audit routes — gate behavior');

    await test('local mode: GET /api/audit returns 200 (gate allows)', async () => {
        const res = fakeRes();
        const handled = await tryAuditRoutes(fakeReq('GET'), res, '/api/audit?tail=5', '/api/audit', {
            auditLog: stubAuditLog as never,
            feedbackStore: stubFeedback as never,
            deploymentMode: 'local',
            dataplane: null,
        });
        assert.equal(handled, true);
        assert.equal(res._status, 200);
    });

    await test('local mode: GET /api/feedback/stats returns 200', async () => {
        const res = fakeRes();
        const handled = await tryAuditRoutes(fakeReq('GET'), res, '/api/feedback/stats?days=7', '/api/feedback/stats', {
            auditLog: stubAuditLog as never,
            feedbackStore: stubFeedback as never,
            deploymentMode: 'local',
            dataplane: null,
        });
        assert.equal(handled, true);
        assert.equal(res._status, 200);
    });

    await test('cloud + no actor: GET /api/audit returns 401 no_actor', async () => {
        const res = fakeRes();
        await tryAuditRoutes(fakeReq('GET'), res, '/api/audit', '/api/audit', {
            auditLog: stubAuditLog as never,
            feedbackStore: stubFeedback as never,
            deploymentMode: 'cloud',
            dataplane: null,
        });
        // No workspace bound either → denied with 'no lore__workspace id'
        // detail (403). Either 401/403 from the gate proves it's wired.
        assert.ok(res._status === 401 || res._status === 403, `expected 401/403, got ${res._status}`);
        assert.match(res._body, /no_actor|denied/);
    });

    await test('cloud + actor + workspace + no dataplane: 503 no_dataplane', async () => {
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'ws-1' }, () =>
            runWithActor({ portalUserId: 'u1', scopes: [] }, () =>
                tryAuditRoutes(fakeReq('GET'), res, '/api/audit', '/api/audit', {
                    auditLog: stubAuditLog as never,
                    feedbackStore: stubFeedback as never,
                    deploymentMode: 'cloud',
                    dataplane: null,
                }),
            ),
        );
        assert.equal(res._status, 503);
        assert.match(res._body, /no_dataplane/);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
