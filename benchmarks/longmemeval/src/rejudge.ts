#!/usr/bin/env tsx
/**
 * rejudge.ts — scores an already-saved results file WITHOUT re-running
 * ingest/extraction/answering.
 *
 * Found necessary 2026-08-16: judging had been bundled inside runSubset.ts's
 * single pipeline pass, so every time the judge needed to change (blocked key
 * → working key, or "try an informal local read first") the ONLY way to add
 * a score was to re-run the whole pipeline — including free-but-slow local
 * answering that hadn't actually changed. Answers are already on disk; only
 * judging needs to run again. This script does exactly that, nothing else.
 *
 * Two judge modes, and they write to DIFFERENT fields on purpose:
 *   --judge official   → the real, comparable LongMemEval score. Calls the
 *                         SAME hard-pinned gpt-4o-2024-08-06 judge.ts uses,
 *                         writes into `result.judge` (and `majorityJudge` if
 *                         --majority-judge is passed) — the exact shape
 *                         runSubset.ts already produces, so report.ts's
 *                         accuracy math and every prior run's number stay
 *                         comparable.
 *   --judge ollama:<m>  → a free, local, INFORMAL read using the same
 *                         grading prompt (getAnscheckPrompt) but a different
 *                         model. Writes into `result.informalJudge` — a
 *                         separate field that can never collide with or be
 *                         mistaken for the official score, even if this is
 *                         run --in-place. NOT comparable to any published
 *                         LongMemEval number or to this harness's own
 *                         gpt-4o-mini/gpt-5-mini runs — self-grading bias and
 *                         a different judge model both apply. Useful only as
 *                         a same-session sanity check while a working
 *                         official key isn't available.
 *
 * Usage:
 *   tsx src/rejudge.ts --results-file results/subset-100-qwen-medium.json --judge official [--majority-judge]
 *   tsx src/rejudge.ts --results-file results/subset-100-qwen-medium.json --judge ollama:qwen3.8:27b
 *
 * --limit N processes at most N not-yet-judged entries (across ALL files
 * passed, in order) and stops — for staged, cost-gated runs: judge a small
 * batch, see the REAL cost (from the API's own usage field, not an
 * estimate), decide whether to continue. Re-running with the same args
 * naturally picks up where the last batch left off, since already-judged
 * entries (`result.judge` set) are skipped.
 *
 * Defaults to writing a NEW file (`<name>-rejudged.json`) rather than
 * overwriting the input — pass --in-place to update the given file directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { judgeAnswer, JudgeUnavailableError, getAnscheckPrompt, OFFICIAL_JUDGE_MODEL } from './judge.js';
import { judgeAnswerMajority } from './judgeMajority.js';
import { callOllamaChat, isOllamaModel, stripOllamaPrefix } from './ollamaClient.js';
import { callOpenCode, isOpenCodeModel, stripOpenCodePrefix, OPENCODE_LUNA_PRICE_PER_M } from './opencodeClient.js';
import { printReport, type BenchmarkReport } from './report.js';

// Live OpenRouter catalog price for openai/gpt-4o-2024-08-06, verified
// 2026-08-16 (see openrouter.ai/api/v1/models) — $2.50/M input, $10/M output.
// Used ONLY to turn real usage tokens into a real dollar figure to print;
// never used to gate whether a call happens.
const OFFICIAL_JUDGE_PRICE_PER_M = { input: 2.5, output: 10.0 };

interface Args {
    resultsFile: string;
    judge: string;
    majorityJudge: boolean;
    majorityVotes: number;
    outFile?: string;
    inPlace: boolean;
    limit?: number;
}

function parseArgs(argv: string[]): Args {
    const get = (flag: string, fallback?: string): string | undefined => {
        const idx = argv.indexOf(flag);
        return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
    };
    const resultsFile = get('--results-file');
    if (!resultsFile) throw new Error('--results-file is required');
    const judge = get('--judge', 'official')!;
    const majorityJudge = argv.includes('--majority-judge');
    const majorityVotes = Number(get('--majority-votes', '3'));
    const outFile = get('--out');
    const inPlace = argv.includes('--in-place');
    const limitRaw = get('--limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    return { resultsFile, judge, majorityJudge, majorityVotes, outFile, inPlace, limit };
}

/** Informal local-model judge (Ollama) — same grading question as the
 *  official judge (getAnscheckPrompt), different model, different output
 *  field. See file header for why this must never be confused with the
 *  official score. */
