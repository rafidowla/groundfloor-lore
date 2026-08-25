#!/usr/bin/env tsx
/**
 * audit-ra2-loadjob-resume-order-unit.ts — re-audit 2026-06-25-reaudit2 (MEDIUM).
 *
 * start() fired startupReconcileAndResume() and loop() both fire-and-forget, so
 * a poll tick could flip a 'received' job to 'running' during the resume's first
 * await — and the resume's listRunning() snapshot then re-picked it as a "crash
 * leftover", running the SAME job twice. The loop must start only AFTER the
 * resume snapshot is taken.
 */

import assert from 'node:assert/strict';
import { LoadJobsRunner } from '../packages/lore/src/storage/loadJobsRunner.js';
import { WorkspaceConcurrencyManager } from '../packages/lore/src/storage/loadJobsConcurrency.js';
import type { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log('RA2-25 — poll loop starts only after the resume snapshot');

await test('loop does NOT tick (listReceived) until startupReconcileAndResume listRunning() resolves', async () => {
    const order: string[] = [];
    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => { openGate = r; });

    const fakeStore = {
        async countRunningByWorkspace() { return new Map<string, number>(); },
        async listRunning() { order.push('listRunning'); await gate; return []; },
        async listReceived(_n: number) { order.push('listReceived'); return []; },
    } as unknown as LoadJobsStore;

    const runner = new LoadJobsRunner({
        store: fakeStore,
        buildDispatcherDeps: async () => ({} as never),
        concurrencyManager: new WorkspaceConcurrencyManager(3),
        config: { log: () => undefined, idleMs: 5, busyMs: 5 },
    });

    runner.start();
    await tick(25);
    assert.ok(order.includes('listRunning'), 'resume snapshot (listRunning) started');
    assert.ok(!order.includes('listReceived'),
        'the poll loop must NOT tick until the resume snapshot resolves (else a tick-flipped received→running job is re-run as a crash leftover)');

    openGate();
    await tick(25);
    assert.ok(order.includes('listReceived'), 'loop ticks after the resume snapshot completes');

    runner.stop();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
