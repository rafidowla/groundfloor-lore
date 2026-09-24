/**
 * retrievalStrategies.ts — single-query vs. decomposed-multi-query retrieval,
 * extracted out of runSubset.ts's main loop (2026-09-20) to keep that file
 * under the repo's file-size budget (see ../../../CLAUDE.md "File Size
 * Budget") while wiring in queryDecompose.ts's --decompose-multi-session path.
 *
 * Exactly one function, `retrieveKnowledge`, replaces the single
 * `lore.recall()` call runSubset.ts used to make inline. It reuses the EXACT
 * SAME recall() parameters (workspace/ecosystem/mode/max/searchMode) the
 * inline call always used — the only thing that varies across sub-queries is
 * the topic string — then merges the per-sub-query result lists with
 * queryDecompose.ts's `mergeRecallResults` (Reciprocal Rank Fusion). See
 * queryDecompose.ts's header for why RRF is the right merge strategy here.
 *
 * ─── Evidence-based decomposition trigger (2026-09-21) ───
 *
 * This function used to take an `isMultiSession` flag computed by the caller
 * from detectQuestionType.ts's guess OR'd with the dataset's ground-truth
 * question_type. Measured against the full 500-question dataset, that guess
 * is right only 42.9% of the time for multi-session questions specifically —
 * worse than a coin flip on the one category the flag exists to help,
 * because nothing about how a multi-session question is WORDED reliably
 * distinguishes it from a single-session one; the only real signal is a fact
 * about the conversation data (relevant evidence scattered across many
 * sessions instead of concentrated in one), not the question text. Ground
 * truth also has no live/production equivalent outside this benchmark, so
 * the old gate couldn't have shipped as-is anyway.
 *
 * The fix: always run the base single-query recall first (this is the SAME
 * call this function always made on the no-decompose path — no extra cost),
 * then look at what it actually found. Every ingested node carries a
 * `session:<id>` tag (see ingest.ts) — if the top-ranked results already
 * touch several distinct sessions, that itself IS the multi-session signal,
 * regardless of what the question's wording looks like. Only then is the
 * extra cost of decomposeQuery() + N more recall() calls spent. A
 * single-session question's top results should almost always cluster in one
 * or two sessions no matter how it's phrased, so the common case stays as
 * cheap as before this change.
 *
 * Fallback contract: `decomposeQuery()` deliberately throws rather than
 * silently degrading to `[question]` (see its header) — that fallback is
 * this caller's job, mirroring extractCountableFacts.ts's per-session
 * isolation philosophy (one question's decomposition failing must never
 * abort the whole benchmark run). Unlike the pre-2026-09-21 version, the
 * fallback no longer re-runs recall() on the original question — the base
 * recall computed for the evidence check above IS that same query's result,
 * so it's reused directly rather than fetched twice. `decomposeAttempted` on
 * the returned outcome is true whenever the evidence signal crossed the
 * threshold (i.e. decomposition was actually tried), regardless of whether
 * the attempt succeeded or fell back — `subQueryCount` tells you which
 * happened (2-5 = real decomposition, 1 = fallback to the base recall,
 * matching decomposeQuery()'s own MIN/MAX_SUB_QUERIES contract).
 */

import { WORKSPACE } from './loreClient.js';
import { decomposeQuery, mergeRecallResults } from './queryDecompose.js';
import type { LoreInstance } from '../../../packages/lore/src/index.js';
import type { LongMemEvalInstance } from './types.js';
import type { RecallNode } from '../../../packages/lore/src/recall/recallPreset.js';

export interface RetrievalOutcome {
    /** Final ranked, deduped candidate list — a single recall() result when
     *  decomposition wasn't attempted or wasn't applicable, or the RRF-merged
     *  union of the base recall plus one recall() call per sub-query when it
     *  was. */
    knowledge: RecallNode[];
    retrieveMs: number;
    /** Whether this instance's evidence signal crossed SESSION_SPREAD_THRESHOLD
     *  and so actually went through decomposeQuery() — see this file's header
     *  ("Evidence-based decomposition trigger"). Always false when
     *  `opts.decomposeMultiSession` is off. */
    decomposeAttempted: boolean;
    /** Sub-queries actually used for retrieval: 0 when decomposition wasn't
     *  attempted, 2-5 on a successful decomposition, 1 on a fallback to the
     *  base recall (decomposeQuery() failed or threw). */
    decomposeSubQueryCount: number;
    /** How many distinct sessions (by each node's `session:<id>` tag) were
     *  present among the top SESSION_SPREAD_TOP_K nodes of the BASE recall —
     *  the evidence signal this function used to decide whether to escalate
     *  to decomposition. Always 0 when `opts.decomposeMultiSession` is off
     *  (the signal is never computed, since it would never be used). */
    sessionSpreadCount: number;
}

