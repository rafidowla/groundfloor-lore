#!/usr/bin/env tsx
/**
 * dataplane-authz-wrapper-unit.ts — direct tests for the
 * envelope-unwrap helpers in security/dataplaneAuthz.
 *
 * Why this exists: the SDK as-of v0.x reads `result.allowed` /
 * `result.granted` directly, but the engine returns
 * `{success, data: {allowed|granted}, error}`. Our wrapper handles
 * both shapes so Lore code is correct regardless of SDK state.
 */

import assert from 'node:assert/strict';
import {
    unwrapAllowed,
    unwrapGranted,
    unwrapRevoked,
    checkPermission,
    grantRelation,
    revokeRelation,
} from '../packages/lore/src/security/dataplaneAuthz.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('unwrapAllowed');
    await test('current engine envelope {success, data: {allowed: true}}', () =>
        assert.equal(unwrapAllowed({ success: true, data: { allowed: true } }), true));
    await test('current engine envelope with allowed: false', () =>
        assert.equal(unwrapAllowed({ success: true, data: { allowed: false } }), false));
    await test('flat shape {allowed: true} (hypothetical future SDK)', () =>
        assert.equal(unwrapAllowed({ allowed: true }), true));
    await test('flat shape {allowed: false}', () =>
        assert.equal(unwrapAllowed({ allowed: false }), false));
    await test('missing field → false (fail-closed)', () => {
        assert.equal(unwrapAllowed({}), false);
        assert.equal(unwrapAllowed({ success: true, data: {} }), false);
    });
    await test('null / non-object → false', () => {
        assert.equal(unwrapAllowed(null), false);
        assert.equal(unwrapAllowed(undefined), false);
        assert.equal(unwrapAllowed('yes'), false);
        assert.equal(unwrapAllowed(42), false);
    });
    await test('non-boolean allowed → false (defensive)', () => {
        assert.equal(unwrapAllowed({ allowed: 'true' }), false);
        assert.equal(unwrapAllowed({ success: true, data: { allowed: 1 } }), false);
    });

    console.log('\nunwrapGranted');
    await test('current envelope', () =>
        assert.equal(unwrapGranted({ success: true, data: { granted: true } }), true));
    await test('flat shape', () =>
        assert.equal(unwrapGranted({ granted: true }), true));
    await test('false envelope', () =>
        assert.equal(unwrapGranted({ success: true, data: { granted: false } }), false));
    await test('malformed → false', () => {
        assert.equal(unwrapGranted({}), false);
        assert.equal(unwrapGranted(null), false);
    });

    console.log('\nunwrapRevoked');
    await test('current envelope', () =>
        assert.equal(unwrapRevoked({ success: true, data: { revoked: true } }), true));
    await test('flat shape', () =>
        assert.equal(unwrapRevoked({ revoked: true }), true));

    console.log('\ncheckPermission integration with stub client');
    function fakeClient(respond: (path: string, body: unknown) => unknown, captured?: Array<{ path: string; body: unknown }>) {
        return {
            fetch(path: string, init: RequestInit) {
                const body = init.body ? JSON.parse(init.body as string) : null;
                captured?.push({ path, body });
                return Promise.resolve(respond(path, body));
            },
        };
    }

    await test('checkPermission hits /v1/authz/check with the right body', async () => {
        const captured: Array<{ path: string; body: unknown }> = [];
        const ok = await checkPermission(fakeClient(
            () => ({ success: true, data: { allowed: true } }),
            captured,
        ) as never, {
            subjectType: 'lore__user', subjectId: 'alice',
            permission: 'read',
            resourceType: 'lore__workspace', resourceId: 'ws',
        });
        assert.equal(ok, true);
        assert.equal(captured[0].path, '/v1/authz/check');
        assert.deepEqual(captured[0].body, {
            subject:    { type: 'lore__user',     id: 'alice' },
            resource:   { type: 'lore__workspace', id: 'ws' },
            permission: 'read',
        });
    });

    await test('grantRelation hits /v1/authz/grant + returns granted', async () => {
        const captured: Array<{ path: string; body: unknown }> = [];
        const granted = await grantRelation(fakeClient(
            () => ({ success: true, data: { granted: true } }),
            captured,
        ) as never, {
            subjectType: 'lore__user', subjectId: 'alice',
            relation: 'owner',
            resourceType: 'lore__workspace', resourceId: 'ws',
        });
        assert.equal(granted, true);
        assert.equal(captured[0].path, '/v1/authz/grant');
        assert.deepEqual(captured[0].body, {
            subject:  { type: 'lore__user',     id: 'alice' },
            resource: { type: 'lore__workspace', id: 'ws' },
            relation: 'owner',
        });
    });

    await test('revokeRelation hits /v1/authz/revoke + returns revoked', async () => {
        const captured: Array<{ path: string; body: unknown }> = [];
        const revoked = await revokeRelation(fakeClient(
            () => ({ success: true, data: { revoked: true } }),
            captured,
        ) as never, {
            subjectType: 'lore__user', subjectId: 'alice',
            relation: 'owner',
            resourceType: 'lore__workspace', resourceId: 'ws',
        });
        assert.equal(revoked, true);
        assert.equal(captured[0].path, '/v1/authz/revoke');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
