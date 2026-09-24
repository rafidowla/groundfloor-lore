#!/usr/bin/env tsx
/**
 * test/outbox-lag-threshold-embedded-registry-home-unit.ts — 3.20.2
 * side-issue fix: `outbox/wiring.ts`'s `thresholdResolver` (wired into
 * `OutboxLagCache`) had the SAME wrong-home bug as the sibling already
 * fixed for write quotas (`mcp/server.ts`'s `getWorkspaceEntryForQuota`,
 * see test/store-node-quota-embedded-registry-home-unit.ts). A bare
 * `loadWorkspacesIfPresent()` (no home arg) resolves against the
 * process-wide `loreHome()`, not an embedded instance's own registry, so
 * a workspace's per-workspace `outboxLagThresholdSeconds` override
 * (workspaces.json) configured only in an embedded host's own registry
 * was silently ignored and the global default threshold applied instead.
 *
 * Severity: low (alerting/backpressure threshold only, not a
 * correctness/authorization gap) — tracked as the outbox sibling of the
 * same class alongside the vocab-policy fix in
 * test/store-node-vocab-policy-embedded-registry-home-unit.ts.
 *
 * This test seeds a workspace with `outboxLagThresholdSeconds` configured
 * ONLY in the embedded instance's OWN registry (dirA) — a second,
 * deliberately DIFFERENT process-wide home (dirB, via LORE_HOME) never
 * hears about this workspace at all — and confirms `wireOutbox()`'s
 * lagCache resolves the override from dirA when `getRegistryHome` points
 * there, not the global default. Pre-fix this test fails (the override is
 * silently ignored, default 30s threshold used); post-fix the configured
 * override (5s) is what `shouldBackpressure()` reports.
 *
 * Harness: calls `wireOutbox()` directly (no full `createLore()` boot
 * needed — the threshold resolver is pure config plumbing) with a real
 * SQLite-backed outbox store in a temp `loreDir`. The replicator is never
 * started, matching this module's own test-mode convention.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';
import { DEFAULT_LAG_THRESHOLD_SECONDS } from '../packages/lore/src/outbox/lagCache.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

/** Patch outboxLagThresholdSeconds directly onto an already-created
 *  workspace entry — createWorkspace() has no field for it and there is
 *  no dedicated setter, so this mirrors the sibling quota test's
 *  setMaxNodesQuota() (what an operator hand-editing workspaces.json
 *  would do). */
function setOutboxLagThreshold(home: string, workspaceName: string, seconds: number): void {
    const controlFile = path.join(home, 'workspaces.json');
    const file = JSON.parse(fs.readFileSync(controlFile, 'utf8')) as {
        active: string;
        workspaces: Array<{ name: string; outboxLagThresholdSeconds?: number }>;
    };
    const entry = file.workspaces.find((w) => w.name === workspaceName);
    if (!entry) throw new Error(`setOutboxLagThreshold: no workspace "${workspaceName}" in ${controlFile}`);
    entry.outboxLagThresholdSeconds = seconds;
    fs.writeFileSync(controlFile, JSON.stringify(file, null, 2), 'utf8');
}

async function main(): Promise<void> {
    console.log(
        'outbox/wiring.ts thresholdResolver — embedded lagCache must resolve THIS instance\'s ' +
        'own registry\'s outboxLagThresholdSeconds override, not the process-wide one',
    );

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-outbox-threshold-instance-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-outbox-threshold-processhome-'));
    const loreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-outbox-threshold-loredir-'));
    process.env['LORE_HOME'] = dirB;

    // Registered — and lag-threshold-overridden to 5s — ONLY in dirA's own
    // registry. dirB (process-wide) never hears about "thresholdws" at
    // all: if the resolver resolves against dirB, loadWorkspacesIfPresent
    // returns null (no workspaces.json there yet) or finds no matching
    // entry, so the override below would be silently ignored in favor of
    // the global default instead of applied.
    createWorkspace('thresholdws', {}, dirA);
    setOutboxLagThreshold(dirA, 'thresholdws', 5);

    let wiring: ReturnType<typeof wireOutbox> | undefined;
    try {
        wiring = wireOutbox({
            loreDir,
            getSyncEngine: () => { throw new Error('not exercised — replicator never started in this test'); },
            getRegistryHome: () => dirA,
        });

        await test(
            'lagCache threshold for a workspace with an override configured ONLY in this instance\'s own ' +
            'registry reflects that override (5s), not the global default',
            async () => {
                const decision = wiring!.lagCache.shouldBackpressure('thresholdws');
                assert.equal(
                    decision.thresholdSeconds,
                    5,
                    `expected thresholdSeconds=5 (dirA's override); got ${decision.thresholdSeconds}. ` +
                    `A value of ${DEFAULT_LAG_THRESHOLD_SECONDS} (the global default) means the resolver ` +
                    `resolved against the process-wide registry (${dirB}) instead of this embedded instance's ` +
                    `own registry (${dirA}), so the per-workspace override was never found.`,
                );
            },
        );

        const noRegistryWiring = wireOutbox({
            loreDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lore-outbox-threshold-loredir2-')),
            getSyncEngine: () => { throw new Error('not exercised'); },
            // getRegistryHome omitted — must fall back to prior
            // process-wide-home behavior exactly as before this fix.
        });
        await test(
            'omitting getRegistryHome (cloud mode / legacy callers) still resolves against the ' +
            'process-wide home — no override there, so the global default applies unchanged',
            async () => {
                const decision = noRegistryWiring.lagCache.shouldBackpressure('thresholdws');
                assert.equal(decision.thresholdSeconds, DEFAULT_LAG_THRESHOLD_SECONDS);
            },
        );
    } finally {
        try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(loreDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
