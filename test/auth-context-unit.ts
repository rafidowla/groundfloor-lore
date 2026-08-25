#!/usr/bin/env tsx
/**
 * auth-context-unit.ts — actorContext + rebacGate.
 *
 * No real Clerk JWKS fetched here — Clerk validator is exercised in
 * a separate file with a self-signed JWKS. This file focuses on the
 * AsyncLocalStorage shape + rebacGate's decision tree.
 */

import assert from 'node:assert/strict';
import {
    bindActorToRequest,
    getCurrentActor,
    getCurrentActorScopes,
    runWithActor,
} from '../packages/lore/src/security/actorContext.js';
import {
    requirePermission,
    writePermissionDenied,
    type PermissionDecision,
} from '../packages/lore/src/security/rebacGate.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('actorContext');

    await test('outside any bound scope, getCurrentActor() returns null', () => {
        assert.equal(getCurrentActor(), null);
        assert.equal(getCurrentActorScopes(), undefined);
    });

    await test('runWithActor binds for the duration of the callback', () => {
        const ctx = { portalUserId: 'u1', scopes: ['a', 'b'] };
        runWithActor(ctx, () => {
            assert.deepEqual(getCurrentActor(), ctx);
            assert.deepEqual(getCurrentActorScopes(), ['a', 'b']);
        });
        assert.equal(getCurrentActor(), null, 'unbound after callback');
    });

    await test('bindActorToRequest binds without nesting (enterWith)', () => {
        runWithActor({ portalUserId: 'parent', scopes: [] }, () => {
            // Inside a nested scope so the rebind is observable + auto-restored.
            bindActorToRequest({ portalUserId: 'rebound', scopes: ['x'] });
            assert.equal(getCurrentActor()?.portalUserId, 'rebound');
        });
    });

    console.log('\nrebacGate.requirePermission');

    // We now route through dataplaneAuthz.checkPermission which calls
    // client.fetch directly (to work around the SDK's envelope-unwrap
    // bug). Stub a minimal client that records the fetch path + body
    // and returns whatever envelope shape we want to assert against.
    function fakeClient(opts: {
        respond?: (path: string, body: unknown) => unknown;
        throws?: Error;
        captured?: Array<{ path: string; body: unknown }>;
    } = {}) {
        return {
            fetch(path: string, init: RequestInit) {
                if (opts.throws) throw opts.throws;
                const body = init.body ? JSON.parse(init.body as string) : null;
                opts.captured?.push({ path, body });
                const r = opts.respond ? opts.respond(path, body) : { success: true, data: { allowed: true } };
                return Promise.resolve(r);
            },
        };
    }

    await test('returns no_actor when no actor bound', async () => {
        const r = await requirePermission(
            { dataplane: fakeClient() as never },
            { resourceType: 'lore__workspace', resourceId: 'w1', permission: 'read' },
        );
        assert.equal(r.allowed, false);
        if (!r.allowed) assert.equal(r.reason, 'no_actor');
    });

    await test('returns no_dataplane when dataplane handle is null', async () => {
        const r = await runWithActor({ portalUserId: 'u1', scopes: [] }, () =>
            requirePermission({ dataplane: null }, {
                resourceType: 'lore__workspace', resourceId: 'w1', permission: 'read',
            }));
        assert.equal(r.allowed, false);
        if (!r.allowed) assert.equal(r.reason, 'no_dataplane');
    });

    await test('returns denied with empty resourceId', async () => {
        const r = await runWithActor({ portalUserId: 'u1', scopes: [] }, () =>
            requirePermission(
                { dataplane: fakeClient() as never },
                { resourceType: 'lore__workspace', resourceId: '', permission: 'read' },
            ));
        assert.equal(r.allowed, false);
        if (!r.allowed) {
            assert.equal(r.reason, 'denied');
            assert.match(r.detail ?? '', /empty resourceId/);
        }
    });

    await test('returns allowed when fetch returns envelope { success, data: { allowed: true } }', async () => {
        const captured: Array<{ path: string; body: unknown }> = [];
        const r = await runWithActor({ portalUserId: 'u-test', scopes: [] }, () =>
            requirePermission(
                { dataplane: fakeClient({ captured, respond: () => ({ success: true, data: { allowed: true } }) }) as never },
                { resourceType: 'lore__workspace', resourceId: 'w1', permission: 'read' },
            ));
        assert.equal(r.allowed, true);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].path, '/v1/authz/check');
        assert.deepEqual(captured[0].body, {
            subject:    { type: 'lore__user',     id: 'u-test' },
            resource:   { type: 'lore__workspace', id: 'w1' },
            permission: 'read',
        });
    });

    await test('returns allowed when fetch returns flat { allowed: true } (future-SDK shape)', async () => {
        const r = await runWithActor({ portalUserId: 'u', scopes: [] }, () =>
            requirePermission(
                { dataplane: fakeClient({ respond: () => ({ allowed: true }) }) as never },
                { resourceType: 'lore__workspace', resourceId: 'w1', permission: 'read' },
            ));
        assert.equal(r.allowed, true, 'wrapper must accept both envelope and flat shapes');
    });

    await test('returns denied when fetch returns envelope with allowed:false', async () => {
        const r = await runWithActor({ portalUserId: 'u', scopes: [] }, () =>
            requirePermission(
                { dataplane: fakeClient({ respond: () => ({ success: true, data: { allowed: false } }) }) as never },
                { resourceType: 'lore__workspace', resourceId: 'w1', permission: 'write' },
            ));
        assert.equal(r.allowed, false);
        if (!r.allowed) assert.equal(r.reason, 'denied');
    });

    await test('returns unreachable when fetch throws', async () => {
        const r = await runWithActor({ portalUserId: 'u', scopes: [] }, () =>
            requirePermission(
                { dataplane: fakeClient({ throws: new Error('connection refused') }) as never },
                { resourceType: 'lore__workspace', resourceId: 'w1', permission: 'read' },
            ));
        assert.equal(r.allowed, false);
        if (!r.allowed) {
            assert.equal(r.reason, 'unreachable');
            assert.match(r.detail ?? '', /connection refused/);
        }
    });

    console.log('\nwritePermissionDenied — status mapping');

    function captureRes(): { writeHead: (s: number, h?: unknown) => void; end: (b: string) => void; status?: number; body?: string } {
        const ctx: ReturnType<typeof captureRes> = {
            writeHead(s: number) { ctx.status = s; },
            end(b: string) { ctx.body = b; },
        };
        return ctx;
    }
    function deniedDecision(reason: 'no_actor' | 'no_dataplane' | 'denied' | 'unreachable'): Exclude<PermissionDecision, { allowed: true }> {
        return { allowed: false, reason };
    }

    await test('no_actor → 401', () => {
        const r = captureRes();
        writePermissionDenied(r as never, deniedDecision('no_actor'));
        assert.equal(r.status, 401);
    });

    await test('denied → 403', () => {
        const r = captureRes();
        writePermissionDenied(r as never, deniedDecision('denied'));
        assert.equal(r.status, 403);
    });

    await test('unreachable → 503', () => {
        const r = captureRes();
        writePermissionDenied(r as never, deniedDecision('unreachable'));
        assert.equal(r.status, 503);
    });

    await test('no_dataplane → 503', () => {
        const r = captureRes();
        writePermissionDenied(r as never, deniedDecision('no_dataplane'));
        assert.equal(r.status, 503);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
