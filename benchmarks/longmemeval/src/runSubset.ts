#!/usr/bin/env tsx
/**
 * runSubset.ts — the cost-controlled smoke-test entry point.
 *
 * Runs the full pipeline (ingest → retrieve → answer → judge) against a
 * small, stratified subset of LongMemEval questions and prints/saves a
 * report. This is the ONLY script this benchmark ships that actually
 * executes against Lore — there is deliberately no "run all 500" script
 * yet (see ../README.md "Full run — deliberately not automated").
 *
 * Usage:
 *   tsx benchmarks/longmemeval/src/runSubset.ts [--n 25] [--ks 5,10,20]
 *       [--dataset benchmarks/longmemeval/data/longmemeval_s_cleaned.json]
 *       [--data-dir benchmarks/longmemeval/lore-home]
 *       [--context-k 10] [--answer-model gpt-4o-mini]
 *       [--majority-judge] [--majority-votes 3]
 *
 * --answer-model accepts `ollama:<model>` (e.g. `ollama:qwen3.8:27b`) to
 * answer against a local Ollama daemon instead of OpenAI/OpenRouter — no API
 * key needed, calls http://localhost:11434 directly (see ollamaClient.ts).
 * --think controls its reasoning: `false` (off), `true`, or `low`/`medium`/
 * `high` (graduated — verified live against qwen3.8:27b 2026-08-15). Ignored
 * for non-Ollama models.
 *
 * --majority-judge runs the OFFICIAL judge N times (--majority-votes,
 * default 3, must be odd) per verdict and records a second, self-audited
 * majority-vote score alongside the official single-call one (see
 * judgeMajority.ts) — costs N-1x extra judge calls, off by default.
 *
 * Must be run under Node 22 (native Kùzu/LanceDB bindings) — see
 * ../README.md "Running this" for the exact command.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenchmarkLore, WORKSPACE } from './loreClient.js';
import { loadDataset, selectStratifiedSubset, ingestInstance } from './ingest.js';
import { computeMetricsAtKs } from './retrievalMetrics.js';
import { generateAnswer, AnswerModelUnavailableError } from './answerModel.js';
import { judgeAnswer, JudgeUnavailableError } from './judge.js';
import { judgeAnswerMajority } from './judgeMajority.js';
import { printReport, type BenchmarkReport, type PerInstanceResult } from './report.js';
import { isCountingQuestion } from './detectCounting.js';
import { queryCountableFacts, formatStructuredFacts } from './countableEvents.js';
import type { LongMemEvalInstance } from './types.js';
import type { OllamaThinkMode } from './ollamaClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(HERE, '..');

interface Args {
    n: number;
    ks: number[];
    dataset: string;
    dataDir: string;
    contextK: number;
    resultsFile: string;
    answerModel: string;
    /** Reasoning control for local Ollama answer models only (`--answer-model
     *  ollama:<model>`) — ignored for OpenAI/OpenRouter/Anthropic, which have
     *  their own reasoning controls (see openaiGateway.ts). undefined leaves
     *  the model's own default (Ollama's is thinking ON). 'auto' is resolved
     *  per-question below, not a literal OllamaThinkMode value — see
     *  effectiveThink. */
    think?: OllamaThinkMode | 'auto';
    /** Opt-in second, self-audited score (see judgeMajority.ts) — never
     *  replaces the official single-call number, only supplements it. */
    majorityJudge: boolean;
    majorityVotes: number;
    /** Explicit question_id list — when set, bypasses selectStratifiedSubset
     *  entirely and runs exactly these questions, in this order. For
     *  deliberately-varied before/after comparisons (e.g. a mix of
     *  previously-failing + previously-passing questions) that a
     *  count/category selection can't guarantee. --n is ignored when set. */
    questionIds?: string[];
}

