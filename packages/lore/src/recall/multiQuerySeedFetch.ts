/**
 * multiQuerySeedFetch.ts — the verbatim-store seed pass (semantic + BM25),
 * generalized over MULTIPLE query phrasings (3.21 step 3(f)). Split out of
 * retrieve.ts (CLAUDE.md's file-size budget — 3(f)'s per-phrasing fan-out
 * pushed that file past the 800-line hard cap).
 *
 * One concern: given N query phrasings (the primary `query` plus up to 5
 * extras) and a mode ('semantic' | 'keyword' | 'hybrid'), run the SAME
 * seed leg(s) that mode already runs for a single query, once per phrasing,
 * and fuse every resulting ranked list (phrasing × leg) with the ONE shared
 * `rrfFuse` (recall/rrf.ts, k=60) — never averaged. With exactly one
 * phrasing (the default — retrieve() never supplies more than one unless
 * the caller passed `queries`), this reduces to byte-identical output to
 * the pre-3.21-f single-query implementation, because rrfFuse's formula IS
 * the formula the single-query code used to compute inline.
 *
 * Nothing here decides ecosystem scoping, alias→parent identity beyond
 * calling the shared mapper, or anything about ranking BEYOND the fusion
 * itself — those stay callers' concerns (retrieve.ts) or live in their own
 * modules (questionAliases.ts, rrf.ts).
 */

import { readBm25Envelope } from '../engines/verbatimBm25Result.js';
import type { Bm25Envelope } from '../engines/verbatimBm25Result.js';
import { mapAliasHitsToParent, MAX_QUESTIONS } from '../core/questionAliases.js';
import { rrfFuse } from './rrf.js';
import { EmbeddingDisabledError } from '../providers/nullEmbeddingProvider.js';
import type { VerbatimSeedStore } from './retrieveSeedStore.js';
import type { VerbatimSeedHit } from './ecosystemSeedUnion.js';
import type { MatchKind } from './retrieveTypes.js';

/**
 * 3.21 r9 recall-quality fix (Finding B — "alias dilution", C4 < C3 on the
 * tapestry-recall benchmark): `mapAliasHitsToParent` correctly collapses
 * several verbatim rows belonging to one parent (its own main row + up to
 * MAX_QUESTIONS `<parent>#q<n>` alias rows) down to a SINGLE entry, keeping
 * the best rank — but it can only collapse what it is HANDED. When a leg's
 * raw top-`window` fetch (seedStore.search / bm25Search) already truncated
 * to `window` rows BEFORE collapsing, a handful of parents each contributing
 * several near-top alias rows can fill that raw window and push OTHER
 * parents' single (alias-less) rows out of it entirely — so the collapsed
 * result has fewer distinct parents than the caller asked for, even when the
 * store holds plenty more. Measured on the benchmark: this is why a
 * write-time-questions config (C4) can score BELOW its own no-aliases
 * baseline (C3) despite mapAliasHitsToParent's per-list dedup being correct
 * in isolation — the loss happens one step earlier, at the raw-fetch/window
 * boundary.
 *
 * ALIAS_ROW_FANOUT (parent row + up to MAX_QUESTIONS aliases) is the worst
 * case a single parent can contribute to a raw window. ALIAS_OVERFETCH_MAX_
 * MULTIPLIER bounds how far {@link fetchCollapsedRanked} widens the raw
 * fetch in response — enough to recover the requested distinct-parent count
 * in the common case, without letting a pathological heavy-alias corpus
 * blow up query cost per recall indefinitely.
 */
const ALIAS_ROW_FANOUT = 1 + MAX_QUESTIONS;
const ALIAS_OVERFETCH_MAX_MULTIPLIER = 4;

/**
 * Fetch a ranked list, collapse alias rows to their parent (mapAliasHitsToParent),
 * and — only when collapsing left FEWER distinct ids than requested AND the
 * raw fetch came back window-filled (so the store may hold more) — widen the
 * raw window and retry, bounded by ALIAS_OVERFETCH_MAX_MULTIPLIER. A corpus
 * with no aliases at all never triggers the retry: collapsing there is a
 * no-op, so `collapsed.length === raw.length`, which only falls short of
 * `desiredCount` when the store itself has fewer than that many rows (the
 * existing, harmless "ran out of corpus" case).
 */
