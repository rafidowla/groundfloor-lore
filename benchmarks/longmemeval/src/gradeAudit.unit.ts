#!/usr/bin/env tsx
/**
 * gradeAudit.unit.ts — flagBorderlineGrade + computeHumanCorrectedAccuracy.
 * Pure functions, zero API calls, deterministic.
 */

import assert from 'node:assert/strict';
import { flagBorderlineGrade, computeHumanCorrectedAccuracy } from './gradeAudit.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('gradeAudit — borderline-grade flags + human-corrected accuracy');

test('the CONFIRMED real case: hedge answer graded true on a non-abstention question → flagged', () => {
    const flag = flagBorderlineGrade({
        questionId: 'q1',
        isAbstention: false,
        answerText: 'The excerpts do not contain enough information to answer this question.',
        judgeLabel: true,
        judgeRawResponse: 'yes',
    });
    assert.ok(flag, 'expected a flag');
    assert.ok(flag!.reasons.some((r) => r.includes('hedge')), 'expected a hedge reason');
});

test('a normal confident answer graded true → not flagged', () => {
    const flag = flagBorderlineGrade({
        questionId: 'q2',
        isAbstention: false,
        answerText: 'You adopted a golden retriever named Max in March 2024.',
        judgeLabel: true,
        judgeRawResponse: 'yes',
    });
    assert.equal(flag, null);
});

test('hedge answer on an ABSTENTION question graded true → NOT flagged for the hedge reason (declining IS correct there)', () => {
    const flag = flagBorderlineGrade({
        questionId: 'q3_abs',
        isAbstention: true,
        answerText: 'I do not have enough information to answer that.',
        judgeLabel: true,
        judgeRawResponse: 'yes',
    });
    assert.equal(flag, null);
});

test('hedge answer graded FALSE → not flagged for the hedge reason (hedge reason only fires when graded correct)', () => {
    const flag = flagBorderlineGrade({
        questionId: 'q4',
        isAbstention: false,
        answerText: 'I am not sure, not enough information given.',
        judgeLabel: false,
        judgeRawResponse: 'no',
    });
    assert.equal(flag, null);
});

test('judge raw response is not a clean yes/no → flagged regardless of label', () => {
    const flag = flagBorderlineGrade({
        questionId: 'q5',
        isAbstention: false,
        answerText: 'You have 12 books on your reading list.',
        judgeLabel: true,
        judgeRawResponse: 'Yes, because the response mentions the correct number.',
    });
    assert.ok(flag, 'expected a flag');
    assert.ok(flag!.reasons.some((r) => r.includes("wasn't a clean yes/no")));
});

test('a clean "Yes" (capitalized, trailing period) raw response is NOT flagged for that reason', () => {
    const flag = flagBorderlineGrade({
        questionId: 'q6',
        isAbstention: false,
        answerText: 'Some confident answer.',
        judgeLabel: true,
        judgeRawResponse: 'Yes.',
    });
    assert.equal(flag, null);
});

test('both reasons can fire together', () => {
    const flag = flagBorderlineGrade({
        questionId: 'q7',
        isAbstention: false,
        answerText: 'There is not enough information to say for certain.',
        judgeLabel: true,
        judgeRawResponse: 'Yes, technically.',
    });
    assert.ok(flag);
    assert.equal(flag!.reasons.length, 2);
});

test('nothing triggers → null', () => {
    const flag = flagBorderlineGrade({
        questionId: 'q8',
        isAbstention: false,
        answerText: 'The meeting was on Tuesday at 3pm.',
        judgeLabel: false,
        judgeRawResponse: 'No',
    });
    assert.equal(flag, null);
});

test('computeHumanCorrectedAccuracy: no overrides → human-corrected equals official', () => {
    const graded = [
        { questionId: 'a', judgeLabel: true },
        { questionId: 'b', judgeLabel: false },
        { questionId: 'c', judgeLabel: true },
        { questionId: 'd', judgeLabel: true },
    ];
    const out = computeHumanCorrectedAccuracy(graded, new Set(['a']), new Map());
    assert.equal(out.total, 4);
    assert.equal(out.officialAccuracy, 0.75);
    assert.equal(out.humanCorrectedAccuracy, 0.75);
    assert.equal(out.flaggedCount, 1);
    assert.equal(out.overriddenCount, 0);
});

test('computeHumanCorrectedAccuracy: one override flips true→false, both numbers reported side by side', () => {
    const graded = [
        { questionId: 'a', judgeLabel: true },
        { questionId: 'b', judgeLabel: false },
        { questionId: 'c', judgeLabel: true },
        { questionId: 'd', judgeLabel: true },
    ];
    const out = computeHumanCorrectedAccuracy(graded, new Set(['a']), new Map([['a', false]]));
    assert.equal(out.officialAccuracy, 0.75);
    assert.equal(out.humanCorrectedAccuracy, 0.5);
    assert.equal(out.flaggedCount, 1);
    assert.equal(out.overriddenCount, 1);
});

test('computeHumanCorrectedAccuracy: empty input is safe (no NaN / divide-by-zero)', () => {
    const out = computeHumanCorrectedAccuracy([], new Set(), new Map());
    assert.equal(out.total, 0);
    assert.equal(out.officialAccuracy, 0);
    assert.equal(out.humanCorrectedAccuracy, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
