/**
 * factRecency.ts — flags which row in a cluster of same-slot facts is the
 * CURRENT value, for the 'knowledge-update' question category ("what is my
 * current phone number", "where do I live now").
 *
 * Why this exists: that category retrieves evidence fine (90-100% recall
 * measured), but the answer is sometimes wrong anyway when the underlying
 * value changed over the conversation history — e.g. "lives in Seattle"
 * (dated March) and "lives in Denver" (dated July) both land in
 * `countable_events` as ordinary rows with no notion of "which one still
 * holds". `formatStructuredFacts` (countableEvents.ts) renders both with equal
 * weight, so the answering model has no signal to prefer the later one over
 * the earlier one — this is a HYPOTHESIS about the wrong-answer cause, not
 * yet confirmed against failing transcripts, which is why this module only
 * ever ADDS an advisory block; it never drops or reorders
 * `formatStructuredFacts`'s own output (same non-destructive contract as
 * `formatComputedAggregateBlock` in structuredFactsAggregate.ts).
 *
 * ─── Clustering strategy: mirrors, doesn't reuse, partitionByRelevance ────
 *
 * `partitionByRelevance` splits rows by overlap against a *question's*
 * content words (one-vs-many). This module has no question — it has to
 * decide which rows, compared to EACH OTHER, describe the same fact-slot
 * (many-vs-many). So the lexical machinery is reused as-is
 * (`extractContentWords`, imported rather than re-implemented — the codebase
 * convention this file follows is "don't reinvent if adequate"), but the
 * comparison is pairwise overlap + union-find instead of a single
 * candidate-word pass. Overlap is measured as an overlap COEFFICIENT
 * (shared / smaller-set-size), not Jaccard: fact descriptions here are short
 * ("lives in Seattle" → {lives, seattle} after stopwording), so a Jaccard
 * denominator inflated by the changed word alone (seattle vs denver) would
 * almost always undershoot any reasonable threshold. Overlap coefficient
 * asks "does the smaller description sit mostly inside the larger one",
 * which is the right question when only the value token is expected to
 * differ.
 *
 * `category` (extraction-assigned, per countableEvents.ts's own doc comment:
 * "not a fixed enum") is used as a HARD pre-filter before any lexical
 * comparison runs. Two rows about unrelated topics that happen to share
 * words ("started a new job" / "started a new hobby") must never cluster
 * just because "started" and "new" overlap — gating on category first, then
 * measuring overlap only within a category, is what keeps this conservative
 * without needing a second stopword list tuned by hand.
 *
 * ─── Three "give up rather than guess" gates (same philosophy as the
 * SUM-vs-COUNT decision documented in structuredFactsAggregate.ts's header:
 * a wrong supersession claim is worse than none) ───────────────────────────
 *
 * 1. A cluster is only tagged if EVERY row in it carries a usable
 *    `event_date`. One undated row in an otherwise-clean cluster means the
 *    ordering can't be trusted, so the whole cluster is dropped rather than
 *    ordering the dated rows and guessing about the rest.
 * 2. A cluster is only tagged if it contains at least two DISTINCT
 *    (description, numeric_value) signatures. Same-slot rows that all say
 *    the same thing on different dates (recaps, not updates — the exact
 *    "same sentence extracted twice" pattern `formatStructuredFacts`'s `src=`
 *    tagging exists for) have nothing to supersede; tagging one of them
 *    SUPERSEDED would assert a change that never happened.
 * 3. A cluster is only tagged if its most-recent `event_date` is held by
 *    exactly ONE row. A tie at the top means "which of these is current" is
 *    itself ambiguous — exactly the kind of case this file's brief says to
 *    leave untagged rather than pick one arbitrarily.
 *
 * ─── Simplification: single CURRENT row, not per-value grouping ───────────
 *
 * Within a tagged cluster, only the single most-recent row is marked CURRENT
 * — every other row in that cluster is SUPERSEDED, even if one of them
 * happens to share the CURRENT row's exact value (e.g. a value that changed
 * and then changed back). This matches the brief literally ("marks the most
 * recent row per cluster CURRENT and older same-cluster rows SUPERSEDED")
 * and keeps the output shape simple for a first version; a value that
 * legitimately recurs is still, correctly, the most recently stated one only
 * once. Revisit only if a real failing transcript shows this simplification
 * producing a wrong answer.
 */

import type { Row } from '../../../packages/lore/src/contracts/tables.js';
import { extractContentWords } from './structuredFactsAggregate.js';

/** At least half of the SMALLER row's content words must reappear in the
 *  other row for the two to be considered the same fact-slot. See header
 *  comment for why this is an overlap coefficient, not Jaccard. */
const CONTENT_OVERLAP_THRESHOLD = 0.5;

/** Loose ISO-date check — accepts YYYY-MM-DD or YYYY-MM, matching the
 *  nullable "ISO date (YYYY-MM-DD)" contract documented on
 *  `CountableFact.eventDate` in countableEvents.ts. Plain string comparison
 *  on values matching this shape sorts correctly either way. */
const ISO_DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;

export type RecencyStatus = 'CURRENT' | 'SUPERSEDED';

export interface FactWithStatus {
    row: Row;
    status: RecencyStatus;
}

/** One confidently-detected group of rows describing the same fact-slot at
 *  different points in time. `rows` is sorted most-recent first; `rows[0]`
 *  is always the CURRENT one. */
export interface RecencyCluster {
    rows: FactWithStatus[];
}

function contentWordSet(row: Row): Set<string> {
    return new Set(extractContentWords(String(row.description ?? '')));
}

function overlapCoefficient(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.min(a.size, b.size);
}

/** Signature used to detect "did the value actually change" (gate #2 in the
 *  header comment) — description text plus numeric value, since a fact's
 *  value may live in either field depending on what was extracted. */
