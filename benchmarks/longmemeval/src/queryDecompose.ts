/**
 * queryDecompose.ts — query-side fix for the multi-session evidence-spread
 * problem (LongMemEval harness).
 *
 * Why this exists: `multi-session` questions ask something that only
 * resolves by combining evidence scattered across SEVERAL separate
 * conversations ("considering everything I've told you about my diet across
 * our chats, am I eating more or less protein than 3 months ago"). A single
 * lore.recall(question) call is one semantic query against one embedding —
 * it finds the sessions closest to the question's own wording, which is
 * rarely all of them. A diet question phrased once will pull the session
 * that literally says "protein" and miss the session that only mentions
 * "chicken thighs" or "cut out snacks", even though that session is exactly
 * the evidence needed. This is a SEARCH-BREADTH gap, not a storage gap —
 * recall_all ("did we find every piece of evidence") is the metric this
 * fails, and no amount of re-ranking a single query's results fixes it,
 * because the missing session was never in the candidate pool at all.
 *
 * The fix is the standard one for this shape of problem: decompose the
 * question into several narrower sub-queries that each target a different
 * facet of the evidence the question implies, run recall() once per
 * sub-query (done by the CALLER — see the header note below), and merge the
 * ranked result lists. This file provides the two pure/isolated pieces of
 * that pipeline:
 *
 *   1. decomposeQuery() — ONE LLM call, question in, 2-5 sub-queries out.
 *   2. mergeRecallResults() — pure, dedupe + re-rank multiple recall() result
 *      lists into one.
 *
 * This file deliberately does NOT call lore.recall() itself. Wiring the
 * sub-queries into the retrieval loop, running them (sequentially or in
 * parallel), and feeding mergeRecallResults()'s output into the existing
 * metrics/answering path is a separate integration step in runSubset.ts —
 * keeping that out of here means this module can be unit-tested with zero
 * Lore instance and zero network mocking beyond the one LLM call.
 *
 * LLM-call conventions mirror answerModel.ts exactly (see that file's
 * header): resolveOpenAiGateway() picks OpenAI-vs-OpenRouter transport,
 * OPENAI_API_KEY is tried before ANTHROPIC_API_KEY, and unavailability is a
 * dedicated error class (QueryDecomposeUnavailableError) rather than a
 * silent fallback baked into this file. The silent fallback — "no key /
 * malformed response ⇒ just use the original question as the only
 * sub-query" — belongs in the CALLER (same isolation philosophy as
 * extractCountableFacts.ts's per-session try/catch: one question's
 * decomposition failing must never abort the whole benchmark run), so
 * decomposeQuery() is free to throw on any failure without special-casing
 * "safe" vs "unsafe" errors internally.
 */

import { resolveOpenAiGateway } from './openaiGateway.js';
import { fetchWithRetry } from './fetchWithRetry.js';
import type { RecallNode } from '../../../packages/lore/src/recall/recallPreset.js';

export class QueryDecomposeUnavailableError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'QueryDecomposeUnavailableError';
    }
}

const OPENAI_DECOMPOSE_MODEL = 'gpt-4o-mini';
const ANTHROPIC_DECOMPOSE_MODEL = 'claude-3-5-haiku-latest';

// A decomposition call is a short structured-output task, not a reasoning
// task — no need for answerModel.ts's 4000-token reasoning-model headroom.
// 500 comfortably fits a 5-line JSON array of sub-queries with margin.
const MAX_DECOMPOSE_TOKENS = 500;

const MIN_SUB_QUERIES = 2;
const MAX_SUB_QUERIES = 5;

/**
 * Pure prompt builder — exported for unit tests (no API calls). Mirrors
 * answerModel.ts's buildPrompt() being exported for the same reason.
 *
 * Asks for a bare JSON array (no markdown fence, no wrapping object) because
 * that is the cheapest format to parse back out reliably across both OpenAI
 * and Anthropic response shapes without a tool-call / structured-output
 * feature this harness's thin fetch-based clients don't already use.
 */
