#!/usr/bin/env tsx
/**
 * WP5 — LORE_RECALL_STAGE_TIMING helper (AsyncLocalStorage, default off).
 */

import assert from 'node:assert/strict';
import { timeRecallStage, timeRecallStageSync, withRecallStageTiming, recallStageTimingEnabled } from '../packages/lore/src/recall/recallStageTiming.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

console.log('WP5 — recall stage timing');

await test('default off: timeRecallStage is a pass-through', async () => {
    delete process.env['LORE_RECALL_STAGE_TIMING'];
    assert.equal(recallStageTimingEnabled(), false);
    const n = await timeRecallStage('embed', async () => 7);
    assert.equal(n, 7);
});

await test('flag on: stages accumulate and log path runs', async () => {
    process.env['LORE_RECALL_STAGE_TIMING'] = '1';
    assert.equal(recallStageTimingEnabled(), true);
    const out = await withRecallStageTiming(async () => {
        await timeRecallStage('embed', async () => { await new Promise((r) => setTimeout(r, 15)); });
        await timeRecallStage('hydrate', async () => 1);
        timeRecallStageSync('filter', () => 2);
        return 9;
    });
    assert.equal(out, 9);
    delete process.env['LORE_RECALL_STAGE_TIMING'];
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
