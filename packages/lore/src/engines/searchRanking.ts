/**
 * searchRanking.ts — single source of truth for keyword-search ordering.
 *
 * The GraphProvider.search contract (SEARCH_CONTRACT_VERSION = 1, see
 * providers/types.ts) mandates a defined result order:
 *   1. Relevance descending — a query hit in more fields, or in the `label`
 *      field, ranks higher.
 *   2. updatedAt descending — tie-break among equally relevant nodes.
 *
 * Set-parity across backends WAS guaranteed before Pass 2: both LocalGraph
 * and DataplaneGraph matched label/content/tags case-insensitively. Pass 2
 * (2026-06-24) dropped tag substring scan from LocalGraph's FTS Cypher, so
 * local now matches label+content only while cloud still substring-matches
 * tags. Nodes whose ONLY hit is via a tag are returned by cloud but not by
 * local — a set-parity regression for tag-only matches (see
 * parity-graph-unit.ts header). Label/content set parity and ORDER parity
 * are unchanged. The ranker still scores tagsHit when it sees one (so cloud
 * order is unaffected); local just doesn't surface those candidates.
 *
 * ORDER parity: W5B extracts the rank/score/sort step here so BOTH adapters
 * produce an IDENTICAL ordering by construction over the candidate set they
 * each fetched.
 *
 * Determinism: the comparator adds a final `id` ascending tiebreak so two
 * nodes with the same score AND updatedAt still sort identically across
 * backends (Array.prototype.sort is not stable for our purposes here because
 * the candidate scan order differs between Kùzu and the Dataplane SDK).
 */

import type { LoreNode } from '../providers/types.js';

/**
 * TW-4c — single source of truth for the keyword-search tuning knobs that BOTH
 * backends must share. Previously the scan cap was duplicated as a private
 * `const SEARCH_SCAN_CAP = 2000` in localGraphReads.ts AND dataplaneGraph.ts
 * (hc-/cq-search-scan-cap-duplicate), and the ranking weights lived only here
 * with no override path (hc-search-ranking-weights). If one copy of the cap
 * were tuned, local vs. cloud would scan different-sized windows and the W5B
 * ORDER-parity contract would silently break. Both engines now import these.
 *
 * Each knob is env-overridable via the helpers below. NOTE (file-scope): the
 * daemon scrubs process.env to an allowlist (security/envScrub.ts) BEFORE any
 * module reads it, so a NEW env var name only takes effect once it is added to
 * that allowlist + docs/CONFIGURATION.md. Those two files are outside TW-4c's
 * edit scope, so today these read as the historical defaults; the override
 * mechanism is in place and activates the moment the allowlist entries land.
 */

/** Parse a positive-integer env override, falling back to `fallback`. */
function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Hard cap on the candidate set EITHER backend scans before in-adapter
 * ranking. The match predicate already narrows to genuine hits; this guards
 * against pulling an unbounded match set into memory before rankSearchResults
 * applies the contracted order + limit. Default 2000 (unchanged); override via
 * LORE_SEARCH_SCAN_CAP. Both engines import this so the scan window — and thus
 * the rows handed to the shared ranker — is IDENTICAL across local and cloud.
 */
export const SEARCH_SCAN_CAP = intEnv('LORE_SEARCH_SCAN_CAP', 2000);

/**
 * Relevance weights for the contracted match surface. label hits weigh
 * highest so label matches outrank pure content/tags matches; the per-field
 * bonus makes multi-field matches rank above single-field matches. Defaults
 * (label 4, content 2, tags 1) UNCHANGED; override via LORE_SEARCH_WEIGHT_LABEL, LORE_SEARCH_WEIGHT_CONTENT, LORE_SEARCH_WEIGHT_TAGS.
 */
const LABEL_WEIGHT = intEnv('LORE_SEARCH_WEIGHT_LABEL', 4);
const CONTENT_WEIGHT = intEnv('LORE_SEARCH_WEIGHT_CONTENT', 2);
const TAGS_WEIGHT = intEnv('LORE_SEARCH_WEIGHT_TAGS', 1);

/**
 * Bonus added when the WHOLE query phrase appears verbatim in a field, on top
 * of the per-field term weights. Keeps an exact multi-word phrase hit ranked
 * above scattered single-term hits at equal field coverage.
 */
const PHRASE_BONUS = 1;

/**
 * Cap on the number of terms expanded into the DB-side keyword predicate
 * (each term is one OR-of-fields clause ANDed together). Past the cap the
 * LONGEST terms win — they are the most discriminative. The ranker below uses
 * the same list, so the DB candidate set and the in-JS match gate can never
 * disagree about which terms count.
 */
const MAX_KEYWORD_TERMS = 8;

/**
 * Minimal English stopword set for keyword-term extraction. Only consulted to
 * keep natural-language questions ("what did we decide about X") matchable —
 * a query made ENTIRELY of stopwords/short tokens falls back to its raw
 * terms, so removing these can never make a previously-matching query match
 * nothing.
 */