async function judgeAnswerInformal(
    model: string,
    questionId: string,
    questionType: Parameters<typeof getAnscheckPrompt>[0],
    question: string,
    expectedAnswer: string,
    modelResponse: string,
): Promise<{ model: string; label: boolean; rawResponse: string }> {
    const abstention = questionId.includes('_abs');
    const prompt = getAnscheckPrompt(questionType, question, expectedAnswer, modelResponse, abstention);
    const { content } = await callOllamaChat(model, prompt, false);
    const raw = content.trim();
    return { model, label: raw.toLowerCase().includes('yes'), rawResponse: raw };
}

/** Informal OpenCode Zen judge (e.g. gpt-5.6-luna) — same pattern as
 *  judgeAnswerInformal but a paid gateway, so it also returns real usage for
 *  cost tracking. reasoning.effort verified 2026-08-16 to make no observable
 *  difference through this proxy — passed through anyway in case that
 *  changes, but do not assume distinct levels produce distinct results. */
async function judgeAnswerOpenCode(
    model: string,
    questionId: string,
    questionType: Parameters<typeof getAnscheckPrompt>[0],
    question: string,
    expectedAnswer: string,
    modelResponse: string,
): Promise<{ model: string; label: boolean; rawResponse: string; promptTokens: number; completionTokens: number }> {
    const abstention = questionId.includes('_abs');
    const prompt = getAnscheckPrompt(questionType, question, expectedAnswer, modelResponse, abstention);
    const { content, promptTokens, completionTokens } = await callOpenCode(model, prompt);
    const raw = content.trim();
    return { model, label: raw.toLowerCase().includes('yes'), rawResponse: raw, promptTokens, completionTokens };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(args.resultsFile)) {
        throw new Error(`Results file not found: ${args.resultsFile}`);
    }
    const report = JSON.parse(fs.readFileSync(args.resultsFile, 'utf-8')) as BenchmarkReport;

    const useOfficial = args.judge === 'official';
    const useOpenCode = !useOfficial && isOpenCodeModel(args.judge);
    const useOllama = !useOfficial && !useOpenCode && isOllamaModel(args.judge);
    if (!useOfficial && !useOpenCode && !useOllama) {
        throw new Error(`--judge must be "official", "ollama:<model>", or "opencode:<model>", got: ${args.judge}`);
    }
    const ollamaModel = useOllama ? stripOllamaPrefix(args.judge) : null;
    const openCodeModel = useOpenCode ? stripOpenCodePrefix(args.judge) : null;
    const informalModelLabel = ollamaModel ?? openCodeModel;

    console.log(
        useOfficial
            ? `Judging with the OFFICIAL judge (${OFFICIAL_JUDGE_MODEL}) — real, comparable score.`
            : `Judging with an INFORMAL judge (${informalModelLabel}) — NOT comparable to any published or prior official score. Written to informalJudge only.` +
                (useOpenCode ? ' Real (small) API cost applies — see per-batch usage below.' : ' Free/local.'),
    );

    let judged = 0;
    let skipped = 0;
    let alreadyDone = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let openCodePromptTokens = 0;
    let openCodeCompletionTokens = 0;
    for (const result of report.perInstance) {
        if (!result.answer) continue; // nothing to judge (see result.answerError)
        // Already scored by this same judge mode on a prior --limit batch (or
        // an earlier full run) — skip so re-running the same command resumes
        // instead of re-spending on entries already done.
        if (useOfficial ? result.judge : result.informalJudge) {
            alreadyDone++;
            continue;
        }
        if (args.limit != null && judged >= args.limit) break;
        try {
            if (useOfficial) {
                const verdict = await judgeAnswer(
                    result.questionId,
                    result.questionType,
                    result.question,
                    String(result.expectedAnswer),
                    result.answer.text,
                );
                result.judge = verdict;
                result.judgeError = null;
                if (verdict.usage) {
                    promptTokens += verdict.usage.promptTokens;
                    completionTokens += verdict.usage.completionTokens;
                }
                if (args.majorityJudge) {
                    const majority = await judgeAnswerMajority(
                        result.questionId,
                        result.questionType,
                        result.question,
                        String(result.expectedAnswer),
                        result.answer.text,
                        { votes: args.majorityVotes },
                    );
                    result.majorityJudge = {
                        majorityLabel: majority.majorityLabel,
                        agreement: majority.agreement,
                        votes: majority.votes.map((v) => v.label),
                    };
                }
            } else if (useOpenCode) {
                const verdict = await judgeAnswerOpenCode(
                    openCodeModel!,
                    result.questionId,
                    result.questionType,
                    result.question,
                    String(result.expectedAnswer),
                    result.answer.text,
                );
                result.informalJudge = { model: verdict.model, label: verdict.label, rawResponse: verdict.rawResponse };
                openCodePromptTokens += verdict.promptTokens;
                openCodeCompletionTokens += verdict.completionTokens;
            } else {
                const verdict = await judgeAnswerInformal(
                    ollamaModel!,
                    result.questionId,
                    result.questionType,
                    result.question,
                    String(result.expectedAnswer),
                    result.answer.text,
                );
                result.informalJudge = verdict;
            }
            judged++;
        } catch (err) {
            skipped++;
            const message = (err as Error).message ?? String(err);
            if (useOfficial) {
                result.judgeError = err instanceof JudgeUnavailableError ? message : `UNEXPECTED: ${message}`;
            }
            console.error(`  SKIPPED ${result.questionId}: ${message}`);
            if (err instanceof JudgeUnavailableError) {
                // No key at all — every remaining call will fail identically;
                // stop burning time re-attempting all of them.
                console.error('No judge key configured — aborting the rest of this pass.');
                break;
            }
        }
    }

    console.log(`\nDone this batch: ${judged} judged, ${skipped} skipped, ${alreadyDone} already scored (untouched).`);
    if (useOfficial && (promptTokens > 0 || completionTokens > 0)) {
        const realCost =
            (promptTokens / 1_000_000) * OFFICIAL_JUDGE_PRICE_PER_M.input +
            (completionTokens / 1_000_000) * OFFICIAL_JUDGE_PRICE_PER_M.output;
        console.log(
            `Real usage this batch: ${promptTokens} prompt + ${completionTokens} completion tokens ` +
                `= $${realCost.toFixed(4)} (at $${OFFICIAL_JUDGE_PRICE_PER_M.input}/M in, $${OFFICIAL_JUDGE_PRICE_PER_M.output}/M out).`,
        );
    }
    if (useOpenCode && (openCodePromptTokens > 0 || openCodeCompletionTokens > 0)) {
        const realCost =
            (openCodePromptTokens / 1_000_000) * OPENCODE_LUNA_PRICE_PER_M.input +
            (openCodeCompletionTokens / 1_000_000) * OPENCODE_LUNA_PRICE_PER_M.output;
        console.log(
            `Real usage this batch: ${openCodePromptTokens} prompt + ${openCodeCompletionTokens} completion tokens ` +
                `= $${realCost.toFixed(6)} (at $${OPENCODE_LUNA_PRICE_PER_M.input}/M in, $${OPENCODE_LUNA_PRICE_PER_M.output}/M out).`,
        );
    }
    const remaining = report.perInstance.filter(
        (r) => r.answer && !(useOfficial ? r.judge : r.informalJudge),
    ).length;
    if (remaining > 0) {
        console.log(`${remaining} entries in this file still unjudged. Re-run the same command to continue.`);
    }

    const outPath = args.inPlace ? args.resultsFile : args.outFile ?? deriveOutPath(args.resultsFile);
    report.generatedAt = new Date().toISOString();
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Wrote: ${outPath}`);

    if (useOfficial) {
        // Same shape runSubset.ts already produces — printReport's official
        // judge section is meaningful here.
        printReport(report);
    } else {
        // Deliberately NOT routed through printReport: that function is also
        // what real, comparable official runs use, and this number must never
        // sit next to it looking like the same kind of result. See file header.
        const withInformal = report.perInstance.filter((r) => r.informalJudge);
        const correct = withInformal.filter((r) => r.informalJudge!.label).length;
        console.log('\n=== INFORMAL judge read — NOT a comparable LongMemEval score ===');
        console.log(`  model: ${informalModelLabel}`);
        console.log(`  ${correct}/${withInformal.length} (${((correct / Math.max(1, withInformal.length)) * 100).toFixed(1)}%)`);
        console.log('  For a real number, run --judge official once a working key is available.');
    }
}

function deriveOutPath(resultsFile: string): string {
    const ext = path.extname(resultsFile);
    const base = resultsFile.slice(0, -ext.length);
    return `${base}-rejudged${ext}`;
}

main().catch((err) => {
    console.error('rejudge FAILED:', err);
    process.exitCode = 1;
});
