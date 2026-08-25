#!/usr/bin/env tsx
/**
 * judgeMajority.unit.ts — judgeAnswerMajority, fully mocked judgeFn.
 * Zero live API calls; deterministic.
 */

import assert from 'node:assert/strict';
import { judgeAnswerMajority, type JudgeFn } from './judgeMajority.js';
import type { JudgeVerdict } from './judge.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function fakeJudge(labels: boolean[]): { fn: JudgeFn; calls: unknown[][] } {
    const calls: unknown[][] = [];
    let i = 0;
    const fn = (async (...args: unknown[]) => {
        calls.push(args);
        const label = labels[i++]!;
        return { model: 'gpt-4o-2024-08-06', label, rawResponse: label ? 'yes' : 'no' } as JudgeVerdict;
    }) as unknown as JudgeFn;
    return { fn, calls };
}

console.log('judgeAnswerMajority — self-audited second score');

await test('2 true + 1 false → majority true, agreement 2/3', async () => {
    const { fn } = fakeJudge([true, true, false]);
    const out = await judgeAnswerMajority('q1', 'multi-session', 'Q?', 'A', 'R', { judgeFn: fn });
    assert.equal(out.majorityLabel, true);
    assert.ok(Math.abs(out.agreement - 2 / 3) < 1e-9);
    assert.equal(out.votes.length, 3);
});

await test('1 true + 2 false → majority false, agreement 2/3', async () => {
    const { fn } = fakeJudge([true, false, false]);
    const out = await judgeAnswerMajority('q1', 'multi-session', 'Q?', 'A', 'R', { judgeFn: fn });
    assert.equal(out.majorityLabel, false);
    assert.ok(Math.abs(out.agreement - 2 / 3) < 1e-9);
});

await test('unanimous true → majority true, agreement 1', async () => {
    const { fn } = fakeJudge([true, true, true]);
    const out = await judgeAnswerMajority('q1', 'multi-session', 'Q?', 'A', 'R', { judgeFn: fn });
    assert.equal(out.majorityLabel, true);
    assert.equal(out.agreement, 1);
});

await test('votes=1 passes through the single vote, agreement 1', async () => {
    const { fn } = fakeJudge([false]);
    const out = await judgeAnswerMajority('q1', 'multi-session', 'Q?', 'A', 'R', { votes: 1, judgeFn: fn });
    assert.equal(out.majorityLabel, false);
    assert.equal(out.agreement, 1);
    assert.equal(out.votes.length, 1);
});

await test('votes=5, 3 true + 2 false → majority true, agreement 3/5', async () => {
    const { fn } = fakeJudge([true, false, true, false, true]);
    const out = await judgeAnswerMajority('q1', 'multi-session', 'Q?', 'A', 'R', { votes: 5, judgeFn: fn });
    assert.equal(out.majorityLabel, true);
    assert.ok(Math.abs(out.agreement - 3 / 5) < 1e-9);
});

await test('even vote count throws (no tie-break policy)', async () => {
    const { fn } = fakeJudge([true, false]);
    await assert.rejects(
        () => judgeAnswerMajority('q1', 'multi-session', 'Q?', 'A', 'R', { votes: 2, judgeFn: fn }),
        /positive odd integer/,
    );
});

await test('zero votes throws', async () => {
    const { fn } = fakeJudge([]);
    await assert.rejects(
        () => judgeAnswerMajority('q1', 'multi-session', 'Q?', 'A', 'R', { votes: 0, judgeFn: fn }),
        /positive odd integer/,
    );
});

await test('judgeFn is called exactly `votes` times, with the same args each time', async () => {
    const { fn, calls } = fakeJudge([true, true, true]);
    await judgeAnswerMajority('qX', 'temporal-reasoning', 'When?', 'Answer', 'Response', { judgeFn: fn });
    assert.equal(calls.length, 3);
    for (const c of calls) {
        assert.deepEqual(c, ['qX', 'temporal-reasoning', 'When?', 'Answer', 'Response']);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
