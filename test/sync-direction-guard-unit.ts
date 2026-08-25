#!/usr/bin/env tsx
/**
 * test/sync-direction-guard-unit.ts — A6 unit tests
 */

import { strict as assert } from 'node:assert';
import {
    SyncDirectionGuard,
    SyncPolicyError,
} from '../packages/lore/src/security/syncDirectionGuard.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

console.log('sync direction guard — A6');

/* ---------- registration ---------- */

test('register + list + unregister', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'personal', policy: 'local-first' });
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only' });
    assert.equal(g.list().length, 2);
    assert.equal(g.unregister('personal'), true);
    assert.equal(g.list().length, 1);
});

test('policyOf returns the registered policy', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'personal', policy: 'local-first' });
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only' });
    assert.equal(g.policyOf('personal'), 'local-first');
    assert.equal(g.policyOf('cloud-ws'), 'cloud-only');
});

test('policyOf throws for unknown workspace', () => {
    const g = new SyncDirectionGuard();
    assert.throws(() => g.policyOf('made-up'), SyncPolicyError);
});

/* ---------- assertCanPersistLocally ---------- */

test('local-first: persist locally always allowed', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'personal', policy: 'local-first' });
    g.assertCanPersistLocally({ workspace: 'personal' });
    g.assertCanPersistLocally({ workspace: 'personal', intent: 'encrypted-cache' });
});

test('cloud-only: persist locally denied by default', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only' });
    assert.throws(
        () => g.assertCanPersistLocally({ workspace: 'cloud-ws' }),
        (e: Error) => e instanceof SyncPolicyError && (e as SyncPolicyError).code === 'cloud-only-no-local-persist',
    );
});

test('cloud-only with encrypted-cache opt-in: persist allowed only with intent flag', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only', allowEncryptedOfflineCache: true });
    // Normal write still denied.
    assert.throws(
        () => g.assertCanPersistLocally({ workspace: 'cloud-ws' }),
        SyncPolicyError,
    );
    // Encrypted-cache intent allowed.
    g.assertCanPersistLocally({ workspace: 'cloud-ws', intent: 'encrypted-cache' });
});

test('cloud-only without encrypted-cache: encrypted-cache intent still denied', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only' });
    assert.throws(
        () => g.assertCanPersistLocally({ workspace: 'cloud-ws', intent: 'encrypted-cache' }),
        SyncPolicyError,
    );
});

/* ---------- assertCanSyncDown ---------- */

test('local-first: sync down allowed', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'personal', policy: 'local-first' });
    g.assertCanSyncDown('personal');
});

test('cloud-only: sync down NEVER allowed (the hard rule)', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only' });
    assert.throws(
        () => g.assertCanSyncDown('cloud-ws'),
        (e: Error) => e instanceof SyncPolicyError && (e as SyncPolicyError).code === 'cloud-only-no-sync-down',
    );
});

test('cloud-only with encryptedOfflineCache: still cannot sync down (cache is for in-flight only)', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only', allowEncryptedOfflineCache: true });
    assert.throws(() => g.assertCanSyncDown('cloud-ws'), SyncPolicyError);
});

/* ---------- assertCanReadInFlight ---------- */

test('local-first: read in-flight allowed', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'personal', policy: 'local-first' });
    g.assertCanReadInFlight('personal');
});

test('cloud-only: in-flight allowed by default', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only' });
    g.assertCanReadInFlight('cloud-ws');
});

test('cloud-only with allowDataInFlight=false: in-flight denied', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'regulated', policy: 'cloud-only', allowDataInFlight: false });
    assert.throws(
        () => g.assertCanReadInFlight('regulated'),
        (e: Error) => e instanceof SyncPolicyError && (e as SyncPolicyError).code === 'cloud-only-not-reachable',
    );
});

/* ---------- predicate variants ---------- */

test('canPersistLocally / canSyncDown / canReadInFlight return booleans', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'personal', policy: 'local-first' });
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only' });
    assert.equal(g.canPersistLocally({ workspace: 'personal' }), true);
    assert.equal(g.canPersistLocally({ workspace: 'cloud-ws' }), false);
    assert.equal(g.canSyncDown('personal'), true);
    assert.equal(g.canSyncDown('cloud-ws'), false);
    assert.equal(g.canReadInFlight('personal'), true);
    assert.equal(g.canReadInFlight('cloud-ws'), true);
});

test('predicate variants throw for unknown workspace (not silently false)', () => {
    const g = new SyncDirectionGuard();
    assert.throws(() => g.canPersistLocally({ workspace: 'unknown' }), SyncPolicyError);
});

/* ---------- the canonical scenario ---------- */

test('canonical scenario: enterprise data on a hybrid device cannot leak to local', () => {
    const g = new SyncDirectionGuard();
    // Same device hosts both a local-first workspace and a cloud-only workspace.
    g.register({ workspace: 'personal', policy: 'local-first' });
    g.register({ workspace: 'cloud-ws-acme', policy: 'cloud-only' });

    // Local-first data: every operation works.
    g.assertCanPersistLocally({ workspace: 'personal' });
    g.assertCanSyncDown('personal');
    g.assertCanReadInFlight('personal');

    // Cloud-only data: in-flight only.
    g.assertCanReadInFlight('cloud-ws-acme');
    assert.throws(() => g.assertCanPersistLocally({ workspace: 'cloud-ws-acme' }), SyncPolicyError);
    assert.throws(() => g.assertCanSyncDown('cloud-ws-acme'), SyncPolicyError);
});

/* ---------- L-035: sync-down gate contract used by the host callback ---------- */

test('L-035: assertCanSyncDown contract — cloud-only throws cloud-only-no-sync-down, unknown throws unknown-workspace, local-first passes', () => {
    const g = new SyncDirectionGuard();
    g.register({ workspace: 'cloud-ws', policy: 'cloud-only' });
    g.register({ workspace: 'personal', policy: 'local-first' });

    // cloud-only → fail-CLOSED (the sensitive case the host callback refuses).
    assert.throws(
        () => g.assertCanSyncDown('cloud-ws'),
        (e: Error) => e instanceof SyncPolicyError && (e as SyncPolicyError).code === 'cloud-only-no-sync-down',
    );

    // unregistered → throws unknown-workspace, which the host callback treats
    // as ALLOW (fail-OPEN) so ordinary multi-workspace local-first sync is not
    // default-denied. This locks why the fix must NOT use bare canSyncDown().
    assert.throws(
        () => g.assertCanSyncDown('never-registered'),
        (e: Error) => e instanceof SyncPolicyError && (e as SyncPolicyError).code === 'unknown-workspace',
    );

    // local-first → passes (no throw).
    g.assertCanSyncDown('personal');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
