/**
 * judgeMajority.ts — optional, SECOND, self-audited judge score.
 *
 * The official protocol (judge.ts) is a single gpt-4o-2024-08-06 call per
 * verdict — that's what every published competitor number also used, so
 * that's what has to stay untouched for comparability. This module runs the
 * SAME official judge multiple times per verdict and takes a majority vote,
 * to measure how much of the observed accuracy is judge noise rather than
 * answer quality. Report it ALONGSIDE the official number, never in place of
 * it — decided 2026-08-13.
 *
 * `judgeFn` is injectable so this is unit-testable with zero live API calls
 * (see judgeMajority.unit.ts) — production callers just omit it and get the
 * real judge.ts:judgeAnswer.
 */

import { judgeAnswer, type JudgeVerdict } from './judge.js';
import type { LongMemEvalQuestionType } from './types.js';

export type JudgeFn = typeof judgeAnswer;

export interface MajorityVerdict {
    majorityLabel: boolean;
    votes: JudgeVerdict[];
    /** Fraction of votes agreeing with majorityLabel, in (0.5, 1]. */
    agreement: number;
}

export async function judgeAnswerMajority(
    questionId: string,
    questionType: LongMemEvalQuestionType,
    question: string,
    expectedAnswer: string,
    modelResponse: string,
    opts: { votes?: number; judgeFn?: JudgeFn } = {},
): Promise<MajorityVerdict> {
    const voteCount = opts.votes ?? 3;
    if (!Number.isInteger(voteCount) || voteCount < 1 || voteCount % 2 === 0) {
        throw new Error(`judgeAnswerMajority: votes must be a positive odd integer to avoid ties (got ${voteCount})`);
    }
    const judgeFn = opts.judgeFn ?? judgeAnswer;

    const votes = await Promise.all(
        Array.from({ length: voteCount }, () =>
            judgeFn(questionId, questionType, question, expectedAnswer, modelResponse)),
    );

    const trueCount = votes.filter((v) => v.label).length;
    const majorityLabel = trueCount > voteCount / 2;
    const agreeCount = majorityLabel ? trueCount : voteCount - trueCount;
    return { majorityLabel, votes, agreement: agreeCount / voteCount };
}
