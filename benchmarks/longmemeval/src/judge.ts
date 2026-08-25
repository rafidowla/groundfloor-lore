/**
 * judge.ts — official LongMemEval grading, ported verbatim from
 * `src/evaluation/evaluate_qa.py` in xiaowu0162/LongMemEval.
 *
 * NON-NEGOTIABLE: the paper's published numbers (and every competitor's
 * published LongMemEval numbers — Mem0, Zep, Letta, Cognee, Supermemory)
 * are graded by `gpt-4o-2024-08-06` via the OpenAI API using these exact
 * prompt templates (`get_anscheck_prompt` below is a byte-for-byte port —
 * do not edit the template strings). A score produced with any other judge
 * model is NOT the same metric and is NOT comparable to those published
 * numbers, even if the harness prints something that looks like "accuracy".
 *
 * This module refuses to run against anything else. If OPENAI_API_KEY is
 * not set, `judgeAnswer()` throws `JudgeUnavailableError` instead of
 * silently falling back to a different model or a different provider.
 * Callers MUST surface that as a loud, visible block — never swallow it and
 * report a number.
 */

import type { LongMemEvalQuestionType } from './types.js';
import { resolveOpenAiGateway } from './openaiGateway.js';
import { fetchWithRetry } from './fetchWithRetry.js';

// Uses Node's built-in fetch (Node >=18) against the OpenAI REST API
// directly rather than pulling in the `openai` npm package as a new
// dependency of the root workspace — this harness only needs one endpoint.
// resolveOpenAiGateway() picks OpenAI direct vs. OpenRouter based on the key
// shape; either way this calls the SAME OFFICIAL_JUDGE_MODEL (see that file).

/** The ONLY model this module will call. Matches `model_zoo['gpt-4o']` in
 *  the official evaluate_qa.py verbatim. */
export const OFFICIAL_JUDGE_MODEL = 'gpt-4o-2024-08-06';

export class JudgeUnavailableError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'JudgeUnavailableError';
    }
}

/**
 * Verbatim port of `get_anscheck_prompt()` from evaluate_qa.py. Do not
 * reword these templates — wording changes would silently diverge from the
 * benchmark's published grading protocol.
 */
export function getAnscheckPrompt(
    task: LongMemEvalQuestionType,
    question: string,
    answer: string,
    response: string,
    abstention = false,
): string {
    if (abstention) {
        return (
            `I will give you an unanswerable question, an explanation, and a response from a model. ` +
            `Please answer yes if the model correctly identifies the question as unanswerable. The model ` +
            `could say that the information is incomplete, or some other information is given but the asked ` +
            `information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}` +
            `\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
        );
    }

    switch (task) {
        case 'single-session-user':
        case 'single-session-assistant':
        case 'multi-session':
            return (
                `I will give you a question, a correct answer, and a response from a model. Please answer yes ` +
                `if the response contains the correct answer. Otherwise, answer no. If the response is ` +
                `equivalent to the correct answer or contains all the intermediate steps to get the correct ` +
                `answer, you should also answer yes. If the response only contains a subset of the information ` +
                `required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}` +
                `\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
            );
        case 'temporal-reasoning':
            return (
                `I will give you a question, a correct answer, and a response from a model. Please answer yes ` +
                `if the response contains the correct answer. Otherwise, answer no. If the response is ` +
                `equivalent to the correct answer or contains all the intermediate steps to get the correct ` +
                `answer, you should also answer yes. If the response only contains a subset of the information ` +
                `required by the answer, answer no. In addition, do not penalize off-by-one errors for the ` +
                `number of days. If the question asks for the number of days/weeks/months, etc., and the model ` +
                `makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response ` +
                `is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ` +
                `${response}\n\nIs the model response correct? Answer yes or no only.`
            );
        case 'knowledge-update':
            return (
                `I will give you a question, a correct answer, and a response from a model. Please answer yes ` +
                `if the response contains the correct answer. Otherwise, answer no. If the response contains ` +
                `some previous information along with an updated answer, the response should be considered as ` +
                `correct as long as the updated answer is the required answer.\n\nQuestion: ${question}` +
                `\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? ` +
                `Answer yes or no only.`
            );
        case 'single-session-preference':
            return (
                `I will give you a question, a rubric for desired personalized response, and a response from a ` +
                `model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. ` +
                `The model does not need to reflect all the points in the rubric. The response is correct as ` +
                `long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ` +
                `${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response ` +
                `correct? Answer yes or no only.`
            );
        default:
            throw new Error(`Unsupported question_type for grading: ${task satisfies never}`);
    }
}

