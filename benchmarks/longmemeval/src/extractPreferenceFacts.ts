#!/usr/bin/env tsx
/**
 * extractPreferenceFacts.ts — the COST-GATED ingest-time extraction pass for
 * stated preferences/opinions. Mirrors extractCountableFacts.ts structurally
 * (same cost gate, same concurrency model, same per-session isolation) —
 * see preferenceEvents.ts's header for why a second extraction pipeline
 * exists alongside the countable one instead of folding preferences into it.
 *
 * One LLM call per session: read the session's turns, return every stated
 * preference, insert into `preference_events` (see
 * preferenceFactExtraction.ts + preferenceEvents.ts). This is deliberately a
 * SEPARATE script from runSubset.ts — runSubset only READS the table at
 * answer time and never triggers extraction, so a normal benchmark run stays
 * free of extraction cost.
 *
 * COST CONTROL (mandatory, per the task brief — identical policy to
 * extractCountableFacts.ts):
 *   - Run with `--dry-run` FIRST. It computes the EXACT number of LLM calls
 *     (= sessions in the selected subset) and an estimated cost, and makes
 *     ZERO calls. Get explicit go-ahead on the reported numbers before any
 *     real run.
 *   - Extraction only ever covers sessions of questions in the selected
 *     subset (never the full 500 unless `--n 500` is explicitly passed).
 *
 * Usage:
 *   tsx benchmarks/longmemeval/src/extractPreferenceFacts.ts --dry-run --n 25
 *   tsx benchmarks/longmemeval/src/extractPreferenceFacts.ts --dry-run --n 25 --question-types single-session-preference
 *   tsx benchmarks/longmemeval/src/extractPreferenceFacts.ts --n 25 [--model gpt-4o-mini] [--concurrency 6]
 *       [--engine surreal-lance|sqlite]
 *
 * No `--question-types` default restriction to `single-session-preference`:
 * a preference can be stated in a session belonging to ANY question type
 * (e.g. a multi-session question's haystack can still contain an offhand "I
 * love spicy food"), exactly the same reasoning extractCountableFacts.ts
 * applies to countable facts. Pass `--question-types single-session-preference`
 * explicitly to scope a run to just that category.
 *
 * --engine MUST match whatever runSubset.ts is run with against the same
 * --data-dir — see extractCountableFacts.ts's header comment and
 * loreClient.ts's 2026-09-20 note for why a mismatch is a real, silent
 * failure mode (workspaces.json's declared engines get rewritten on every
 * createBenchmarkLore() call).
 *
 * --concurrency N processes N questions at once (each question's own
 * sessions still run one at a time — see the comment in main() for why).
 * Default DEFAULT_QUESTION_CONCURRENCY.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenchmarkLore, engineProfileFor } from './loreClient.js';
import { loadDataset, selectStratifiedSubset, disambiguateSessionIds } from './ingest.js';
import type { LongMemEvalInstance, LongMemEvalQuestionType } from './types.js';
import { extractPreferenceFactsFromSession, PreferenceExtractionUnavailableError } from './preferenceFactExtraction.js';
import { writePreferenceFacts } from './preferenceEvents.js';
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
     *  sessions, in the given order. Matches runSubset.ts's / extractCountableFacts.ts's
     *  --question-ids so extraction can target an identical set for a
     *  before/after comparison. */
    questionIds?: string[];
    /** Which graph/vector engines the target --data-dir's workspace runs —
     *  must match whatever runSubset.ts uses against the same --data-dir.
     *  See loreClient.ts's 2026-09-20 note and this file's header comment. */
    engine: 'surreal-lance' | 'sqlite';
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        n: 25,
        dataset: path.join(BENCH_ROOT, 'data', 'longmemeval_s_cleaned.json'),
        dataDir: path.join(BENCH_ROOT, 'lore-home'),
        dryRun: false,
        engine: 'surreal-lance',
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
        else if (a === '--engine') {
            const raw = next();
            if (raw !== 'surreal-lance' && raw !== 'sqlite') {
                throw new Error(`--engine must be "surreal-lance" or "sqlite", got "${raw}"`);
            }
            args.engine = raw;
        }
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
        // `--n 5 --question-types single-session-preference` means "5
        // single-session-preference questions", not "5 stratified questions,
        // then keep the preference ones among them".
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

    const { lore } = await createBenchmarkLore(args.dataDir, engineProfileFor(args.engine));
    let processed = 0;
    let totalFacts = 0;
    let sessionsWithFacts = 0;
    let sessionCapHit = false;
    // Per-session isolation — identical contract to extractCountableFacts.ts:
    // one bad session fails in its own slot, the rest of the run still lands.
    const failedSessions: Array<{ questionId: string; sessionId: string; error: string }> = [];

    // Process one QUESTION's sessions in order (sequential within a
    // question — see the concurrency comment below for why).
    async function processQuestion(instance: LongMemEvalInstance): Promise<void> {
        // Disambiguated once per instance (see ingest.ts's disambiguateSessionIds
        // for the full rationale) — a repeated session_id within one question's
        // own haystack would otherwise make two different facts' sourceNodeId
        // collide, corrupting the `src=` provenance tagging the answering
        // prompt relies on.
        const nodeSessionIds = disambiguateSessionIds(instance.haystack_session_ids);
        for (let s = 0; s < instance.haystack_sessions.length; s++) {
            if (args.sessionCap != null && processed >= args.sessionCap) { sessionCapHit = true; return; }
            const sessionId = instance.haystack_session_ids[s] ?? `session-${s}`;
            const nodeSessionId = nodeSessionIds[s] ?? sessionId;
            const turns = instance.haystack_sessions[s]!;
            processed++;
            try {
                const facts = await extractPreferenceFactsFromSession({
                    questionId: instance.question_id,
                    sessionId: nodeSessionId,
                    turns,
                    modelOverride: args.model,
                });
                if (facts.length > 0) {
                    await writePreferenceFacts(lore.store.tableStorage, instance.question_id, facts);
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
        // Parallel ACROSS questions, sequential WITHIN a question — identical
        // reasoning to extractCountableFacts.ts: writePreferenceFacts does a
        // read-then-write with no locking, so two sessions of the SAME
        // question racing could both decide to insert an identical fact at
        // once, while two sessions of DIFFERENT questions never touch each
        // other's rows (separate ecosystem).
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

    console.log(`\nDone: ${processed} sessions, ${sessionsWithFacts} with facts, ${totalFacts} facts written to preference_events.`);
    if (failedSessions.length > 0) {
        console.log(`\n${failedSessions.length} session(s) SKIPPED (isolated failure, rest of the run completed):`);
        for (const f of failedSessions) console.log(`  ${f.questionId}/${f.sessionId}: ${f.error}`);
    }
}

main().catch((err) => {
    if (err instanceof PreferenceExtractionUnavailableError) {
        console.error('EXTRACTION UNAVAILABLE:', err.message);
    } else {
        console.error('extractPreferenceFacts FAILED:', err);
    }
    process.exitCode = 1;
});
