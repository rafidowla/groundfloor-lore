#!/usr/bin/env tsx
/**
 * buildMosaic.ts — the ONE-TIME, cost-gated build for "Mosaic": raw ingest
 * (ingestInstance, unchanged) + proposition extraction (extractPropositions.ts,
 * Haiku) + proposition storage (writePropositions.ts), for a subset of
 * LongMemEval questions.
 *
 * Deliberately separate from extractCountableFacts.ts — that script writes
 * to the SQL countable_events table for Bucket B (counting questions);
 * this one writes proposition NODES into the vector/graph store, additive to
 * the turn-level nodes ingestInstance already creates. Different table,
 * different purpose, same cost-gating discipline.
 *
 * COST CONTROL (mandatory — this hits a real paid Anthropic key):
 *   - Run with --dry-run FIRST. It reports the EXACT session count (= exact
 *     Haiku call count) and a cost estimate, and makes ZERO calls.
 *   - The cost estimate borrows extractionCost.ts's per-session token-size
 *     assumptions from the OLD countable-facts extraction task — proposition
 *     extraction is a different, more expansive task (rewrite every fact,
 *     not just countable ones) and has NOT been measured for real. Run
 *     --dry-run --n 1 first, note the estimate, then run --n 1 for real and
 *     compare the printed real cost against it before trusting the estimate
 *     for the full run.
 *   - Once built, THIS DATA DIRECTORY IS REUSABLE — every later test run
 *     (different answer model, different thinking mode, re-judging) reads
 *     from it without re-ingesting or re-extracting. That's the whole point:
 *     pay this cost once, not once per test run.
 *
 * Usage:
 *   tsx src/buildMosaic.ts --dry-run --question-ids "<comma-separated ids>"
 *   tsx src/buildMosaic.ts --question-ids "<ids>" --data-dir lore-home-mosaic
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenchmarkLore } from './loreClient.js';
import { loadDataset, selectStratifiedSubset, ingestInstance, disambiguateSessionIds } from './ingest.js';
import type { LongMemEvalInstance, LongMemEvalQuestionType } from './types.js';
import { extractPropositionsFromSession, PropositionExtractionUnavailableError } from './extractPropositions.js';
import { writePropositions } from './writePropositions.js';
import { HAIKU_PRICE_PER_M } from './anthropicClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(HERE, '..');
const DEFAULT_QUESTION_CONCURRENCY = 4;

// Same per-session shape extractionCost.ts uses for the OLD countable-facts
// task — an ESTIMATE, not a measurement, for THIS task. See file header.
const EST_INPUT_TOKENS_PER_SESSION = 1500;
const EST_OUTPUT_TOKENS_PER_SESSION = 100;

interface Args {
    n: number;
    dataset: string;
    dataDir: string;
    questionTypes?: LongMemEvalQuestionType[];
    dryRun: boolean;
    concurrency?: number;
    questionIds?: string[];
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        n: 25,
        dataset: path.join(BENCH_ROOT, 'data', 'longmemeval_s_cleaned.json'),
        dataDir: path.join(BENCH_ROOT, 'lore-home-mosaic'),
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const next = () => argv[++i];
        if (a === '--n') args.n = Number(next());
        else if (a === '--dataset') args.dataset = next()!;
        else if (a === '--data-dir') args.dataDir = next()!;
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--question-types') args.questionTypes = next()!.split(',').map((t) => t.trim()) as LongMemEvalQuestionType[];
        else if (a === '--question-ids') args.questionIds = next()!.split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--concurrency') args.concurrency = Number(next());
        else throw new Error(`Unknown arg: ${a}`);
    }
    return args;
}

function filterByTypes(data: LongMemEvalInstance[], types: LongMemEvalQuestionType[]): LongMemEvalInstance[] {
    const wanted = new Set(types);
    return data.filter((i) => wanted.has(i.question_type));
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(args.dataset)) throw new Error(`Dataset not found at ${args.dataset}.`);

    const full = loadDataset(args.dataset);
    let subset: LongMemEvalInstance[];
    if (args.questionIds) {
        const byId = new Map(full.map((i) => [i.question_id, i]));
        subset = args.questionIds.map((id) => {
            const inst = byId.get(id);
            if (!inst) throw new Error(`--question-ids: "${id}" not found in ${args.dataset}`);
            return inst;
        });
    } else {
        const pool = args.questionTypes && args.questionTypes.length > 0 ? filterByTypes(full, args.questionTypes) : full;
        subset = selectStratifiedSubset(pool, args.n);
    }

    const totalSessions = subset.reduce((s, i) => s + i.haystack_sessions.length, 0);
    const estInputTokens = totalSessions * EST_INPUT_TOKENS_PER_SESSION;
    const estOutputTokens = totalSessions * EST_OUTPUT_TOKENS_PER_SESSION;
    const estUsd = (estInputTokens / 1_000_000) * HAIKU_PRICE_PER_M.input + (estOutputTokens / 1_000_000) * HAIKU_PRICE_PER_M.output;

    console.log(`Mosaic build subset: ${subset.length} questions / ${totalSessions} sessions`);
    console.log(`Exact Haiku call count: ${totalSessions} (one per session, proposition extraction only — raw ingest makes no LLM calls)`);
    console.log(
        `ROUGH estimated cost: ~$${estUsd.toFixed(2)} (claude-haiku-4-5, $${HAIKU_PRICE_PER_M.input}/M in $${HAIKU_PRICE_PER_M.output}/M out; ` +
            `assuming ${EST_INPUT_TOKENS_PER_SESSION} in / ${EST_OUTPUT_TOKENS_PER_SESSION} out tokens per session — UNVERIFIED for this task, see file header. Run --n 1 for real first.)`,
    );

    if (args.dryRun) {
        console.log('DRY RUN — made zero calls. Get explicit go-ahead before running without --dry-run.');
        return;
    }

    // EAGER key check — before the Lore data dir is opened and before a single
    // session is ingested. Without it, the missing key surfaced as a
    // PropositionExtractionUnavailableError thrown INSIDE the per-session
    // try/catch, which is designed to isolate one bad session from the rest:
    // every session was "SKIPPED", the run printed one identical failure line
    // per session (hundreds, on a full subset), exited 1, and only after having
    // done all the raw-ingest graph writes for every question. The condition is
    // known before any of that starts, so it is checked before any of that
    // starts. Deliberately AFTER the --dry-run return: a dry run makes zero
    // calls and must keep working with no key.
    if (!process.env['ANTHROPIC_API_KEY']) {
        throw new PropositionExtractionUnavailableError(
            'ANTHROPIC_API_KEY is not set. Proposition extraction needs it for every session, ' +
                'so the whole run would fail one session at a time. Set the key, or use --dry-run ' +
                '(zero calls) to preview the subset and cost estimate.',
        );
    }

    const { lore } = await createBenchmarkLore(args.dataDir);
    let sessionsProcessed = 0;
    let propositionsWritten = 0;
    let realInputTokens = 0;
    let realOutputTokens = 0;
    const failedSessions: Array<{ questionId: string; sessionId: string; error: string }> = [];
    /** Sessions the model reported as genuinely having no extractable facts
     *  (well-formed `[]`). Tracked apart from failures so "0 propositions" is
     *  never ambiguous between "none exist" and "we couldn't tell". */
    let emptySessions = 0;
    /** Sessions whose first extraction call was truncated and needed the retry
     *  at double the token budget. A rising count means MAX_PROPOSITION_TOKENS
     *  is too low for this dataset. */
    let truncationRetries = 0;

    async function processQuestion(instance: LongMemEvalInstance): Promise<void> {
        // Raw ingest first (unchanged path, no LLM calls) — propositions
        // reference these node ids via writePropositions' buildNodeId call.
        await ingestInstance(lore, instance);

        const nodeSessionIds = disambiguateSessionIds(instance.haystack_session_ids);
        for (let s = 0; s < instance.haystack_sessions.length; s++) {
            const nodeSessionId = nodeSessionIds[s] ?? instance.haystack_session_ids[s] ?? `session-${s}`;
            const sessionDate = instance.haystack_dates[s] ?? null;
            const turns = instance.haystack_sessions[s]!;
            sessionsProcessed++;
            try {
                const { propositions, inputTokens, outputTokens, retried, emptySession } =
                    await extractPropositionsFromSession({ sessionDate, turns });
                realInputTokens += inputTokens;
                realOutputTokens += outputTokens;
                if (retried) truncationRetries++;
                // A VERIFIED-empty session (model returned a well-formed []) is
                // counted separately from a failure. Before, both looked like
                // "0 propositions written" and were indistinguishable.
                if (emptySession) emptySessions++;
                if (propositions.length > 0) {
                    const { written } = await writePropositions(lore, instance.question_id, nodeSessionId, sessionDate, propositions);
                    propositionsWritten += written;
                }
            } catch (err) {
                const message = (err as Error).message?.slice(0, 300) ?? String(err);
                failedSessions.push({ questionId: instance.question_id, sessionId: nodeSessionId, error: message });
                console.error(`  SKIPPED ${instance.question_id}/${nodeSessionId}: ${message}`);
            }
            if (sessionsProcessed % 50 === 0) {
                const realUsd = (realInputTokens / 1_000_000) * HAIKU_PRICE_PER_M.input + (realOutputTokens / 1_000_000) * HAIKU_PRICE_PER_M.output;
                console.log(
                    `  ${sessionsProcessed}/${totalSessions} sessions done, ${propositionsWritten} propositions written, ` +
                        `${failedSessions.length} skipped, real spend so far: $${realUsd.toFixed(4)}`,
                );
            }
        }
    }

    try {
        const concurrency = Math.max(1, args.concurrency ?? DEFAULT_QUESTION_CONCURRENCY);
        let nextIdx = 0;
        const workers = Array.from({ length: Math.min(concurrency, subset.length) }, async () => {
            while (nextIdx < subset.length) {
                const instance = subset[nextIdx++]!;
                await processQuestion(instance);
            }
        });
        await Promise.all(workers);
    } finally {
        await lore.dispose();
    }

    const finalUsd = (realInputTokens / 1_000_000) * HAIKU_PRICE_PER_M.input + (realOutputTokens / 1_000_000) * HAIKU_PRICE_PER_M.output;
    console.log(
        `\nDone: ${sessionsProcessed} sessions, ${propositionsWritten} propositions written. ` +
            `Real usage: ${realInputTokens} input + ${realOutputTokens} output tokens = $${finalUsd.toFixed(4)}.`,
    );
    console.log(
        `Extraction health: ${emptySessions} session(s) VERIFIED to have no extractable facts, ` +
            `${truncationRetries} needed a truncation retry, ${failedSessions.length} failed (count UNKNOWN for those).`,
    );
    if (failedSessions.length > 0) {
        console.log(`\n${failedSessions.length} session(s) SKIPPED (isolated failure, rest of the run completed):`);
        for (const f of failedSessions) console.log(`  ${f.questionId}/${f.sessionId}: ${f.error}`);
    }
}

main().catch((err) => {
    if (err instanceof PropositionExtractionUnavailableError) {
        console.error('MOSAIC BUILD UNAVAILABLE:', err.message);
    } else {
        console.error('buildMosaic FAILED:', err);
    }
    process.exitCode = 1;
});
