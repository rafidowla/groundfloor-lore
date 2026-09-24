/**
 * candidateWindow.ts — D3 (prefix-stable ranking): make candidate generation
 * independent of the caller's `limit`, and anchor lexical-only seed scores
 * onto the semantic scale instead of mixing incomparable score ranges.
 *
 * Split out of retrieve.ts (design doc §3.1 — retrieve.ts is at the 800-line
 * hard cap already; see docs/design/D3-prefix-stable-ranking.md).
 *
 * Root cause (design §2): every candidate-generation step in retrieve.ts
 * previously sized its fetch off `limit` directly (`seedFetch = limit * 4`,
 * `graph.search(query, limit, …)`, the starvation-retry bound). Because the
 * post-fetch re-rank (typeBias × curationBoost, up to 1.8×) runs on whatever
 * landed in that limit-sized window, two different `limit`s over the SAME
 * query could surface a materially different top-k — top-10@10 was not a
 * prefix of top-50@50 even though the underlying legs were consistent
 * (`LORE_RECALL_RANKING=off` gave 100% prefix stability on both engines).
 *
 * Fix (§3.1): every candidate-generation step uses
 * `candLimit = max(limit, candidateFloor)`, and only the FINAL slice uses
 * `limit`. For every `limit <= candidateFloor` (default 50), the candidates,
 * scores and order are therefore identical — `top-k@k` is `first k of
 * top-50` BY CONSTRUCTION, not by observation.
 *
 * §3.5 (D1 hand-off) — mixed base-score scales: a seed with a semantic score
 * gets raw cosine (0.80-0.89 in the e5 regime); a seed with none gets either
 * the normalised RRF score or a `1/(idx+1)` keyword-rank score, both of which
 * can exceed 0.85 even for a glue-word match. The 1.8x curated-type boost
 * then lets a curated bm25-only row outrank every genuinely-relevant semantic
 * row. `lexicalOnlyBase` anchors a lexical-only row's base score to
 * `semFloor x prov` — an upper bound on that row's TRUE cosine similarity
 * (it did not make the semantic top-W kNN list, so its real similarity is
 * <= the window's own minimum), scaled down further by its own lexical rank/
 * score so relative lexical ordering is preserved beneath that ceiling.
 */

/** Below this the candidate window equals `limit` exactly — LEGACY behaviour
 *  (pre-D3: `seedFetch = limit * SEED_HIDDEN_HEADROOM`, nothing more). Kept
 *  as the RECOMMENDED opt-in value (`LORE_RECALL_CANDIDATE_FLOOR=50`) — see
 *  the gating-rule note on `resolveCandidateFloor` for why it is no longer
 *  the silent default. */
export const DEFAULT_CANDIDATE_FLOOR = 50;

/** Upper clamp on an operator-supplied floor — protects worst-case query
 *  cost (the window multiplies straight into every seed-fetch call). */
export const MAX_CANDIDATE_FLOOR = 200;

/**
 * Resolve the effective candidate floor: explicit option, then
 * `LORE_RECALL_CANDIDATE_FLOOR`, then the default.
 *
 * Review round 2 gating rule — DEFAULT FLIPPED BACK TO LEGACY (0), not
 * `DEFAULT_CANDIDATE_FLOOR`. Real-10k re-measurement
 * (scripts/diagnostics/recall-eval/results/d3-before-after.md): floor=50
 * combined with `lexicalBase=rrf` (i.e. this knob in isolation) collapsed
 * real-question hit@1 from 87.5%/100% (chatty/terse, legacy) to
 * 4.2%/45.8% on sqlite (37.5%/66.7% on surreal-lance) — `stableProv`'s
 * fixed RRF normalization (needed to fix the identifiers dip) has no
 * ceiling in `rrf` mode, so a mid-rank single-list keyword match can be
 * normalized up near 1.0 and outrank the true semantic top hit. That
 * inflation is only bounded when `lexicalBase=anchored` also applies its
 * ceiling — a cross-knob dependency the gating rule (per-knob, no
 * regression) does not tolerate. `0` (legacy) is safe unconditionally, so
 * it is the default; `50` remains available as an explicit opt-in.
 * Bad env input also falls back to `0`, not `DEFAULT_CANDIDATE_FLOOR`, so
 * malformed config never silently activates a mode that requires pairing.
 * The result is an integer clamped to `[0, MAX_CANDIDATE_FLOOR]`.
 */
export function resolveCandidateFloor(opt?: number): number {
    let raw: number;
    if (typeof opt === 'number' && Number.isFinite(opt)) {
        raw = opt;
    } else {
        const env = Number(process.env.LORE_RECALL_CANDIDATE_FLOOR);
        raw = Number.isFinite(env) ? env : 0;
    }
    if (!Number.isFinite(raw) || raw < 0) raw = 0;
    const floored = Math.floor(raw);
    return Math.min(Math.max(floored, 0), MAX_CANDIDATE_FLOOR);
}

/**
 * The candidate-generation window: `floor > 0 ? max(limit, floor) : limit`.
 * `floor === 0` is the legacy escape hatch — candidate generation tracks
 * `limit` exactly, restoring pre-D3 output byte-for-byte.
 */
