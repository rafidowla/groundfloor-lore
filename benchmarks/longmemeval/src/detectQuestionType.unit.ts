#!/usr/bin/env tsx
/**
 * detectQuestionType.unit.ts — pins the accuracy numbers detectQuestionType.ts's
 * header comment cites, and locks in a handful of real per-category phrasings
 * as regression guards.
 *
 * Two kinds of checks, deliberately not blended into one:
 *
 *   1. A handful of hard-coded real questions per category, asserted exactly
 *      — these pin the near-certain categories (single-session-assistant,
 *      single-session-preference) the same way detectCounting.unit.ts pins
 *      its keyword list against literal dataset phrasings.
 *   2. A full-dataset accuracy report over all 500 real instances in
 *      data/longmemeval_s_cleaned.json, asserted against floors well below
 *      the currently-measured numbers. This is a heuristic, not a
 *      classifier — see detectQuestionType.ts's header for why
 *      multi-session and knowledge-update have a much lower ceiling than
 *      the other four categories — so the floors leave slack for the
 *      dataset file changing slightly, not for the heuristic regressing
 *      silently. A real drop should fail this.
 *
 * Run: npx tsx benchmarks/longmemeval/src/detectQuestionType.unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectQuestionType } from './detectQuestionType.js';
import type { LongMemEvalInstance, LongMemEvalQuestionType } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.join(HERE, '..', 'data', 'longmemeval_s_cleaned.json');

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1 — pinned real phrasings, one small block per category.
// Every string below is a literal question from longmemeval_s_cleaned.json.
// ─────────────────────────────────────────────────────────────────────────

console.log('detectQuestionType — pinned real phrasings');

const PINNED: ReadonlyArray<[LongMemEvalQuestionType, string]> = [
    ['single-session-assistant', "Can you remind me of the name of the romantic Italian restaurant in Rome you recommended for dinner?"],
    ['single-session-assistant', "I'm going back to our previous conversation about music theory. You mentioned some online resources for learning music theory. Can you remind me of the website you recommended for free lessons and exercises?"],
    ['single-session-assistant', "I remember you told me to dilute tea tree oil with a carrier oil before applying it to my skin. Can you remind me what the recommended ratio is?"],
    ['single-session-preference', "Can you suggest a hotel for my upcoming trip to Miami?"],
    ['single-session-preference', "I've been struggling with my slow cooker recipes. Any advice on getting better results?"],
    ['single-session-preference', "I'm trying to decide whether to buy a NAS device now or wait. What do you think?"],
    ['temporal-reasoning', "How many weeks ago did I meet up with my aunt and receive the crystal chandelier?"],
    ['temporal-reasoning', "What is the order of the six museums I visited from earliest to latest?"],
    ['temporal-reasoning', "Which event happened first, my cousin's wedding or Michael's engagement party?"],
    ['multi-session', "How much total money have I spent on bike-related expenses since the start of the year?"],
    ['multi-session', "How many hours in total did I spend driving to my three road trip destinations combined?"],
    ['knowledge-update', "How many musical instruments do I currently own?"],
    ['knowledge-update', "How often do I play tennis with my friends at the local park previously? How often do I play now?"],
];

for (const [expected, q] of PINNED) {
    test(`${expected}: ${q.slice(0, 60)}`, () => {
        assert.equal(detectQuestionType(q), expected, q);
    });
}

test('never throws on empty or whitespace-only input', () => {
    assert.doesNotThrow(() => detectQuestionType(''));
    assert.doesNotThrow(() => detectQuestionType('   '));
    assert.equal(detectQuestionType(''), 'single-session-user');
});

// ─────────────────────────────────────────────────────────────────────────
// Part 2 — full-dataset accuracy report.
// ─────────────────────────────────────────────────────────────────────────

console.log('\ndetectQuestionType — accuracy over the full 500-instance dataset');

/** Measured floor per category as of the patterns in detectQuestionType.ts
 *  (see that file's header for the exact current numbers). Set a few points
 *  below the measured value so incidental dataset-file drift doesn't fail
 *  this, while an actual pattern regression still does. */
const ACCURACY_FLOOR: Record<LongMemEvalQuestionType, number> = {
    'single-session-assistant': 0.90,
    'single-session-preference': 0.75,
    'temporal-reasoning': 0.65,
    'multi-session': 0.35,
    'knowledge-update': 0.45,
    'single-session-user': 0.80,
};
const OVERALL_FLOOR = 0.60;

test('dataset file is readable', () => {
    assert.ok(fs.existsSync(DATASET_PATH), `expected dataset at ${DATASET_PATH}`);
});

if (fs.existsSync(DATASET_PATH)) {
    const instances: LongMemEvalInstance[] = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));

    const byType = new Map<LongMemEvalQuestionType, { correct: number; total: number }>();
    let overallCorrect = 0;

    for (const inst of instances) {
        const truth = inst.question_type;
        const guess = detectQuestionType(inst.question);
        const bucket = byType.get(truth) ?? { correct: 0, total: 0 };
        bucket.total += 1;
        if (guess === truth) { bucket.correct += 1; overallCorrect += 1; }
        byType.set(truth, bucket);
    }

    console.log('  category                       correct/total   accuracy   floor');
    for (const [type, floor] of Object.entries(ACCURACY_FLOOR) as [LongMemEvalQuestionType, number][]) {
        const bucket = byType.get(type);
        if (!bucket) continue;
        const acc = bucket.correct / bucket.total;
        console.log(
            `  ${type.padEnd(30)} ${`${bucket.correct}/${bucket.total}`.padEnd(15)} ${(acc * 100).toFixed(1).padStart(5)}%    ${(floor * 100).toFixed(0)}%`,
        );
        test(`${type} accuracy >= floor (${(floor * 100).toFixed(0)}%)`, () => {
            assert.ok(acc >= floor, `${type}: ${bucket.correct}/${bucket.total} = ${(acc * 100).toFixed(1)}%, below floor ${(floor * 100).toFixed(0)}%`);
        });
    }

    const overallAcc = overallCorrect / instances.length;
    console.log(`\n  OVERALL: ${overallCorrect}/${instances.length} = ${(overallAcc * 100).toFixed(1)}% (floor ${(OVERALL_FLOOR * 100).toFixed(0)}%)`);
    test(`overall accuracy >= floor (${(OVERALL_FLOOR * 100).toFixed(0)}%)`, () => {
        assert.ok(overallAcc >= OVERALL_FLOOR, `overall: ${(overallAcc * 100).toFixed(1)}%, below floor ${(OVERALL_FLOOR * 100).toFixed(0)}%`);
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
