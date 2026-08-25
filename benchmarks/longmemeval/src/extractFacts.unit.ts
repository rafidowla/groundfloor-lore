#!/usr/bin/env tsx
/**
 * extractFacts.unit.ts — pure parts of the extraction pipeline (prompt
 * construction + response parsing). Zero API calls, deterministic.
 *
 * Run: npx tsx benchmarks/longmemeval/src/extractFacts.unit.ts
 */

import assert from 'node:assert/strict';
import { buildExtractionPrompt, parseExtractionResult } from './extractFacts.js';
import type { LongMemEvalTurn } from './types.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const turns: LongMemEvalTurn[] = [
    { role: 'user', content: 'I bought a bike for $800 yesterday.' },
    { role: 'assistant', content: 'Nice! What kind?' },
];

console.log('buildExtractionPrompt');

test('includes the session date and every turn', () => {
    const p = buildExtractionPrompt('2024-03-15', turns);
    assert.ok(p.includes("This session's date is 2024-03-15."), p);
    assert.ok(p.includes('[0] user: I bought a bike for $800 yesterday.'), p);
    assert.ok(p.includes('[1] assistant: Nice! What kind?'), p);
});

test('handles a missing session date', () => {
    const p = buildExtractionPrompt(null, turns);
    assert.ok(p.includes('No session date is given.'), p);
});

test('demands a JSON array and a return-[] fallback', () => {
    const p = buildExtractionPrompt('2024-03-15', turns);
    assert.ok(p.includes('Return ONLY a JSON array'), p);
    assert.ok(p.includes('return []'), p);
    assert.ok(p.includes('source_turn_index'), p);
});

console.log('buildExtractionPrompt — exhaustiveness (2026-08-14 misses)');

// Case 1a: `answer_afa9873b_3::6` — "I need to return some boots to Zara ...
// I exchanged them for a larger size. I just haven't had a chance to pick them
// up yet." Extraction emitted ONLY the purchase half.
test('covers outstanding pick-up / return / exchange obligations', () => {
    const p = buildExtractionPrompt('2023-02-15', turns);
    assert.ok(/an outstanding item or obligation/.test(p), p);
    for (const verb of ['pick up', 'collect', 'return', 'exchange', 'drop off']) {
        assert.ok(p.includes(verb), `include-list is missing "${verb}":\n${p}`);
    }
    assert.ok(p.includes('waiting for the user at a shop or service'), p);
});

// The same turn was ALSO pushed out by the old blanket "exclude future plans"
// clause, since "I still need to pick them up" is future-facing grammar.
test('narrows the exclusion so committed obligations survive it', () => {
    const p = buildExtractionPrompt('2023-02-15', turns);
    // The undecided-intention exclusion is still there …
    assert.ok(p.includes('undecided intentions that have no committed object'), p);
    assert.ok(p.includes('"I want to"') && p.includes('"I might"') && p.includes(`"I'm thinking about"`), p);
    // … but it no longer swallows every not-yet-happened thing.
    assert.ok(
        p.includes('An obligation with a concrete object is NOT an undecided intention'),
        p,
    );
    assert.ok(p.includes('MUST be included, even though they have not happened yet'), p);
    // The old blanket wording must be gone, or the narrowing is decorative.
    assert.ok(!/wishes, hypotheticals, and future plans/.test(p), p);
});

// Case 1b: `answer_ec904b3c_1::0` ("I led the data analysis team") and
// `answer_ec904b3c_2::2` ("I've been working on a solo project for my Data
// Mining class") produced no rows at all — neither is a purchase, a dated
// event, nor time spent.
test('covers roles held and undertakings already under way', () => {
    const p = buildExtractionPrompt('2023-05-21', turns);
    assert.ok(p.includes('a role or responsibility the user holds or held'), p);
    for (const verb of ['leading', 'running', 'managing', 'organising']) {
        assert.ok(p.includes(verb), `role bullet is missing "${verb}":\n${p}`);
    }
    assert.ok(p.includes('an undertaking the user is in the middle of'), p);
    assert.ok(p.includes('already under way'), p);
});

test('states that ONE turn can yield SEVERAL rows', () => {
    const p = buildExtractionPrompt('2023-02-15', turns);
    assert.ok(p.includes('A single turn can yield zero, one, or several facts'), p);
    assert.ok(p.includes('states THREE facts, not one'), p);
    assert.ok(p.includes('emit a separate row for each'), p);
});

