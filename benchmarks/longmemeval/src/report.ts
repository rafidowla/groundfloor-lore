/**
 * report.ts — aggregation + console/JSON reporting for a benchmark run.
 *
 * REPORTING CONVENTION (set 2026-09-20, after the counting-question
 * investigation): this benchmark measures two genuinely different things
 * under one run, and they must never be read as interchangeable.
 *
 *   - Retrieval metrics (recall_any/recall_all/ndcg) are Lore's OWN signal —
 *     did the product surface the right facts at all. This is the number
 *     that reflects Lore's actual quality, and it is unaffected by anything
 *     downstream of retrieval.
 *   - Judged answer accuracy depends on an answer-writing layer (answerModel.ts,
 *     countableEvents.ts, extractFacts.ts, detectCounting.ts) that exists ONLY
 *     in this benchmark harness — verified 2026-09-20 to have zero references
 *     anywhere in packages/lore/src. Lore itself has no question-answering
 *     feature (chat/UI was deliberately removed from Core; see project memory
 *     `feedback_lore_core_only_no_ui`). A low judged-accuracy number can
 *     therefore mean the harness's disposable answer-writer made a mistake
 *     (a bad prompt, a missed arithmetic step) with Lore's own retrieval
 *     having been perfect — this happened repeatedly in the 2026-09-20
 *     counting-question runs, where recall hit 100% at @20 on questions the
 *     judge still marked wrong.
 *
 * printReport() below labels both sections accordingly. Treat the retrieval
 * section as the primary "is Lore good" measure; treat judged accuracy as a
 * secondary, harness-dependent number — useful for realistic end-to-end
 * testing, but never evidence of a Lore regression by itself. Any report
 * generated from this data (dashboards, summaries, docs) should preserve
 * that framing rather than leading with the headline accuracy percentage.
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
     *  ordering question (see detectCounting.ts)? Recorded regardless of
     *  --structured-facts mode, so an `all`/`off` run can still be compared
     *  against what the heuristic alone would have decided. */
    countingDetected: boolean;
    /** Whether THIS run actually attempted the countable_events lookup for
     *  this instance — depends on --structured-facts (runSubset.ts):
     *  `off` → always false, `all` → always true, `auto` → equals
     *  countingDetected. Compare against countingDetected to isolate the
     *  effect of forcing structured facts on for a type that wouldn't
     *  otherwise get them. */
    structuredFactsAttempted: boolean;
    /** Number of structured facts read from countable_events for this
     *  question (0 when not attempted, or attempted but no extraction pass ran). */
    structuredFactCount: number;
    /** detectQuestionType.ts's keyword-cascade guess at this question's
     *  category, from the question text alone (no ground truth, no LLM call).
     *  INSTRUMENTATION ONLY — recorded on every run regardless of
     *  --preference-facts/--decompose-multi-session mode, purely so a report
     *  can compare this guess against the dataset's own `questionType`
     *  (mirrors how `countingDetected` is recorded independent of
     *  --structured-facts mode). Never used to change answering behavior by
     *  itself; see runSubset.ts for the two places it now DOES gate a
     *  behavior (preference-facts `auto`, decompose-multi-session routing). */
    detectedQuestionType: LongMemEvalQuestionType;
    /** Whether THIS run actually attempted the preference_events lookup for
     *  this instance — depends on --preference-facts (runSubset.ts): `off` →
     *  always false, `all` → always true, `auto` → true when EITHER the
     *  ground-truth questionType OR detectedQuestionType is
     *  'single-session-preference' (see runSubset.ts header for why OR). */
    preferenceFactsAttempted: boolean;
    /** Number of preference facts read from preference_events for this
     *  question (0 when not attempted, or attempted but no extraction pass ran). */
    preferenceFactCount: number;
    /** Whether this instance went through queryDecompose.ts's decomposition
     *  path — true only when --decompose-multi-session is `on` AND the base
     *  recall's own results looked scattered across sessions (see
     *  retrievalStrategies.ts header "Evidence-based decomposition trigger",
     *  2026-09-21 — this replaced an earlier ground-truth-OR-detector-guess
     *  gate that measured only 42.9% accuracy on multi-session questions). */
    decomposeAttempted: boolean;
    /** Sub-queries actually used for retrieval: 0 when decomposition wasn't
     *  attempted, 2-5 on a successful decomposition, 1 on a fallback to the
     *  base recall (decomposeQuery() was unavailable or malformed). */
    decomposeSubQueryCount: number;
    /** Distinct sessions among the top-ranked base-recall candidates — the
     *  evidence signal that decides decomposeAttempted (see
     *  retrievalStrategies.ts). 0 whenever --decompose-multi-session was off
     *  (the signal is never computed). */
    sessionSpreadCount: number;
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
    /** Which graph/vector engines the benchmark workspace ran on — see
     *  loreClient.ts's 2026-09-20 note. Absent on any results file from
     *  before that date, which all ran surreal/lance. */
    engines?: { graph: 'surreal' | 'sqlite'; vector: 'lance' | 'sqlite' };
    /** --structured-facts mode this run used (runSubset.ts). Absent on any
     *  results file from before 2026-09-20, which all behaved as `auto`. */
    structuredFactsMode?: 'auto' | 'all' | 'off';
    /** --preference-facts mode this run used (runSubset.ts). Absent on any
     *  results file from before this field was added, which all behaved as `auto`. */
    preferenceFactsMode?: 'auto' | 'all' | 'off';
    /** --recency-tagging this run used (runSubset.ts). Absent on any results
     *  file from before this field was added, which all behaved as `on`
     *  (the default) since the flag didn't exist yet to turn it off. */
    recencyTagging?: 'on' | 'off';
    /** --decompose-multi-session this run used (runSubset.ts). Absent on any
     *  results file from before this field was added, which all behaved as
     *  `off` (the default). */
    decomposeMultiSession?: 'on' | 'off';
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
    if (report.structuredFactsMode) {
        console.log(`structured-facts mode: ${report.structuredFactsMode}`);
    }
    if (report.preferenceFactsMode) {
        console.log(`preference-facts mode: ${report.preferenceFactsMode}`);
    }
    if (report.recencyTagging) {
        console.log(`recency-tagging:       ${report.recencyTagging}`);
    }
    if (report.decomposeMultiSession) {
        console.log(`decompose-multi-session: ${report.decomposeMultiSession}`);
    }

    const totalTurns = perInstance.reduce((s, r) => s + r.totalTurns, 0);
    const totalIngestMs = perInstance.reduce((s, r) => s + r.ingestMs, 0);
    console.log(`\ningested:     ${totalTurns} turns across ${perInstance.length} questions in ${(totalIngestMs / 1000).toFixed(1)}s`);
    console.log(`avg ingest:   ${(totalIngestMs / perInstance.length / 1000).toFixed(2)}s/question, ${(totalIngestMs / totalTurns).toFixed(1)}ms/turn`);

    console.log('\n--- PRIMARY: Lore retrieval quality (no LLM judge required) ---');
    console.log('This is Lore\'s own signal — unaffected by the answer-writing harness below.');
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

    // Instrumentation, not a Lore signal: detectQuestionType.ts's guess is a
    // harness-only heuristic over question TEXT (see that file's header for
    // measured per-category accuracy) — this line is purely diagnostic, never
    // evidence of a Lore regression, same framing as the judge section below.
    const withDetectedType = perInstance.filter((r) => r.detectedQuestionType);
    if (withDetectedType.length > 0) {
        const guessedRight = withDetectedType.filter((r) => r.detectedQuestionType === r.questionType).length;
        console.log('\n--- Instrumentation: question-type detector (detectQuestionType.ts, harness-only) ---');
        console.log(
            `  guess vs. ground-truth question_type: ${fmtPct(guessedRight / withDetectedType.length)} ` +
                `(${guessedRight}/${withDetectedType.length})`,
        );
    }

    const answered = perInstance.filter((r) => r.answer);
    const answerSkipped = perInstance.filter((r) => r.answerError);
    console.log(`\n--- Answering (assistant under test) ---`);
    console.log(`  answered: ${answered.length}/${perInstance.length}, skipped: ${answerSkipped.length}/${perInstance.length}`);
    if (answerSkipped.length > 0) {
        console.log(`  skip reason (first): ${answerSkipped[0]!.answerError}`);
    }

    const preferenceAttempted = perInstance.filter((r) => r.preferenceFactsAttempted);
    if (preferenceAttempted.length > 0) {
        const withFacts = preferenceAttempted.filter((r) => r.preferenceFactCount > 0).length;
        console.log(
            `  preference-facts attempted: ${preferenceAttempted.length}/${perInstance.length} ` +
                `(${withFacts} had at least one fact in preference_events)`,
        );
    }

    const spreadChecked = perInstance.filter((r) => r.sessionSpreadCount > 0 || r.decomposeAttempted);
    const decomposed = perInstance.filter((r) => r.decomposeAttempted);
    if (spreadChecked.length > 0) {
        const avgSpread = spreadChecked.reduce((s, r) => s + r.sessionSpreadCount, 0) / spreadChecked.length;
        console.log(
            `  session-spread signal checked: ${spreadChecked.length}/${perInstance.length}, ` +
                `avg distinct sessions in top candidates: ${avgSpread.toFixed(1)}`,
        );
    }
    if (decomposed.length > 0) {
        const avgSubQueries = decomposed.reduce((s, r) => s + r.decomposeSubQueryCount, 0) / decomposed.length;
        const fellBack = decomposed.filter((r) => r.decomposeSubQueryCount === 1).length;
        console.log(
            `  multi-session decomposition attempted (spread signal fired): ${decomposed.length}/${perInstance.length}, ` +
                `avg sub-queries: ${avgSubQueries.toFixed(1)} (${fellBack} fell back to the base recall)`,
        );
    }

    const judged = perInstance.filter((r) => r.judge);
    const judgeSkipped = perInstance.filter((r) => r.judgeError);
    console.log(`\n--- SECONDARY: Judge (official gpt-4o-2024-08-06 grading) ---`);
    console.log(`  NOTE: scores (Lore retrieval + this harness's disposable answer-writer)`);
    console.log(`  combined. Not a Lore quality measure by itself — a wrong answer here can`);
    console.log(`  be a harness mistake (bad prompt, missed arithmetic) with retrieval above`);
    console.log(`  having been perfect. See this file's header comment (2026-09-20).`);
    console.log(`  judged: ${judged.length}/${perInstance.length}, skipped: ${judgeSkipped.length}/${perInstance.length}`);
    if (judgeSkipped.length > 0) {
        console.log(`  BLOCKED: ${judgeSkipped[0]!.judgeError}`);
    }
    if (judged.length > 0) {
        const correct = judged.filter((r) => r.judge!.label).length;
        console.log(`  accuracy (judged subset only): ${fmtPct(correct / judged.length)} (${correct}/${judged.length})`);

        // By category + structured-facts-attempted, so an `all`-mode run
        // (or an `off` vs `all` pair on the same --question-ids) shows
        // whether forcing the countable_events lookup on for a type that
        // wouldn't otherwise get it moved judged accuracy, not just the
        // pooled headline number above.
        console.log('  by category:');
        const byCat = new Map<string, PerInstanceResult[]>();
        for (const r of judged) {
            const arr = byCat.get(r.questionType) ?? [];
            arr.push(r);
            byCat.set(r.questionType, arr);
        }
        for (const [cat, rows] of byCat) {
            const catCorrect = rows.filter((r) => r.judge!.label).length;
            const withFacts = rows.filter((r) => r.structuredFactsAttempted).length;
            const withPreferenceFacts = rows.filter((r) => r.preferenceFactsAttempted).length;
            const withDecompose = rows.filter((r) => r.decomposeAttempted).length;
            const extras = [
                `structured-facts attempted on ${withFacts}`,
                withPreferenceFacts > 0 ? `preference-facts attempted on ${withPreferenceFacts}` : null,
                withDecompose > 0 ? `decompose attempted on ${withDecompose}` : null,
            ].filter(Boolean);
            console.log(
                `    ${cat} (n=${rows.length}, ${extras.join(', ')}): ` +
                    `${fmtPct(catCorrect / rows.length)} (${catCorrect}/${rows.length})`,
            );
        }
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
