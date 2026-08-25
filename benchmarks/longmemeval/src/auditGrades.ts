#!/usr/bin/env tsx
/**
 * auditGrades.ts — apply flagBorderlineGrade() to an EXISTING results JSON
 * and print the candidates worth a manual/agent double-check, plus the
 * official vs. human-corrected accuracy (before any human has reviewed
 * anything, humanCorrectedAccuracy === officialAccuracy — overrides start
 * empty; this is a starting point for review, not a verdict).
 *
 * Reads already-saved results — zero API calls, zero new ingest/retrieve
 * runs. Safe to run any time against any subset-*.json this harness wrote.
 *
 * Usage:
 *   tsx benchmarks/longmemeval/src/auditGrades.ts [path/to/results.json]
 *   (defaults to results/subset-n100.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagBorderlineGrade, computeHumanCorrectedAccuracy } from './gradeAudit.js';
import type { BenchmarkReport } from './report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(HERE, '..');

function main(): void {
    const resultsFile = process.argv[2]
        ? path.resolve(process.argv[2])
        : path.join(BENCH_ROOT, 'results', 'subset-n100.json');

    if (!fs.existsSync(resultsFile)) {
        console.error(`No results file at ${resultsFile}`);
        process.exit(1);
    }
    const report = JSON.parse(fs.readFileSync(resultsFile, 'utf8')) as BenchmarkReport;

    const graded = report.perInstance.filter((r) => r.judge != null);
    const flags = graded
        .map((r) => flagBorderlineGrade({
            questionId: r.questionId,
            isAbstention: r.isAbstention,
            answerText: r.answer?.text ?? null,
            judgeLabel: r.judge!.label,
            judgeRawResponse: r.judge!.rawResponse,
        }))
        .filter((f): f is NonNullable<typeof f> => f !== null);

    console.log(`Grade audit — ${resultsFile}`);
    console.log(`${graded.length} graded questions, ${flags.length} flagged for review:\n`);

    for (const flag of flags) {
        const inst = graded.find((r) => r.questionId === flag.questionId)!;
        console.log(`[${flag.questionId}] label=${inst.judge!.label} (${inst.questionType})`);
        console.log(`  question: ${inst.question}`);
        console.log(`  expected: ${inst.expectedAnswer}`);
        console.log(`  answer:   ${inst.answer?.text ?? '(no answer)'}`);
        for (const reason of flag.reasons) console.log(`  ⚠ ${reason}`);
        console.log();
    }

    const summary = computeHumanCorrectedAccuracy(
        graded.map((r) => ({ questionId: r.questionId, judgeLabel: r.judge!.label })),
        new Set(flags.map((f) => f.questionId)),
        new Map(), // no human overrides applied yet — this is the starting point for review
    );
    console.log('Summary (no overrides applied yet — flags are candidates for review, not confirmed misgrades):');
    console.log(`  official accuracy:        ${(summary.officialAccuracy * 100).toFixed(1)}% (${summary.total} graded)`);
    console.log(`  flagged for review:       ${summary.flaggedCount}`);
    console.log(`  human-corrected accuracy: ${(summary.humanCorrectedAccuracy * 100).toFixed(1)}% (0 overrides applied so far — same as official until reviewed)`);
}

main();