function factSignature(row: Row): string {
    const desc = String(row.description ?? '').trim().toLowerCase();
    const numeric = row.numeric_value == null ? '' : String(row.numeric_value);
    return `${desc}${numeric}`;
}

/**
 * Groups `rows` into candidate same-fact-slot clusters: same `category`,
 * pairwise content-word overlap at or above `CONTENT_OVERLAP_THRESHOLD`,
 * connected via union-find (so a chain of restatements clusters together
 * even if the first and last row don't directly overlap). Singletons are
 * dropped — a cluster of one has nothing to compare against. This is the
 * "clusters by topical similarity" step; it does NOT yet apply the
 * date/signature gates in `detectFactRecency` — a caller that only wants
 * groupings (e.g. a test) can use this directly.
 */
export function clusterFactsByTopic(rows: Row[]): Row[][] {
    const byCategory = new Map<string, number[]>();
    rows.forEach((r, i) => {
        const cat = String(r.category ?? '');
        const bucket = byCategory.get(cat);
        if (bucket) bucket.push(i);
        else byCategory.set(cat, [i]);
    });

    const clusters: Row[][] = [];
    for (const indices of byCategory.values()) {
        if (indices.length < 2) continue;

        const words = indices.map((i) => contentWordSet(rows[i]!));
        const parent = indices.map((_, k) => k);
        const find = (k: number): number => {
            while (parent[k] !== k) {
                parent[k] = parent[parent[k]!]!;
                k = parent[k]!;
            }
            return k;
        };
        const union = (a: number, b: number): void => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) parent[ra] = rb;
        };

        for (let a = 0; a < indices.length; a++) {
            for (let b = a + 1; b < indices.length; b++) {
                if (overlapCoefficient(words[a]!, words[b]!) >= CONTENT_OVERLAP_THRESHOLD) {
                    union(a, b);
                }
            }
        }

        const groups = new Map<number, number[]>();
        for (let k = 0; k < indices.length; k++) {
            const root = find(k);
            const g = groups.get(root);
            if (g) g.push(indices[k]!);
            else groups.set(root, [indices[k]!]);
        }
        for (const groupIndices of groups.values()) {
            if (groupIndices.length >= 2) clusters.push(groupIndices.map((i) => rows[i]!));
        }
    }
    return clusters;
}

/** Applies the three "give up rather than guess" gates from the header
 *  comment to one candidate cluster. Returns `null` (tag nothing) rather
 *  than a best-effort partial ordering whenever any gate fails. */
function tagClusterIfConfident(candidate: Row[]): RecencyCluster | null {
    const dates = candidate.map((r) => String(r.event_date ?? ''));
    if (dates.some((d) => !ISO_DATE_RE.test(d))) return null; // gate 1

    if (new Set(candidate.map(factSignature)).size < 2) return null; // gate 2

    const sorted = [...candidate].sort((a, b) => {
        const da = String(a.event_date);
        const db = String(b.event_date);
        if (da !== db) return da < db ? 1 : -1; // descending: most recent first
        const na = String(a.source_node_id ?? '');
        const nb = String(b.source_node_id ?? '');
        return na < nb ? -1 : na > nb ? 1 : 0;
    });

    const topDate = String(sorted[0]!.event_date);
    if (sorted.filter((r) => String(r.event_date) === topDate).length > 1) return null; // gate 3

    return {
        rows: sorted.map((row, i) => ({ row, status: i === 0 ? 'CURRENT' : 'SUPERSEDED' })),
    };
}

/**
 * Full pipeline: cluster `rows` by topic, then tag each cluster CURRENT /
 * SUPERSEDED where the evidence is confident enough (see header comment).
 * Pure; empty or all-unrelated input yields `[]`.
 */
export function detectFactRecency(rows: Row[]): RecencyCluster[] {
    const candidates = clusterFactsByTopic(rows);
    const tagged: RecencyCluster[] = [];
    for (const candidate of candidates) {
        const result = tagClusterIfConfident(candidate);
        if (result) tagged.push(result);
    }
    return tagged;
}

/**
 * Renders detected clusters into an advisory block for the answering prompt,
 * prepended ahead of (never replacing) `formatStructuredFacts`'s full row
 * listing — same non-destructive contract as `formatComputedAggregateBlock`.
 * Pure. No clusters → `''` (same empty-input convention as
 * `formatStructuredFacts` / `formatComputedAggregateBlock`).
 */
export function formatFactRecencyBlock(clusters: RecencyCluster[]): string {
    if (clusters.length === 0) return '';

    const lines = clusters.map((cluster) => {
        const current = cluster.rows[0]!;
        const superseded = cluster.rows.slice(1);
        const supersededDesc = superseded
            .map((f) => `"${String(f.row.description ?? '')}" (date=${String(f.row.event_date ?? '')})`)
            .join('; ');
        return (
            `- CURRENT: [${current.row.category ?? 'event'}] ${current.row.description ?? ''} ` +
            `(date=${String(current.row.event_date ?? '')}) — supersedes ${superseded.length} older ` +
            `statement(s) of the same fact: ${supersededDesc}`
        );
    });

    return (
        `The following ${clusters.length} value(s) changed over the course of the conversation history. ` +
        `Each line names the CURRENT (most recent) value and the older, now-superseded statement(s) it ` +
        `replaces. If the question asks for a CURRENT/present-tense value, prefer the CURRENT line over any ` +
        `superseded one in the full record list below, even if the superseded statement seems more prominent. ` +
        `Detection here is a conservative heuristic (category + wording overlap + date ordering) — it is not ` +
        `exhaustive, so a real update it missed may still only appear in the full record list below:\n` +
        lines.join('\n')
    );
}