export function buildDecomposePrompt(question: string, questionDate: string): string {
    return (
        `A user is asking a question that may require combining evidence from SEVERAL different ` +
        `past conversations, not just one. Your job is to break the question into 2 to 5 short, ` +
        `focused search queries that together would find every conversation needed to answer it fully.\n\n` +
        `Today's date is ${questionDate}.\n\n` +
        `Question: ${question}\n\n` +
        `Rules:\n` +
        `- Each sub-query should target ONE distinct facet of evidence the question implies (e.g. a specific ` +
        `time period, a specific topic, a specific named thing) — not paraphrases of the same facet.\n` +
        `- If the question already names multiple things to compare (e.g. "protein 3 months ago" vs "protein now"), ` +
        `each side of the comparison should get its own sub-query.\n` +
        `- Prefer plain factual search phrases over full sentences — write them the way you'd search, not the way ` +
        `you'd ask a person.\n` +
        `- Do not invent facts or dates not implied by the question itself.\n\n` +
        `Respond with ONLY a JSON array of 2 to 5 strings, no markdown fence, no other text. ` +
        `Example: ["protein intake three months ago", "protein intake recently", "current diet changes"]`
    );
}

/**
 * Parses and validates the model's raw text response into a sub-query list.
 * Strips a markdown fence if the model added one anyway (both OpenAI- and
 * Anthropic-class models do this often enough in practice that not handling
 * it would make the "no fence" prompt instruction load-bearing in a way it
 * doesn't need to be). Throws QueryDecomposeUnavailableError on anything
 * that isn't a JSON array of MIN_SUB_QUERIES..MAX_SUB_QUERIES non-empty
 * strings — a malformed response is exactly as "unavailable" to the caller
 * as a missing API key, so it gets the same error type and the same
 * fallback-to-original-question handling.
 */