export function candidateLimit(limit: number, floor: number): number {
    return floor > 0 ? Math.max(limit, floor) : limit;
}

import { DEFAULT_K as RRF_K } from './rrf.js';

export type LexicalBaseMode = 'anchored' | 'rrf';

/**
 * Resolve the lexical-base mode: explicit option, then
 * `LORE_RECALL_LEXICAL_BASE`, then the default.
 *
 * Review round 2 gating rule — DEFAULT FLIPPED BACK TO LEGACY (`rrf`), not
 * `anchored`. The strength-aware ceiling (see `lexicalOnlyBase`) fixed the
 * review's HIGH finding (anchored-default identifiers rank1 0/12 -> a real
 * top-3 reach) but the real-10k re-measurement still shows it short of
 * legacy on the identifiers pass: rank1 85.0%->65.0%, found@10 95.0%->85.0%
 * (sqlite; surreal-lance 80.0%->65.0%, 90.0%->85.0%) — see
 * scripts/diagnostics/recall-eval/results/d3-before-after.md. The gating
 * rule is "identifiers rank1/found@10 must not drop vs legacy"; this drops.
 * `anchored` remains available as an explicit opt-in (its real-question
 * hit@1/hit@3 and negatives numbers are strictly better than legacy — only
 * the identifiers pass regressed). Any value other than the literal
 * `'anchored'` (case-insensitive) now resolves to `rrf`, mirroring
 * `resolveCandidateFloor`'s "bad/absent input -> legacy" posture.
 *
 * Review round 3 — `candidateFloor > 0` FORCES `anchored`, overriding an
 * explicit `'rrf'` option or env. floor>0 + rrf is not a safe combination:
 * `stableProv` (active whenever floor>0) normalizes lexical-only rows by a
 * fixed RRF max with no ceiling in `rrf` mode, so a broad keyword match can
 * outrank the semantic top hit (real-10k chatty hit@1 87.5% -> 4.2%). Only
 * the anchored ceiling bounds it, so the floor implies the anchor. With
 * `floor === 0` (default) resolution is unchanged.
 */
export function resolveLexicalBase(opt?: LexicalBaseMode, candidateFloor = 0): LexicalBaseMode {
    if (candidateFloor > 0) return 'anchored';
    if (opt === 'anchored' || opt === 'rrf') return opt;
    const env = (process.env.LORE_RECALL_LEXICAL_BASE ?? '').toLowerCase();
    return env === 'anchored' ? 'anchored' : 'rrf';
}

/**
 * Review round 2 (HIGH finding) — undo `rrfFuse`'s WINDOW-SIZE-DEPENDENT
 * normalization for `prov`. `FusedResult.score` divides each id's raw RRF
 * value by `Math.max(...allRrfValues)` — the top of THIS fused list. Widening
 * the D3 candidate window (`candLimit`) admits more semantic AND bm25
 * candidates into that SAME fused list; if some OTHER id now also appears in
 * two lists (both legs) its summed raw rrf becomes the new max, so an
 * unrelated exact-match id's `score` shrinks even though its OWN rank in
 * every list it's actually in never moved. Measured: this is the floor-only
 * regression (10/12 -> 6/12 rank-1 on the identifier probe) — it hits BOTH
 * `lexicalBase` modes, since 'rrf' mode uses `prov` as the base directly.
 *
 * Fix: normalize by the FIXED theoretical max (`1/(k+1)`, a single list's
 * rank-0 contribution) instead of the empirical, window-dependent max. This
 * value is invariant to what ELSE is in the fused list — only this id's own
 * rank(s) matter — so widening the window can no longer dilute it. Clamped
 * to 1 (a row matched in >1 list can exceed the single-list max; that's
 * correct, not a bug — multi-leg agreement IS stronger evidence).
 *
 * Gated on `floor > 0`: at `candidateFloor: 0` the window is byte-identical
 * to pre-D3 (`candLimit === limit`), so `prov` stays the UNCHANGED
 * `seedProvenance.score` there — the full-legacy escape hatch keeps its
 * exact pre-D3 numeric values, not just its pre-D3 ranking.
 *
 * Multi-query (`queries[]`) fix — divide by `listsMatched`, i.e. use the
 * MEAN per-list contribution, not the sum. A lexical-only row (only ever
 * called for rows with no semantic score) can only sit in bm25/keyword
 * lists, one per phrasing. Summing across phrasings let any row in the top
 * ~60 of two phrasings' bm25 lists clamp to 1.0 and land exactly AT the
 * anchored ceiling (~semTop), while a semantic row's base is its BEST cosine
 * across phrasings (`recordSemanticScore` takes the max) and gains nothing
 * from recurring. Measured: recall-eval queries[] hit@3 100% -> 83.3% at
 * floor=50, the answer pushed out of the top-10 by a tie of saturated
 * keyword-only rows. The per-list mean keeps a lexical-only row on the same
 * per-phrasing scale as the single-query path (identical when every
 * phrasing ranks it the same), so queries[] no longer inflates it.
 * `listsMatched === 1` (every single-query call) is unchanged.
 */
