/**
 * gradeAudit.ts — heuristic flags for judge grades worth a manual/agent
 * double-check, plus the human-corrected accuracy once flagged cases have
 * been reviewed.
 *
 * Doesn't change grading — flags candidates for review. A real misgrade was
 * already found this way by hand (see README "judge noise"): the official
 * judge marked an explicit "the excerpts do not contain enough information"
 * non-answer as correct on a non-abstention question. HEDGE_PATTERNS below
 * is built directly from that confirmed case, not a guess.
 *
 * Pure, deterministic, no API calls — safe to run over an existing results
 * JSON file at zero cost (see auditGrades.ts).
 */

const HEDGE_PATTERNS: RegExp[] = [
    /\bnot enough information\b/i,
    /\bdo(?:es)? not (?:contain|include|provide) enough\b/i,
    /\binsufficient information\b/i,
    /\bcannot determine\b/i,
    /\bunable to determine\b/i,
    /\bi don'?t know\b/i,
    /\bno information\b/i,
    /\bnot (?:clear|specified|mentioned)\b/i,
    /\bunclear from\b/i,
];

export interface GradeAuditInput {
    questionId: string;
    isAbstention: boolean;
    answerText: string | null | undefined;
    judgeLabel: boolean;
    judgeRawResponse: string | null | undefined;
}

export interface BorderlineFlag {
    questionId: string;
    reasons: string[];
}

/** Pure heuristic — no API calls, fully deterministic, unit-testable. */
export function flagBorderlineGrade(input: GradeAuditInput): BorderlineFlag | null {
    const reasons: string[] = [];

    // The confirmed real misgrade pattern: an answer that reads as a
    // non-answer/hedge, graded correct, on a question that ISN'T itself an
    // abstention question (abstention questions are supposed to be graded
    // "did the model correctly decline" — a hedge there is a legitimate
    // pass, not a red flag).
    if (!input.isAbstention && input.judgeLabel && input.answerText) {
        const hit = HEDGE_PATTERNS.find((p) => p.test(input.answerText!));
        if (hit) reasons.push(`answer reads as a hedge/non-answer (matched ${hit.source}) but was graded correct`);
    }

    // The official prompt asks for "yes or no only" (judge.ts). Anything
    // else means the judge's raw output didn't cleanly parse as one or the
    // other, even though judge.ts's `.includes('yes')` parse still produced
    // a label from it — worth a human look regardless of which way it went.
    if (input.judgeRawResponse && !/^(yes|no)\.?$/i.test(input.judgeRawResponse.trim())) {
        reasons.push(`judge raw response wasn't a clean yes/no: "${input.judgeRawResponse}"`);
    }

    return reasons.length > 0 ? { questionId: input.questionId, reasons } : null;
}

export interface HumanCorrectedSummary {
    total: number;
    officialAccuracy: number;
    flaggedCount: number;
    overriddenCount: number;
    humanCorrectedAccuracy: number;
}

/**
 * `flagged` — questionIds flagBorderlineGrade() flagged for review.
 * `overrides` — the subset of those a reviewer actually decided to flip,
 * questionId -> corrected label. Flagged-but-confirmed-correct cases don't
 * need an entry here; only overturned ones do.
 */
export function computeHumanCorrectedAccuracy(
    graded: Array<{ questionId: string; judgeLabel: boolean }>,
    flagged: ReadonlySet<string>,
    overrides: ReadonlyMap<string, boolean>,
): HumanCorrectedSummary {
    const total = graded.length;
    const officialAccuracy = total === 0 ? 0 : graded.filter((g) => g.judgeLabel).length / total;
    const corrected = graded.map((g) => overrides.get(g.questionId) ?? g.judgeLabel);
    const humanCorrectedAccuracy = total === 0 ? 0 : corrected.filter(Boolean).length / total;
    return {
        total,
        officialAccuracy,
        flaggedCount: flagged.size,
        overriddenCount: overrides.size,
        humanCorrectedAccuracy,
    };
}
