#!/usr/bin/env tsx
/**
 * audit-bw7-accesstracker-dispose-unit.ts — re-audit 2026-06-25 (MEDIUM, concurrency).
 *
 * ensureAccessTracker lazily starts a per-graph interval timer but nothing
 * stopped it when the registry evicted/closed that graph — leaking the closed
 * LocalGraph (ref held by the timer), perpetually failing its flush against a
 * closed pool, and dropping access stamps for evicted non-active workspaces.
 * disposeAccessTracker(graph) now stops the timer + drops the tracker, and the
 * registry calls it after every graph.close().
 */

import assert from 'node:assert/strict';
import { ensureAccessTracker, disposeAccessTracker } from '../packages/lore/src/engines/accessTracker.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

// Minimal AccessStampTarget — ensureAccessTracker only requires stampAccessTimes.
const mkGraph = () => ({ stampAccessTimes: async () => undefined });

console.log('BW-7 — AccessTracker is disposed on graph eviction');

await test('disposeAccessTracker stops + drops the tracker (a fresh ensure creates a new one)', async () => {
    const g = mkGraph();
    const t1 = ensureAccessTracker(g);
    assert.ok(t1, 'a tracker is created for the graph');
    assert.equal(ensureAccessTracker(g), t1, 'same graph returns the SAME cached tracker');
    await disposeAccessTracker(g);
    const t2 = ensureAccessTracker(g);
    assert.notEqual(t2, t1, 'after dispose the old tracker was removed → a fresh one is created');
    await disposeAccessTracker(g); // cleanup
});

await test('disposeAccessTracker is a no-op when the graph has no tracker', async () => {
    await disposeAccessTracker(mkGraph()); // never ensured
    await disposeAccessTracker(null);
    assert.ok(true, 'no throw');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