async function fetchCollapsedRanked<H extends { id: string }>(
    fetchRaw: (window: number) => Promise<H[]>,
    desiredCount: number,
): Promise<{ collapsed: H[]; rawCount: number }> {
    let window = desiredCount;
    let raw = await fetchRaw(window);
    let collapsed = mapAliasHitsToParent(raw);
    while (
        collapsed.length < desiredCount &&
        raw.length >= window &&
        window < desiredCount * ALIAS_OVERFETCH_MAX_MULTIPLIER
    ) {
        window = Math.min(window * ALIAS_ROW_FANOUT, desiredCount * ALIAS_OVERFETCH_MAX_MULTIPLIER);
        raw = await fetchRaw(window);
        collapsed = mapAliasHitsToParent(raw);
    }
    return { collapsed, rawCount: raw.length };
}

/**
 * BM25 twin of {@link fetchCollapsedRanked} — threads the envelope's
 * `ranked` signal through instead of throwing/catching. A phrasing that
 * comes back UNRANKED on the FIRST (desiredCount-sized) fetch contributes
 * nothing, exactly like the pre-fix behaviour (an unranked LIKE-scan result
 * must never be fused alongside genuinely-ranked lists). If a later,
 * WIDENED retry happens to come back unranked (e.g. a heal raced mid-loop),
 * the loop stops and keeps the last genuinely-ranked collapsed list rather
 * than discarding already-good data.
 */
async function fetchCollapsedBm25(
    fetchRaw: (window: number) => Promise<Bm25Envelope<VerbatimSeedHit>>,
    desiredCount: number,
): Promise<{ collapsed: VerbatimSeedHit[]; rawCount: number; ranked: boolean }> {
    let window = desiredCount;
    let envelope = readBm25Envelope<VerbatimSeedHit>(await fetchRaw(window));
    if (!envelope.ranked) return { collapsed: [], rawCount: 0, ranked: false };
    let collapsed = mapAliasHitsToParent(envelope.hits);
    while (
        collapsed.length < desiredCount &&
        envelope.hits.length >= window &&
        window < desiredCount * ALIAS_OVERFETCH_MAX_MULTIPLIER
    ) {
        window = Math.min(window * ALIAS_ROW_FANOUT, desiredCount * ALIAS_OVERFETCH_MAX_MULTIPLIER);
        const next = readBm25Envelope<VerbatimSeedHit>(await fetchRaw(window));
        if (!next.ranked) break; // keep the last known-ranked collapsed list
        envelope = next;
        collapsed = mapAliasHitsToParent(envelope.hits);
    }
    return { collapsed, rawCount: envelope.hits.length, ranked: true };
}

export interface SeedFetchOutcome {
    seedNodeIds: string[];
    seedProvenance: Map<string, { matchedBy: Set<MatchKind>; score: number; rrf?: number; lists?: number }>;
    /** Raw semantic similarity per id (for `RetrieveMeta.topScore`) — NOT
     *  the fused score; recorded from every phrasing's semantic hits. */
    semanticScoreById: Map<string, number>;
    /**
     * D1 (calibrated relevance + abstention) — the same raw semantic
     * similarity as `semanticScoreById`, but recorded ONLY from the PRIMARY
     * phrasing's (`allQueries[0]`) semantic hits — never the extra phrasings
     * 3.21 step 3(f) fuses in. The calibration `s*` statistic is deliberately
     * scoped to the primary query alone (design §2): an extra phrasing that
     * happens to embed close to stored content shouldn't rescue an otherwise
     * off-topic primary query from abstention, and vice versa. Empty when
     * `allQueries[0]` has no semantic hit, or in keyword mode (no semantic
     * leg at all).
     */
    primarySemanticScoreById: Map<string, number>;
    /** True only when EVERY phrasing's bm25Search() came back ranked. */
    bm25Ranked: boolean;
    /** True when at least one phrasing's semantic leg was skipped because
     *  the embedding provider is disabled (3.21 step 3c). */
    vectorLegSkipped: boolean;
    /** Pre-dedup raw fetch count (starvation detection needs the raw
     *  window size, not how many distinct ids survived alias-collapsing +
     *  fusion). Semantic count for 'semantic'/'hybrid'; bm25 count for
     *  'keyword'. */
    rawWindowCount: number;
    /** D3 review round 2 (strength-aware anchor) — the bm25/keyword leg's
     *  own raw candidate count for this query (pre-window-truncation, MEAN
     *  per ranked phrasing — a sum would read N identical phrasings as an
     *  N-times broader match), used as a selectivity signal: a leg that matched
     *  very few rows is a rare/selective lexical match (identifiers, rare
     *  terms); a leg that filled the window is broad/common (glue words).
     *  0 when no bm25 leg ran ('semantic' mode). */
    bm25CandidateCount: number;
}