const KEYWORD_STOPWORDS: ReadonlySet<string> = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'of', 'in', 'on', 'at',
    'to', 'for', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
    'been', 'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no', 'we', 'i',
    'you', 'it', 'he', 'she', 'they', 'this', 'that', 'these', 'those', 'what',
    'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'about', 'into',
    'our', 'your', 'their', 'its', 'my', 'me', 'us', 'them', 'any', 'all',
]);

/**
 * keywordSearchTerms — split a raw query into the significant terms the
 * keyword match gates on (AND-of-terms, fixing the whole-phrase substring
 * defect where a multi-word query matched nothing unless the exact phrase
 * appeared verbatim in a field).
 *
 * Rules:
 *   - lowercase, split on non-letter/non-number boundaries (unicode-aware),
 *     dedupe;
 *   - drop stopwords and 1-character tokens WHEN at least one significant
 *     term survives; otherwise keep the raw terms (a query of only stopwords
 *     still matches, exactly as the whole-phrase match did);
 *   - a query with NO extractable terms (punctuation-only) falls back to the
 *     whole lowercased query as one term — the old behaviour;
 *   - empty/whitespace query → [] (the caller's trivial-match path);
 *   - capped at MAX_KEYWORD_TERMS, longest-first.
 *
 * BOTH the DB-side candidate predicate (LocalGraph Cypher / SurrealDB SQL)
 * and rankSearchResults derive their term list from this one function, so
 * the two match gates are identical by construction.
 */
export function keywordSearchTerms(query: string): string[] {
    const q = (query ?? '').toLowerCase().trim();
    if (!q) return [];
    const split = [...new Set(q.split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
    if (split.length === 0) return [q];
    const significant = split.filter((t) => t.length >= 2 && !KEYWORD_STOPWORDS.has(t));
    const terms = significant.length > 0 ? significant : split;
    if (terms.length <= MAX_KEYWORD_TERMS) return terms;
    return [...terms].sort((a, b) => b.length - a.length).slice(0, MAX_KEYWORD_TERMS);
}

/**
 * rankSearchResults — filter, score, and order keyword-search candidates.
 *
 * Given a candidate set already scoped (org_id / project / ecosystem) and
 * bounded by the backend's scan cap, this:
 *   - filters to nodes matching `query` case-insensitively. Matching is
 *     AND-of-significant-terms (keywordSearchTerms): every significant term
 *     must appear in the label, the content, or a tag. The previous
 *     whole-phrase substring test silently returned NOTHING for multi-word
 *     queries unless the exact phrase appeared verbatim — which also starved
 *     recall's keyword fallback/supplement paths that rely on this scan.
 *     (empty query → every candidate is a trivial match, score 0);
 *   - scores each match (label?4 + content?2 + tags?1, per-field any-term
 *     basis, plus a small exact-phrase bonus for verbatim multi-word hits);
 *   - sorts score desc, then updatedAt desc, then id asc (full determinism);
 *   - slices to `limit`.
 *
 * This is the ONLY place keyword-search order is decided. Both
 * DataplaneGraph.search and LocalGraph.search call it so cloud and local
 * return identical id-sequences for identical inputs.
 */
export function rankSearchResults(
    nodes: LoreNode[],
    query: string,
    limit: number,
): LoreNode[] {
    const q = (query ?? '').toLowerCase();
    const terms = keywordSearchTerms(query);

    type Scored = { node: LoreNode; score: number };
    const scored: Scored[] = [];
    for (const node of nodes) {
        if (q.length === 0 || terms.length === 0) {
            // No keyword constraint → every scoped node is a trivial match.
            scored.push({ node, score: 0 });
            continue;
        }
        const label = node.label.toLowerCase();
        const content = node.content.toLowerCase();
        // Pass 3 — node.tags is string[] (already lowercased on store).
        const tags = node.tags.map((t) => t.toLowerCase());
        const termHits = (t: string) => label.includes(t) || content.includes(t) || tags.some((tag) => tag.includes(t));
        // AND-of-terms: every significant term must hit SOME field. A node
        // matching only a subset of the query's terms is not a match.
        if (!terms.every(termHits)) continue; // no match → drop
        const labelHit = terms.some((t) => label.includes(t));
        const contentHit = terms.some((t) => content.includes(t));
        const tagsHit = tags.some((tag) => terms.some((t) => tag.includes(t)));
        const score =
            (labelHit ? LABEL_WEIGHT : 0) +
            (contentHit ? CONTENT_WEIGHT : 0) +
            (tagsHit ? TAGS_WEIGHT : 0) +
            // Exact-phrase bonus: the whole multi-word query appearing
            // verbatim in a field outranks scattered term coverage.
            (terms.length > 1 && (label.includes(q) || content.includes(q) || tags.some((tag) => tag.includes(q))) ? PHRASE_BONUS : 0);
        scored.push({ node, score });
    }

    // Contract ordering: relevance desc, then updatedAt desc, then id asc.
    // The id tiebreak makes the order fully deterministic across backends
    // whose candidate scan order may differ.
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const byUpdated = (b.node.updatedAt ?? '').localeCompare(a.node.updatedAt ?? '');
        if (byUpdated !== 0) return byUpdated;
        return (a.node.id ?? '').localeCompare(b.node.id ?? '');
    });

    return scored.slice(0, Math.max(0, limit)).map((s) => s.node);
}
