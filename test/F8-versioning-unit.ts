#!/usr/bin/env tsx
/**
 * F8-versioning-unit.ts — Feature 8 unit tests (2026-05-26).
 *
 * Covers VersionStore and changeset mechanics without spinning up Kùzu,
 * LanceDB, or a live daemon.
 *
 * Tests:
 *   VersionStore open        — creates versions.sqlite
 *   recordVersion / getVersions — round-trip, ordering, workspace isolation
 *   getDiff                  — timestamp boundary behaviour
 *   pruneVersions            — compacts old rows, spares protected + recent
 *   Changesets               — create, addWrite, commit flow, rollback
 *   Adversarial              — SQL injection, large JSON, duplicate version_id
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void | Promise<void>) => {
    const result = (() => { try { return fn(); } catch (e) { return Promise.reject(e); } })();
    if (result instanceof Promise) {
        result.then(() => { passed++; console.log(`  ✓ ${name}`); })
              .catch((e) => { failed++; console.error(`  ✗ ${name}: ${(e as Error).message}`); });
    } else {
        passed++;
        console.log(`  ✓ ${name}`);
    }
};

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f8-'));
}

function makeVersion(overrides: Partial<{
    versionId: string; nodeId: string; workspace: string;
    timestamp: string; operation: string;
    previousState: unknown; newState: unknown; changesetId: string | null;
}> = {}) {
    return {
        versionId: overrides.versionId ?? randomUUID(),
        nodeId: overrides.nodeId ?? 'node-1',
        workspace: overrides.workspace ?? 'default',
        timestamp: overrides.timestamp ?? new Date().toISOString(),
        principal: 'mcp',
        operation: overrides.operation ?? 'upsert',
        previousState: overrides.previousState ?? null,
        newState: overrides.newState ?? { id: 'node-1', type: 'note', label: 'Test' },
        changesetId: overrides.changesetId ?? null,
    };
}

/* ─── VersionStore: open ─────────────────────────────────────────── */

console.log('\n─── VersionStore: open ───');

