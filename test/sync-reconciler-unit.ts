#!/usr/bin/env tsx
/**
 * sync-reconciler-unit.ts — pure-function tests for `reconcile`.
 *
 * No I/O. The reconciler is a pure plan generator; the polling loop
 * owns execution. Verifies every transition + the safety guard
 * against accidentally dropping workspaces when cloud isn't
 * authoritative.
 */

import assert from 'node:assert/strict';
import { reconcile, summarizePlan } from '../packages/lore/src/sync/reconciler.js';
import type { SyncedWorkspace } from '../packages/lore/src/sync/cloudSyncClient.js';

function ws(workspaceId: string, version: string, perms: SyncedWorkspace['permissions'] = ['read', 'write']): SyncedWorkspace {
    return { workspaceId, displayName: workspaceId, accountId: 'acct', permissions: perms, version };
}

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('reconcile');

test('cloud-only, fresh install → pull every workspace as new-from-cloud', () => {
    const plan = reconcile({
        cloud: [ws('ws-1', 'v1'), ws('ws-2', 'v1')],
        local: [],
        cloudIsAuthoritative: true,
    });
    assert.equal(plan.pull.length, 2);
    assert.equal(plan.drop.length, 0);
    assert.equal(plan.unchanged.length, 0);
    assert.equal(plan.pull[0].reason, 'new-from-cloud');
    assert.equal(plan.pull[0].cloudVersion, 'v1');
});

test('local in sync with cloud → unchanged for all', () => {
    const plan = reconcile({
        cloud: [ws('ws-1', 'v3'), ws('ws-2', 'v5')],
        local: [{ workspaceId: 'ws-1', syncedVersion: 'v3' }, { workspaceId: 'ws-2', syncedVersion: 'v5' }],
        cloudIsAuthoritative: true,
    });
    assert.equal(plan.unchanged.length, 2);
    assert.equal(plan.pull.length, 0);
    assert.equal(plan.drop.length, 0);
});

test('version mismatch → pull with reason=version-mismatch', () => {
    const plan = reconcile({
        cloud: [ws('ws-1', 'v2')],
        local: [{ workspaceId: 'ws-1', syncedVersion: 'v1' }],
        cloudIsAuthoritative: true,
    });
    assert.equal(plan.pull.length, 1);
    assert.equal(plan.pull[0].reason, 'version-mismatch');
    assert.equal(plan.pull[0].cloudVersion, 'v2');
});

test('local row missing from cloud → drop with reason=access-revoked', () => {
    const plan = reconcile({
        cloud: [ws('ws-keep', 'v1')],
        local: [
            { workspaceId: 'ws-keep', syncedVersion: 'v1' },
            { workspaceId: 'ws-revoked', syncedVersion: 'v1' },
        ],
        cloudIsAuthoritative: true,
    });
    assert.equal(plan.drop.length, 1);
    assert.equal(plan.drop[0].workspaceId, 'ws-revoked');
    assert.equal(plan.drop[0].reason, 'access-revoked');
    assert.equal(plan.unchanged.length, 1);
});

test('SAFETY: cloudIsAuthoritative=false suppresses drops entirely', () => {
    const plan = reconcile({
        cloud: [],                           // No-op client returns []
        local: [
            { workspaceId: 'ws-1', syncedVersion: 'v1' },
            { workspaceId: 'ws-2', syncedVersion: 'v1' },
        ],
        cloudIsAuthoritative: false,
    });
    assert.equal(plan.drop.length, 0, 'no drops when cloud is not authoritative');
    assert.equal(plan.pull.length, 0);
    assert.equal(plan.unchanged.length, 0);
});

test('SAFETY: cloudIsAuthoritative defaults to false (omitted) — no drops', () => {
    // Mistake-mode: caller forgets to set the flag. Reconciler must
    // refuse to drop rather than wipe local state on the next tick.
    const plan = reconcile({
        cloud: [],
        local: [{ workspaceId: 'ws-1', syncedVersion: 'v1' }],
    });
    assert.equal(plan.drop.length, 0);
});

test('neverDrop allowlist protects ids from drop even when cloud-authoritative', () => {
    const plan = reconcile({
        cloud: [],
        local: [
            { workspaceId: 'ws-precious', syncedVersion: '' },
            { workspaceId: 'ws-other', syncedVersion: 'v1' },
        ],
        cloudIsAuthoritative: true,
        neverDrop: ['ws-precious'],
    });
    assert.equal(plan.drop.length, 1);
    assert.equal(plan.drop[0].workspaceId, 'ws-other');
});

test('mixed input: pull + drop + unchanged in one plan', () => {
    const plan = reconcile({
        cloud: [
            ws('ws-new', 'v1'),                 // → pull (new)
            ws('ws-stale', 'v2'),               // → pull (mismatch)
            ws('ws-same', 'v1'),                // → unchanged
        ],
        local: [
            { workspaceId: 'ws-stale', syncedVersion: 'v1' },
            { workspaceId: 'ws-same', syncedVersion: 'v1' },
            { workspaceId: 'ws-revoked', syncedVersion: 'v1' },   // → drop
        ],
        cloudIsAuthoritative: true,
    });
    assert.deepEqual(plan.pull.map(p => p.workspaceId).sort(), ['ws-new', 'ws-stale']);
    assert.deepEqual(plan.drop.map(d => d.workspaceId), ['ws-revoked']);
    assert.deepEqual(plan.unchanged.map(u => u.workspaceId), ['ws-same']);
});

test('all[] preserves input order (cloud first, then local-only-in-local)', () => {
    const plan = reconcile({
        cloud: [ws('a', 'v1'), ws('b', 'v1')],
        local: [
            { workspaceId: 'b', syncedVersion: 'v1' },
            { workspaceId: 'gone', syncedVersion: 'v1' },
        ],
        cloudIsAuthoritative: true,
    });
    assert.deepEqual(plan.all.map(a => a.workspaceId), ['a', 'b', 'gone']);
});

console.log('\nsummarizePlan');

test('renders compact one-line summary with counts + sample ids', () => {
    const plan = reconcile({
        cloud: [ws('a', 'v1'), ws('b', 'v1'), ws('c', 'v1')],
        local: [
            { workspaceId: 'b', syncedVersion: 'v1' },
            { workspaceId: 'old1', syncedVersion: 'v1' },
            { workspaceId: 'old2', syncedVersion: 'v1' },
        ],
        cloudIsAuthoritative: true,
    });
    const s = summarizePlan(plan);
    assert.match(s, /pull=2/);
    assert.match(s, /drop=2/);
    assert.match(s, /unchanged=1/);
});

test('summary handles empty plan (— placeholders)', () => {
    const plan = reconcile({ cloud: [], local: [], cloudIsAuthoritative: true });
    const s = summarizePlan(plan);
    assert.match(s, /pull=0 \(—\) drop=0 \(—\) drop-deferred=0 \(—\) unchanged=0/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
