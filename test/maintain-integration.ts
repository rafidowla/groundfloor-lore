/**
 * test/maintain-integration.ts
 *
 * Integration test for `maintain` against REAL substrates:
 *   1. Seed a real LanceDB table with many versions, run maintenance,
 *      assert version count + on-disk bytes drop while current data
 *      survives.
 *   2. Seed real ephemeral + protected workspaces under a temp LORE_HOME,
 *      run maintenance, assert the ephemeral ones are expired (registry +
 *      on-disk dir removed) while non-matching / too-young / active ones
 *      survive.
 *   3. Assert dry-run touches nothing.
 *
 * Uses a throwaway LORE_HOME under the OS temp dir — never the operator's
 * real store.
 *
 * Run: npx tsx test/maintain-integration.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP_HOME = path.join(os.tmpdir(), `lore-maintain-it-${process.pid}-${Date.now()}`);
process.env.LORE_HOME = TMP_HOME;

const DAY = 86_400_000;

async function setupTempHome(): Promise<void> {
    fs.mkdirSync(path.join(TMP_HOME, 'workspaces'), { recursive: true });
}

function cleanup(): void {
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── 1. LanceDB version cleanup against a real table ──────────────────────────

async function testLanceVersionCleanup(): Promise<void> {
    const { LanceMaintainer } = await import('../packages/lore/src/engines/maintain/adapters.js');
    const lancedbDir = path.join(TMP_HOME, 'workspaces', 'default', '.lore', 'lancedb');
    fs.mkdirSync(lancedbDir, { recursive: true });

    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(lancedbDir);
    const table = await db.createTable('verbatim', [
        { id: '1', vector: [0.1, 0.2], text: 'alpha' },
        { id: '2', vector: [0.3, 0.4], text: 'beta' },
    ]);
    // Churn the table to produce many versions (each add/delete = 1 version).
    for (let i = 3; i < 20; i++) {
        await table.add([{ id: String(i), vector: [i / 100, i / 100], text: `row-${i}` }]);
    }
    await table.delete("id = '5'");
    await table.delete("id = '6'");

    const maint = new LanceMaintainer(lancedbDir);
    const cutoffFuture = Date.now() + 60_000; // make all existing versions "old"

    const probesBefore = await maint.probe(0, cutoffFuture);
    const vb = probesBefore[0];
    assert.equal(vb.name, 'verbatim');
    assert.ok(vb.versions >= 3, `expected several versions, got ${vb.versions}`);
    assert.ok(vb.eligibleOldVersions >= 1, `expected eligible old versions, got ${vb.eligibleOldVersions}`);
    const bytesBefore = vb.bytes;

    // Apply: prune versions older than cutoff (= all of them but current).
    const res = await maint.optimizeTable('verbatim', { compact: true, cleanupOlderThanMs: 0, now: cutoffFuture });

    const probesAfter = await maint.probe(0, cutoffFuture);
    const va = probesAfter[0];
    assert.ok(va.versions < vb.versions, `versions should drop: before ${vb.versions} after ${va.versions}`);
    assert.ok(res.versionsRemoved >= 1, `result should report removed versions, got ${res.versionsRemoved}`);
    assert.ok(va.bytes <= bytesBefore, `bytes should not grow: before ${bytesBefore} after ${va.bytes}`);

    // Current data must survive: rows 1..19 minus deleted 5,6 = 17 rows.
    const reopened = await db.openTable('verbatim');
    const count = await reopened.countRows();
    assert.equal(count, 17, `live rows preserved, got ${count}`);

    console.log(`  ✓ LanceDB: versions ${vb.versions}→${va.versions}, removed ${res.versionsRemoved}, ${count} live rows preserved`);
}

// ── 2. Ephemeral workspace expiry against a real registry + dirs ─────────────

interface WsSeed { name: string; ageDays: number; }

function writeWorkspacesFile(seeds: WsSeed[]): void {
    const now = Date.now();
    const workspaces = [
        { name: 'default', path: TMP_HOME, createdAt: new Date(now - 365 * DAY).toISOString() },
    ];
    for (const s of seeds) {
        const wsPath = path.join(TMP_HOME, 'workspaces', s.name);
        fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
        fs.writeFileSync(path.join(wsPath, '.lore', 'marker.txt'), 'data', 'utf8');
        workspaces.push({ name: s.name, path: wsPath, createdAt: new Date(now - s.ageDays * DAY).toISOString() });
    }
    fs.writeFileSync(path.join(TMP_HOME, 'workspaces.json'), JSON.stringify({ active: 'default', workspaces }, null, 2), 'utf8');
}

async function testEphemeralExpiry(): Promise<void> {
    const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');
    const { runMaintenance } = await import('../packages/lore/src/engines/maintain/maintain.js');
    const { resolveMaintainPolicy } = await import('../packages/lore/src/engines/maintain/policy.js');

    writeWorkspacesFile([
        { name: 'e2e-old', ageDays: 30 },      // ephemeral + old → expire
        { name: 'nightly-smoke', ageDays: 30 },// ephemeral + old → expire
        { name: 'e2e-young', ageDays: 2 },     // ephemeral but young → survive
        { name: 'developer', ageDays: 200 },   // non-matching → survive
    ]);

    const policy = resolveMaintainPolicy({
        ephemeralWorkspaceTtlDays: 14,
        enabled: { compaction: false, versionCleanup: false, nodeRetention: false, ephemeralExpiry: true },
    }, { skipEnv: true });

    // First: dry-run must change nothing on disk.
    const dry = await runMaintenance(policy, { workspaces: new WorkspaceRegistry(), safety: { async writeActive() { return false; } } }, { dryRun: true });
    assert.deepEqual(dry.workspaces.expired.sort(), ['e2e-old', 'nightly-smoke'], 'dry-run reports candidates');
    assert.ok(fs.existsSync(path.join(TMP_HOME, 'workspaces', 'e2e-old')), 'dry-run did NOT delete dir');

    // Apply.
    const report = await runMaintenance(policy, { workspaces: new WorkspaceRegistry(), safety: { async writeActive() { return false; } } }, { dryRun: false });
    assert.deepEqual(report.workspaces.expired.sort(), ['e2e-old', 'nightly-smoke'], 'expired the two ephemeral-old');

    // On-disk: ephemeral-old dirs gone, survivors intact.
    assert.ok(!fs.existsSync(path.join(TMP_HOME, 'workspaces', 'e2e-old')), 'e2e-old dir removed');
    assert.ok(!fs.existsSync(path.join(TMP_HOME, 'workspaces', 'nightly-smoke')), 'nightly-smoke dir removed');
    assert.ok(fs.existsSync(path.join(TMP_HOME, 'workspaces', 'e2e-young')), 'e2e-young (too young) survives');
    assert.ok(fs.existsSync(path.join(TMP_HOME, 'workspaces', 'developer')), 'developer (non-matching) survives');

    // Registry: survivors + default remain, expired removed.
    const remaining = JSON.parse(fs.readFileSync(path.join(TMP_HOME, 'workspaces.json'), 'utf8')) as { workspaces: { name: string }[] };
    const names = remaining.workspaces.map((w) => w.name).sort();
    assert.deepEqual(names, ['default', 'developer', 'e2e-young'], 'registry reflects expiry');

    console.log('  ✓ ephemeral expiry: removed e2e-old + nightly-smoke; spared young/non-matching/active');
}

// ── 3. Active + bootstrap guard: an ephemeral-named ACTIVE workspace survives ─

async function testActiveGuard(): Promise<void> {
    const { WorkspaceRegistry } = await import('../packages/lore/src/engines/maintain/adapters.js');
    const { runMaintenance } = await import('../packages/lore/src/engines/maintain/maintain.js');
    const { resolveMaintainPolicy } = await import('../packages/lore/src/engines/maintain/policy.js');

    // Active workspace happens to match an ephemeral pattern + is old.
    const wsPath = path.join(TMP_HOME, 'workspaces', 'e2e-active');
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    const old = new Date(Date.now() - 90 * DAY).toISOString();
    fs.writeFileSync(path.join(TMP_HOME, 'workspaces.json'), JSON.stringify({
        active: 'e2e-active',
        workspaces: [
            { name: 'default', path: TMP_HOME, createdAt: old },
            { name: 'e2e-active', path: wsPath, createdAt: old },
        ],
    }, null, 2), 'utf8');

    const policy = resolveMaintainPolicy({
        ephemeralWorkspaceTtlDays: 14,
        enabled: { compaction: false, versionCleanup: false, nodeRetention: false, ephemeralExpiry: true },
    }, { skipEnv: true });
    const report = await runMaintenance(policy, { workspaces: new WorkspaceRegistry(), safety: { async writeActive() { return false; } } }, { dryRun: false });
    assert.deepEqual(report.workspaces.expired, [], 'active ephemeral-named workspace is NEVER expired');
    assert.ok(fs.existsSync(wsPath), 'active workspace dir intact');
    console.log('  ✓ active workspace is never expired even if it matches a pattern');
}

// ── runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('maintain integration tests');
    console.log(`  (temp LORE_HOME: ${TMP_HOME})`);
    await setupTempHome();
    try {
        await testLanceVersionCleanup();
        await testEphemeralExpiry();
        await testActiveGuard();
        console.log('\n✓ All maintain integration tests passed.');
    } finally {
        cleanup();
    }
}

main().catch((err) => {
    cleanup();
    console.error('✗ maintain-integration:', err);
    process.exit(1);
});
