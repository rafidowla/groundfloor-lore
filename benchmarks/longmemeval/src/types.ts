/**
 * types.ts — LongMemEval dataset shape.
 *
 * Mirrors the schema documented in the official repo README
 * (https://github.com/xiaowu0162/LongMemEval) and verified empirically
 * against `longmemeval_s_cleaned.json` (500 instances, fields below present
 * on every instance we inspected).
 */

export type LongMemEvalRole = 'user' | 'assistant';

export interface LongMemEvalTurn {
    role: LongMemEvalRole;
    content: string;
    /** Present (true) only on turns that contain the evidence needed to
     *  answer the question. Used for turn-level retrieval evaluation. */
    has_answer?: boolean;
}

export type LongMemEvalQuestionType =
    | 'single-session-user'
    | 'single-session-assistant'
    | 'single-session-preference'
    | 'temporal-reasoning'
    | 'knowledge-update'
    | 'multi-session';

export interface LongMemEvalInstance {
    question_id: string;
    question_type: LongMemEvalQuestionType;
    question: string;
    question_date: string;
    /** Expected answer (or grading rubric, for single-session-preference). */
    answer: string;
    /** Session ids that carry the evidence. Sessions named 'answer_*' when
     *  synthesized as new evidence not sourced from an existing haystack
     *  session id. */
    answer_session_ids: string[];
    haystack_dates: string[];
    haystack_session_ids: string[];
    haystack_sessions: LongMemEvalTurn[][];
}

/** True when the question is an "abstention" instance — the model is
 *  expected to recognize the question as unanswerable from the given
 *  history. Signaled by a `_abs` suffix on `question_id`, per the paper. */
export function isAbstentionQuestion(questionId: string): boolean {
    return questionId.includes('_abs');
}

export interface EvidenceTurnRef {
    sessionId: string;
    turnIndex: number;
    /** The deterministic Lore node id this turn was ingested as. */
    nodeId: string;
}

/** Per-instance record of what was ingested, so retrieval evaluation does
 *  not have to re-derive ground truth from the raw dataset. */
export interface IngestedInstance {
    questionId: string;
    ecosystem: string;
    totalTurns: number;
    totalSessions: number;
    evidenceTurns: EvidenceTurnRef[];
    ingestMs: number;
}
