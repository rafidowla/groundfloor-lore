#!/usr/bin/env tsx
/**
 * revocation-handler-unit.ts — verifies every safety layer + the
 * happy path.
 *
 * fs.rmSync + existsSync are injected so no real disk is touched.
 * Each test records what would-have-been deleted and asserts.
 */

import assert from 'node:assert/strict';
import { revokeWorkspaces } from '../packages/lore/src/sync/revocationHandler.js';

interface RmCall { target: string; opts: { recursive?: boolean; force?: boolean } }
function fakes(opts: { existing?: ReadonlySet<string>; throwOn?: ReadonlySet<string> } = {}) {
    const removed: RmCall[] = [];
    const exists = (t: string) => opts.existing?.has(t) ?? true;
    const rm = (target: string, o: { recursive?: boolean; force?: boolean }) => {
        if (opts.throwOn?.has(target)) throw new Error('EACCES');
        removed.push({ target, opts: o });
    };
    return { removed, exists, rm };
}

const ROOT = '/var/lore/workspaces';

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('revokeWorkspaces — happy path');

test('removes workspaces with recursive+force', () => {
    const { removed, exists, rm } = fakes();
    const r = revokeWorkspaces({
        workspaceIds: ['ws-a', 'ws-b'],
        workspacesRoot: ROOT,
        activeWorkspaceId: null,
        rmSyncImpl: rm,
        existsSyncImpl: exists,
    });
    assert.deepEqual(r.executed.sort(), ['ws-a', 'ws-b']);
    assert.equal(removed.length, 2);
    for (const call of removed) {
        assert.deepEqual(call.opts, { recursive: true, force: true });
        assert.match(call.target, /^\/var\/lore\/workspaces\/ws-[ab]$/);
    }
});

test('all[] preserves input order', () => {
    const { exists, rm } = fakes();
    const r = revokeWorkspaces({
        workspaceIds: ['c', 'a', 'b'],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        existsSyncImpl: exists, rmSyncImpl: rm,
    });
    assert.deepEqual(r.all.map((o) => o.workspaceId), ['c', 'a', 'b']);
});

console.log('\nrevokeWorkspaces — SAFETY: active workspace');

test('refuses to drop the active workspace', () => {
    const { removed, exists, rm } = fakes();
    const r = revokeWorkspaces({
        workspaceIds: ['ws-active', 'ws-other'],
        workspacesRoot: ROOT,
        activeWorkspaceId: 'ws-active',
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.deepEqual(r.executed, ['ws-other']);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].workspaceId, 'ws-active');
    assert.equal(r.skipped[0].reason, 'is-active');
    assert.equal(removed.length, 1, 'only ws-other actually got removed');
});

test('null activeWorkspaceId allows all drops', () => {
    const { removed, exists, rm } = fakes();
    revokeWorkspaces({
        workspaceIds: ['ws-1'],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.equal(removed.length, 1);
});

console.log('\nrevokeWorkspaces — SAFETY: neverDrop allowlist');

test('skips ids on the neverDrop list with reason=in-never-drop', () => {
    const { removed, exists, rm } = fakes();
    const r = revokeWorkspaces({
        workspaceIds: ['ws-precious', 'ws-other'],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        neverDrop: ['ws-precious'],
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.deepEqual(r.executed, ['ws-other']);
    assert.equal(r.skipped[0].workspaceId, 'ws-precious');
    assert.equal(r.skipped[0].reason, 'in-never-drop');
});

console.log('\nrevokeWorkspaces — SAFETY: path containment');

test('refuses path-traversal workspaceIds (..)', () => {
    const { removed, exists, rm } = fakes();
    const r = revokeWorkspaces({
        workspaceIds: ['../etc'],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.equal(r.skipped[0].reason, 'path-escape');
    assert.equal(removed.length, 0);
});

test('refuses absolute-path workspaceIds', () => {
    const { removed, exists, rm } = fakes();
    const r = revokeWorkspaces({
        workspaceIds: ['/etc'],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.equal(r.skipped[0].reason, 'path-escape');
    assert.equal(removed.length, 0);
});

test('refuses empty workspaceId (would resolve to workspacesRoot itself)', () => {
    const { removed, exists, rm } = fakes();
    const r = revokeWorkspaces({
        workspaceIds: [''],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.equal(r.skipped[0].reason, 'path-escape');
    assert.equal(removed.length, 0);
});

test('refuses workspaceId that escapes via redundant path tricks', () => {
    const { removed, exists, rm } = fakes();
    const r = revokeWorkspaces({
        workspaceIds: ['ws-a/../../etc'],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.equal(r.skipped[0].reason, 'path-escape');
    assert.equal(removed.length, 0);
});

console.log('\nrevokeWorkspaces — pre-flight + error handling');

test('not-on-disk → skipped with reason=not-on-disk, no rm call', () => {
    const { removed, exists, rm } = fakes({ existing: new Set([]) });
    const r = revokeWorkspaces({
        workspaceIds: ['ws-gone'],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.equal(r.skipped[0].reason, 'not-on-disk');
    assert.equal(removed.length, 0);
});

test('rm failure captured + does not abort remaining drops', () => {
    const { exists, rm } = fakes({ throwOn: new Set(['/var/lore/workspaces/ws-bad']) });
    const r = revokeWorkspaces({
        workspaceIds: ['ws-good', 'ws-bad', 'ws-also-good'],
        workspacesRoot: ROOT, activeWorkspaceId: null,
        rmSyncImpl: rm, existsSyncImpl: exists,
    });
    assert.deepEqual(r.executed, ['ws-good', 'ws-also-good']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].workspaceId, 'ws-bad');
    assert.match(r.failed[0].reason, /EACCES/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
