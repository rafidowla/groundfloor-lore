#!/usr/bin/env tsx
/**
 * retrievalMetrics.unit.ts — recall_any / recall_all / nDCG, with the
 * proposition-aware scoring extension (toEvidenceTurnId).
 *
 * Two things are under test here:
 *
 *   1. NO REGRESSION on turn-only corpora. Every pre-Mosaic data directory
 *      (e.g. lore-home-counting-validation-100-fixed) contains zero
 *      proposition nodes, and its numbers must not move by a single float.
 *      Proved the strong way rather than by example: the PRE-FIX evaluator
 *      is reproduced verbatim below as `legacy*`, and a deterministic fuzz
 *      asserts exact equality against it across hundreds of random
 *      turn-only rankings.
 *
 *   2. The bug itself. A proposition node's id is its source turn's id plus
 *      `::prop<n>`, so it can never string-equal an evidence turn id — a
 *      proposition that surfaced exactly the right fact at rank 0 used to
 *      score as a miss at every k.
 *
 * Pure functions, zero API calls, no Lore instance.
 */

import assert from 'node:assert/strict';
import {
    computeMetricsAtKs,
    evaluateRetrieval,
    meanMetrics,
    ndcgAtK,
    toEvidenceTurnId,
    type RetrievalMetrics,
} from './retrievalMetrics.js';
import { buildNodeId } from './ingest.js';
import { buildPropositionNodeId } from './writePropositions.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

// ---------------------------------------------------------------------------
// The PRE-FIX implementation, copied verbatim, as the regression oracle.
// ---------------------------------------------------------------------------
function legacyDcg(relevances: number[], k: number): number {
    const slice = relevances.slice(0, k);
    if (slice.length === 0) return 0;
    let sum = slice[0]!;
    for (let i = 1; i < slice.length; i++) sum += slice[i]! / Math.log2(i + 2);
    return sum;
}
function legacyNdcgAtK(rankings: number[], correctDocs: Set<string>, corpusIds: string[], k: number): number {
    const relevances = corpusIds.map((id) => (correctDocs.has(id) ? 1 : 0));
    const sortedRelevances = rankings.slice(0, k).map((idx) => relevances[idx] ?? 0);
    const idealRelevance = [...relevances].sort((a, b) => b - a);
    const idealDcg = legacyDcg(idealRelevance, k);
    const actualDcg = legacyDcg(sortedRelevances, k);
    if (idealDcg === 0) return 0;
    return actualDcg / idealDcg;
}
function legacyEvaluateRetrieval(rankings: number[], correctDocs: Set<string>, corpusIds: string[], k: number): RetrievalMetrics {
    const recalledDocs = new Set(rankings.slice(0, k).map((idx) => corpusIds[idx]));
    let recallAny = 0;
    let recallAll = 1;
    for (const doc of correctDocs) {
        if (recalledDocs.has(doc)) recallAny = 1;
        else recallAll = 0;
    }
    if (correctDocs.size === 0) recallAll = 0;
    return { recallAny, recallAll, ndcg: legacyNdcgAtK(rankings, correctDocs, corpusIds, k) };
}
function legacyComputeMetricsAtKs(rankedNodeIds: string[], evidenceNodeIds: string[], ks: number[]): Record<number, RetrievalMetrics> {
    const corpusIds = [...new Set([...rankedNodeIds, ...evidenceNodeIds])];
    const idToIdx = new Map(corpusIds.map((id, i) => [id, i]));
    const rankings = rankedNodeIds.map((id) => idToIdx.get(id)!);
    const correctDocs = new Set(evidenceNodeIds);
    const out: Record<number, RetrievalMetrics> = {};
    for (const k of ks) out[k] = legacyEvaluateRetrieval(rankings, correctDocs, corpusIds, k);
    return out;
}

