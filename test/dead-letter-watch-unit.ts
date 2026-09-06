#!/usr/bin/env tsx
/**
 * dead-letter-watch-unit.ts — the dead-letter watchdog's policy.
 *
 * The thing being defended: a dead-letter is permanent, silent data loss, and
 * before this existed the only trace was one `marked dead:` line per row. The
 * 3.17.0 parent-embeds regression wrote ~3,000 of those lines over seven days
 * and nobody noticed, because thousands of identical lines are wallpaper.
 *
 * So the two properties that matter are in tension and both get pinned here:
 *   - LOUD when data is actually being lost (Sections A/C), and
 *   - SILENT when it is not (Section B) — a watchdog that cries every tick is
 *     the wallpaper problem again, and would be turned off within a week.
 *
 * Run: npx tsx test/dead-letter-watch-unit.ts
 */

import assert from 'node:assert/strict';

import {
    DEAD_LETTER_ESCALATE_TICKS,
    DeadLetterWatch,
    newDeadLetterWatchState,
    observeDeadLetters,
} from '../packages/lore/src/outbox/deadLetterWatch.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

/** Drive a sequence of totals through the policy, collecting every line. */
function run(counts: number[]): string[][] {
    let state = newDeadLetterWatchState();
    const out: string[][] = [];
    for (const c of counts) {
        const r = observeDeadLetters(state, c);
        state = r.state;
        out.push(r.lines);
    }
    return out;
}

console.log('dead-letter-watch: loud on real loss, silent otherwise');

// ── Section A: loud when writes are actually being discarded ────────────────

test('a rising count reports the DELTA and the running total', () => {
    const [, second] = run([0, 7]);
    assert.equal(second.length, 1);
    assert.match(second[0], /DATA LOSS: 7 write\(s\) permanently discarded/);
    assert.match(second[0], /7 dead-lettered in total/);
});

test('the line says the data is gone and will not be retried — not just that something failed', () => {
    const [, second] = run([0, 1]);
    assert.match(second[0], /NOT on the substrate/);
    assert.match(second[0], /NOT be retried/);
});

test('a non-empty queue at startup is reported once, as a backlog NOTE rather than new loss', () => {
    const [first, second] = run([2500, 2500]);
    assert.equal(first.length, 1);
    assert.match(first[0], /NOTE: 2500 dead-lettered row\(s\) already in the outbox at startup/);
    assert.doesNotMatch(first[0], /DATA LOSS/, 'a pre-existing backlog is not loss that happened just now');
    assert.deepEqual(second, [], 'and it is not repeated on every subsequent tick');
});

test('an empty queue at startup says nothing at all', () => {
    assert.deepEqual(run([0])[0], []);
});

// ── Section B: silent when nothing is being lost ────────────────────────────

test('a steady count is completely silent — no per-tick nagging', () => {
    const lines = run([0, 5, 5, 5, 5, 5]);
    assert.equal(lines[1].length, 1, 'the jump to 5 is reported once');
    for (let i = 2; i < lines.length; i++) {
        assert.deepEqual(lines[i], [], `tick ${i} stayed quiet while the count held steady`);
    }
});

test('a falling count (operator drained or requeued) is silent and re-baselines', () => {
    const lines = run([0, 10, 0, 3]);
    assert.deepEqual(lines[2], [], 'the drain itself is not an alarm');
    assert.match(lines[3][0], /DATA LOSS: 3 write\(s\)/, 'and the next loss is measured from the NEW baseline, not the old peak');
});

// ── Section C: escalation distinguishes bad rows from a bad build ───────────

test(`escalates after ${DEAD_LETTER_ESCALATE_TICKS} consecutive increases — a sustained rate means a defect`, () => {
    const lines = run([0, 1, 2, 3]);
    const escalations = lines.flat().filter((l) => /STILL CLIMBING/.test(l));
    assert.equal(escalations.length, 1, 'exactly one escalation once the streak is reached');
    assert.match(escalations[0], /SUSTAINED rate is a defect rejecting a class of write/);
});

test('the escalation names both the triage command and the recovery command', () => {
    const esc = run([0, 1, 2, 3]).flat().find((l) => /STILL CLIMBING/.test(l))!;
    assert.match(esc, /lore outbox drain-failed --dry-run/, 'how to look');
    assert.match(esc, /lore outbox requeue-dead --dry-run/, 'how to recover');
    assert.match(esc, /payloads are retained/, 'and that recovery is actually possible');
});

test('an interrupted streak does not escalate — one-off dead rows are not an incident', () => {
    // up, up, steady, up: three increases, but never three in a row.
    const lines = run([0, 1, 2, 2, 3]);
    assert.equal(lines.flat().filter((l) => /STILL CLIMBING/.test(l)).length, 0);
});

test('a continuing incident keeps escalating instead of firing once and going quiet', () => {
    const lines = run([0, 1, 2, 3, 4, 5, 6]);
    assert.equal(
        lines.flat().filter((l) => /STILL CLIMBING/.test(l)).length, 2,
        'six consecutive increases escalate twice — an unresolved incident must not fall silent',
    );
});

// ── Section D: the wrapper the replicator actually holds ────────────────────

test('DeadLetterWatch carries state across calls and emits through the given logger', () => {
    const seen: string[] = [];
    const watch = new DeadLetterWatch();
    watch.observe(0, (m) => seen.push(m));
    watch.observe(4, (m) => seen.push(m));
    watch.observe(4, (m) => seen.push(m));
    assert.equal(seen.length, 1, 'baseline silent, one loss reported, steady tick silent');
    assert.match(seen[0], /DATA LOSS: 4 write\(s\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
