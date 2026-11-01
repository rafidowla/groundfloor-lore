#!/usr/bin/env tsx
/**
 * recall/ranking.ts recallRankClockMs — 3.38.3: recall ranks against the UTC day, not the live clock.
 *
 * recencyDecay is continuous in "now", so two near-tied results could swap between two identical
 * recalls seconds apart (Nokshi order drift). Default recall (floor 0 + rrf) used the live
 * Date.now(); the D3 minute bucket covered only anchored/BM25 modes. This file pins:
 *   1. the clock is the start of the current UTC day, constant across the day, moving at midnight;
 *   2. a constructed near-tie that FLIPS between t and t+90 s under the live clock keeps its order
 *      under the day clock (the bug and the fix, on rankScore itself);
 *   3. both recall entry points (retrieve.ts, recallCrossWorkspace.ts) rank with recallRankClockMs —
 *      a wiring guard so a later edit cannot silently put the live clock back.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rankScore, recallRankClockMs } from '../packages/lore/src/recall/ranking.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const DAY = 86_400_000;

console.log('\nrecall — day-bucketed ranking clock (3.38.3)\n');

await test('clock = start of the UTC day; constant within the day, moves at UTC midnight', () => {
    const t = Date.parse('2026-11-01T17:42:13.512Z');
    assert.equal(recallRankClockMs(t), Date.parse('2026-11-01T00:00:00.000Z'));
    assert.equal(recallRankClockMs(Date.parse('2026-11-01T23:59:59.999Z')), recallRankClockMs(t));
    assert.equal(recallRankClockMs(Date.parse('2026-11-02T00:00:00.000Z')), recallRankClockMs(t) + DAY);
    const live = recallRankClockMs();
    assert.ok(live <= Date.now() && Date.now() - live < DAY, 'default argument reads the live clock');
});

await test('a near-tie that flips under the live clock keeps its order under the day clock', () => {
    const t0 = Date.parse('2026-11-01T12:00:00.000Z');
    const t1 = t0 + 90_000;
    const older = { type: 'note', updatedAt: '2026-09-01T00:00:00.000Z' };
    const newer = { type: 'note', updatedAt: '2026-10-31T00:00:00.000Z' };
    // Pick newer's base score so the two cross exactly at t0 + 45 s: older wins at t0, newer at t1.
    const tMid = t0 + 45_000;
    const olderAt = (now: number) => rankScore({ node: older, baseScore: 0.8, nowMs: now });
    const newerUnit = (now: number) => rankScore({ node: newer, baseScore: 1, nowMs: now });
    const base = olderAt(tMid) / newerUnit(tMid);
    const newerAt = (now: number) => rankScore({ node: newer, baseScore: base, nowMs: now });
    const order = (now: number) => (olderAt(now) > newerAt(now) ? 'older-first' : 'newer-first');
    assert.notEqual(order(t0), order(t1), 'precondition: the live clock flips this pair within 90 s');
    assert.equal(order(recallRankClockMs(t0)), order(recallRankClockMs(t1)), 'day clock: same order');
});

await test('both recall entry points rank with recallRankClockMs (wiring guard)', () => {
    const root = path.resolve(import.meta.dirname, '..', 'packages', 'lore', 'src');
    const retrieve = fs.readFileSync(path.join(root, 'recall', 'retrieve.ts'), 'utf8');
    assert.match(retrieve, /const rankNowMs = recallRankClockMs\(\);/);
    assert.match(retrieve, /reRankLoreNodes\(seeds, rankNowMs,/);
    const xws = fs.readFileSync(path.join(root, 'mcp', 'tools', 'recallCrossWorkspace.ts'), 'utf8');
    assert.match(xws, /const nowMs = recallRankClockMs\(\);/);
    assert.match(xws, /rankScore\(\{ node: c\.node, baseScore: c\.score, nowMs, curatedTypes \}\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
