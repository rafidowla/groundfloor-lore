#!/usr/bin/env tsx
/**
 * extractPropositions.unit.ts — buildPropositionPrompt / parsePropositionResult.
 * Pure functions, zero API calls.
 */

import assert from 'node:assert/strict';
import {
    buildPropositionPrompt,
    parsePropositionResult,
    parsePropositionResultDetailed,
    extractPropositionsFromSession,
    PropositionExtractionTruncatedError,
    PropositionParseError,
    type PropositionCaller,
} from './extractPropositions.js';
import type { LongMemEvalTurn } from './types.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const asyncTests: Array<Promise<void>> = [];
function testAsync(name: string, fn: () => Promise<void>): void {
    asyncTests.push(
        (async () => {
            try { await fn(); console.log(`  ✓ ${name}`); passed++; }
            catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
        })(),
    );
}

console.log('buildPropositionPrompt');

const turns: LongMemEvalTurn[] = [
    { role: 'user', content: 'By the way, my new bike lights cost $40, they are great.' } as LongMemEvalTurn,
];

test('includes the session date when given', () => {
    const p = buildPropositionPrompt('2023/05/29', turns);
    assert.match(p, /2023\/05\/29/);
});

test('says "no session date" when null', () => {
    const p = buildPropositionPrompt(null, turns);
    assert.match(p, /No session date is given/);
});

test('instructs resolving pronouns / implicit references', () => {
    const p = buildPropositionPrompt(null, turns);
    assert.match(p, /pronoun/i);
});

test('instructs extracting from BOTH user and assistant turns', () => {
    const p = buildPropositionPrompt(null, turns);
    assert.match(p, /EITHER the user or the assistant/);
});

test('instructs extracting asides embedded in an off-topic turn', () => {
    const p = buildPropositionPrompt(null, turns);
    assert.match(p, /passing aside/);
});

test('includes every turn, indexed', () => {
    const multi: LongMemEvalTurn[] = [
        { role: 'user', content: 'first' } as LongMemEvalTurn,
        { role: 'assistant', content: 'second' } as LongMemEvalTurn,
    ];
    const p = buildPropositionPrompt(null, multi);
    assert.match(p, /\[0\] user: first/);
    assert.match(p, /\[1\] assistant: second/);
});

console.log('\nparsePropositionResult');

test('parses a clean JSON array', () => {
    const result = parsePropositionResult('[{"text": "The user bought bike lights for $40.", "source_turn_index": 0}]');
    assert.deepEqual(result, [{ text: 'The user bought bike lights for $40.', sourceTurnIndex: 0 }]);
});

test('parses a markdown-fenced array', () => {
    const result = parsePropositionResult('```json\n[{"text": "fact", "source_turn_index": 2}]\n```');
    assert.deepEqual(result, [{ text: 'fact', sourceTurnIndex: 2 }]);
});

test('parses an array wrapped in prose', () => {
    const result = parsePropositionResult('Here you go:\n[{"text": "fact", "source_turn_index": 1}]\nHope that helps!');
    assert.deepEqual(result, [{ text: 'fact', sourceTurnIndex: 1 }]);
});

test('returns [] for empty / malformed / non-array responses', () => {
    assert.deepEqual(parsePropositionResult(''), []);
    assert.deepEqual(parsePropositionResult('not json at all'), []);
    assert.deepEqual(parsePropositionResult('{"text": "not an array"}'), []);
});

test('skips malformed items but keeps valid ones', () => {
    const result = parsePropositionResult(
        '[{"text": "good one", "source_turn_index": 0}, {"text": "missing index"}, {"source_turn_index": 1}, {"text": "", "source_turn_index": 2}]',
    );
    assert.deepEqual(result, [{ text: 'good one', sourceTurnIndex: 0 }]);
});

