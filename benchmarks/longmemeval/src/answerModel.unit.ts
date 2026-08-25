#!/usr/bin/env tsx
/**
 * answerModel.unit.ts — buildPrompt wiring for reference date + temporal/recency instructions.
 * Pure function, zero API calls, deterministic.
 */

import assert from 'node:assert/strict';
import { buildPrompt } from './answerModel.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('buildPrompt — reference date + temporal/recency instructions');

const REFERENCE_DATE = '2023/05/30 (Tue) 23:40';
const QUESTION = 'How many months ago did I attend the Seattle International Film Festival?';
const CONTEXT = '[1] 2021-06-01\nI went to SIFF yesterday.';

test('includes the reference date as today', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE);
    assert.ok(prompt.includes(`Today's date is ${REFERENCE_DATE}.`));
});

test('instructs the model to calculate elapsed time from dates', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE);
    assert.ok(
        prompt.includes(
            'If the question asks how long ago something happened, calculate the elapsed time yourself from the dates given in the excerpts and today\'s date above',
        ),
    );
    assert.ok(
        prompt.includes(
            'do not say the information is missing just because you don\'t see the elapsed time already stated outright',
        ),
    );
});

test('instructs the model to prefer the most recently stated value for conflicting facts', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE);
    assert.ok(
        prompt.includes(
            'If the excerpts mention different values for the same fact at different points in the conversation',
        ),
    );
    assert.ok(
        prompt.includes(
            'use the most recently stated value — treat it as having been updated, not contradicted',
        ),
    );
});

test('retains the existing instruction to decline when info is truly missing', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE);
    assert.ok(
        prompt.includes(
            'If the excerpts do not contain enough information to answer, say so plainly rather than guessing.',
        ),
    );
});

test('still includes question and retrieved context', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE);
    assert.ok(prompt.includes(`Question: ${QUESTION}`));
    assert.ok(prompt.includes('--- Retrieved context ---'));
    assert.ok(prompt.includes(CONTEXT));
});
console.log('buildPrompt — structured counting records (Bucket B)');

const STRUCTURED = 'The following 3 countable event(s) were extracted from the full conversation history (one per line):\n- [purchase] spent $800 on a bike, value=800\n- [visit] went to the museum, date=2024-01-01\n- [visit] went to the zoo, date=2024-02-02';

test('injects the structured record + authoritative instruction when present', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE, STRUCTURED);
    assert.ok(prompt.includes('--- Structured record (authoritative) ---'), prompt);
    assert.ok(prompt.includes(STRUCTURED), prompt);
    assert.ok(prompt.includes('treat the structured record above as authoritative'), prompt);
});

test('omits the structured section when no structured facts are supplied', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE);
    assert.ok(!prompt.includes('Structured record'), prompt);
    const promptEmpty = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE, '   ');
    assert.ok(!promptEmpty.includes('Structured record'), promptEmpty);
});

test('structured facts are additive — retrieved context still present', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE, STRUCTURED);
    assert.ok(prompt.includes('--- Retrieved context ---'), prompt);
    assert.ok(prompt.includes(CONTEXT), prompt);
    assert.ok(prompt.includes(`Question: ${QUESTION}`), prompt);
});

console.log('buildPrompt — same-subject rows are not duplicates (2026-08-14)');

// The rows behind "How many hours have I spent playing games in total?"
// (gold 140, answered 110). Four lines name one game; two of them carry
// numbers — 25 (normal difficulty) and 30 (hard difficulty) — and both are
// real, additive playthroughs.
const GAMING_STRUCTURED = [
    'The following 9 countable event(s) were extracted from the full conversation history (one per line).',
    "- [gaming] User completed The Last of Us Part II on normal difficulty, taking 25 hours, value=25, src=answer_8d015d9d_1::0",
    '- [gaming] Completed The Last of Us Part II on hard difficulty, src=answer_8d015d9d_2::0',
    '- [gaming] Time spent playing The Last of Us Part II, value=30, src=answer_8d015d9d_2::0',
    "- [gaming] User spent 70 hours playing Assassin's Creed Odyssey, value=70, src=answer_8d015d9d_3::6",
    '- [gaming] User completed Celeste in 10 hours, value=10, src=answer_8d015d9d_4::0',
    '- [gaming] User finished Hyper Light Drifter in 5 hours, value=5, src=answer_8d015d9d_5::0',
    '- [gaming] User completed The Last of Us Part II on both normal and hard difficulties, src=answer_8d015d9d_5::4',
].join('\n');

test('tells the model that same-subject lines need classifying before summing', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE, GAMING_STRUCTURED);
    assert.ok(
        prompt.includes('Several lines can describe the same subject'),
        prompt,
    );
    assert.ok(prompt.includes('without being duplicates of each other'), prompt);
    assert.ok(prompt.includes('Before you sum or count, classify each line'), prompt);
});

test('same src = two halves of one occurrence (the qualifier and its number)', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE, GAMING_STRUCTURED);
    assert.ok(prompt.includes('Lines sharing a src= were extracted from the same sentence'), prompt);
    assert.ok(prompt.includes('are two halves of ONE occurrence'), prompt);
    assert.ok(prompt.includes('count that occurrence once, and use its number'), prompt);
});

test('different src + different numbers = always separate occurrences', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE, GAMING_STRUCTURED);
    assert.ok(
        prompt.includes('Lines with different src= that carry different numbers are ALWAYS separate occurrences'),
        prompt,
    );
    assert.ok(prompt.includes('even when the subject is identical'), prompt);
    assert.ok(prompt.includes('two real durations, and both are added'), prompt);
});

test('a numeric line is never cancelled by a value-less line about the same subject', () => {
    const prompt = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE, GAMING_STRUCTURED);
    assert.ok(prompt.includes('A line with no number never cancels a line that has one'), prompt);
    assert.ok(
        prompt.includes('Only fold two lines together when they state the same event with no distinguishing number, qualifier, or date between them'),
        prompt,
    );
    assert.ok(
        prompt.includes('Do not drop a numeric line because some other line mentions the same subject'),
        prompt,
    );
    assert.ok(prompt.includes('the usual error here is under-counting, not double-counting'), prompt);
});

test('the same-subject rules ride with the structured block, not the plain prompt', () => {
    const withFacts = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE, GAMING_STRUCTURED);
    const without = buildPrompt(QUESTION, CONTEXT, REFERENCE_DATE);
    assert.ok(withFacts.includes('Several lines can describe the same subject'), withFacts);
    assert.ok(!without.includes('Several lines can describe the same subject'), without);
    // The original authoritative-record instruction is not displaced by them.
    assert.ok(withFacts.includes('treat the structured record above as authoritative'), withFacts);
    assert.ok(withFacts.includes('Sum numeric values for totals and count lines for counts'), withFacts);
    assert.ok(withFacts.includes(GAMING_STRUCTURED), withFacts);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
