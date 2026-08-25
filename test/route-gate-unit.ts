#!/usr/bin/env tsx
/**
 * route-gate-unit.ts — gateRoute (deployment-mode-aware ReBAC wrapper).
 *
 * Covers the local-mode short-circuit + the cloud-mode dispatch into
 * requirePermission with the actor + workspace context. We don't need
 * a real Dataplane handle — the cloud path branches on
 * `deps.dataplane === null` and returns 'no_dataplane', which is
 * enough to verify gateRoute is wiring through correctly.
 */

import assert from 'node:assert/strict';
import { gateRoute } from '../packages/lore/src/security/routeGate.js';
import { runWithPrincipal } from '../packages/lore/src/auth/principal.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('gateRoute — local mode');

    await test('local mode short-circuits with allowed=true (no actor needed)', async () => {
        const r = await gateRoute(
            { deploymentMode: 'local', dataplane: null },
            { permission: 'read' },
        );
        assert.equal(r.allowed, true);
    });

    await test('local mode allows even when no workspace context bound', async () => {
        const r = await gateRoute(
            { deploymentMode: 'local', dataplane: null },
            { permission: 'write' },
        );
        assert.equal(r.allowed, true);
    });

    await test('local mode + read-write principal → write allowed', async () => {
        const r = await runWithPrincipal(
            { kind: 'app', workspace: 'dev', scopes: ['read', 'write'], label: 'test' },
            () => gateRoute({ deploymentMode: 'local', dataplane: null }, { permission: 'write' }),
        );
        assert.equal(r.allowed, true);
    });

    await test('local mode + read-only principal → write denied', async () => {
        const r = await runWithPrincipal(
            { kind: 'app', workspace: 'dev', scopes: ['read'], label: 'test' },
            () => gateRoute({ deploymentMode: 'local', dataplane: null }, { permission: 'write' }),
        );
        assert.equal(r.allowed, false);
        if (r.allowed === false) assert.match(r.detail ?? '', /scope/);
    });

    await test('local mode + read-only principal → read allowed', async () => {
        const r = await runWithPrincipal(
            { kind: 'app', workspace: 'dev', scopes: ['read'], label: 'test' },
            () => gateRoute({ deploymentMode: 'local', dataplane: null }, { permission: 'read' }),
        );
        assert.equal(r.allowed, true);
    });

    console.log('\ngateRoute — cloud mode');

    await test('cloud + no workspace context → denied with detail', async () => {
        const r = await runWithActor(
            { portalUserId: 'u1', scopes: [] },
            () => gateRoute(
                { deploymentMode: 'cloud', dataplane: null },
                { permission: 'read' },
            ),
        );
        assert.equal(r.allowed, false);
        if (r.allowed === false) {
            assert.equal(r.reason, 'denied');
            assert.match(r.detail ?? '', /no lore__workspace id/);
        }
    });

    await test('cloud + workspace bound + no actor → no_actor', async () => {
        const r = await runWithWorkspace(
            { workspaceId: 'ws-1' },
            () => gateRoute(
                { deploymentMode: 'cloud', dataplane: null },
                { permission: 'read' },
            ),
        );
        assert.equal(r.allowed, false);
        if (r.allowed === false) assert.equal(r.reason, 'no_actor');
    });

    await test('cloud + actor + workspace + no dataplane → no_dataplane (cloud-feature-misconfig signal)', async () => {
        const r = await runWithWorkspace(
            { workspaceId: 'ws-2' },
            () => runWithActor(
                { portalUserId: 'u1', scopes: [] },
                () => gateRoute(
                    { deploymentMode: 'cloud', dataplane: null },
                    { permission: 'read' },
                ),
            ),
        );
        assert.equal(r.allowed, false);
        if (r.allowed === false) assert.equal(r.reason, 'no_dataplane');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