test('open creates versions.sqlite in loreDir', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    assert.ok(fs.existsSync(path.join(dir, 'versions.sqlite')));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('open is idempotent — second open on same file succeeds', () => {
    const dir = makeTmpDir();
    const s1 = VersionStore.open(dir);
    s1.close();
    const s2 = VersionStore.open(dir);
    s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ─── recordVersion / getVersions ───────────────────────────────── */

console.log('\n─── recordVersion / getVersions ───');

test('recordVersion + getVersions round-trip', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const v = makeVersion({ operation: 'upsert', newState: { id: 'n1', label: 'hello' } });
    store.recordVersion(v);
    const versions = store.getVersions('node-1', 'default');
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.versionId, v.versionId);
    assert.equal(versions[0]!.operation, 'upsert');
    assert.deepEqual(versions[0]!.newState, { id: 'n1', label: 'hello' });
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getVersions returns newest-first (by timestamp)', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    store.recordVersion(makeVersion({ versionId: 'v1', timestamp: '2024-01-01T00:00:00Z' }));
    store.recordVersion(makeVersion({ versionId: 'v2', timestamp: '2024-06-01T00:00:00Z' }));
    store.recordVersion(makeVersion({ versionId: 'v3', timestamp: '2024-03-01T00:00:00Z' }));
    const versions = store.getVersions('node-1', 'default');
    assert.equal(versions[0]!.versionId, 'v2');
    assert.equal(versions[1]!.versionId, 'v3');
    assert.equal(versions[2]!.versionId, 'v1');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getVersions respects limit parameter', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    for (let i = 0; i < 5; i++) {
        store.recordVersion(makeVersion({ versionId: `v${i}`, timestamp: `2024-0${i + 1}-01T00:00:00Z` }));
    }
    assert.equal(store.getVersions('node-1', 'default', 2).length, 2);
    assert.equal(store.getVersions('node-1', 'default', 10).length, 5);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getVersions isolates by workspace', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    store.recordVersion(makeVersion({ versionId: 'a', workspace: 'ws-A' }));
    store.recordVersion(makeVersion({ versionId: 'b', workspace: 'ws-B' }));
    assert.equal(store.getVersions('node-1', 'ws-A').length, 1);
    assert.equal(store.getVersions('node-1', 'ws-B').length, 1);
    assert.equal(store.getVersions('node-1', 'ws-A')[0]!.versionId, 'a');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('previousState is stored and retrieved as parsed JSON object', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const prevState = { id: 'node-1', type: 'note', label: 'Old label', status: 'active' };
    store.recordVersion(makeVersion({ previousState: prevState, operation: 'upsert' }));
    const v = store.getVersions('node-1', 'default')[0]!;
    assert.deepEqual(v.previousState, prevState);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('null previousState (new node create) is returned as null', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    store.recordVersion(makeVersion({ previousState: null }));
    const v = store.getVersions('node-1', 'default')[0]!;
    assert.equal(v.previousState, null);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ─── getDiff ────────────────────────────────────────────────────── */

console.log('\n─── getDiff ───');

test('getDiff returns all records since timestamp', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    store.recordVersion(makeVersion({ versionId: 'old', timestamp: '2024-01-01T00:00:00Z' }));
    store.recordVersion(makeVersion({ versionId: 'new', timestamp: '2024-06-01T00:00:00Z' }));
    const diff = store.getDiff('default', '2024-03-01T00:00:00Z');
    assert.equal(diff.length, 1);
    assert.equal(diff[0]!.versionId, 'new');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getDiff includes records at exact since boundary', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const since = '2024-06-01T00:00:00.000Z';
    store.recordVersion(makeVersion({ versionId: 'exactly-at', timestamp: since }));
    const diff = store.getDiff('default', since);
    assert.equal(diff.length, 1);
    assert.equal(diff[0]!.versionId, 'exactly-at');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getDiff returns empty array when no changes since timestamp', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    store.recordVersion(makeVersion({ timestamp: '2024-01-01T00:00:00Z' }));
    const diff = store.getDiff('default', '2025-01-01T00:00:00Z');
    assert.equal(diff.length, 0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getDiff isolates by workspace', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    store.recordVersion(makeVersion({ versionId: 'a', workspace: 'ws-A', timestamp: '2024-06-01T00:00:00Z' }));
    store.recordVersion(makeVersion({ versionId: 'b', workspace: 'ws-B', timestamp: '2024-06-01T00:00:00Z' }));
    const diffA = store.getDiff('ws-A', '2024-01-01T00:00:00Z');
    assert.equal(diffA.length, 1);
    assert.equal(diffA[0]!.versionId, 'a');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ─── pruneVersions ─────────────────────────────────────────────── */

console.log('\n─── pruneVersions ───');

test('pruneVersions compacts rows older than retentionDays', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    // 200 days ago — eligible for 90-day pruning
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    store.recordVersion(makeVersion({ versionId: 'should-compact', timestamp: old }));
    const compacted = store.pruneVersions(90);
    assert.equal(compacted, 1);
    // Compacted rows disappear from getVersions
    assert.equal(store.getVersions('node-1', 'default').length, 0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneVersions spares rows within retention window', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    // 30 days ago — inside the 90-day window
    const recent = new Date(Date.now() - 30 * 86_400_000).toISOString();
    store.recordVersion(makeVersion({ versionId: 'should-keep', timestamp: recent }));
    const compacted = store.pruneVersions(90);
    assert.equal(compacted, 0);
    assert.equal(store.getVersions('node-1', 'default').length, 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneVersions spares protected-node rows regardless of age', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const veryOld = new Date(Date.now() - 500 * 86_400_000).toISOString();
    // new_state contains "status":"protected"
    store.recordVersion(makeVersion({
        versionId: 'protected-v',
        timestamp: veryOld,
        newState: { id: 'node-1', status: 'protected', label: 'Keep me' },
    }));
    const compacted = store.pruneVersions(90);
    assert.equal(compacted, 0, 'protected-node row should NOT be compacted');
    assert.equal(store.getVersions('node-1', 'default').length, 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneVersions spares rows where previous_state is protected', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const veryOld = new Date(Date.now() - 500 * 86_400_000).toISOString();
    store.recordVersion(makeVersion({
        versionId: 'prev-protected',
        timestamp: veryOld,
        previousState: { id: 'node-1', status: 'protected' },
        newState: { id: 'node-1', status: 'active' },  // new_state is NOT protected
    }));
    const compacted = store.pruneVersions(90);
    assert.equal(compacted, 0, 'row with protected previous_state should be kept');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneVersions returns 0 when nothing is eligible', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    assert.equal(store.pruneVersions(90), 0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ─── Changesets ─────────────────────────────────────────────────── */

console.log('\n─── Changesets ───');

test('createChangeset + getChangeset round-trip', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const csId = store.createChangeset('default');
    assert.ok(typeof csId === 'string' && csId.startsWith('cs-'));
    // RA2-reaudit2 — crypto-random id (cs-<uuid>), not a guessable timestamp+rand.
    assert.match(csId, /^cs-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'changeset id is cs-<uuid>');
    const cs = store.getChangeset(csId);
    assert.ok(cs);
    assert.equal(cs!.workspace, 'default');
    assert.equal(cs!.status, 'open');
    assert.equal(cs!.writeCount, 0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getChangeset returns null for unknown id', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    assert.equal(store.getChangeset('nonexistent'), null);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('addChangesetWrite increments writeCount', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const csId = store.createChangeset('default');
    store.addChangesetWrite(csId, 'upsert_node', { workspace: 'default', nodeData: { id: 'n1' } });
    store.addChangesetWrite(csId, 'upsert_node', { workspace: 'default', nodeData: { id: 'n2' } });
    const cs = store.getChangeset(csId)!;
    assert.equal(cs.writeCount, 2);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getChangesetWrites returns ops in seq order', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const csId = store.createChangeset('default');
    store.addChangesetWrite(csId, 'upsert_node', { id: 'first' });
    store.addChangesetWrite(csId, 'delete_node', { id: 'second' });
    const writes = store.getChangesetWrites(csId);
    assert.equal(writes.length, 2);
    assert.equal(writes[0]!.seq, 0);
    assert.equal(writes[0]!.operation, 'upsert_node');
    assert.equal(writes[1]!.seq, 1);
    assert.equal(writes[1]!.operation, 'delete_node');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('updateChangeset to committed sets status + committedAt', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const csId = store.createChangeset('default');
    store.updateChangeset(csId, 'committed');
    const cs = store.getChangeset(csId)!;
    assert.equal(cs.status, 'committed');
    assert.ok(cs.committedAt, 'committedAt should be set');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('updateChangeset to rolled_back sets status', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const csId = store.createChangeset('default');
    store.updateChangeset(csId, 'rolled_back');
    assert.equal(store.getChangeset(csId)!.status, 'rolled_back');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getVersionsByChangeset returns only versions for that changeset', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const csId = store.createChangeset('default');
    store.recordVersion(makeVersion({ versionId: 'v-cs', changesetId: csId }));
    store.recordVersion(makeVersion({ versionId: 'v-free', changesetId: null }));
    const csVersions = store.getVersionsByChangeset(csId);
    assert.equal(csVersions.length, 1);
    assert.equal(csVersions[0]!.versionId, 'v-cs');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('addChangesetWrite allocates distinct monotonic seqs (SW-06)', () => {
    // SW-06 (B8): seq is store-allocated; callers no longer pass it, so two
    // buffered writes to one changeset can never collide on UNIQUE(changeset_id,
    // seq). The store returns the assigned seq.
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const csId = store.createChangeset('default');
    const s0 = store.addChangesetWrite(csId, 'upsert_node', { id: 'n1' });
    const s1 = store.addChangesetWrite(csId, 'upsert_node', { id: 'n2' });
    assert.equal(s0, 0);
    assert.equal(s1, 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ─── Adversarial ────────────────────────────────────────────────── */

console.log('\n─── Adversarial ───');

test('SQL injection in nodeId is stored safely', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const injectedId = `node'; DROP TABLE node_versions; --`;
    store.recordVersion(makeVersion({ nodeId: injectedId }));
    const versions = store.getVersions(injectedId, 'default');
    assert.equal(versions.length, 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('SQL injection in workspace is stored safely', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const injectedWs = `ws'; DELETE FROM node_versions WHERE '1'='1`;
    store.recordVersion(makeVersion({ workspace: injectedWs }));
    const versions = store.getVersions('node-1', injectedWs);
    assert.equal(versions.length, 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate version_id throws PRIMARY KEY constraint', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const vid = 'dup-version-id';
    store.recordVersion(makeVersion({ versionId: vid }));
    assert.throws(() => store.recordVersion(makeVersion({ versionId: vid })));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('very large JSON state (50 KB) round-trips faithfully', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const largeState = { id: 'node-1', content: 'x'.repeat(50_000) };
    store.recordVersion(makeVersion({ newState: largeState }));
    const v = store.getVersions('node-1', 'default')[0]!;
    assert.deepEqual(v.newState, largeState);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('Unicode in operation field is stored faithfully', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const v = makeVersion({ operation: 'архив 📦' });
    store.recordVersion(v);
    const result = store.getVersions('node-1', 'default')[0]!;
    assert.equal(result.operation, 'архив 📦');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('compacted rows are excluded from getVersions', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const veryOld = new Date(Date.now() - 400 * 86_400_000).toISOString();
    store.recordVersion(makeVersion({ versionId: 'old', timestamp: veryOld }));
    store.recordVersion(makeVersion({ versionId: 'recent' }));
    store.pruneVersions(90);
    const visible = store.getVersions('node-1', 'default');
    assert.equal(visible.length, 1);
    assert.equal(visible[0]!.versionId, 'recent');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('compacted rows are excluded from getDiff', () => {
    const dir = makeTmpDir();
    const store = VersionStore.open(dir);
    const veryOld = new Date(Date.now() - 400 * 86_400_000).toISOString();
    store.recordVersion(makeVersion({ versionId: 'old', timestamp: veryOld }));
    store.pruneVersions(90);
    const diff = store.getDiff('default', '2000-01-01T00:00:00Z');
    assert.equal(diff.find((v) => v.versionId === 'old'), undefined);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ─── Summary ────────────────────────────────────────────────────── */

setImmediate(() => {
    setTimeout(() => {
        console.log(`\n─── Summary: ${passed}/${passed + failed} passed ───`);
        if (failed > 0) process.exit(1);
    }, 100);
});