/** Deterministic PRNG so a failure is always reproducible. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const Q = 'gpt4_59149c77';
const turn = (session: string, idx: number): string => buildNodeId(Q, session, idx);
const prop = (session: string, idx: number, n: number): string => buildPropositionNodeId(Q, session, idx, n);

// ---------------------------------------------------------------------------
console.log('toEvidenceTurnId');

test('strips a ::prop<n> suffix back to the source turn id', () => {
    assert.equal(toEvidenceTurnId('q::sess::3::prop0'), 'q::sess::3');
    assert.equal(toEvidenceTurnId('q::sess::3::prop12'), 'q::sess::3');
});

test('leaves a plain turn id untouched', () => {
    assert.equal(toEvidenceTurnId('q::sess::3'), 'q::sess::3');
    assert.equal(toEvidenceTurnId('q::sess#2::0'), 'q::sess#2::0');
});

test('only strips a real prop suffix — "prop" elsewhere in the id is not touched', () => {
    assert.equal(toEvidenceTurnId('q::prop_session::3'), 'q::prop_session::3');
    assert.equal(toEvidenceTurnId('q::sess::3::propfoo'), 'q::sess::3::propfoo');
    assert.equal(toEvidenceTurnId('q::sess::3::prop'), 'q::sess::3::prop');
});

test('agrees with the real id builders (buildPropositionNodeId → buildNodeId)', () => {
    // The whole fix rests on this coupling: if either builder's format ever
    // changes, this test fails instead of the metric silently going blind.
    for (const [sid, ti, pi] of [['answer_555dfb94', 0, 0], ['answer_b51b6115_1', 14, 7], ['dup#2', 3, 11]] as const) {
        assert.equal(toEvidenceTurnId(buildPropositionNodeId(Q, sid, ti, pi)), buildNodeId(Q, sid, ti));
    }
});

// ---------------------------------------------------------------------------
console.log('\n(a) turn-only corpora — identical to the pre-fix evaluator');

test('single evidence turn at rank 0', () => {
    const got = computeMetricsAtKs([turn('s1', 0), turn('s2', 4)], [turn('s1', 0)], [5]);
    assert.deepEqual(got[5], { recallAny: 1, recallAll: 1, ndcg: 1 });
    assert.deepEqual(got[5], legacyComputeMetricsAtKs([turn('s1', 0), turn('s2', 4)], [turn('s1', 0)], [5])[5]);
});

test('evidence turn outside the top-k scores zero at that k', () => {
    const ranked = [turn('s2', 1), turn('s2', 2), turn('s1', 0)];
    const got = computeMetricsAtKs(ranked, [turn('s1', 0)], [2, 5]);
    assert.deepEqual(got[2], { recallAny: 0, recallAll: 0, ndcg: 0 });
    assert.equal(got[5]!.recallAll, 1);
});

test('two evidence turns, only one retrieved → recall_any 1, recall_all 0', () => {
    const ranked = [turn('s1', 0), turn('s9', 9)];
    const evidence = [turn('s1', 0), turn('s1', 5)];
    const got = computeMetricsAtKs(ranked, evidence, [5])[5]!;
    assert.equal(got.recallAny, 1);
    assert.equal(got.recallAll, 0);
    assert.deepEqual(got, legacyComputeMetricsAtKs(ranked, evidence, [5])[5]);
});

test('nDCG positional decay is unchanged (evidence at rank 2 → 0.5)', () => {
    const ranked = [turn('s2', 1), turn('s2', 2), turn('s1', 0)];
    assert.equal(computeMetricsAtKs(ranked, [turn('s1', 0)], [5])[5]!.ndcg, 0.5);
});

test('empty correctDocs → recall_all 0 (the by-construction-undefined case), unchanged', () => {
    assert.deepEqual(evaluateRetrieval([0], new Set<string>(), [turn('s1', 0)], 5), { recallAny: 0, recallAll: 0, ndcg: 0 });
});

test('empty ranking → all zero, unchanged', () => {
    assert.deepEqual(computeMetricsAtKs([], [turn('s1', 0)], [5])[5], { recallAny: 0, recallAll: 0, ndcg: 0 });
});

test('fuzz: 400 random turn-only cases are float-identical to the pre-fix evaluator', () => {
    const rand = mulberry32(20260816);
    const pick = (n: number): number => Math.floor(rand() * n);
    let checked = 0;
    for (let case_ = 0; case_ < 400; case_++) {
        const corpusSize = 1 + pick(30);
        const ids: string[] = [];
        for (let i = 0; i < corpusSize; i++) ids.push(turn(`s${pick(8)}`, i));
        // Random evidence subset (>=1) and a random retrieved sub-ranking.
        const evidence = ids.filter(() => rand() < 0.25);
        if (evidence.length === 0) evidence.push(ids[pick(ids.length)]!);
        const shuffled = [...ids].sort(() => rand() - 0.5);
        const ranked = shuffled.slice(0, 1 + pick(shuffled.length));
        const ks = [1, 3, 5, 10, 20];
        assert.deepEqual(
            computeMetricsAtKs(ranked, evidence, ks),
            legacyComputeMetricsAtKs(ranked, evidence, ks),
            `case ${case_} diverged from the pre-fix evaluator`,
        );
        checked++;
    }
    assert.equal(checked, 400);
});

// ---------------------------------------------------------------------------
console.log('\n(b) a proposition-only match counts as its source turn');

test('proposition at rank 0, source turn NOT retrieved → recall_any/recall_all 1, ndcg 1', () => {
    const got = computeMetricsAtKs([prop('s1', 3, 0), turn('s7', 2)], [turn('s1', 3)], [5])[5]!;
    assert.deepEqual(got, { recallAny: 1, recallAll: 1, ndcg: 1 });
    // ...and this is exactly the bug: the pre-fix evaluator called it a miss.
    assert.deepEqual(legacyComputeMetricsAtKs([prop('s1', 3, 0), turn('s7', 2)], [turn('s1', 3)], [5])[5], {
        recallAny: 0, recallAll: 0, ndcg: 0,
    });
});

test('a proposition scores identically to its source turn at every rank', () => {
    const filler = [turn('s7', 1), turn('s7', 2)];
    for (const rank of [0, 1, 2]) {
        const withTurn = [...filler];
        withTurn.splice(rank, 0, turn('s1', 3));
        const withProp = [...filler];
        withProp.splice(rank, 0, prop('s1', 3, 0));
        assert.deepEqual(
            computeMetricsAtKs(withProp, [turn('s1', 3)], [1, 3, 5]),
            computeMetricsAtKs(withTurn, [turn('s1', 3)], [1, 3, 5]),
            `rank ${rank}`,
        );
    }
});

test('the ideal DCG is not inflated by the source turn also sitting in the corpus', () => {
    // The unretrieved evidence turn is always unioned into corpusIds. If it
    // counted as a second relevant doc alongside its own proposition, a
    // perfect rank-0 hit would score ~0.61 instead of 1.
    assert.equal(ndcgAtK([0], new Set([turn('s1', 3)]), [prop('s1', 3, 0), turn('s1', 3)], 5), 1);
});

test('a proposition of a NON-evidence turn stays irrelevant', () => {
    const got = computeMetricsAtKs([prop('s7', 2, 0)], [turn('s1', 3)], [5])[5]!;
    assert.deepEqual(got, { recallAny: 0, recallAll: 0, ndcg: 0 });
});

// ---------------------------------------------------------------------------
console.log('\n(c) duplicate propositions off one turn never double-count');

test('3 propositions off one evidence turn score exactly as one hit (ndcg stays 1, never >1)', () => {
    const ranked = [prop('s1', 3, 0), prop('s1', 3, 1), prop('s1', 3, 2)];
    const got = computeMetricsAtKs(ranked, [turn('s1', 3)], [5])[5]!;
    assert.deepEqual(got, { recallAny: 1, recallAll: 1, ndcg: 1 });
    assert.ok(got.ndcg <= 1, 'nDCG must never exceed 1');
});

test('a proposition duplicating an already-retrieved turn adds nothing', () => {
    const withDup = [turn('s1', 3), prop('s1', 3, 0), turn('s7', 1)];
    const withoutDup = [turn('s1', 3), turn('s9', 9), turn('s7', 1)];
    assert.deepEqual(
        computeMetricsAtKs(withDup, [turn('s1', 3)], [1, 3, 5]),
        computeMetricsAtKs(withoutDup, [turn('s1', 3)], [1, 3, 5]),
    );
});

test('duplicates still consume top-k slots (they cannot buy extra coverage)', () => {
    // 3 propositions off evidence turn A fill k=3; evidence turn B sits at
    // rank 3 and is genuinely outside the window — recall_all must stay 0.
    const ranked = [prop('s1', 3, 0), prop('s1', 3, 1), prop('s1', 3, 2), turn('s1', 8)];
    const evidence = [turn('s1', 3), turn('s1', 8)];
    const at3 = computeMetricsAtKs(ranked, evidence, [3])[3]!;
    assert.deepEqual(at3, { recallAny: 1, recallAll: 0, ndcg: 1 / (1 + 1 / Math.log2(3)) });
    const at4 = computeMetricsAtKs(ranked, evidence, [4])[4]!;
    assert.equal(at4.recallAll, 1);
});

// ---------------------------------------------------------------------------
console.log('\n(d) each evidence turn needs its OWN match');

test("one turn's propositions cannot satisfy another turn's evidence requirement", () => {
    const ranked = [prop('s1', 3, 0), prop('s1', 3, 1), prop('s1', 3, 2), prop('s1', 3, 3)];
    const got = computeMetricsAtKs(ranked, [turn('s1', 3), turn('s1', 8)], [10])[10]!;
    assert.equal(got.recallAny, 1);
    assert.equal(got.recallAll, 0, 'turn s1::8 was never retrieved, in any form');
});

test('recall_all only flips once every evidence turn is covered by its own turn or proposition', () => {
    const evidence = [turn('s1', 3), turn('s1', 8), turn('s4', 0)];
    assert.equal(computeMetricsAtKs([prop('s1', 3, 0), prop('s1', 8, 0)], evidence, [10])[10]!.recallAll, 0);
    assert.equal(computeMetricsAtKs([prop('s1', 3, 0), prop('s1', 8, 0), turn('s4', 0)], evidence, [10])[10]!.recallAll, 1);
    // Mixed forms across turns are fine — turn, proposition, proposition.
    assert.equal(computeMetricsAtKs([turn('s1', 3), prop('s1', 8, 2), prop('s4', 0, 1)], evidence, [10])[10]!.recallAll, 1);
});

test('a near-miss proposition off an ADJACENT turn does not count (turn-exact, as the paper intends)', () => {
    // README "Retrieval-failure spot check": recall_all is deliberately
    // strict about neighbouring turns. Propositions must not smuggle that in.
    const got = computeMetricsAtKs([prop('s1', 4, 0), prop('s1', 2, 0)], [turn('s1', 3)], [10])[10]!;
    assert.deepEqual(got, { recallAny: 0, recallAll: 0, ndcg: 0 });
});

// ---------------------------------------------------------------------------
console.log('\nmixed realistic ranking (runSubset.ts shape)');

test('turns and propositions interleaved, scored at 5/10/20', () => {
    const ranked = [
        turn('filler1', 2),
        prop('answer_555dfb94', 8, 0), // ← evidence, proposition form only
        turn('filler2', 0),
        prop('answer_555dfb94', 8, 1), // ← duplicate of the same evidence turn
        turn('filler3', 3),
        turn('answer_555dfb94', 14), // ← second evidence turn, raw
    ];
    const evidence = [turn('answer_555dfb94', 8), turn('answer_555dfb94', 14)];
    const got = computeMetricsAtKs(ranked, evidence, [5, 10, 20]);
    assert.equal(got[5]!.recallAny, 1);
    assert.equal(got[5]!.recallAll, 0, 'turn 14 is at rank 5, outside k=5');
    assert.equal(got[10]!.recallAll, 1);
    assert.equal(got[20]!.recallAll, 1);
    for (const k of [5, 10, 20]) assert.ok(got[k]!.ndcg <= 1 && got[k]!.ndcg > 0, `ndcg@${k} in (0,1]`);
});

test('meanMetrics is untouched', () => {
    assert.deepEqual(meanMetrics([]), { recallAny: 0, recallAll: 0, ndcg: 0 });
    assert.deepEqual(
        meanMetrics([{ recallAny: 1, recallAll: 1, ndcg: 1 }, { recallAny: 1, recallAll: 0, ndcg: 0.5 }]),
        { recallAny: 1, recallAll: 0.5, ndcg: 0.75 },
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
