/**
 * ingest.ts — LongMemEval → Lore ingestion adapter.
 *
 * DESIGN DECISION: one Lore node per conversation TURN (not per session,
 * not per whole haystack).
 *
 * Why turn-level:
 *   - Matches how the benchmark itself grades retrieval: the official
 *     dataset marks `has_answer: true` on individual TURNS (not sessions),
 *     and the paper's own retrieval evaluation (`src/evaluation/
 *     print_retrieval_metrics.py` / `src/retrieval/eval_utils.py`) reports
 *     turn-level recall_all@k / ndcg@k as the primary retrieval metric
 *     (session-level is derived FROM turn-level by stripping the turn
 *     suffix off each doc id — turn-level is the finer-grained ground
 *     truth). Ingesting at turn granularity lets us compute the identical
 *     metric directly against Lore's own retrieval ranking.
 *   - A session-level node would force us to either (a) grade a whole
 *     session as "retrieved" even when only one irrelevant turn in a
 *     12-turn session matched the query embedding, inflating recall, or
 *     (b) pre-chunk sessions ourselves, which just re-derives turn
 *     boundaries the dataset already gives us for free.
 *   - Turn-level content is short (median ~440 chars per the dataset scan
 *     in benchmarks/longmemeval/README.md), which is a good match for
 *     Lore's node model (one semantic unit per node) and for
 *     Xenova/multilingual-e5-small's embedding window.
 *
 * ISOLATION: each LongMemEval instance's haystack is its own synthetic
 * conversation — filler sessions are sampled from ShareGPT/UltraChat and
 * CAN repeat the same `session_id` across different questions (they are
 * drawn from a shared filler pool). So every node id is prefixed with the
 * owning `question_id`, and every node is written under
 * `ecosystem: question_id` so `lore.recall()` scoped to that ecosystem only
 * ever searches within that question's own haystack — mirroring how a real
 * memory system serves one user/conversation at a time. All instances share
 * one Lore `workspace` ("longmemeval") to avoid paying Kùzu/LanceDB's
 * per-workspace directory cost 500 times over.
 */

import fs from 'node:fs';
import type { LoreInstance } from '../../../packages/lore/src/index.js';
import type { BulkIngestNodeArgs } from '../../../packages/lore/src/mcp/bulkIngest.js';
import type {
    EvidenceTurnRef,
    IngestedInstance,
    LongMemEvalInstance,
    LongMemEvalQuestionType,
} from './types.js';

export function loadDataset(filePath: string): LongMemEvalInstance[] {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as LongMemEvalInstance[];
    return data;
}

/**
 * Deterministic stratified sample across `question_type` so a small subset
 * still covers every ability category the paper reports on (proportional
 * to each category's share of the full 500, capped/floored so every
 * category present in the source gets at least 1 when n allows it).
 */
export function selectStratifiedSubset(
    data: LongMemEvalInstance[],
    n: number,
): LongMemEvalInstance[] {
    const byType = new Map<LongMemEvalQuestionType, LongMemEvalInstance[]>();
    for (const inst of data) {
        const arr = byType.get(inst.question_type) ?? [];
        arr.push(inst);
        byType.set(inst.question_type, arr);
    }
    const types = [...byType.keys()];
    const total = data.length;
    const picked: LongMemEvalInstance[] = [];
    for (const t of types) {
        const bucket = byType.get(t)!;
        const share = Math.max(1, Math.round((bucket.length / total) * n));
        picked.push(...bucket.slice(0, share));
    }
    // Trim/pad to exactly n while keeping deterministic order.
    if (picked.length > n) return picked.slice(0, n);
    if (picked.length < n) {
        const pickedIds = new Set(picked.map((p) => p.question_id));
        for (const inst of data) {
            if (picked.length >= n) break;
            if (!pickedIds.has(inst.question_id)) picked.push(inst);
        }
    }
    return picked;
}

export function buildNodeId(questionId: string, sessionId: string, turnIndex: number): string {
    return `${questionId}::${sessionId}::${turnIndex}`;
}

/**
 * Disambiguates session ids that repeat within ONE instance's own haystack —
 * a real, rare LongMemEval dataset quirk (found 2026-08-15: 13/500 questions
 * in longmemeval_s_cleaned.json have the identical session_id string at two
 * different haystack positions, with different actual turn content at each).
 * buildNodeId keys only on (questionId, sessionId, turnIndex), so two such
 * occurrences collide on id for every matching turn index. On a re-ingest
 * (existing row present) LanceDB's merge-insert correctly refuses the
 * resulting ambiguous write ("multiple source rows match the same target
 * row") and the whole batch fails; on a first-ever ingest it can silently
 * accept both writes under one shared id, which is worse — and the same
 * collision corrupts extraction's sourceNodeId-based `src=` provenance
 * tagging (countableEvents.ts), which the answering prompt relies on to tell
 * "same sentence" apart from "different occasion" — silently merging two
 * real, distinct occurrences into one.
 *
 * Only the 2nd+ occurrence of a repeated id gets a suffix, so all 487
 * unaffected questions' node ids are byte-identical to before this existed.
 */