export interface JudgeVerdict {
    model: typeof OFFICIAL_JUDGE_MODEL;
    label: boolean;
    rawResponse: string;
    /** Real token usage from the API response, when the provider returned one.
     *  Not part of the original comparable-score shape — additive, optional. */
    usage?: TokenUsage;
}

/** Throws JudgeUnavailableError (before any network call) if no key is
 *  configured. Call this eagerly wherever the pipeline needs to decide
 *  whether judging is possible at all. */
export function requireOpenAiApiKey(): string {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) {
        throw new JudgeUnavailableError(
            'OPENAI_API_KEY is not set in this environment. The LongMemEval judge is hard-pinned to ' +
                `${OFFICIAL_JUDGE_MODEL} via the OpenAI API (see judge.ts header) and this harness refuses to ` +
                'substitute a different model. Set OPENAI_API_KEY and re-run to score answers.',
        );
    }
    return apiKey;
}

interface OpenAiChatResponse {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; type?: string };
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
}

/** Mirrors evaluate_qa.py's chat_completions_with_backoff call shape:
 *  n=1, temperature=0, max_tokens=10, single user-role message. Retries on
 *  429 / 5xx *and* thrown network errors (DNS, connection reset, etc.) via
 *  the shared fetchWithRetry — request shape/model is unchanged, so this
 *  doesn't affect the byte-for-byte official-protocol comparability this
 *  module's header is strict about, only transport-level resilience.
 *
 *  Also returns the response's real `usage` block (2026-08-16) — added so
 *  callers doing cost-gated staged runs (rejudge.ts's --limit) can report
 *  REAL token counts per batch instead of an estimate. undefined when the
 *  provider omits usage (rare, but not worth failing the call over). */
async function chatCompletionWithBackoff(
    apiKey: string,
    prompt: string,
    maxRetries = 5,
): Promise<{ content: string; usage?: TokenUsage }> {
    const organization = process.env['OPENAI_ORGANIZATION'];
    const gateway = resolveOpenAiGateway(apiKey, OFFICIAL_JUDGE_MODEL);
    const response = await fetchWithRetry(gateway.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(organization ? { 'OpenAI-Organization': organization } : {}),
        },
        body: JSON.stringify({
            model: gateway.modelFor(OFFICIAL_JUDGE_MODEL),
            messages: [{ role: 'user', content: prompt }],
            n: 1,
            temperature: 0,
            max_tokens: 10,
        }),
    }, { maxRetries });

    if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`OpenAI judge call failed: HTTP ${response.status} ${bodyText.slice(0, 500)}`);
    }
    const body = (await response.json()) as OpenAiChatResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        throw new Error(`Unexpected OpenAI response shape: ${JSON.stringify(body).slice(0, 300)}`);
    }
    const usage = body.usage
        ? { promptTokens: body.usage.prompt_tokens ?? 0, completionTokens: body.usage.completion_tokens ?? 0 }
        : undefined;
    return { content, usage };
}

/**
 * Grades one (question, expected answer, model response) triple against
 * the official gpt-4o-2024-08-06 judge. Throws JudgeUnavailableError if
 * OPENAI_API_KEY is not set — callers must not catch-and-substitute.
 */
export async function judgeAnswer(
    questionId: string,
    questionType: LongMemEvalQuestionType,
    question: string,
    expectedAnswer: string,
    modelResponse: string,
): Promise<JudgeVerdict> {
    const apiKey = requireOpenAiApiKey(); // throws before any network call
    const abstention = questionId.includes('_abs');
    const prompt = getAnscheckPrompt(questionType, question, expectedAnswer, modelResponse, abstention);

    const { content, usage } = await chatCompletionWithBackoff(apiKey, prompt);
    const raw = content.trim();
    return {
        model: OFFICIAL_JUDGE_MODEL,
        label: raw.toLowerCase().includes('yes'),
        rawResponse: raw,
        usage,
    };
}
