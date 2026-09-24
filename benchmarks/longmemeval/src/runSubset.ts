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
 *       [--engine surreal-lance|sqlite]
 *       [--structured-facts auto|all|off]
 *       [--preference-facts auto|all|off] [--recency-tagging on|off]
 *       [--decompose-multi-session on|off] [--retrieval-only] [--skip-ingest]
 *
 * --engine picks which graph/vector engines the benchmark workspace runs on
 * (default: surreal-lance, the profile every existing results file used).
 * sqlite tests 3.21's new default — see loreClient.ts's 2026-09-20 note.
 *
 * --structured-facts controls Bucket B (the countable_events lookup), default
 * `auto` (unchanged pre-2026-09-20 behavior: only questions detectCounting.ts
 * flags get the lookup). `all` forces the lookup for EVERY question type,
 * regardless of what the heuristic says — this is the substrate-combination
 * experiment: does giving every question type access to the structured
 * facts table help or hurt, not just counting questions? `off` disables it
 * for everyone, a clean baseline to compare `all` against. Reading an empty
 * or nonexistent countable_events table is a no-op either way (see the
 * try/catch below), so `all` is safe to run even against a data-dir that was
 * never extracted for some question types — it just adds nothing for those.
 * `structuredFactsAttempted` on each result records whether THIS run actually
 * did the lookup, independent of what the heuristic (`countingDetected`)
 * would have decided on its own — compare the two fields across an `off` vs
 * `all` run pair on the identical --question-ids / --data-dir to isolate the
 * effect.
 *
 * --preference-facts mirrors --structured-facts in spirit for the
 * preference_events table (preferenceEvents.ts): `auto` (default) attempts
 * the lookup when EITHER the ground-truth question_type OR
 * detectQuestionType.ts's guess is `single-session-preference`; `all` forces
 * it for every question; `off` never attempts it. OR (not AND, and not
 * ground-truth alone) was the deliberate choice here: this is an offline
 * evaluation harness that already has ground truth on hand for every
 * instance, and a false-positive lookup only costs one cheap table read (the
 * same "cheap and additive" reasoning --structured-facts's `auto` already
 * relies on for countingDetected) — so widening `auto` to catch anything
 * EITHER signal flags maximizes how often the fix actually gets exercised
 * without materially changing the cost profile. Read from preference_events
 * and APPEND its formatted block to the answering prompt, alongside (never
 * replacing) the existing --structured-facts block. `preferenceFactsAttempted`
 * / `preferenceFactCount` on each result mirror `structuredFactsAttempted` /
 * `structuredFactCount` exactly.
 *
 * --recency-tagging (default `on`) applies factRecency.ts's CURRENT/SUPERSEDED
 * clustering to the countable_events rows already being read whenever
 * --structured-facts attempted a lookup, so a knowledge-update-style value
 * change gets an advisory annotation ahead of the full record list. It is
 * additive and conservative by design (see factRecency.ts's three "give up
 * rather than guess" gates) — default ON reflects that low downside. `off`
 * restores the exact pre-2026-09-20 structured-facts block byte-for-byte.
 *
 * --decompose-multi-session (default `off`, opt-in — costs one extra LLM call
 * plus one extra lore.recall() per sub-query, ONLY when it actually fires)
 * routes a question through queryDecompose.ts when it is ON AND the base
 * recall's own results look scattered across many sessions. As of
 * 2026-09-21 this is decided AFTER the base recall runs, from the base
 * recall's own results (how many distinct sessions the top-ranked candidates
 * touch — see retrievalStrategies.ts header "Evidence-based decomposition
 * trigger"), NOT from detectQuestionType.ts's guess or the ground-truth
 * question_type. The old text-based gate was measured at only 42.9%
 * accuracy on multi-session questions specifically — nothing about a
 * question's wording reliably signals that its evidence happens to be
 * scattered across sessions, so an evidence-based trigger (which also has a
 * live/production equivalent, unlike a ground-truth label) replaced it.
 * `decomposeAttempted` / `decomposeSubQueryCount` / `sessionSpreadCount` on
 * each result record whether the evidence signal crossed the threshold,
 * whether decomposition was attempted, and how many sub-queries retrieval
 * actually used.
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
 * --retrieval-only (default off) skips the structured/preference-facts
 * lookups AND the answer-writer AND the judge entirely — the run stops right
 * after PRIMARY retrieval metrics are computed for each instance. Use this
 * when the question being tested is "does a retrieval-time flag (e.g.
 * --decompose-multi-session) change what Lore finds," which the PRIMARY
 * metrics already answer on their own — the disposable answer-writer and the
 * judge model exist only to produce the SECONDARY judged-accuracy number,
 * which is a harness-quality measure, not a Lore quality measure (see
 * report.ts's SECONDARY section header). Skipping them removes the two
 * costed LLM calls per question; only decompose's own sub-query LLM call
 * (when --decompose-multi-session on fires) remains.
 *
 * --skip-ingest (default off) skips re-writing each instance's haystack into
 * the store (see ingest.ts's `skipWrite`) and trusts that --data-dir already
 * has it from a prior run over the SAME instances. Node ids are deterministic
 * per (question_id, session_id, turn_index), so this is safe ONLY when
 * reusing an identical --data-dir + --n/--question-ids combination as the run
 * that actually ingested it — e.g. running --decompose-multi-session off then
 * on, back to back, against the same --data-dir, to isolate that flag's
 * effect on retrieval without paying the ~30s/instance embedding cost twice.
 * Ingestion is the dominant wall-clock cost of this script; this is the
 * single biggest lever for a faster --retrieval-only comparison run.
 *
 * Must be run under Node 22 (native LanceDB/better-sqlite3 bindings) — see
 * ../README.md "Running this" for the exact command.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenchmarkLore, WORKSPACE, engineProfileFor } from './loreClient.js';
import { loadDataset, selectStratifiedSubset, ingestInstance } from './ingest.js';
import { computeMetricsAtKs } from './retrievalMetrics.js';
import { generateAnswer, AnswerModelUnavailableError } from './answerModel.js';
import { judgeAnswer, JudgeUnavailableError } from './judge.js';
import { judgeAnswerMajority } from './judgeMajority.js';
import { printReport, type BenchmarkReport, type PerInstanceResult } from './report.js';
import { isCountingQuestion } from './detectCounting.js';
import { detectQuestionType } from './detectQuestionType.js';
import { queryCountableFacts, formatStructuredFacts } from './countableEvents.js';
import {
    partitionByRelevance,
    computeStructuredAggregate,
    formatComputedAggregateBlock,
} from './structuredFactsAggregate.js';
import { detectFactRecency, formatFactRecencyBlock } from './factRecency.js';
import { queryPreferenceFacts, formatPreferenceFacts } from './preferenceEvents.js';
import { retrieveKnowledge } from './retrievalStrategies.js';
import { createAnalyticalStorage } from '../../../packages/lore/src/engines/analyticalStorageFactory.js';
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
    /** Which graph/vector engines the benchmark workspace runs on — see
     *  loreClient.ts's 2026-09-20 note. Defaults to the profile every prior
     *  results file used (surreal-lance), not 3.21's new default, so
     *  existing invocations are unaffected. */
    engine: 'surreal-lance' | 'sqlite';
    /** Explicit question_id list — when set, bypasses selectStratifiedSubset
     *  entirely and runs exactly these questions, in this order. For
     *  deliberately-varied before/after comparisons (e.g. a mix of
     *  previously-failing + previously-passing questions) that a
     *  count/category selection can't guarantee. --n is ignored when set. */
    questionIds?: string[];
    /** Bucket B lookup mode — see this file's header comment. `auto`
     *  preserves the pre-2026-09-20 default (detectCounting.ts gates it). */
    structuredFacts: 'auto' | 'all' | 'off';
    /** preference_events lookup mode — see this file's header comment.
     *  `auto` preserves pre-existing behavior in the sense that it is the
     *  new default (this flag did not exist before). */
    preferenceFacts: 'auto' | 'all' | 'off';
    /** factRecency.ts CURRENT/SUPERSEDED annotation on countable_events rows
     *  — see this file's header comment. Default `on`. */
    recencyTagging: 'on' | 'off';
    /** queryDecompose.ts multi-session retrieval routing — see this file's
     *  header comment. Default `off` (opt-in, costs extra LLM+recall calls). */
    decomposeMultiSession: 'on' | 'off';
    /** Skip fact lookups + answer-writer + judge; stop after PRIMARY
     *  retrieval metrics. See this file's header comment. Default `false`. */
    retrievalOnly: boolean;
    /** Skip re-ingesting each instance; trust --data-dir already has it from
     *  a prior identical run. See this file's header comment. Default `false`. */
    skipIngest: boolean;
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
    const engineRaw = get('--engine', 'surreal-lance');
    if (engineRaw !== 'surreal-lance' && engineRaw !== 'sqlite') {
        throw new Error(`--engine must be "surreal-lance" or "sqlite", got "${engineRaw}"`);
    }
    const engine = engineRaw;
    const structuredFactsRaw = get('--structured-facts', 'auto');
    if (structuredFactsRaw !== 'auto' && structuredFactsRaw !== 'all' && structuredFactsRaw !== 'off') {
        throw new Error(`--structured-facts must be "auto", "all", or "off", got "${structuredFactsRaw}"`);
    }
    const structuredFacts = structuredFactsRaw;
    const preferenceFactsRaw = get('--preference-facts', 'auto');
    if (preferenceFactsRaw !== 'auto' && preferenceFactsRaw !== 'all' && preferenceFactsRaw !== 'off') {
        throw new Error(`--preference-facts must be "auto", "all", or "off", got "${preferenceFactsRaw}"`);
    }
    const preferenceFacts = preferenceFactsRaw;
    const recencyTaggingRaw = get('--recency-tagging', 'on');
    if (recencyTaggingRaw !== 'on' && recencyTaggingRaw !== 'off') {
        throw new Error(`--recency-tagging must be "on" or "off", got "${recencyTaggingRaw}"`);
    }
    const recencyTagging = recencyTaggingRaw;
    const decomposeMultiSessionRaw = get('--decompose-multi-session', 'off');
    if (decomposeMultiSessionRaw !== 'on' && decomposeMultiSessionRaw !== 'off') {
        throw new Error(`--decompose-multi-session must be "on" or "off", got "${decomposeMultiSessionRaw}"`);
    }
    const decomposeMultiSession = decomposeMultiSessionRaw;
    const retrievalOnly = argv.includes('--retrieval-only');
    const skipIngest = argv.includes('--skip-ingest');
    const resultsFile = get(
        '--results-file',
        path.join(BENCH_ROOT, 'results', `subset-n${n}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    );
    return {
        n, ks, dataset, dataDir, contextK, resultsFile, answerModel, think, majorityJudge, majorityVotes,
        questionIds, engine, structuredFacts, preferenceFacts, recencyTagging, decomposeMultiSession, retrievalOnly,
        skipIngest,
    };
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
    opts: { skipWrite?: boolean } = {},
    maxAttempts = 3,
): ReturnType<typeof ingestInstance> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await ingestInstance(lore, instance, opts);
        } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            // Observed once during smoke testing under the prior local
            // graph engine (since removed 2026-08-21; see
            // docs/KUZU_REMOVAL.md): the checkpointer could time out
            // waiting for a prior bulkIngest's transaction to fully clear
            // under rapid back-to-back large bulk writes. Kept as a
            // defensive retry in case the same message class ever surfaces
            // under the current SurrealDB engine. Retrying after a short
            // pause has cleared it every time seen so far.
            const retryable = msg.includes('Timeout waiting for active transactions');
            if (!retryable || attempt === maxAttempts) throw err;
            console.log(`  ingest attempt ${attempt} hit a retryable checkpoint timeout, retrying in 3s...`);
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

    const { lore } = await createBenchmarkLore(args.dataDir, engineProfileFor(args.engine));

    const perInstance: PerInstanceResult[] = [];
    const maxK = Math.max(...args.ks);

    try {
        for (const [idx, instance] of subset.entries()) {
            const label = `[${idx + 1}/${subset.length}] ${instance.question_id} (${instance.question_type})`;
            console.log(`\n${label} — ingesting ${instance.haystack_sessions.flat().length} turns...`);
            const ingested = await ingestWithRetry(lore, instance, { skipWrite: args.skipIngest });
            console.log(
                `  ingested ${ingested.totalTurns} turns / ${ingested.totalSessions} sessions in ${ingested.ingestMs}ms, ` +
                    `${ingested.evidenceTurns.length} evidence turn(s)`,
            );

            // Instrumentation only for now (see this file's header comment) —
            // detectQuestionType.ts's guess never changes behavior by itself.
            // It DOES gate --preference-facts `auto` (below). It no longer
            // gates --decompose-multi-session: that routing now decides from
            // the base recall's OWN results (session spread across the top
            // candidates), not from this pre-search guess — see
            // retrievalStrategies.ts header "Evidence-based decomposition
            // trigger" (2026-09-21) for why the old text-based gate was
            // replaced (42.9% accuracy on multi-session, no signal in the
            // question's wording to tune against).
            const detectedQuestionType = detectQuestionType(instance.question);

            // The recall IS the result set — no client-side filtering (that
            // workaround was removed 2026-08-19; see RAW_RECALL_FETCH above).
            // Single-query vs. decomposed-multi-query branching lives in
            // retrievalStrategies.ts (extracted out of this loop to stay
            // within the file-size budget — see that file's header).
            const { knowledge, retrieveMs, decomposeAttempted, decomposeSubQueryCount, sessionSpreadCount } =
                await retrieveKnowledge(lore, instance, RAW_RECALL_FETCH, {
                    decomposeMultiSession: args.decomposeMultiSession === 'on',
                });
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
            if (args.decomposeMultiSession === 'on') {
                console.log(
                    `  decompose-multi-session: session spread ${sessionSpreadCount} ` +
                        `→ ${decomposeAttempted ? `decomposed (${decomposeSubQueryCount} sub-queries)` : 'skipped, single recall kept'}`,
                );
            }

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
                structuredFactsAttempted: false,
                detectedQuestionType,
                preferenceFactsAttempted: false,
                preferenceFactCount: 0,
                decomposeAttempted,
                decomposeSubQueryCount,
                sessionSpreadCount,
            };

            // --retrieval-only stops here: PRIMARY retrieval metrics are
            // already computed and attached to `result` above. Everything
            // below this point (fact lookups, the answer-writer, the judge)
            // exists only to produce the SECONDARY judged-accuracy number,
            // which this mode doesn't need — see this file's header comment.
            if (args.retrievalOnly) {
                perInstance.push(result);
                continue;
            }

            // Bucket B — structured counting/aggregation records. Additive to
            // normal recall (which is unchanged above): a question ALSO reads
            // the countable_events table, populated by the separate,
            // cost-gated extractCountableFacts.ts pass, when EITHER the
            // detectCounting.ts heuristic fires (`auto`, the pre-2026-09-20
            // default) OR --structured-facts forces it for every question
            // type (`all`) — see this file's header comment for the
            // substrate-combination experiment this supports. `off` never
            // attempts it. When the table is empty or absent, structuredFacts
            // stays undefined and the prompt is byte-for-byte the
            // pre-Bucket-B shape.
            const countingDetected = isCountingQuestion(instance.question);
            result.countingDetected = countingDetected;
            const attemptStructured =
                args.structuredFacts === 'off' ? false
                : args.structuredFacts === 'all' ? true
                : countingDetected;
            result.structuredFactsAttempted = attemptStructured;
            let structuredFacts: string | undefined;
            if (attemptStructured) {
                try {
                    const rows = await queryCountableFacts(lore.store.tableStorage, instance.question_id);
                    result.structuredFactCount = rows.length;
                    if (rows.length > 0) {
                        const rowsText = formatStructuredFacts(rows);
                        // CURRENT/SUPERSEDED advisory ahead of the row list —
                        // additive and conservative (see factRecency.ts's
                        // three "give up rather than guess" gates), default
                        // ON. `off` restores the exact pre-2026-09-20 block.
                        const recencyBlock =
                            args.recencyTagging === 'on' ? formatFactRecencyBlock(detectFactRecency(rows)) : '';
                        if (recencyBlock) {
                            console.log(`  factRecency: tagged CURRENT/SUPERSEDED cluster(s) in countable_events`);
                        }
                        // Exact COUNT (sum deliberately dropped — see
                        // structuredFactsAggregate.ts header, 2026-09-20: this
                        // dataset re-extracts the same real-world event across
                        // multiple session recaps, so a blind SQL sum over
                        // duplicate rows is not a safe database operation here)
                        // via Lore's own IAnalyticalStorage over a
                        // lexically-scoped subset of these rows.
                        // `analytical` is null only for a table backend with no
                        // analytical implementation, which the relational substrate
                        // never is (SQLite, always) — falls back to the row list alone.
                        const analytical = createAnalyticalStorage(lore.store.tableStorage);
                        if (analytical) {
                            const { onTopic } = partitionByRelevance(instance.question, rows);
                            const aggregate = await computeStructuredAggregate(
                                analytical,
                                instance.question_id,
                                onTopic.map((r) => String(r.id)),
                            );
                            const aggregateBlock = formatComputedAggregateBlock({
                                totalRows: rows.length,
                                onTopicCount: onTopic.length,
                                aggregate,
                            });
                            structuredFacts = [recencyBlock, aggregateBlock, rowsText].filter(Boolean).join('\n\n');
                            console.log(
                                `  countable_events: ${rows.length} structured fact(s), ${onTopic.length} on-topic ` +
                                    `(computed count=${aggregate.computedCount})`,
                            );
                        } else {
                            structuredFacts = [recencyBlock, rowsText].filter(Boolean).join('\n\n');
                            console.log(`  countable_events: ${rows.length} structured fact(s) added to context (no analytical store)`);
                        }
                    }
                } catch (err) {
                    // Table not created yet (no extraction pass ran). Treat as
                    // "no structured record" — the recall-only path is unchanged.
                    console.log(`  countable_events read skipped: ${(err as Error).message}`);
                }
            }

            // Preference facts — same shape as the Bucket B block above, over
            // preference_events (preferenceEvents.ts) instead of
            // countable_events. See this file's header comment for the
            // --preference-facts `auto` gating policy (ground-truth type OR
            // detectQuestionType.ts's guess). APPENDED to (never replaces)
            // structuredFacts below — both blocks can be present at once.
            const attemptPreferenceFacts =
                args.preferenceFacts === 'off' ? false
                : args.preferenceFacts === 'all' ? true
                : instance.question_type === 'single-session-preference' ||
                  detectedQuestionType === 'single-session-preference';
            result.preferenceFactsAttempted = attemptPreferenceFacts;
            let preferenceFactsBlock: string | undefined;
            if (attemptPreferenceFacts) {
                try {
                    const rows = await queryPreferenceFacts(lore.store.tableStorage, instance.question_id);
                    result.preferenceFactCount = rows.length;
                    if (rows.length > 0) {
                        preferenceFactsBlock = formatPreferenceFacts(rows);
                        console.log(`  preference_events: ${rows.length} preference fact(s) added to context`);
                    }
                } catch (err) {
                    // Table not created yet (no extraction pass ran). Treat as
                    // "no preference record" — the recall-only path is unchanged.
                    console.log(`  preference_events read skipped: ${(err as Error).message}`);
                }
            }
            // Combine the two structured blocks for the prompt — APPEND, never
            // replace: generateAnswer() takes one `structuredFacts` string, so
            // both blocks (when both are present) are joined here rather than
            // one overwriting the other.
            const combinedStructuredFacts = [structuredFacts, preferenceFactsBlock].filter(Boolean).join('\n\n');
            const structuredFactsForPrompt = combinedStructuredFacts.length > 0 ? combinedStructuredFacts : undefined;

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
                    structuredFactsForPrompt,
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
        engines:
            args.engine === 'sqlite'
                ? { graph: 'sqlite', vector: 'sqlite' }
                : { graph: 'surreal', vector: 'lance' },
        structuredFactsMode: args.structuredFacts,
        preferenceFactsMode: args.preferenceFacts,
        recencyTagging: args.recencyTagging,
        decomposeMultiSession: args.decomposeMultiSession,
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
