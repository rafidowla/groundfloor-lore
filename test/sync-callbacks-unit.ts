#!/usr/bin/env tsx
/**
 * sync-callbacks-unit.ts — pins the three disk-IO callbacks the
 * SyncPoller will consume:
 *
 *   readLocalWorkspaceStates - scans workspacesDir/* for sync-state.json
 *   applySnapshotToDisk      - atomic write of bytes + version bump
 *   removeWorkspaceFromDisk  - delegates to revokeWorkspaces (PR #41)
 *
 * Uses fs.mkdtempSync for the disk-touching paths so the test runs in
 * an isolated tempdir and cleans up. Where the surface is purely
 * stub-able (read state with a mocked fs), we mock; for write paths
 * we use real disk inside the tempdir.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    readLocalWorkspaceStates,
    applySnapshotToDisk,
    removeWorkspaceFromDisk,
} from '../packages/lore/src/sync/syncCallbacks.js';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sync-cb-'));
}
function cleanup(d: string): void {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
}

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('readLocalWorkspaceStates');

test('returns [] when workspacesDir does not exist', () => {
    const tmp = mkTmp();
    try {
        const r = readLocalWorkspaceStates(path.join(tmp, 'does-not-exist'));
        assert.deepEqual(r, []);
    } finally { cleanup(tmp); }
});

test('reads each subdir as a workspace, syncedVersion empty when no state file', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        fs.mkdirSync(path.join(wsDir, 'developer'), { recursive: true });
        fs.mkdirSync(path.join(wsDir, 'family'), { recursive: true });
        const r = readLocalWorkspaceStates(wsDir);
        const byId = new Map(r.map((s) => [s.workspaceId, s.syncedVersion]));
        assert.equal(byId.get('developer'), '');
        assert.equal(byId.get('family'), '');
        assert.equal(r.length, 2);
    } finally { cleanup(tmp); }
});

test('reads syncedVersion when sync-state.json exists', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        const stateDir = path.join(wsDir, 'cre', '.lore');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'sync-state.json'), JSON.stringify({ syncedVersion: 'v42' }));
        const r = readLocalWorkspaceStates(wsDir);
        assert.equal(r.length, 1);
        assert.equal(r[0].workspaceId, 'cre');
        assert.equal(r[0].syncedVersion, 'v42');
    } finally { cleanup(tmp); }
});

test('corrupt sync-state.json → syncedVersion empty (treated as never-synced)', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        const stateDir = path.join(wsDir, 'borked', '.lore');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'sync-state.json'), '{not valid');
        const r = readLocalWorkspaceStates(wsDir);
        assert.equal(r[0].syncedVersion, '');
    } finally { cleanup(tmp); }
});

test('non-directory entries in workspacesDir are ignored', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.mkdirSync(path.join(wsDir, 'real'));
        fs.writeFileSync(path.join(wsDir, 'a-stray-file.txt'), 'oops');
        const r = readLocalWorkspaceStates(wsDir);
        assert.deepEqual(r.map((s) => s.workspaceId), ['real']);
    } finally { cleanup(tmp); }
});

console.log('\napplySnapshotToDisk');

test('writes bytes + sync-state.json, creating dirs as needed', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        const bytes = new Uint8Array([1, 2, 3, 4]);
        applySnapshotToDisk(wsDir, 'newws', 'v1', bytes);
        const snap = fs.readFileSync(path.join(wsDir, 'newws', '.lore', 'snapshot.bin'));
        assert.deepEqual(Uint8Array.from(snap), bytes);
        const state = JSON.parse(fs.readFileSync(path.join(wsDir, 'newws', '.lore', 'sync-state.json'), 'utf8')) as { syncedVersion: string };
        assert.equal(state.syncedVersion, 'v1');
    } finally { cleanup(tmp); }
});

test('overwrites existing snapshot atomically (no .tmp left behind on success)', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        applySnapshotToDisk(wsDir, 'ws', 'v1', new Uint8Array([1]));
        applySnapshotToDisk(wsDir, 'ws', 'v2', new Uint8Array([2, 2]));
        const snap = fs.readFileSync(path.join(wsDir, 'ws', '.lore', 'snapshot.bin'));
        assert.deepEqual(Uint8Array.from(snap), new Uint8Array([2, 2]));
        const state = JSON.parse(fs.readFileSync(path.join(wsDir, 'ws', '.lore', 'sync-state.json'), 'utf8')) as { syncedVersion: string };
        assert.equal(state.syncedVersion, 'v2');
        const entries = fs.readdirSync(path.join(wsDir, 'ws', '.lore'));
        assert.ok(!entries.some((e) => e.endsWith('.tmp')), 'no leftover .tmp files');
    } finally { cleanup(tmp); }
});

test('L-034: rejects a workspaceId that escapes the root (../) and writes nothing', () => {
    const tmp = mkTmp();
    try {
        // wsDir is nested one level deeper than tmp so the `../../escape`
        // target resolves to `<tmp>/escape` (INSIDE the cleaned temp dir),
        // not `<os.tmpdir()>/escape` — otherwise a rejected-write probe would
        // assert against a shared out-of-tree path that pollutes across runs.
        const wsDir = path.join(tmp, 'sub', 'workspaces');
        assert.throws(
            () => applySnapshotToDisk(wsDir, '../../escape', 'v1', new Uint8Array([1])),
            /path-escape/,
        );
        // Nothing written outside the root (both resolve to <tmp>/escape).
        assert.equal(fs.existsSync(path.join(tmp, 'escape')), false);
        assert.equal(fs.existsSync(path.resolve(wsDir, '../../escape')), false);
    } finally { cleanup(tmp); }
});

test('L-034: rejects an absolute-path workspaceId and writes nothing', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        const evil = path.join(tmp, 'evil-abs');
        assert.throws(
            () => applySnapshotToDisk(wsDir, evil, 'v1', new Uint8Array([1])),
            /path-escape/,
        );
        assert.equal(fs.existsSync(evil), false);
    } finally { cleanup(tmp); }
});

test('L-034: a normal workspace id still writes snapshot.bin + sync-state.json', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        const bytes = new Uint8Array([9, 8, 7]);
        applySnapshotToDisk(wsDir, 'developer', 'v3', bytes);
        const snap = fs.readFileSync(path.join(wsDir, 'developer', '.lore', 'snapshot.bin'));
        assert.deepEqual(Uint8Array.from(snap), bytes);
        const state = JSON.parse(fs.readFileSync(path.join(wsDir, 'developer', '.lore', 'sync-state.json'), 'utf8')) as { syncedVersion: string };
        assert.equal(state.syncedVersion, 'v3');
    } finally { cleanup(tmp); }
});

console.log('\nremoveWorkspaceFromDisk');

test('removes the workspace dir on disk', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        const target = path.join(wsDir, 'doomed');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'data'), 'x');
        removeWorkspaceFromDisk(wsDir, 'doomed', null);
        assert.equal(fs.existsSync(target), false);
    } finally { cleanup(tmp); }
});

test('refuses to remove the active workspace (throws)', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        const target = path.join(wsDir, 'developer');
        fs.mkdirSync(target, { recursive: true });
        assert.throws(
            () => removeWorkspaceFromDisk(wsDir, 'developer', 'developer'),
            /is-active/,
        );
        assert.equal(fs.existsSync(target), true);
    } finally { cleanup(tmp); }
});

test('refuses neverDrop workspaces (throws)', () => {
    const tmp = mkTmp();
    try {
        const wsDir = path.join(tmp, 'workspaces');
        const target = path.join(wsDir, 'precious');
        fs.mkdirSync(target, { recursive: true });
        assert.throws(
            () => removeWorkspaceFromDisk(wsDir, 'precious', null, ['precious']),
            /in-never-drop/,
        );
        assert.equal(fs.existsSync(target), true);
    } finally { cleanup(tmp); }
});

test('silent no-op when workspace already missing', () => {
    const tmp = mkTmp();
    try {
        // Don't create the workspace dir at all.
        removeWorkspaceFromDisk(path.join(tmp, 'workspaces'), 'ghost', null);
        // No throw is the assertion.
    } finally { cleanup(tmp); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