export function stableProv(prov: number, rrf: number | undefined, floor: number, listsMatched = 1): number {
    if (floor <= 0 || rrf === undefined) return prov;
    return Math.min(1, (rrf / Math.max(1, listsMatched)) * (RRF_K + 1));
}

/**
 * Review round 2 — bm25/keyword leg selectivity, 0 (broad/common — many rows
 * matched) to 1 (selective/rare — almost nothing else matched). A leg that
 * returns only a handful of rows out of a `candLimit`-sized window is a
 * strong "this term is rare" signal (identifiers, file names, error codes);
 * a leg that fills the window is a common/glue-word match. `0` candidates
 * (no bm25 leg ran, e.g. 'semantic' mode) is treated as NOT selective — the
 * safe fallback (old semFloor-capped behaviour), never boosted.
 */
export function lexicalSelectivity(bm25CandidateCount: number, candLimit: number): number {
    if (bm25CandidateCount <= 0) return 0;
    const frac = (bm25CandidateCount - 1) / Math.max(1, candLimit);
    return Math.max(0, Math.min(1, 1 - frac));
}

/**
 * Base score for a seed with NO semantic score (bm25-only or keyword-only).
 *
 * - `mode === 'rrf'` (legacy) or no semantic list at all in this query
 *   (`semFloor === undefined`) — nothing to anchor against, so the row keeps
 *   its own (now window-stable, see `stableProv`) provenance score (`prov`)
 *   unchanged.
 * - `mode === 'anchored'` (opt-in; forced when candidateFloor > 0) with a semantic list present — review
 *   round 2 (HIGH finding): the original rule (`semFloor * prov`) put a HARD
 *   CEILING at `semFloor` on every lexical-only row, no matter how strong
 *   the match — an exact rare-identifier hit (prov ~ 1) could never rank
 *   above even the WEAKEST semantic row, because `semFloor` IS that row's
 *   score. Measured: anchored default found the target in top-10 for 1/12
 *   identifier queries (rank-1 0/12) vs legacy's 12/12 (10/12).
 *
 *   Fix: make the ceiling `strength-aware`. `selectivity` (bm25 leg
 *   selectivity, `lexicalSelectivity`) picks WHERE between `semFloor` and
 *   `semTop` the row's ceiling sits: a selective/rare match (selectivity ~1)
 *   gets a ceiling near `semTop` (can compete for the top slots); a
 *   broad/common match (selectivity ~0) keeps the ORIGINAL `semFloor`
 *   ceiling exactly (`selectivity=0` reduces this formula to the pre-review
 *   `semFloor * prov` byte-for-byte). `prov` still scales everything below
 *   that ceiling by the row's own rank within its leg, so a weak/low-rank
 *   row in even a selective leg does not jump to the top.
 */
export function lexicalOnlyBase(
    prov: number,
    semFloor: number | undefined,
    semTop: number | undefined,
    mode: LexicalBaseMode,
    selectivity: number,
): number {
    if (mode === 'rrf' || semFloor === undefined) return prov;
    const top = semTop ?? semFloor;
    const ceiling = semFloor + selectivity * (top - semFloor);
    return prov * ceiling;
}

/**
 * Finding 5.4 + D3 §3.5 (+ review round 2 strength-aware anchor) — build the
 * base-score map `reRankLoreNodes` uses in place of a rank-position proxy:
 * raw vector similarity for semantic hits, `lexicalOnlyBase(...)` (anchored
 * onto the semantic scale when anchored, strength-aware) for everything else.
 * Split out of retrieve.ts purely for the 800-line file-size cap — no
 * behavioural reason to keep it inline.
 */
export function computeSeedBaseScores(
    seeds: ReadonlyArray<{ id: string }>,
    semanticScoreById: ReadonlyMap<string, number>,
    seedProvenance: ReadonlyMap<string, { score: number; rrf?: number; lists?: number }>,
    mode: LexicalBaseMode,
    ctx: { candidateFloor: number; bm25CandidateCount: number; candLimit: number },
): Map<string, number> {
    const semFloorArr = [...semanticScoreById.values()];
    const semFloor = semFloorArr.length > 0 ? Math.min(...semFloorArr) : undefined;
    const semTop = semFloorArr.length > 0 ? Math.max(...semFloorArr) : undefined;
    const selectivity = lexicalSelectivity(ctx.bm25CandidateCount, ctx.candLimit);
    const seedBaseScores = new Map<string, number>();
    for (const n of seeds) {
        const sim = semanticScoreById.get(n.id);
        if (sim !== undefined) { seedBaseScores.set(n.id, sim); continue; }
        const p = seedProvenance.get(n.id);
        if (p === undefined) continue;
        const prov = stableProv(p.score, p.rrf, ctx.candidateFloor, p.lists);
        seedBaseScores.set(n.id, lexicalOnlyBase(prov, semFloor, semTop, mode, selectivity));
    }
    return seedBaseScores;
}