/* ─── Bug C: truncation retry + distinguishable zero-proposition outcomes ──
 *
 * MAX_PROPOSITION_TOKENS is 2000 and the old parser returned [] on ANY parse
 * failure, so a truncated response, a malformed response, and a genuinely
 * fact-free session were literally indistinguishable to the caller — all three
 * silently contributed nothing to the index. This happened on real sessions
 * during actual runs.
 *
 * The retry mirrors extractFacts.ts's callOpenAiExtract (one retry at double
 * the budget on truncation); the outcome split mirrors extractCountableFacts's
 * failedSessions visibility pattern (failures are reported, not swallowed).
 */

console.log('\nparsePropositionResultDetailed — failure reasons are preserved');

test('genuinely empty session is `ok` with zero propositions, NOT a failure', () => {
    const outcome = parsePropositionResultDetailed('[]');
    assert.equal(outcome.status, 'ok');
    assert.deepEqual(outcome.status === 'ok' ? outcome.propositions : null, []);
});

test('a truncated (unclosed) JSON array is `unparseable`, not an empty result', () => {
    // Exactly what a max_tokens cut-off looks like: the array opened, the model
    // was cut mid-item, nothing closes it.
    const outcome = parsePropositionResultDetailed('[{"text": "the user baked a bagu');
    assert.equal(outcome.status, 'unparseable', 'a cut-off array must not read as "no facts"');
});

test('malformed / non-array responses are `unparseable` with a reason', () => {
    for (const bad of ['', 'not json at all', '{"text": "not an array"}']) {
        const outcome = parsePropositionResultDetailed(bad);
        assert.equal(outcome.status, 'unparseable', `expected unparseable for ${JSON.stringify(bad)}`);
        assert.ok(outcome.status === 'unparseable' && outcome.reason.length > 0, 'must carry a reason');
    }
});

console.log('\nextractPropositionsFromSession — retry + distinguishable failures');

/** Scripted caller: one entry per expected attempt. */
function scriptedCaller(script: Array<{ content: string; stopReason: string | null }>): {
    caller: PropositionCaller;
    calls: Array<{ maxTokens: number }>;
} {
    const calls: Array<{ maxTokens: number }> = [];
    const caller: PropositionCaller = async (_prompt, maxTokens) => {
        const step = script[calls.length];
        calls.push({ maxTokens });
        if (!step) throw new Error(`unexpected extra call #${calls.length}`);
        return { content: step.content, inputTokens: 10, outputTokens: 20, stopReason: step.stopReason };
    };
    return { caller, calls };
}

const oneTurn: LongMemEvalTurn[] = [{ role: 'user', content: 'I baked a baguette on Saturday.' } as LongMemEvalTurn];

testAsync('a truncated response TRIGGERS the retry at double the token budget', async () => {
    const { caller, calls } = scriptedCaller([
        { content: '[{"text": "cut off mid-arr', stopReason: 'max_tokens' },
        { content: '[{"text": "The user baked a baguette on Saturday.", "source_turn_index": 0}]', stopReason: 'end_turn' },
    ]);
    const res = await extractPropositionsFromSession({ sessionDate: null, turns: oneTurn, caller });

    assert.equal(calls.length, 2, 'must retry exactly once');
    assert.equal(calls[0]!.maxTokens, 2000, 'first attempt uses MAX_PROPOSITION_TOKENS');
    assert.equal(calls[1]!.maxTokens, 4000, 'retry uses DOUBLE the budget (matches extractFacts.ts)');
    assert.equal(res.propositions.length, 1, 'the retry result is used');
    assert.equal(res.retried, true, 'the retry is reported to the caller');
    assert.equal(res.emptySession, false);
});