test('demands turn-by-turn traversal rather than skimming', () => {
    const p = buildExtractionPrompt('2023-02-15', turns);
    assert.ok(p.includes('Work through the turns one at a time, in index order'), p);
    assert.ok(p.includes('Do not skim the session as a whole'), p);
});

test('breaks borderline calls toward including', () => {
    const p = buildExtractionPrompt('2023-02-15', turns);
    assert.ok(p.includes('When you are unsure whether a mention is countable, INCLUDE it'), p);
    assert.ok(p.includes('nothing downstream can recover a fact you leave out'), p);
});

// The anti-duplicate rule must survive — it works WITHIN a session — but it
// must not read as "one row per object", which is what suppressed the
// to-return / to-collect rows on the Zara turn.
test('keeps same-session dedup but exempts different facts about one object', () => {
    const p = buildExtractionPrompt('2023-02-15', turns);
    assert.ok(p.includes('Do not emit duplicate rows for the same underlying event'), p);
    assert.ok(p.includes('when a later turn in this session restates a fact'), p);
    assert.ok(
        p.includes(
            'Two different facts about the same object (buying it, and still needing to collect it) are NOT the same event',
        ),
        p,
    );
});

// Observed leak: row `28dc39ac::cbd18c72::10` shipped with the model's own
// include/exclude deliberation sitting in the description field.
test('forbids reasoning in the description field', () => {
    const p = buildExtractionPrompt('2023-02-15', turns);
    assert.ok(
        p.includes('"description" holds the fact alone — never your reasoning about whether to include it'),
        p,
    );
});

test('keeps the original three include shapes intact', () => {
    const p = buildExtractionPrompt('2024-03-15', turns);
    assert.ok(p.includes('a purchase or expense (put the amount in numeric_value)'), p);
    assert.ok(p.includes('a visit, trip, event, or activity the user actually did'), p);
    assert.ok(p.includes('time spent on something (hours/days/weeks'), p);
});

console.log('parseExtractionResult');

test('parses a clean JSON array and maps turn index to node id', () => {
    const raw = JSON.stringify([
        { category: 'purchase', description: 'bought a bike', numeric_value: 800, event_date: '2024-03-15', source_turn_index: 0 },
    ]);
    const facts = parseExtractionResult(raw, 'q1', 's1');
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0], {
        category: 'purchase',
        description: 'bought a bike',
        numericValue: 800,
        eventDate: '2024-03-15',
        sourceNodeId: 'q1::s1::0',
    });
});

test('parses a markdown-fenced array', () => {
    const raw = '```json\n[{"category":"visit","description":"museum","numeric_value":null,"event_date":"2024-01-01","source_turn_index":2}]\n```';
    const facts = parseExtractionResult(raw, 'q1', 's1');
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.sourceNodeId, 'q1::s1::2');
    assert.equal(facts[0]!.numericValue, null);
});

test('parses an array wrapped in prose', () => {
    const raw = 'Here are the facts:\n[{"category":"reading","description":"read a book","numeric_value":null,"event_date":null,"source_turn_index":1}]\nDone.';
    const facts = parseExtractionResult(raw, 'q1', 's1');
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.sourceNodeId, 'q1::s1::1');
});

test('returns [] for empty / malformed / non-array responses', () => {
    assert.deepEqual(parseExtractionResult('', 'q', 's'), []);
    assert.deepEqual(parseExtractionResult('not json at all', 'q', 's'), []);
    assert.deepEqual(parseExtractionResult('{"facts": []}', 'q', 's'), []); // object, not array
});

test('skips malformed items but keeps valid ones', () => {
    const raw = JSON.stringify([
        { category: 'purchase', description: 'ok', numeric_value: 5, event_date: '2024-01-01', source_turn_index: 0 },
        { category: '', description: 'missing category', numeric_value: null, event_date: null, source_turn_index: 1 },
        { category: 'visit', description: '', numeric_value: null, event_date: null, source_turn_index: 2 },
        { category: 'visit', description: 'missing turn index' },
        { category: 'visit', description: 'bad date', numeric_value: null, event_date: 'not-a-date', source_turn_index: 3 },
        'garbage',
    ]);
    const facts = parseExtractionResult(raw, 'q1', 's1');
    assert.equal(facts.length, 2); // only the first + the bad-date one survive (date coerced to null)
    assert.equal(facts[0]!.sourceNodeId, 'q1::s1::0');
    assert.equal(facts[1]!.eventDate, null); // invalid date → null, not dropped
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
