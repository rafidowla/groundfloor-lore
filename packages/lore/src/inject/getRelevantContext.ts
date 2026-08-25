/**
 * getRelevantContext.ts — outbound half of the context-injection helper.
 *
 * Decided 2026-08-03 (context-injection-helper-placement): apps embedding
 * Lore each had to independently decide what context to fetch before a model
 * call. This is the shared answer for the OUTBOUND direction — "what context
 * matters here" — packaged as plain text within a character budget, ready
 * for the caller to splice into its own prompt. No provider-specific message
 * format is touched; this module returns a `string`, nothing else.
 *
 * Pure retrieval: `lore.recall()` already does semantic ranking, so no LLM
 * is needed on this side (contrast with `captureIfWorthRemembering`, the
 * inbound half, which needs a caller-supplied LLM to judge worth-keeping).
 */

import type { LoreInstance } from '../mcp/server.js';
import type { RecallOpts, RecallResult } from '../recall/inProcessRecall.js';

/**
 * Default character budget for the packaged text `getRelevantContext`
 * returns. 4000 chars is the same order of magnitude as the codebase's own
 * token/char convention (see `estimateTokens` in
 * `mcp/tools/search/helpers.ts`: `Math.ceil((label+content)/4)`, i.e. ~4
 * chars/token) — 4000 chars ≈ 1000 tokens, a reasonable slice of a prompt
 * budget without dominating it. Override via `opts.maxChars`.
 */
export const DEFAULT_MAX_CHARS = 4000;

/** Matches the chars-per-token ratio `estimateTokens` uses elsewhere in this
 *  codebase (recall/retrieve.ts's token-budget truncation), so the char
 *  budget passed in here and the token budget `recall()` truncates against
 *  internally stay consistent instead of inventing a second convention. */
const CHARS_PER_TOKEN = 4;

export interface GetRelevantContextOpts {
    /** Target workspace (required — same as `RecallOpts.workspace`). Pass
     *  '*' for cross-workspace recall. */
    workspace: string;
    /** Ecosystem filter. Defaults to '*' (all ecosystems). */
    ecosystem?: string;
    /** Character budget for the returned text. Default {@link DEFAULT_MAX_CHARS}.
     *  This is a HARD cap — the returned string is never longer than this
     *  (best-effort trimmed at entry boundaries, then a final hard slice as
     *  a backstop). */
    maxChars?: number;
    /** Graph traversal depth from each seed node. Default 1 (RecallOpts default). */
    depth?: number;
    /** Filter results to nodes that carry ALL listed tags. */
    tags?: string[];
    /** Include archived (status="archived") nodes. Default false. */
    includeArchived?: boolean;
    /** Retrieval mode. Default 'hybrid' (BM25 + semantic RRF). */
    searchMode?: 'semantic' | 'keyword' | 'hybrid';
    /** Maximum number of candidate seed nodes passed to recall(). Default 10. */
    max?: number;
    /** Recall response shape to source entries from. 'full' (default) uses
     *  real node bodies — more useful as injected context than the 120-char
     *  snippets 'summary' hits carry. */
    mode?: 'summary' | 'full';
}

interface FormattableEntry {
    type: string;
    label: string;
    text: string;
}

/** Normalises either RecallResult shape (`summary` hits or `full` knowledge)
 *  into a flat list of {type, label, text}. Zero-hit recall ALWAYS comes back
 *  as `mode: 'summary', hits: []` (recallPreset.ts's early-return branch
 *  ignores the requested mode on a miss), so this has to handle that even
 *  when the caller asked for 'full'. */
function extractEntries(result: RecallResult): FormattableEntry[] {
    if (result.mode === 'full') {
        return result.knowledge.map((n) => ({ type: n.type, label: n.label, text: n.content }));
    }
    return result.hits
        .filter((h): h is typeof h & { snippet: string } => typeof h.snippet === 'string' && h.snippet.length > 0)
        .map((h) => ({ type: h.type, label: h.label, text: h.snippet }));
}

/** Packages entries into plain text, filling top-ranked-first until
 *  `maxChars` is exhausted — mirrors retrieve.ts's own token-budget
 *  truncation loop (always keep at least one entry, then stop), plus a
 *  final hard slice as a backstop so the character budget is never
 *  exceeded even if a single entry alone is oversized. */
function formatEntries(entries: FormattableEntry[], maxChars: number): string {
    if (entries.length === 0) return '';
    const blocks: string[] = [];
    let used = 0;
    for (const e of entries) {
        const block = `[${e.type}] ${e.label}\n${e.text}`.trim();
        const withSepLen = block.length + (blocks.length > 0 ? 2 : 0); // "\n\n" separator
        if (used + withSepLen > maxChars && blocks.length > 0) break;
        blocks.push(block);
        used += withSepLen;
    }
    const text = blocks.join('\n\n');
    return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * getRelevantContext — fetch what's worth telling the model before a call.
 *
 * Calls `lore.recall(query, opts)` and formats the hits into packaged plain
 * text within `opts.maxChars` (default {@link DEFAULT_MAX_CHARS}). The
 * caller inserts the returned string into its own prompt however it likes —
 * this function never touches a provider-specific message format.
 *
 * @returns The packaged text, or `''` when recall finds nothing. Empty
 *   string, not an exception — a cold-start / no-memory-yet workspace is an
 *   expected, non-error outcome; callers can `if (context) …` and otherwise
 *   proceed with no injected context.
 */
export async function getRelevantContext(
    lore: LoreInstance,
    query: string,
    opts: GetRelevantContextOpts,
): Promise<string> {
    const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : DEFAULT_MAX_CHARS;
    const maxTokens = Math.max(1, Math.ceil(maxChars / CHARS_PER_TOKEN));

    const recallOpts: RecallOpts = {
        workspace: opts.workspace,
        ecosystem: opts.ecosystem,
        depth: opts.depth,
        tags: opts.tags,
        includeArchived: opts.includeArchived,
        searchMode: opts.searchMode,
        max: opts.max,
        mode: opts.mode ?? 'full',
        maxTokens,
    };
    const result = await lore.recall(query, recallOpts);
    return formatEntries(extractEntries(result), maxChars);
}
