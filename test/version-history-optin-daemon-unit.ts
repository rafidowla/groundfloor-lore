#!/usr/bin/env tsx
/**
 * test/version-history-optin-daemon-unit.ts — the DAEMON's version-prune
 * timer is opt-in (owner decision 2026-09-29). Before this change the daemon
 * pruned at a 90-day default with no configuration at all.
 *
 * Drives the real daemon wiring (`wireDaemonTimers`, the function server.ts
 * calls with `startsDaemonTimers: true`) with the policy resolved from the
 * PROCESS ENV exactly as a daemon does, a real VersionStore, and a short
 * `LORE_VERSION_PRUNE_INTERVAL_MS` so the timer actually fires:
 *
 *   D1  no env                               -> timer never prunes; nothing deleted
 *   D2  LORE_VERSION_PRUNE_ENABLED=1         -> 7-year cutoff
 *   D3  LORE_VERSION_RETENTION_DAYS=30 alone -> enabled at 30 days
 *   D4  ...ENABLED=1 + ...SCHEDULE_DISABLED=1 -> kill switch still wins
 *   D5  the sweep itself is inert when handed a disabled policy (no env needed)
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import { wireDaemonTimers } from '../packages/lore/src/mcp/daemonTimers.js';
import { runVersionPruneSweep } from '../packages/lore/src/mcp/versionPruneScheduler.js';
import { resolveEffectiveVersionHistoryPolicy, _resetLegacyRetentionNoticeForTests } from '../packages/lore/src/outbox/versionPruningPolicy.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

const DAY = 86_400_000;
const AGES = { tenYears: 3650, fiveYears: 1825, hundredDays: 100, oneDay: 1 } as const;

function seed(store: VersionStore): void {
    for (const [label, days] of Object.entries(AGES)) {
        store.recordVersion({
            versionId: randomUUID(), nodeId: label, workspace: 'w',
            timestamp: new Date(Date.now() - days * DAY).toISOString(),
            principal: 'test', operation: 'upsert', previousState: null,
            newState: { type: 'note', content: 'x'.repeat(2000) }, changesetId: null,
        });
    }
}
const survivors = (store: VersionStore): string[] =>
    Object.keys(AGES).filter((l) => store.getVersions(l, 'w').length > 0).sort();
const ALL = Object.keys(AGES).sort();

const ENV_KEYS = ['LORE_VERSION_PRUNE_ENABLED', 'LORE_VERSION_RETENTION_DAYS', 'LORE_VERSION_PRUNE_SCHEDULE_DISABLED', 'LORE_VERSION_PRUNE_INTERVAL_MS'];

/** Run the real daemon wiring under `env`, let the (80ms) timer fire a few
 *  times, then return which rows survived. */
async function runDaemon(env: Record<string, string>): Promise<{ left: string[]; policyEnabled: boolean }> {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, { LORE_VERSION_PRUNE_INTERVAL_MS: '80', ...env });
    _resetLegacyRetentionNoticeForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vdaemon-'));
    const store = VersionStore.open(dir);
    const origErr = console.error;
    console.error = () => undefined; // the once-only legacy notice is asserted in the policy unit test
    try {
        seed(store);
        const handles = wireDaemonTimers({
            startsDaemonTimers: true,
            isLocal: false,
            runRetentionSweep: async () => ({}),
            graph: {} as never,
            verbatimStore: {} as never,
            tableStorage: null,
            embedQueue: { enqueue: () => undefined },
            workspace: 'w',
            workspaceVerbatimResolver: undefined,
            auditLog: { log: () => undefined } as never,
            versionStore: store,
            // versionPolicy deliberately omitted: resolved from process.env, as the daemon does.
        });
        await new Promise((r) => setTimeout(r, 600));
        await handles.versionPruneSweeper.stop();
        await handles.consistencySweeper.stop();
        handles.authTokenSweeper.stop();
        if (handles.retentionScheduler.bootstrapTimer) clearTimeout(handles.retentionScheduler.bootstrapTimer);
        return { left: survivors(store), policyEnabled: resolveEffectiveVersionHistoryPolicy().enabled };
    } finally {
        console.error = origErr;
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
        for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
}

console.log('\nDaemon version-prune timer — opt-in retention\n');

await test('D1: no env -> the timer never prunes (previously deleted everything past 90 days)', async () => {
    const r = await runDaemon({});
    assert.equal(r.policyEnabled, false);
    assert.deepEqual(r.left, ALL, 'rows older than 90 days AND older than 7 years must all survive');
});

await test('D2: LORE_VERSION_PRUNE_ENABLED=1 -> 7-year cutoff (10y row deleted; 5y, 100d, 1d kept)', async () => {
    const r = await runDaemon({ LORE_VERSION_PRUNE_ENABLED: '1' });
    assert.equal(r.policyEnabled, true);
    assert.deepEqual(r.left, ['fiveYears', 'hundredDays', 'oneDay']);
});

await test('D3: explicit LORE_VERSION_RETENTION_DAYS=30 alone -> enabled at 30 days (only the 1d row kept)', async () => {
    const r = await runDaemon({ LORE_VERSION_RETENTION_DAYS: '30' });
    assert.deepEqual(r.left, ['oneDay']);
});

await test('D4: LORE_VERSION_PRUNE_SCHEDULE_DISABLED=1 is still a kill switch even when enabled', async () => {
    const r = await runDaemon({ LORE_VERSION_PRUNE_ENABLED: '1', LORE_VERSION_PRUNE_SCHEDULE_DISABLED: '1' });
    assert.deepEqual(r.left, ALL);
});

await test('D5: runVersionPruneSweep with a disabled policy is a zero-work no-op; an enabled one prunes at its cutoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vdaemon-'));
    const store = VersionStore.open(dir);
    try {
        seed(store);
        const off = await runVersionPruneSweep({ store, policy: resolveEffectiveVersionHistoryPolicy(undefined, {}) });
        assert.deepEqual(off, { softCompacted: 0, hardDeleted: 0, vacuumed: false });
        assert.deepEqual(survivors(store), ALL);
        const on = await runVersionPruneSweep({ store, policy: resolveEffectiveVersionHistoryPolicy({ pruning: { enabled: true } }, {}) });
        assert.equal(on.softCompacted, 1);
        assert.deepEqual(survivors(store), ['fiveYears', 'hundredDays', 'oneDay']);
    } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
