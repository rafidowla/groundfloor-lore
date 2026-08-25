#!/usr/bin/env tsx
/**
 * extractCountableFacts.ts — the COST-GATED ingest-time extraction pass.
 *
 * One LLM call per session: read the session's turns, return every
 * countable/quantifiable fact, insert into `countable_events` (see
 * extractFacts.ts + countableEvents.ts). This is deliberately a SEPARATE
 * script from runSubset.ts — runSubset only READS the table at answer time
 * and never triggers extraction, so a normal benchmark run stays free of
 * extraction cost.
 *
 * COST CONTROL (mandatory, per the task brief):
 *   - Run with `--dry-run` FIRST. It computes the EXACT number of LLM calls
 *     (= sessions in the selected subset) and an estimated cost, and makes
 *     ZERO calls. Get explicit go-ahead on the reported numbers before any
 *     real run.
 *   - Extraction only ever covers sessions of questions in the selected
 *     subset (never the full 500 unless `--n 500` is explicitly passed).
 *
 * Usage:
 *   tsx benchmarks/longmemeval/src/extractCountableFacts.ts --dry-run --n 25
 *   tsx benchmarks/longmemeval/src/extractCountableFacts.ts --dry-run --n 25 --question-types multi-session
 *   tsx benchmarks/longmemeval/src/extractCountableFacts.ts --n 25 [--model gpt-4o-mini] [--concurrency 6]
 *
 * --concurrency N processes N questions at once (each question's own
 * sessions still run one at a time — see the comment in main() for why).
 * Default DEFAULT_QUESTION_CONCURRENCY. This is the main lever for wall-clock
 * time: sequential (--concurrency 1) means every one of the exact-call-count
 * calls above waits for the previous one to finish.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenchmarkLore } from './loreClient.js';
import { loadDataset, selectStratifiedSubset, disambiguateSessionIds } from './ingest.js';
import type { LongMemEvalInstance, LongMemEvalQuestionType } from './types.js';
import { extractFactsFromSession, ExtractionUnavailableError } from './extractFacts.js';
import { writeCountableFacts } from './countableEvents.js';
import { estimateExtractionCost, DEFAULT_EXTRACT_MODEL, EST_INPUT_TOKENS_PER_SESSION, EST_OUTPUT_TOKENS_PER_SESSION } from './extractionCost.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(HERE, '..');
const DEFAULT_QUESTION_CONCURRENCY = 6;

interface Args {
    n: number;
    dataset: string;
    dataDir: string;
    model?: string;
    questionTypes?: LongMemEvalQuestionType[];
    dryRun: boolean;
    sessionCap?: number;
    /** How many QUESTIONS to process concurrently (each question's own
     *  sessions still run one at a time — see the concurrency comment in
     *  main() for why). Default DEFAULT_QUESTION_CONCURRENCY. */
    concurrency?: number;
    /** Explicit question_id list — bypasses --n/--question-types/stratified
     *  selection entirely, extracting exactly (and only) these questions'
     *  sessions, in the given order. Matches runSubset.ts's --question-ids
     *  so the two scripts can target the identical set for a before/after
     *  comparison. */
    questionIds?: string[];
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        n: 25,
        dataset: path.join(BENCH_ROOT, 'data', 'longmemeval_s_cleaned.json'),
        dataDir: path.join(BENCH_ROOT, 'lore-home'),
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const next = () => argv[++i];
        if (a === '--n') args.n = Number(next());
        else if (a === '--dataset') args.dataset = next()!;
        else if (a === '--data-dir') args.dataDir = next()!;
        else if (a === '--model') args.model = next();
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--session-cap') args.sessionCap = Number(next());
        else if (a === '--question-types') args.questionTypes = next()!.split(',').map((t) => t.trim()) as LongMemEvalQuestionType[];
        else if (a === '--question-ids') args.questionIds = next()!.split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--concurrency') args.concurrency = Number(next());
        else throw new Error(`Unknown arg: ${a}`);
    }
    return args;
}