testAsync('a truncated but PARSEABLE response does NOT retry (no wasted spend)', async () => {
    // stop_reason "max_tokens" says the model ran out of budget; it does not
    // say the payload is unusable. The common shape is a COMPLETE array
    // followed by trailing prose cut mid-sentence — extractJsonArray recovers
    // it fine. Retrying that bought nothing and cost a second full-size Haiku
    // call at DOUBLE the budget.
    const { caller, calls } = scriptedCaller([
        {
            content: '[{"text": "The user baked a baguette on Saturday.", "source_turn_index": 0}]\n'
                + 'I extracted one proposition. Note that the session also mentio',
            stopReason: 'max_tokens',
        },
        { content: '[{"text": "SHOULD NOT BE REACHED", "source_turn_index": 0}]', stopReason: 'end_turn' },
    ]);
    const res = await extractPropositionsFromSession({ sessionDate: null, turns: oneTurn, caller });

    assert.equal(calls.length, 1, 'a truncated-but-parseable response must NOT trigger the retry');
    assert.equal(res.retried, false, 'and must not be reported as retried');
    assert.equal(res.propositions.length, 1, 'the recovered array is used');
    assert.equal(res.propositions[0]!.text, 'The user baked a baguette on Saturday.');
});

testAsync('a retry that truncates but PARSES is a success, not a hard failure', async () => {
    // Same gate on the way out of the retry branch.
    const { caller, calls } = scriptedCaller([
        { content: '[{"text": "cut off', stopReason: 'max_tokens' },
        {
            content: '[{"text": "The user baked a baguette on Saturday.", "source_turn_index": 0}] and also th',
            stopReason: 'max_tokens',
        },
    ]);
    const res = await extractPropositionsFromSession({ sessionDate: null, turns: oneTurn, caller });
    assert.equal(calls.length, 2);
    assert.equal(res.retried, true);
    assert.equal(res.propositions.length, 1, 'a parseable retry payload must be kept, not thrown away');
});

testAsync('a retry that STILL truncates surfaces as a distinguishable failure, not []', async () => {
    const { caller, calls } = scriptedCaller([
        { content: '[{"text": "cut off', stopReason: 'max_tokens' },
        { content: '[{"text": "still cut off', stopReason: 'max_tokens' },
    ]);
    await assert.rejects(
        () => extractPropositionsFromSession({ sessionDate: null, turns: oneTurn, caller }),
        (err: unknown) => {
            assert.ok(err instanceof PropositionExtractionTruncatedError, `expected truncation error, got ${(err as Error).name}`);
            assert.equal((err as PropositionExtractionTruncatedError).attemptedMaxTokens, 4000);
            assert.match((err as Error).message, /UNKNOWN, not zero/, 'message must say the count is unknown');
            return true;
        },
    );
    assert.equal(calls.length, 2, 'exactly two attempts — one retry, then give up');
});

testAsync('a genuinely-empty session ([]) is NOT flagged as a failure', async () => {
    const { caller, calls } = scriptedCaller([{ content: '[]', stopReason: 'end_turn' }]);
    const res = await extractPropositionsFromSession({ sessionDate: null, turns: oneTurn, caller });

    assert.deepEqual(res.propositions, [], 'no propositions');
    assert.equal(res.emptySession, true, 'VERIFIED empty — the distinguishing signal');
    assert.equal(res.retried, false, 'no retry for a well-formed empty answer');
    assert.equal(calls.length, 1, 'a correct [] must not trigger a retry');
});

testAsync('an unparseable (non-truncated) response throws rather than returning []', async () => {
    const { caller } = scriptedCaller([{ content: 'I could not find any facts, sorry.', stopReason: 'end_turn' }]);
    await assert.rejects(
        () => extractPropositionsFromSession({ sessionDate: null, turns: oneTurn, caller }),
        (err: unknown) => {
            assert.ok(err instanceof PropositionParseError, `expected parse error, got ${(err as Error).name}`);
            assert.match((err as Error).message, /UNKNOWN, not zero/);
            return true;
        },
    );
});

testAsync('token usage is summed across BOTH attempts when a retry happens', async () => {
    const { caller } = scriptedCaller([
        { content: '[', stopReason: 'max_tokens' },
        { content: '[]', stopReason: 'end_turn' },
    ]);
    const res = await extractPropositionsFromSession({ sessionDate: null, turns: oneTurn, caller });
    assert.equal(res.inputTokens, 20, 'both attempts billed (10 + 10)');
    assert.equal(res.outputTokens, 40, 'both attempts billed (20 + 20)');
});

await Promise.all(asyncTests);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