function parseSubQueries(raw: string): string[] {
    const fenced = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let parsed: unknown;
    try {
        parsed = JSON.parse(fenced);
    } catch {
        throw new QueryDecomposeUnavailableError(`Decomposition response was not valid JSON: ${raw.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
        throw new QueryDecomposeUnavailableError(`Decomposition response was not a JSON array of strings: ${raw.slice(0, 200)}`);
    }
    const subQueries = parsed.map((s) => s.trim()).filter((s) => s.length > 0);
    if (subQueries.length < MIN_SUB_QUERIES || subQueries.length > MAX_SUB_QUERIES) {
        throw new QueryDecomposeUnavailableError(
            `Decomposition returned ${subQueries.length} sub-queries, expected ${MIN_SUB_QUERIES}-${MAX_SUB_QUERIES}: ${raw.slice(0, 200)}`,
        );
    }
    return subQueries;
}

async function callOpenAiDecompose(
    apiKey: string,
    question: string,
    questionDate: string,
    model: string,
): Promise<string[]> {
    const gateway = resolveOpenAiGateway(apiKey, model);
    const response = await fetchWithRetry(gateway.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: gateway.modelFor(model),
            messages: [{ role: 'user', content: buildDecomposePrompt(question, questionDate) }],
            temperature: 0,
            max_tokens: MAX_DECOMPOSE_TOKENS,
            ...gateway.extraBody,
        }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new QueryDecomposeUnavailableError(`OpenAI decompose call failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) {
        throw new QueryDecomposeUnavailableError(`Unexpected OpenAI decompose response: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return parseSubQueries(content);
}

async function callAnthropicDecompose(
    apiKey: string,
    question: string,
    questionDate: string,
): Promise<string[]> {
    const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: ANTHROPIC_DECOMPOSE_MODEL,
            max_tokens: MAX_DECOMPOSE_TOKENS,
            temperature: 0,
            messages: [{ role: 'user', content: buildDecomposePrompt(question, questionDate) }],
        }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new QueryDecomposeUnavailableError(`Anthropic decompose call failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((b) => b.type === 'text')?.text?.trim();
    if (!text) {
        throw new QueryDecomposeUnavailableError(`Unexpected Anthropic decompose response: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return parseSubQueries(text);
}

/**
 * Breaks `question` into 2-5 focused sub-queries meant to be run through
 * lore.recall() individually by the caller (see this file's header — that
 * wiring lives in runSubset.ts, not here). ONE LLM call per invocation.
 *
 * Provider selection mirrors generateAnswer() in answerModel.ts: OpenAI (or
 * OpenRouter, via resolveOpenAiGateway) is tried first via OPENAI_API_KEY,
 * then ANTHROPIC_API_KEY. `model` overrides the OpenAI-path model id only
 * (matching answerModel.ts's modelOverride — the Anthropic fallback path has
 * no override, same as callAnthropic there).
 *
 * Throws QueryDecomposeUnavailableError when no key is configured OR when
 * the model's response can't be parsed into a valid sub-query list. Callers
 * MUST catch this (and, defensively, any other error a network failure
 * could raise) and fall back to `[question]` as the sole sub-query — this
 * function intentionally does not do that fallback itself, so a caller can't
 * mistake "decomposition silently degraded" for "decomposition succeeded
 * with one sub-query".
 */
export async function decomposeQuery(
    question: string,
    questionDate: string,
    model?: string,
): Promise<string[]> {
    const openAiKey = process.env['OPENAI_API_KEY'];
    if (openAiKey) return callOpenAiDecompose(openAiKey, question, questionDate, model ?? OPENAI_DECOMPOSE_MODEL);

    const anthropicKey = process.env['ANTHROPIC_API_KEY'];
    if (anthropicKey) return callAnthropicDecompose(anthropicKey, question, questionDate);

    throw new QueryDecomposeUnavailableError(
        'Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set. No scriptable decomposition model is available ' +
            'in this environment — see answerModel.ts header for the equivalent note on the answering path.',
    );
}

// Reciprocal Rank Fusion constant. 60 is the value from the original RRF
// paper (Cormack et al., 2009) and is not sensitive to tuning for this use —
// it only controls how sharply a #1 rank outweighs a #2 rank; the merge
// behaves the same qualitatively across a wide range of values.
const RRF_K = 60;

/**
 * Merges the ranked RecallNode[] results of multiple sub-query recall()
 * calls into one ranked, deduped list. Pure — no I/O, easy to unit-test
 * against hand-built fixtures.
 *
 * ─── Why Reciprocal Rank Fusion, and why not a score field (2026-09-20) ───
 *
 * RecallNode (recallPreset.ts) carries no numeric relevance score — recall()
 * already reduces a hybrid semantic+BM25+traversal ranking down to array
 * ORDER before it ever reaches a caller (runSubset.ts derives its own
 * retrievedNodeIds purely from `knowledge.map(k => k.id)`'s position, never
 * a score). So the only signal available to merge on, across N independent
 * recall() calls each with their own internal (and mutually incomparable)
 * scoring, is each node's RANK POSITION within its own list. That is
 * precisely the situation Reciprocal Rank Fusion was designed for: score(id)
 * = sum over every sub-query list containing id of 1/(RRF_K + rank), where
 * rank is 1-indexed. This codebase already fuses independently-scored
 * ranked lists this way once (see recallPreset.ts's header: "semantic + BM25
 * → RRF → traversal" is retrieve()'s own internal fusion step) — applying
 * the same technique one layer up, across sub-queries instead of across
 * scoring signals, keeps the merge strategy consistent with how the rest of
 * the retrieval pipeline already reconciles rankings it can't compare
 * directly.
 *
 * RRF also directly serves the multi-session goal this file exists for: a
 * node that only ONE sub-query surfaced (breadth — the exact gap
 * decomposition is meant to close) still gets a nonzero score and a slot in
 * the merged list, while a node that MULTIPLE sub-queries independently
 * agree on ranks higher (precision) than a node only one sub-query liked.
 * Neither a plain concatenation (no re-ranking, arbitrary duplicate
 * ordering) nor a naive round-robin interleave (ignores how confidently
 * ranked a node was within its own list) captures that "agreement across
 * sub-queries is itself evidence" property; RRF does, for free, from
 * position alone.
 *
 * Dedup: the FIRST list to contain a given node id contributes the node
 * object; every later list contributing an entry for the same id only adds
 * to its RRF score, since a node's metadata (label/content/tags) is a
 * property of the underlying graph node, not of which sub-query happened to
 * retrieve it, so re-fetching a second copy would be redundant duplication,
 * not new information.
 *
 * Ties (equal fused score — most commonly two nodes that appeared in exactly
 * the same set of lists at the same ranks) keep the input order they were
 * first encountered in, so this function's output is deterministic for a
 * fixed input.
 */
export function mergeRecallResults(resultsPerSubQuery: RecallNode[][]): RecallNode[] {
    const scoreById = new Map<string, number>();
    const nodeById = new Map<string, RecallNode>();
    const firstSeenOrder: string[] = [];

    for (const results of resultsPerSubQuery) {
        results.forEach((node, index) => {
            const rank = index + 1;
            const contribution = 1 / (RRF_K + rank);
            scoreById.set(node.id, (scoreById.get(node.id) ?? 0) + contribution);
            if (!nodeById.has(node.id)) {
                nodeById.set(node.id, node);
                firstSeenOrder.push(node.id);
            }
        });
    }

    // Stable sort: Array.prototype.sort is stable per spec (guaranteed since
    // ES2019), so nodes with equal fused scores keep firstSeenOrder's
    // relative order rather than an implementation-defined one.
    return firstSeenOrder
        .slice()
        .sort((a, b) => scoreById.get(b)! - scoreById.get(a)!)
        .map((id) => nodeById.get(id)!);
}