function filterByTypes(
    data: LongMemEvalInstance[],
    types: LongMemEvalQuestionType[],
): LongMemEvalInstance[] {
    const wanted = new Set(types);
    return data.filter((i) => wanted.has(i.question_type));
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(args.dataset)) {
        throw new Error(`Dataset not found at ${args.dataset}.`);
    }

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
        // Filter to the requested question types FIRST, then stratify — so
        // `--n 5 --question-types multi-session` means "5 multi-session
        // questions", not "5 stratified questions, then keep the multi-session
        // ones among them".
        const pool = args.questionTypes && args.questionTypes.length > 0
            ? filterByTypes(full, args.questionTypes)
            : full;
        subset = selectStratifiedSubset(pool, args.n);
    }

    const totalSessions = subset.reduce((s, i) => s + i.haystack_sessions.length, 0);
    const totalTurns = subset.reduce((s, i) => s + i.haystack_sessions.reduce((a, sess) => a + sess.length, 0), 0);
    const cost = estimateExtractionCost(totalSessions, args.model ?? DEFAULT_EXTRACT_MODEL);

    console.log(`Extraction subset: ${subset.length} questions / ${totalSessions} sessions / ${totalTurns} turns`);
    console.log(`Exact LLM call count: ${totalSessions} (one per session)`);
    console.log(`Estimated tokens: ~${cost.inputTokens.toLocaleString()} input + ~${cost.outputTokens.toLocaleString()} output`);
    console.log(
        `Estimated cost: ~$${cost.usd} (${cost.model}` +
            (cost.priceKnown ? '' : ' — UNKNOWN MODEL, using gpt-4o-mini pricing as a rough stand-in, treat this number as unreliable') +
            `; assuming ${EST_INPUT_TOKENS_PER_SESSION} in / ${EST_OUTPUT_TOKENS_PER_SESSION} out tokens per session)`,
    );

    if (args.dryRun) {
        console.log('DRY RUN — made zero LLM calls. Get explicit go-ahead before running without --dry-run.');
        return;
    }

    const { lore } = await createBenchmarkLore(args.dataDir);
    let processed = 0;
    let totalFacts = 0;
    let sessionsWithFacts = 0;
    let sessionCapHit = false;
    // Per-session isolation (mirrors bulkIngest.ts's contract elsewhere in
    // this codebase: one bad item fails in its own slot, the rest still
    // land) — found necessary 2026-08-14: a single unusually fact-dense
    // session overflowed even the retry budget in extractFacts.ts, and
    // without this, that ONE session killed the entire multi-hundred-call
    // run, discarding every already-paid-for successful extraction with it.
    const failedSessions: Array<{ questionId: string; sessionId: string; error: string }> = [];

    // Process one QUESTION's sessions in order (sequential within a
    // question — see the concurrency comment below for why).
    async function processQuestion(instance: LongMemEvalInstance): Promise<void> {
        // Disambiguated once per instance (see ingest.ts's disambiguateSessionIds
        // for the full rationale) — a repeated session_id within one question's
        // own haystack would otherwise make two different facts' sourceNodeId
        // collide, corrupting the `src=` provenance tagging the answering
        // prompt relies on to tell "same sentence" apart from "different
        // occasion" for counting questions.
        const nodeSessionIds = disambiguateSessionIds(instance.haystack_session_ids);
        for (let s = 0; s < instance.haystack_sessions.length; s++) {
            if (args.sessionCap != null && processed >= args.sessionCap) { sessionCapHit = true; return; }
            const sessionId = instance.haystack_session_ids[s] ?? `session-${s}`;
            const nodeSessionId = nodeSessionIds[s] ?? sessionId;
            const sessionDate = instance.haystack_dates[s] ?? null;
            const turns = instance.haystack_sessions[s]!;
            processed++;
            try {
                const facts = await extractFactsFromSession({
                    questionId: instance.question_id,
                    sessionId: nodeSessionId,
                    sessionDate,
                    turns,
                    modelOverride: args.model,
                });
                if (facts.length > 0) {
                    await writeCountableFacts(lore.store.tableStorage, instance.question_id, facts);
                    totalFacts += facts.length;
                    sessionsWithFacts++;
                }
            } catch (err) {
                const message = (err as Error).message?.slice(0, 300) ?? String(err);
                failedSessions.push({ questionId: instance.question_id, sessionId, error: message });
                console.error(`  SKIPPED ${instance.question_id}/${sessionId}: ${message}`);
            }
            if (processed % 100 === 0) {
                console.log(`  ${processed}/${totalSessions} sessions done, ${totalFacts} facts so far, ${failedSessions.length} skipped`);
            }
        }
    }

    try {
        // Parallel ACROSS questions, sequential WITHIN a question.
        // writeCountableFacts does a read-then-write (check which facts
        // already exist, then insert the new ones) with no locking — two
        // sessions of the SAME question racing that could both decide to
        // insert an identical fact at once. Two sessions of DIFFERENT
        // questions never touch each other's rows at all (separate
        // ecosystem), so they're always safe together. With 20 questions and
        // ~40-50 sessions each, most of the real speedup is here anyway —
        // this gets it without touching the write path's locking at all.
        const concurrency = Math.max(1, args.concurrency ?? DEFAULT_QUESTION_CONCURRENCY);
        let nextIdx = 0;
        const workers = Array.from({ length: Math.min(concurrency, subset.length) }, async () => {
            while (nextIdx < subset.length) {
                if (sessionCapHit) return;
                const instance = subset[nextIdx++]!;
                await processQuestion(instance);
            }
        });
        await Promise.all(workers);
    } finally {
        await lore.dispose();
    }

    console.log(`\nDone: ${processed} sessions, ${sessionsWithFacts} with facts, ${totalFacts} facts written to countable_events.`);
    if (failedSessions.length > 0) {
        console.log(`\n${failedSessions.length} session(s) SKIPPED (isolated failure, rest of the run completed):`);
        for (const f of failedSessions) console.log(`  ${f.questionId}/${f.sessionId}: ${f.error}`);
    }
}

main().catch((err) => {
    if (err instanceof ExtractionUnavailableError) {
        console.error('EXTRACTION UNAVAILABLE:', err.message);
    } else {
        console.error('extractCountableFacts FAILED:', err);
    }
    process.exitCode = 1;
});
