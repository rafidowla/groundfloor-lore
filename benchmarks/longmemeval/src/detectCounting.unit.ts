#!/usr/bin/env tsx
/**
 * detectCounting.unit.ts — the keyword gate for counting/aggregation/order
 * questions. Pure, zero API calls. The question strings are the real
 * LongMemEval phrasings from results/subset-n100-final.json and
 * results/subset-20-counting-validation.json.
 *
 * Run: npx tsx benchmarks/longmemeval/src/detectCounting.unit.ts
 */

import assert from 'node:assert/strict';
import { isCountingQuestion, isElapsedTimeQuestion } from './detectCounting.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('isCountingQuestion — real question phrasings');

const COUNTING_QUESTIONS = [
    'How many times did I go to the gym in the past month?',
    'How much total money have I spent on bike-related expenses since the start of the year?',
    'How many hours in total did I spend driving to my three road trip destinations combined?',
    'How many days did I take social media breaks in total?',
    'What is the total amount I spent on luxury items in the past few months?',
    'How many hours have I spent playing games in total?',
    'How many weeks in total do I spent on reading \'The Nightingale\' and listening to \'Sapiens\'?',
    'What is the order of the three trips I took in the past three months, from earliest to latest?',
    'What is the order of the six museums I visited from earliest to latest?',
    'What is the order of the three events: \'I signed up for the rewards program\', \'I used a coupon\', \'I redeemed cashback\'?',
    'How many different doctors did you visit?',
    'How many times did I bake something in the past two weeks?',
    'How often do I go running?',
];

for (const q of COUNTING_QUESTIONS) {
    test(`detects: ${q.slice(0, 60)}`, () => {
        assert.equal(isCountingQuestion(q), true, q);
    });
}

test('is case-insensitive', () => {
    assert.equal(isCountingQuestion('HOW MANY times did I go?'), true);
    assert.equal(isCountingQuestion('How Much did I spend in TOTAL?'), true);
});

console.log('isCountingQuestion — non-counting questions');

const NON_COUNTING = [
    'What degree did I graduate with?',
    'Where did I buy my winter boots?',
    'What is my favorite kind of coffee?',
    'What would I prefer for a photography setup?',
    'What is my current job title?',
    'Who did I meet for lunch last Tuesday?',
];

for (const q of NON_COUNTING) {
    test(`does not detect: ${q.slice(0, 50)}`, () => {
        assert.equal(isCountingQuestion(q), false, q);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Elapsed-time veto (2026-08-14).
//
// "how many" also opens every date-math question in the dataset. Those are one
// date subtraction, owned by the answering-prompt date fix — the
// countable_events rows cannot answer them, and letting them through made the
// counting system's measured wins indistinguishable from the date fix's wins
// (every wrong→right flip in the 20-question validation run was one of these).
//
// Every question below is a literal dataset phrasing, kept verbatim so the test
// stays pinned to the data this was debugged against.
// ─────────────────────────────────────────────────────────────────────────────

console.log('isCountingQuestion — elapsed-time / date-math questions are NOT counting');

const ELAPSED_TIME_QUESTIONS = [
    'How many weeks ago did I meet up with my aunt and receive the crystal chandelier?',
    'How many weeks ago did I attend the friends and family sale at Nordstrom?',
    'How many days ago did I attend the Maundy Thursday service at the Episcopal Church?',
    'How many days ago did I attend a baking class at a local culinary school when I made my friend\'s birthday cake?',
    'How many days passed between the day I started watering my herb garden and the day I harvested my first batch of fresh herbs?',
    'How many weeks ago did I start using the cashback app \'Ibotta\'?',
    'How many days ago did I buy a smoker?',
    'How many days ago did I meet Emma?',
    'How many months ago did I attend the Seattle International Film Festival?',
    'How many months have passed since I participated in two charity events in a row, on consecutive days?',
    'How many months have passed since I last visited a museum with a friend?',
    'How many days had passed since I started taking ukulele lessons when I decided to take my acoustic guitar to the guitar tech for servicing?',
    // The hard one: one camping trip = one start/end date pair = date math,
    // despite reading like "how many hours have I spent playing games".
    'How many days did I spend on my solo camping trip to Yosemite National Park?',
];

for (const q of ELAPSED_TIME_QUESTIONS) {
    test(`vetoes date-math: ${q.slice(0, 60)}`, () => {
        assert.equal(isElapsedTimeQuestion(q), true, `should be elapsed-time: ${q}`);
        assert.equal(isCountingQuestion(q), false, `should not be counting: ${q}`);
    });
}

console.log('isCountingQuestion — genuine counting questions survive the veto');

const COUNTING_QUESTIONS_SURVIVE_VETO = [
    'How many babies were born to friends and family members in the last few months?',
    'How many hours have I spent playing games in total?',
    'What is the total amount I spent on luxury items in the past few months?',
    'How many projects have I led or am currently leading?',
    'How many hours of jogging and yoga did I do last week?',
    'How many items of clothing do I need to pick up or return from a store?',
    'What\'s the order of the six museums I visited from earliest to latest?',
    'How many different doctors did I visit?',
    'How many times did I bake something in the past two weeks?',
    'How many different museums or galleries did I visit in the month of February?',
];

for (const q of COUNTING_QUESTIONS_SURVIVE_VETO) {
    test(`keeps counting: ${q.slice(0, 60)}`, () => {
        assert.equal(isCountingQuestion(q), true, `should be counting: ${q}`);
    });
}

console.log('isCountingQuestion — the hard edge case, side by side');

test('one bounded episode is a duration; many scattered sessions are a count', () => {
    // Near-identical surface wording ("spend/spent" + a time unit), opposite
    // classification. The signal is one start/end date pair vs many distinct
    // occurrences, not the wording.
    assert.equal(
        isCountingQuestion('How many days did I spend on my solo camping trip to Yosemite National Park?'),
        false,
    );
    assert.equal(isCountingQuestion('How many hours have I spent playing games in total?'), true);
});

test('plural episodes are an enumeration again, not a duration', () => {
    // Same frame as Yosemite but "trips" — several trips scattered across the
    // conversation is exactly what the structured-fact lookup is for.
    assert.equal(
        isCountingQuestion('How many days did I spend on camping trips in the United States this year?'),
        true,
    );
});

test('an explicit total outranks the date cues', () => {
    // "combined" / "in total" say outright that more than one occurrence is in
    // scope, so these stay counting even though they read as durations.
    assert.equal(
        isCountingQuestion('How long did I take to finish \'The Seven Husbands of Evelyn Hugo\' and \'The Nightingale\' combined?'),
        true,
    );
    assert.equal(
        isCountingQuestion('How many days did I spend in total traveling in Hawaii and in New York City?'),
        true,
    );
});

test('the veto never fires on questions that count things, not time', () => {
    // "before"/"since" anchors on a counting question must not trigger the veto:
    // the veto only engages when the asked-for quantity is itself a time unit.
    assert.equal(
        isCountingQuestion('How many charity events did I participate in before the \'Run for the Cure\' event?'),
        true,
    );
    assert.equal(
        isElapsedTimeQuestion('How much total money have I spent on bike-related expenses since the start of the year?'),
        false,
    );
    assert.equal(isElapsedTimeQuestion('How many different doctors did I visit?'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