/** Record a raw semantic similarity under the STRIPPED graph id (hit ids
 *  may carry the `lore:` prefix, graph node ids never do). Keeps the max
 *  when both forms of an id appear across phrasings. */
function recordSemanticScore(into: Map<string, number>, hit: VerbatimSeedHit): void {
    const id = hit.id.startsWith('lore:') ? hit.id.slice(5) : hit.id;
    const score = hit.score ?? 0;
    const prev = into.get(id);
    if (prev === undefined || score > prev) into.set(id, score);
}

export async function fetchSeeds(
    seedStore: VerbatimSeedStore | null,
    allQueries: string[],
    mode: 'semantic' | 'keyword' | 'hybrid',
    seedFetch: number,
): Promise<SeedFetchOutcome> {
    const seedProvenance = new Map<string, { matchedBy: Set<MatchKind>; score: number; rrf?: number; lists?: number }>();
    const semanticScoreById = new Map<string, number>();
    const primarySemanticScoreById = new Map<string, number>();
    const primaryQuery = allQueries[0];
    let vectorLegSkipped = false;

    if (!seedStore) {
        return { seedNodeIds: [], seedProvenance, semanticScoreById, primarySemanticScoreById, bm25Ranked: true, vectorLegSkipped, rawWindowCount: 0, bm25CandidateCount: 0 };
    }

    if (mode === 'semantic') {
        const lists: string[][] = [];
        let rawFetchCount = 0;
        for (const q of allQueries) {
            let mapped: VerbatimSeedHit[];
            try {
                // 3.21 r9 (Finding B) — fetchCollapsedRanked does the
                // alias→parent mapping (3.21 step 3(e)) itself, over-fetching
                // the raw window when collapsing loses distinct parents.
                const outcome = await fetchCollapsedRanked((w) => seedStore.search(q, w), seedFetch);
                mapped = outcome.collapsed;
                rawFetchCount += outcome.rawCount;
            } catch (err) {
                // 3.21 step 3(c) — embeddings disabled: skip this phrasing's
                // semantic leg entirely (narrow catch — the typed
                // EmbeddingDisabledError only; anything else propagates).
                if (err instanceof EmbeddingDisabledError) { vectorLegSkipped = true; continue; }
                throw err;
            }
            for (const h of mapped) {
                recordSemanticScore(semanticScoreById, h);
                if (q === primaryQuery) recordSemanticScore(primarySemanticScoreById, h);
            }
            lists.push(mapped.map((h) => h.id));
        }
        const fused = rrfFuse(lists);
        const seedNodeIds = fused.map((f) => f.id);
        for (const f of fused) seedProvenance.set(f.id, { matchedBy: new Set<MatchKind>(['semantic']), score: f.score, rrf: f.rrf, lists: f.listsMatched });
        return { seedNodeIds, seedProvenance, semanticScoreById, primarySemanticScoreById, bm25Ranked: true, vectorLegSkipped, rawWindowCount: rawFetchCount, bm25CandidateCount: 0 };
    }

    if (mode === 'keyword') {
        // 3.21 step 3(a) — standalone BM25/keyword recall. Consults ONLY
        // the store's lexical bm25Search — NEVER seedStore.search() (the
        // semantic method, which embeds the query).
        //
        // readBm25Envelope is fail-closed: an UNRANKED phrasing (the
        // LIKE-scan fallback) contributes NOTHING to the fusion. `bm25Ranked`
        // is true only when EVERY phrasing came back ranked.
        const lists: string[][] = [];
        let rawBm25Count = 0;
        let bm25Ranked = true;
        for (const q of allQueries) {
            // 3.21 r9 (Finding B) — over-fetches the raw bm25 window when
            // alias-collapsing loses distinct parents; see fetchCollapsedBm25.
            const outcome = await fetchCollapsedBm25((w) => seedStore.bm25Search(q, w), seedFetch);
            if (!outcome.ranked) { bm25Ranked = false; continue; }
            rawBm25Count += outcome.rawCount;
            const mapped = outcome.collapsed; // already alias→parent mapped (3.21 step 3(e))
            mapped.forEach((h, idx) => {
                if (!seedProvenance.has(h.id)) seedProvenance.set(h.id, { matchedBy: new Set<MatchKind>(['bm25']), score: h.score ?? 1 / (idx + 1) });
            });
            lists.push(mapped.map((h) => h.id));
        }
        const fused = rrfFuse(lists);
        const seedNodeIds = fused.map((f) => f.id);
        for (const f of fused) {
            const prov = seedProvenance.get(f.id);
            seedProvenance.set(f.id, { matchedBy: prov?.matchedBy ?? new Set<MatchKind>(['bm25']), score: f.score, rrf: f.rrf, lists: f.listsMatched });
        }
        // mode:'keyword' has no semantic leg — primarySemanticScoreById stays
        // empty, which D1's calibration/abstention reads as "no similarity
        // available", i.e. not_applicable/abstain-inert, not a false positive.
        return { seedNodeIds, seedProvenance, semanticScoreById, primarySemanticScoreById, bm25Ranked, vectorLegSkipped, rawWindowCount: rawBm25Count, bm25CandidateCount: lists.length > 0 ? rawBm25Count / lists.length : 0 };
    }

    // hybrid — 3.21 step 3(c): the semantic half is caught INDEPENDENTLY per
    // phrasing (not a bare Promise.all, which fails the whole pair on one
    // rejection): a disabled embedding provider must degrade hybrid mode to
    // bm25-only instead of losing an already-successful bm25Search to an
    // unrelated Promise.all rejection.
    const semanticLists: string[][] = [];
    const bm25Lists: string[][] = [];
    const semanticSet = new Set<string>();
    const bm25Set = new Set<string>();
    let rawSemanticCount = 0;
    let rawBm25CountHybrid = 0;
    let bm25Ranked = true;
    for (const q of allQueries) {
        // 3.21 r9 (Finding B) — both legs now over-fetch their raw window
        // when alias-collapsing loses distinct parents (fetchCollapsedRanked /
        // fetchCollapsedBm25), still run concurrently per phrasing.
        const [semanticOutcome, bm25Outcome] = await Promise.all([
            fetchCollapsedRanked((w) => seedStore.search(q, w), seedFetch).catch((err: unknown) => {
                if (err instanceof EmbeddingDisabledError) { vectorLegSkipped = true; return { collapsed: [] as VerbatimSeedHit[], rawCount: 0 }; }
                throw err;
            }),
            fetchCollapsedBm25((w) => seedStore.bm25Search(q, w), seedFetch),
        ]);
        rawSemanticCount += semanticOutcome.rawCount;
        // fix/fts-index-and-tokenizer (item 2, follow-up): an UNRANKED bm25
        // phrasing (LIKE-scan fallback, every hit force-scored 1.0) must not
        // be fused alongside a genuinely-ranked list — excluded entirely.
        if (!bm25Outcome.ranked) bm25Ranked = false;
        // 3.21 step 3(e) — alias→parent mapping already applied to both legs
        // (fetchCollapsedRanked / fetchCollapsedBm25).
        const semanticMapped = semanticOutcome.collapsed;
        for (const h of semanticMapped) {
            recordSemanticScore(semanticScoreById, h);
            if (q === primaryQuery) recordSemanticScore(primarySemanticScoreById, h);
            semanticSet.add(h.id);
        }
        semanticLists.push(semanticMapped.map((h) => h.id));
        if (bm25Outcome.ranked) {
            const bm25Mapped = bm25Outcome.collapsed;
            for (const h of bm25Mapped) bm25Set.add(h.id);
            bm25Lists.push(bm25Mapped.map((h) => h.id));
            rawBm25CountHybrid += bm25Outcome.rawCount;
        }
    }
    // 3.21 step 3(b) — the ONE shared RRF implementation (recall/rrf.ts),
    // fusing every phrasing × leg list at once. Fuses rank POSITION only;
    // the per-id normalised `score` and the fused order come from the SAME
    // call, so they can never disagree the way two independently-computed
    // passes could.
    const fused = rrfFuse([...semanticLists, ...bm25Lists]);
    const seedNodeIds = fused.map((f) => f.id);
    for (const f of fused) {
        const matchedBy = new Set<MatchKind>();
        if (semanticSet.has(f.id)) matchedBy.add('semantic');
        if (bm25Set.has(f.id)) matchedBy.add('bm25');
        seedProvenance.set(f.id, { matchedBy, score: f.score, rrf: f.rrf, lists: f.listsMatched });
    }
    const bm25CandidateCount = bm25Lists.length > 0 ? rawBm25CountHybrid / bm25Lists.length : 0;
    return { seedNodeIds, seedProvenance, semanticScoreById, primarySemanticScoreById, bm25Ranked, vectorLegSkipped, rawWindowCount: rawSemanticCount, bm25CandidateCount };
}