export interface RetrievalOptions {
    /** --decompose-multi-session on|off (runSubset.ts), resolved to a bool.
     *  This is the only input controlling whether decomposition is even a
     *  candidate for this instance — whether it actually FIRES is decided
     *  from the base recall's own results, not from a pre-search guess (see
     *  this file's header). */
    decomposeMultiSession: boolean;
}

// See this file's header ("Evidence-based decomposition trigger") for the
// full rationale. Starting estimates, not tuned against held-out data — there
// wasn't a labeled "how scattered is scattered enough" set to tune against.
// Chosen to be conservative: cheap to be wrong in the "skip decomposition"
// direction (falls back to the pre-existing single-query behavior), expensive
// to be wrong in the "always decompose" direction (an LLM call + N extra
// recall() calls on every question). Revisit once this has real accuracy
// numbers behind it.
const SESSION_SPREAD_TOP_K = 20;
const SESSION_SPREAD_THRESHOLD = 5;

/**
 * Extracts the `session:<id>` tag ingest.ts writes onto every
 * conversation-turn node — the only place a session identity survives the
 * round-trip through lore.recall(), since RecallNode doesn't surface
 * arbitrary custom fields (see ingest.ts's own comment on why the session
 * date rides in the label for the same reason). Returns null for a node
 * with no such tag — shouldn't happen for this harness's own nodes, but a
 * foreign/contaminated node (see the `contaminated` diagnostic in
 * runSubset.ts) could lack one.
 */
function sessionIdOf(node: RecallNode): string | null {
    const tag = node.tags.find((t) => t.startsWith('session:'));
    return tag ? tag.slice('session:'.length) : null;
}

/**
 * How many distinct sessions are represented among the top `topK` ranked
 * nodes of `knowledge` (already relevance-ordered by recall()). Pure,
 * exported for unit testing.
 */
export function countSessionSpread(knowledge: RecallNode[], topK: number): number {
    const sessions = new Set<string>();
    for (const node of knowledge.slice(0, topK)) {
        const sessionId = sessionIdOf(node);
        if (sessionId) sessions.add(sessionId);
    }
    return sessions.size;
}

/**
 * Runs retrieval for one instance: always the base single lore.recall() call
 * (unchanged, pre-2026-09-20 shape). When `decomposeMultiSession` is on, the
 * base result's session spread is then checked (see header) and, only if it
 * crosses SESSION_SPREAD_THRESHOLD, the question is decomposed into several
 * sub-queries, each recalled separately (same params, reused verbatim), and
 * merged together with the base recall.
 */
export async function retrieveKnowledge(
    lore: LoreInstance,
    instance: LongMemEvalInstance,
    rawFetchDepth: number,
    opts: RetrievalOptions,
): Promise<RetrievalOutcome> {
    const baseRecallParams = {
        workspace: WORKSPACE,
        ecosystem: instance.question_id,
        mode: 'full' as const,
        max: rawFetchDepth,
        searchMode: 'hybrid' as const,
    };

    const start = Date.now();
    const baseRecallResult = await lore.recall(instance.question, baseRecallParams);
    const baseKnowledge = baseRecallResult.mode === 'full' ? baseRecallResult.knowledge : [];

    if (!opts.decomposeMultiSession) {
        return {
            knowledge: baseKnowledge,
            retrieveMs: Date.now() - start,
            decomposeAttempted: false,
            decomposeSubQueryCount: 0,
            sessionSpreadCount: 0,
        };
    }

    const sessionSpreadCount = countSessionSpread(baseKnowledge, SESSION_SPREAD_TOP_K);
    if (sessionSpreadCount < SESSION_SPREAD_THRESHOLD) {
        return {
            knowledge: baseKnowledge,
            retrieveMs: Date.now() - start,
            decomposeAttempted: false,
            decomposeSubQueryCount: 0,
            sessionSpreadCount,
        };
    }

    let subQueries: string[];
    try {
        subQueries = await decomposeQuery(instance.question, instance.question_date);
    } catch (err) {
        // decomposeQuery() intentionally does not fall back itself (see its
        // header) — one question's decomposition failing must fall back to
        // the base recall already computed above, not abort the whole run,
        // and not pay for a second identical recall() call.
        console.log(
            `  decompose-multi-session: decomposition unavailable (${(err as Error).message}), ` +
                'falling back to the base recall already retrieved above',
        );
        return {
            knowledge: baseKnowledge,
            retrieveMs: Date.now() - start,
            decomposeAttempted: true,
            decomposeSubQueryCount: 1,
            sessionSpreadCount,
        };
    }

    const resultsPerSubQuery: RecallNode[][] = [baseKnowledge];
    for (const subQuery of subQueries) {
        const recallResult = await lore.recall(subQuery, baseRecallParams);
        resultsPerSubQuery.push(recallResult.mode === 'full' ? recallResult.knowledge : []);
    }

    return {
        knowledge: mergeRecallResults(resultsPerSubQuery),
        retrieveMs: Date.now() - start,
        decomposeAttempted: true,
        decomposeSubQueryCount: subQueries.length,
        sessionSpreadCount,
    };
}
