/**
 * report.ts — aggregation + console/JSON reporting for a benchmark run.
 */

import type { LongMemEvalQuestionType } from './types.js';
import { meanMetrics, type RetrievalMetrics } from './retrievalMetrics.js';

export interface PerInstanceResult {
    questionId: string;
    questionType: LongMemEvalQuestionType;
    isAbstention: boolean;
    question: string;
    expectedAnswer: string;
    totalTurns: number;
    totalSessions: number;
    evidenceTurnCount: number;
    ingestMs: number;
    retrieveMs: number;
    rawRetrievedCount: number; // candidates Lore returned (the ecosystem-scoped window; see runSubset.ts RAW_RECALL_FETCH)
    contaminatedCount: number; // DIAGNOSTIC only: cross-question ids detected in that window (post-fix expectation: 0). NOT filtered out since 2026-08-19 — a nonzero value means the Core scoping bug regressed.
    retrievedNodeIds: string[]; // rank order, best first, exactly as Lore returned them
    retrievalMetricsByK: Record<number, RetrievalMetrics>;
    answer?: { provider: string; model: string; text: string } | null;
    answerError?: string | null;
    judge?: { model: string; label: boolean; rawResponse: string } | null;
    judgeError?: string | null;
    /** Bucket B — was this question detected as a counting/aggregation/
     *  ordering question (see detectCounting.ts)? */
    countingDetected: boolean;
    /** Number of structured facts read from countable_events for this
     *  question (0 when undetected, or detected but no extraction pass ran). */
    structuredFactCount: number;
    /** Opt-in second, self-audited score (--majority-judge) — supplements
     *  `judge`, never replaces it. See judgeMajority.ts. */
    majorityJudge?: { majorityLabel: boolean; agreement: number; votes: boolean[] } | null;
    /** A local/non-official model's read on the SAME grading question
     *  (rejudge.ts --judge ollama:<model>) — NOT a comparable LongMemEval
     *  score. Kept in a field of its own precisely so it can never be
     *  confused with or overwrite `judge`. */
    informalJudge?: { model: string; label: boolean; rawResponse: string } | null;
}

export interface BenchmarkReport {
    generatedAt: string;
    datasetFile: string;
    subsetSize: number;
    ks: number[];
    perInstance: PerInstanceResult[];
}

export function summarizeByCategory(
    perInstance: PerInstanceResult[],
    ks: number[],
): Record<string, Record<number, RetrievalMetrics>> {
    const byCategory = new Map<string, PerInstanceResult[]>();
    for (const r of perInstance) {
        const arr = byCategory.get(r.questionType) ?? [];
        arr.push(r);
        byCategory.set(r.questionType, arr);
    }
    const out: Record<string, Record<number, RetrievalMetrics>> = {};
    for (const [cat, rows] of byCategory) {
        out[cat] = {};
        for (const k of ks) {
            out[cat]![k] = meanMetrics(rows.map((r) => r.retrievalMetricsByK[k]!));
        }
    }
    return out;
}

function fmtPct(x: number): string {
    return `${(x * 100).toFixed(1)}%`;
}

export function printReport(report: BenchmarkReport): void {
    const { perInstance, ks } = report;
    console.log('\n' + '='.repeat(78));
    console.log('LongMemEval x Lore — subset report');
    console.log('='.repeat(78));
    console.log(`generated:    ${report.generatedAt}`);
    console.log(`dataset:      ${report.datasetFile}`);
    console.log(`subset size:  ${report.subsetSize}`);
    console.log(`k values:     ${ks.join(', ')}`);

    const totalTurns = perInstance.reduce((s, r) => s + r.totalTurns, 0);
    const totalIngestMs = perInstance.reduce((s, r) => s + r.ingestMs, 0);
    console.log(`\ningested:     ${totalTurns} turns across ${perInstance.length} questions in ${(totalIngestMs / 1000).toFixed(1)}s`);
    console.log(`avg ingest:   ${(totalIngestMs / perInstance.length / 1000).toFixed(2)}s/question, ${(totalIngestMs / totalTurns).toFixed(1)}ms/turn`);

    console.log('\n--- Objective retrieval metrics (no LLM judge required) ---');
    console.log('Overall (mean across subset):');
    for (const k of ks) {
        const m = meanMetrics(perInstance.map((r) => r.retrievalMetricsByK[k]!));
        console.log(
            `  @${k}: recall_any=${fmtPct(m.recallAny)}  recall_all=${fmtPct(m.recallAll)}  ndcg=${m.ndcg.toFixed(3)}`,
        );
    }

    console.log('\nBy category:');
    const byCat = summarizeByCategory(perInstance, ks);
    for (const [cat, byK] of Object.entries(byCat)) {
        const n = perInstance.filter((r) => r.questionType === cat).length;
        console.log(`  ${cat} (n=${n}):`);
        for (const k of ks) {
            const m = byK[k]!;
            console.log(
                `    @${k}: recall_any=${fmtPct(m.recallAny)}  recall_all=${fmtPct(m.recallAll)}  ndcg=${m.ndcg.toFixed(3)}`,
            );
        }
    }

    const answered = perInstance.filter((r) => r.answer);
    const answerSkipped = perInstance.filter((r) => r.answerError);
    console.log(`\n--- Answering (assistant under test) ---`);
    console.log(`  answered: ${answered.length}/${perInstance.length}, skipped: ${answerSkipped.length}/${perInstance.length}`);
    if (answerSkipped.length > 0) {
        console.log(`  skip reason (first): ${answerSkipped[0]!.answerError}`);
    }

    const judged = perInstance.filter((r) => r.judge);
    const judgeSkipped = perInstance.filter((r) => r.judgeError);
    console.log(`\n--- Judge (official gpt-4o-2024-08-06 grading) ---`);
    console.log(`  judged: ${judged.length}/${perInstance.length}, skipped: ${judgeSkipped.length}/${perInstance.length}`);
    if (judgeSkipped.length > 0) {
        console.log(`  BLOCKED: ${judgeSkipped[0]!.judgeError}`);
    }
    if (judged.length > 0) {
        const correct = judged.filter((r) => r.judge!.label).length;
        console.log(`  accuracy (judged subset only): ${fmtPct(correct / judged.length)} (${correct}/${judged.length})`);
    }

    // Second, self-audited score (--majority-judge) — supplements the
    // official number above, never replaces it (see judgeMajority.ts).
    const withMajority = judged.filter((r) => r.majorityJudge);
    if (withMajority.length > 0) {
        const majorityCorrect = withMajority.filter((r) => r.majorityJudge!.majorityLabel).length;
        const disagreements = withMajority.filter((r) => r.majorityJudge!.majorityLabel !== r.judge!.label);
        console.log(`\n--- Majority-vote judge (self-audited second score, NOT the official comparable number) ---`);
        console.log(`  accuracy (majority vote): ${fmtPct(majorityCorrect / withMajority.length)} (${majorityCorrect}/${withMajority.length})`);
        console.log(`  disagrees with official single-call verdict: ${disagreements.length}/${withMajority.length}`);
        for (const r of disagreements) {
            console.log(`    [${r.questionId}] official=${r.judge!.label} majority=${r.majorityJudge!.majorityLabel} (agreement=${fmtPct(r.majorityJudge!.agreement)})`);
        }
    }
    console.log('='.repeat(78) + '\n');
}