function parseArgs(argv: string[]): Args {
    const get = (flag: string, fallback: string): string => {
        const idx = argv.indexOf(flag);
        return idx >= 0 && argv[idx + 1] ? argv[idx + 1]! : fallback;
    };
    const n = Number(get('--n', '25'));
    const ks = get('--ks', '5,10,20').split(',').map(Number);
    const dataset = get('--dataset', path.join(BENCH_ROOT, 'data', 'longmemeval_s_cleaned.json'));
    const dataDir = get('--data-dir', path.join(BENCH_ROOT, 'lore-home'));
    const contextK = Number(get('--context-k', '10'));
    const answerModel = get('--answer-model', 'gpt-4o-mini');
    const thinkRaw = get('--think', '');
    const think: OllamaThinkMode | 'auto' | undefined =
        thinkRaw === '' ? undefined
        : thinkRaw === 'true' ? true
        : thinkRaw === 'false' ? false
        : thinkRaw === 'auto' ? 'auto'
        : (thinkRaw as OllamaThinkMode);
    const majorityJudge = argv.includes('--majority-judge');
    const majorityVotes = Number(get('--majority-votes', '3'));
    const questionIdsRaw = get('--question-ids', '');
    const questionIds = questionIdsRaw ? questionIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const resultsFile = get(
        '--results-file',
        path.join(BENCH_ROOT, 'results', `subset-n${n}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    );
    return { n, ks, dataset, dataDir, contextK, resultsFile, answerModel, think, majorityJudge, majorityVotes, questionIds };
}

function formatContext(nodes: Array<{ content: string; label: string }>): string {
    return nodes.map((n, i) => `[${i + 1}] ${n.label}\n${n.content}`).join('\n\n');
}

/**
 * Raw candidate pool fetched from lore.recall(). Today this is exactly what
 * the name says: the candidate-pool DEPTH the metrics + answering context
 * are computed over (max(ks) ranked candidates need a window at least that
 * deep; --context-k slices the top of the same ranking). It is NOT a
 * workaround any more — but it was born as one, and the history matters for
 * reading old results files: see ../README.md "Confirmed retrieval-scoping
 * bug". Pre-2026-08-13, retrieve()'s semantic/BM25 seed pass never applied
 * the `ecosystem` filter to the underlying query, only to the hydrated
 * result set, so a shared workspace's fixed-size top-K window got crowded
 * out by other questions' data as the workspace grew (raw own-question
 * candidate count fell from 150 to single digits across this harness's own
 * n=100 run). FIXED 2026-08-13 in retrieve.ts: the ecosystem filter is
 * pushed into the vector/BM25 query itself (with the post-hydration check
 * on the authoritative graph node still deciding — see
 * recall/ecosystemSeedUnion.ts), so this window no longer competes against
 * the whole shared workspace. The client-side id-prefix filter that used to
 * sit below was REMOVED 2026-08-19 after the fix was re-verified live across
 * all three search_modes; only a diagnostic count remains (below).
 */
const RAW_RECALL_FETCH = 150;

async function ingestWithRetry(
    lore: import('../../../packages/lore/src/index.js').LoreInstance,
    instance: import('./types.js').LongMemEvalInstance,
    maxAttempts = 3,
): ReturnType<typeof ingestInstance> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await ingestInstance(lore, instance);
        } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            // Observed once during smoke testing: Kùzu's checkpointer can time
            // out waiting for a prior bulkIngest's transaction to fully clear
            // under rapid back-to-back large bulk writes. Retrying after a
            // short pause has cleared it every time seen so far.
            const retryable = msg.includes('Timeout waiting for active transactions');
            if (!retryable || attempt === maxAttempts) throw err;
            console.log(`  ingest attempt ${attempt} hit a retryable Kùzu checkpoint timeout, retrying in 3s...`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
    throw lastErr;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    console.log('Args:', args);

    if (!fs.existsSync(args.dataset)) {
        throw new Error(
            `Dataset not found at ${args.dataset}. Run: curl -L -o ${args.dataset} ` +
                `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json`,
        );
    }

    const fullDataset = loadDataset(args.dataset);
    console.log(`Loaded ${fullDataset.length} instances from ${args.dataset}`);

    let subset: LongMemEvalInstance[];
    if (args.questionIds) {
        const byId = new Map(fullDataset.map((i) => [i.question_id, i]));
        subset = args.questionIds.map((id) => {
            const inst = byId.get(id);
            if (!inst) throw new Error(`--question-ids: "${id}" not found in ${args.dataset}`);
            return inst;
        });
        console.log(`Selected ${subset.length} explicit question_ids (--question-ids), in the given order.`);
    } else {
        subset = selectStratifiedSubset(fullDataset, args.n);
    }
    console.log(
        `Selected ${subset.length} (${args.questionIds ? 'explicit --question-ids' : 'stratified'}):`,
        subset.reduce<Record<string, number>>((acc, i) => {
            acc[i.question_type] = (acc[i.question_type] ?? 0) + 1;
            return acc;
        }, {}),
    );

    const { lore } = await createBenchmarkLore(args.dataDir);

    const perInstance: PerInstanceResult[] = [];
    const maxK = Math.max(...args.ks);

    try {
        for (const [idx, instance] of subset.entries()) {
            const label = `[${idx + 1}/${subset.length}] ${instance.question_id} (${instance.question_type})`;
            console.log(`\n${label} — ingesting ${instance.haystack_sessions.flat().length} turns...`);
            const ingested = await ingestWithRetry(lore, instance);
            console.log(
                `  ingested ${ingested.totalTurns} turns / ${ingested.totalSessions} sessions in ${ingested.ingestMs}ms, ` +
                    `${ingested.evidenceTurns.length} evidence turn(s)`,
            );

            const retrieveStart = Date.now();
            const recallResult = await lore.recall(instance.question, {
                workspace: WORKSPACE,
                ecosystem: instance.question_id,
                mode: 'full',
                max: RAW_RECALL_FETCH,
                searchMode: 'hybrid',
            });
            const retrieveMs = Date.now() - retrieveStart;
            // The recall IS the result set — no client-side filtering (that
            // workaround was removed 2026-08-19; see RAW_RECALL_FETCH above).
            const knowledge = recallResult.mode === 'full' ? recallResult.knowledge : [];
            // Purely a DIAGNOSTIC, not a filter: the id prefix this harness
            // controls (`<question_id>::...`, see ingest.ts buildNodeId) makes
            // foreign-node detection exact, so a regression of the Core
            // ecosystem-scoping bug lands loudly in the log + results file
            // instead of silently corrupting the metrics.
            const idPrefix = `${instance.question_id}::`;
            const contaminated = knowledge.filter((k) => !k.id.startsWith(idPrefix)).length;
            if (contaminated > 0) {
                console.warn(
                    `  WARNING: ${contaminated} cross-question node(s) in the recall window — ` +
                        'the Core ecosystem-scoping bug may have REGRESSED (see README "Confirmed retrieval-scoping bug")',
                );
            }
            const retrievedNodeIds = knowledge.map((k) => k.id);
            console.log(
                `  retrieved ${knowledge.length} candidates (${contaminated} cross-question — diagnostic, not filtered) ` +
                    `in ${retrieveMs}ms (top-3: ${retrievedNodeIds.slice(0, 3).join(', ')})`,
            );

            const evidenceNodeIds = ingested.evidenceTurns.map((e) => e.nodeId);
            const retrievalMetricsByK = computeMetricsAtKs(retrievedNodeIds, evidenceNodeIds, args.ks);
            for (const k of args.ks) {
                const m = retrievalMetricsByK[k]!;
                console.log(`    @${k}: recall_any=${m.recallAny} recall_all=${m.recallAll} ndcg=${m.ndcg.toFixed(3)}`);
            }

            const result: PerInstanceResult = {
                questionId: instance.question_id,
                questionType: instance.question_type,
                isAbstention: instance.question_id.includes('_abs'),
                question: instance.question,
                expectedAnswer: instance.answer,
                totalTurns: ingested.totalTurns,
                totalSessions: ingested.totalSessions,
                evidenceTurnCount: ingested.evidenceTurns.length,
                ingestMs: ingested.ingestMs,
                retrieveMs,
                rawRetrievedCount: knowledge.length,
                contaminatedCount: contaminated,
                retrievedNodeIds,
                retrievalMetricsByK,
                answer: null,
                answerError: null,
                judge: null,
                judgeError: null,
                countingDetected: false,
                structuredFactCount: 0,
            };

            // Bucket B — structured counting/aggregation records. Additive to
            // normal recall (which is unchanged above): a detected counting
            // question ALSO reads the countable_events table, populated by the
            // separate, cost-gated extractCountableFacts.ts pass. When the
            // table is empty or absent, structuredFacts stays undefined and the
            // prompt is byte-for-byte the pre-Bucket-B shape.
            const countingDetected = isCountingQuestion(instance.question);
            result.countingDetected = countingDetected;
            let structuredFacts: string | undefined;
            if (countingDetected) {
                try {
                    const rows = await queryCountableFacts(lore.store.tableStorage, instance.question_id);
                    result.structuredFactCount = rows.length;
                    if (rows.length > 0) {
                        structuredFacts = formatStructuredFacts(rows);
                        console.log(`  countable_events: ${rows.length} structured fact(s) added to context`);
                    }
                } catch (err) {
                    // Table not created yet (no extraction pass ran). Treat as
                    // "no structured record" — the recall-only path is unchanged.
                    console.log(`  countable_events read skipped: ${(err as Error).message}`);
                }
            }

            // Answering — best-effort; a missing key is expected right now
            // (see answerModel.ts header) and must be recorded, not hidden.
            try {
                // Use the node's REAL label (carries the session date — see
                // ingest.ts), not just its type — dates matter for
                // temporal-reasoning questions and are otherwise invisible
                // to the answering model (RecallNode doesn't surface the
                // custom session_date field, only label/content/tags).
                const contextNodes = knowledge.slice(0, args.contextK).map((k) => ({
                    content: k.content,
                    label: k.label,
                }));
                // --think auto (2026-08-16): 9 of 38 real judged failures were
                // correct with medium-thinking and wrong with no-thinking on
                // the SAME question — always an arithmetic slip on a counting/
                // aggregation question (e.g. "10-day break + 7-day break =
                // 11 days"), never on a non-counting one. Force thinking on
                // for exactly the questions detectCounting.ts already flags,
                // leave everything else at the caller's chosen level (or off,
                // for speed) — this is the harness-level version of the
                // app-layer routing recommendation: classify intent, THEN
                // decide reasoning effort, same as any Lore-backed app should.
                const effectiveThink =
                    args.think === 'auto' ? (countingDetected ? 'medium' : false) : args.think;
                const answer = await generateAnswer(
                    instance.question,
                    formatContext(contextNodes),
                    instance.question_date,
                    args.answerModel,
                    structuredFacts,
                    effectiveThink,
                );
                result.answer = { provider: answer.provider, model: answer.model, text: answer.answer };
                console.log(`  answer [${answer.provider}/${answer.model}]: ${answer.answer.slice(0, 200)}`);
            } catch (err) {
                if (err instanceof AnswerModelUnavailableError) {
                    result.answerError = err.message;
                    console.log(`  answer SKIPPED: ${err.message}`);
                } else {
                    throw err;
                }
            }

            // Judge — MUST be gpt-4o-2024-08-06 via OpenAI. Never substitute.
            if (result.answer) {
                try {
                    const verdict = await judgeAnswer(
                        instance.question_id,
                        instance.question_type,
                        instance.question,
                        instance.answer,
                        result.answer.text,
                    );
                    result.judge = verdict;
                    console.log(`  judge [${verdict.model}]: label=${verdict.label} raw="${verdict.rawResponse}"`);

                    if (args.majorityJudge) {
                        const majority = await judgeAnswerMajority(
                            instance.question_id,
                            instance.question_type,
                            instance.question,
                            instance.answer,
                            result.answer.text,
                            { votes: args.majorityVotes },
                        );
                        result.majorityJudge = {
                            majorityLabel: majority.majorityLabel,
                            agreement: majority.agreement,
                            votes: majority.votes.map((v) => v.label),
                        };
                        console.log(
                            `  majority judge (${args.majorityVotes}x): label=${majority.majorityLabel} ` +
                                `agreement=${(majority.agreement * 100).toFixed(0)}%` +
                                (majority.majorityLabel !== verdict.label ? '  ← DISAGREES with official single-call verdict' : ''),
                        );
                    }
                } catch (err) {
                    // Isolate ANY judge failure to this one instance — not just
                    // the "no key configured" case. Found 2026-08-15: a judge
                    // call against a rate/limit-exhausted key throws a plain
                    // Error (HTTP non-ok), not JudgeUnavailableError, and the
                    // previous version of this catch re-threw that, crashing
                    // the whole multi-question run and discarding every
                    // already-computed answer with it — the exact failure class
                    // extractCountableFacts.ts's per-session isolation already
                    // exists to prevent (see that file's failedSessions
                    // comment), just not mirrored here yet.
                    const message = (err as Error).message ?? String(err);
                    result.judgeError = err instanceof JudgeUnavailableError ? message : `UNEXPECTED: ${message}`;
                    console.log(`  judge SKIPPED: ${message}`);
                }
            } else {
                result.judgeError = 'No answer generated for this instance (see answerError) — nothing to judge.';
            }

            perInstance.push(result);
        }
    } finally {
        await lore.dispose();
    }

    const report: BenchmarkReport = {
        generatedAt: new Date().toISOString(),
        datasetFile: args.dataset,
        subsetSize: subset.length,
        ks: args.ks,
        perInstance,
    };

    fs.mkdirSync(path.dirname(args.resultsFile), { recursive: true });
    fs.writeFileSync(args.resultsFile, JSON.stringify(report, null, 2));
    console.log(`\nWrote full results to ${args.resultsFile}`);

    printReport(report);
}

main().catch((err) => {
    console.error('runSubset FAILED:', err);
    process.exitCode = 1;
});
