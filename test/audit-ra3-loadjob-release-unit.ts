#!/usr/bin/env tsx
/**
 * audit-ra3-loadjob-release-unit.ts — re-audit 2026-06-25 (MEDIUM, concurrency).
 *
 * The per-workspace concurrency slot was released in THREE places: runOneJob's
 * success path, its catch, and tickOnce's catch. On an in-try failure via
 * tickOnce the slot was released TWICE (job-catch + tick-catch) → the count
 * dropped below reality and the cap could be exceeded; the resume caller
 * meanwhile LEAKED a slot on a pre-try failure (no release at all). runOneJob
 * now releases EXACTLY ONCE in a finally covering every exit.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import { LoadJobsRunner } from '../packages/lore/src/storage/loadJobsRunner.js';
import { WorkspaceConcurrencyManager } from '../packages/lore/src/storage/loadJobsConcurrency.js';

/** Counts release() calls so a double-release is observable even though the
 *  underlying counter clamps at 0. */
class SpyConcurrency extends WorkspaceConcurrencyManager {
    releaseCalls: string[] = [];
    release(ws: string): void { this.releaseCalls.push(ws); super.release(ws); }
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

/** Run one failing job through tickOnce with a slot pre-acquired (submit-time). */
async function runFailingJob(format: string, tempExists: boolean) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ra3-'));
    const store = new LoadJobsStore(dir);
    const tempFile = path.join(dir, `data.${format}`);
    if (tempExists) fs.writeFileSync(tempFile, 'irrelevant');
    await store.create({
        jobId: 'j1', workspace: 'W', format: format as never, embedMode: 'skip',
        tempFilePath: tempFile, createdAt: new Date().toISOString(),
    });
    const conc = new SpyConcurrency(3);
    conc.tryAcquire('W'); // simulate the /api/load submit-time acquire → count = 1
    const runner = new LoadJobsRunner({
        store,
        buildDispatcherDeps: async () => ({}), // no substrate adapters → begin() no-ops
        concurrencyManager: conc,
        config: { log: () => undefined },
    });
    await runner.tickOnce();
    const job = await store.get('j1');
    store.close();
    return { conc, job, dir };
}

console.log('RA-3 — load-job concurrency slot is released exactly once on failure');

await test('in-try failure (arrow format) releases the slot EXACTLY ONCE (no double)', async () => {
    // arrow throws inside the inner try (after dispatcher.begin) → previously
    // released at the job-catch AND tickOnce-catch (double).
    const { conc, job, dir } = await runFailingJob('arrow', true);
    assert.equal(conc.releaseCalls.length, 1, `expected exactly 1 release, got ${conc.releaseCalls.length} (double-release regressed)`);
    assert.equal(conc.getCount('W'), 0, 'slot returns to 0');
    assert.equal(job?.status, 'failed', 'job marked failed');
    fs.rmSync(dir, { recursive: true, force: true });
});

await test('pre-try failure (missing temp file) releases the slot exactly once', async () => {
    const { conc, dir } = await runFailingJob('jsonl', false);
    assert.equal(conc.releaseCalls.length, 1, `expected exactly 1 release, got ${conc.releaseCalls.length}`);
    assert.equal(conc.getCount('W'), 0, 'no leak, no double');
    fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