export function disambiguateSessionIds(sessionIds: string[]): string[] {
    const seen = new Map<string, number>();
    return sessionIds.map((sid) => {
        const n = (seen.get(sid) ?? 0) + 1;
        seen.set(sid, n);
        return n === 1 ? sid : `${sid}#${n}`;
    });
}

/** Ingests one LongMemEval instance's full haystack as one bulk write.
 *
 * `autolink` (default false, preserving every existing data directory's
 * current behavior unchanged) — when true, passes autolink:true through to
 * bulkIngest, which fires a per-node similarity search that creates real
 * semantic_neighbor graph EDGES between nodes as they're written. Without
 * it (the long-standing default here — see this file's original "DESIGN
 * DECISION" header), retrieve()'s graph-traversal step has nothing to walk:
 * the graph substrate exists but is empty. Left opt-in rather than flipped
 * globally because it's a real ingest-time cost (one extra ONNX search per
 * node) — Mosaic turns it on deliberately; other callers are unaffected. */
export async function ingestInstance(
    lore: LoreInstance,
    instance: LongMemEvalInstance,
    opts: { autolink?: boolean } = {},
): Promise<IngestedInstance> {
    const start = Date.now();
    const nodes: BulkIngestNodeArgs[] = [];
    const evidenceTurns: EvidenceTurnRef[] = [];
    let totalTurns = 0;

    // Disambiguated once per instance — see disambiguateSessionIds. Used ONLY
    // for node-id construction; the human-readable session_id field/tag below
    // still carries the true, un-suffixed session id.
    const nodeSessionIds = disambiguateSessionIds(instance.haystack_session_ids);

    instance.haystack_sessions.forEach((session, sessionIdx) => {
        const sessionId = instance.haystack_session_ids[sessionIdx] ?? `session-${sessionIdx}`;
        const nodeSessionId = nodeSessionIds[sessionIdx] ?? sessionId;
        const sessionDate = instance.haystack_dates[sessionIdx] ?? null;
        session.forEach((turn, turnIdx) => {
            totalTurns += 1;
            const nodeId = buildNodeId(instance.question_id, nodeSessionId, turnIdx);
            // Date is prepended to the LABEL (not just stashed in a custom
            // nodeData field) because lore.recall()'s typed RecallNode result
            // only surfaces {id,type,label,content,tags,project,source,
            // language} — custom fields like a bare `session_date` do NOT
            // round-trip through recall(). Confirmed empirically 2026-08-12:
            // an answering pass over real retrieved temporal-reasoning turns
            // had no way to compute "how many days apart" without the date
            // being IN one of those surfaced fields. See README.md "Dates
            // must ride in the label".
            const label = sessionDate
                ? `[${sessionDate}] ${turn.role}: ${turn.content.slice(0, 80).replace(/\s+/g, ' ')}`
                : `${turn.role}: ${turn.content.slice(0, 80).replace(/\s+/g, ' ')}`;
            nodes.push({
                id: nodeId,
                workspace: 'longmemeval',
                ecosystem: instance.question_id,
                nodeData: {
                    id: nodeId,
                    ecosystem: instance.question_id,
                    type: 'conversation_turn',
                    label,
                    content: turn.content,
                    tags: [
                        `role:${turn.role}`,
                        `session:${sessionId}`,
                        ...(turn.has_answer ? ['evidence'] : []),
                    ],
                    session_id: sessionId,
                    session_date: sessionDate,
                    turn_index: turnIdx,
                },
            });
            if (turn.has_answer) {
                evidenceTurns.push({ sessionId, turnIndex: turnIdx, nodeId });
            }
        });
    });

    const result = await lore.bulkIngest(nodes, { autolink: opts.autolink ?? false, embed: 'sync' });
    if (!result.ok) {
        const failed = result.results.filter((r) => !r.ok);
        throw new Error(
            `bulkIngest reported failures for ${instance.question_id}: ${failed.length}/${result.count} failed. ` +
                `First error: ${JSON.stringify(failed[0])}`,
        );
    }

    return {
        questionId: instance.question_id,
        ecosystem: instance.question_id,
        totalTurns,
        totalSessions: instance.haystack_sessions.length,
        evidenceTurns,
        ingestMs: Date.now() - start,
    };
}
