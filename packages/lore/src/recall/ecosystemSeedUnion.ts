/**
 * ecosystemSeedUnion.ts — the ecosystem-scoped seed query, UNIONED with the
 * unscoped one, for `recall/retrieve.ts`'s vector + BM25 seed pass.
 *
 * Its own module rather than more lines in `retrieve.ts` (CLAUDE.md's file-size
 * budget: that file is already past the 500-line target and this round added to
 * it). One concern: how a concrete ecosystem scope becomes a CANDIDATE set.
 * Nothing here decides what is RETURNED — `retrieve()`'s post-hydration
 * `n.ecosystem === ecosystemScope` check, which reads the authoritative graph
 * node, is the only thing that does.
 *
 * License: original work for groundfloor-lore.
 */

import { readBm25Envelope } from '../engines/verbatimBm25Result.js';
import type { Bm25Envelope } from '../engines/verbatimBm25Result.js';

/** A verbatim seed result — the `{ id, score }` shape both the boot
 *  storageClient and a per-workspace VerbatimStore return. */
export interface VerbatimSeedHit { id: string; score?: number }

/**
 * Ecosystem-scoped vector/BM25 seeding: the scoped query UNIONED with the
 * unscoped one, unconditionally, whenever a concrete ecosystem is requested.
 *
 * The pushdown filter matches on the VERBATIM ROW's `ecosystem` metadata; the
 * authoritative value is the GRAPH NODE's. Those are two representations of
 * one fact and they can disagree — two bulk write paths stamped a literal '*'
 * into verbatim metadata while the graph node kept the caller's real ecosystem
 * (fixed at the root in `http/routes/bulkWrite.ts` + `bulkEmbedFlush.ts`, but
 * rows already on disk keep the old metadata, and any future path can
 * reintroduce it). Relying SOLELY on the pushdown turns such a disagreement
 * into silent, total invisibility: the row never comes back, so the
 * post-hydration check in `retrieve()` — which reads the graph node and is
 * therefore RIGHT — never gets to see it.
 *
 * ─── Why this is unconditional (the round-1 fix was not enough) ───────────
 *
 * The first cut made the unscoped query a bounded TOP-UP: it ran only when the
 * scoped query returned fewer rows than the requested window. That looks like
 * a free correctness net and is not one, because the trigger is backwards. An
 * ecosystem with a NORMAL amount of correctly-tagged data fills the window on
 * the scoped query alone, so the top-up never fires — and the mismatched rows
 * in that same ecosystem stay invisible forever. The condition only fires for
 * small/sparse ecosystems, i.e. exactly the case that was never broken. That
 * is a regression against pre-pushdown behavior (one global top-K + a
 * post-hydration graph filter), which recovered such rows correctly.
 *
 * A correctness backstop cannot be gated on how full the primary result looked.
 * So both queries always run and their union becomes the CANDIDATE set; the
 * authoritative decision stays where it belongs — `retrieve()`'s post-hydration
 * `n.ecosystem === ecosystemScope` filter, which reads the graph node.
 *
 * Each half earns its keep:
 *   - the SCOPED half guarantees the requested ecosystem's own best candidates
 *     are in the window even when other ecosystems dominate the workspace (the
 *     crowding-out problem the pushdown was introduced for — LongMemEval: raw
 *     candidate count for one ecosystem fell 150 → single digits as unrelated
 *     data accumulated);
 *   - the UNSCOPED half is byte-for-byte the pre-pushdown query, so any row
 *     whose metadata copy is wrong is still reachable, exactly as before.
 *
 * ─── What the union actually COSTS (do not re-litigate this from the old
 *     performance claim) ──────────────────────────────────────────────────
 *
 * Be honest about the trade, because the pushdown's original justification no
 * longer describes what runs:
 *
 *   - LATENCY is back to roughly the pre-pushdown figure. The two halves are
 *     issued concurrently, so wall clock is max(scoped, unscoped) — and the
 *     UNSCOPED query IS the slow one (it is the pre-pushdown query verbatim).
 *     The ~15x seed-latency growth the LongMemEval note attributes to
 *     ecosystem crowding is therefore NOT recovered by the pushdown any more.
 *   - What the pushdown still buys is candidate QUALITY: the scoped half
 *     guarantees the requested ecosystem's own best rows are in the window
 *     even when unrelated ecosystems dominate the workspace (raw candidate
 *     count for one ecosystem fell 150 → single digits without it). That, not
 *     latency, is why it stays.
 *   - THROUGHPUT roughly halves on COLD scoped hybrid recalls. The SP-22 result
 *     cache keys on the filter (verbatimStore.ts `normFilter`), so the scoped
 *     and unscoped halves are two DISTINCT entries — they never share a hit.
 *     A cold pair therefore costs 2 `embedQuery` ONNX runs + 2 LanceDB vector
 *     scans (+ 2 bm25 scans in hybrid), each taking a SearchGate permit, under
 *     that gate's bounded concurrency. Warm, it is 2 cache lookups and no
 *     permits (`cachedRead` wraps the gate, so hits never take one), which is
 *     why this is a throughput cost on cold/varied queries rather than a flat
 *     2x on everything.
 *   - HYDRATION is bounded at 2x the window per METHOD, not per call. Hybrid
 *     fuses two 2x-sized lists through RRF, so `getNodesByIds` can receive up
 *     to 4x the window.
 *
 * None of that makes the union wrong — a correctness backstop that only fires
 * when the primary looked thin is not a backstop — but the cost is real and
 * the next reader should weigh the real number, not the old one.
 *
 * `'*'` (crossProject / no ecosystem) still runs exactly one unfiltered query
 * — nothing to reconcile there, and no added cost.
 */
export async function seedWithEcosystemUnion(
    run: (limit: number, filter?: { ecosystem: string }) => Promise<VerbatimSeedHit[]>,
    limit: number,
    filter: { ecosystem: string } | undefined,
): Promise<VerbatimSeedHit[]> {
    if (!filter) return run(limit, undefined);
    // Scoped first so a store that records its calls sees the optimisation
    // query first; both are in flight together (one round trip, not two).
    const [scoped, unfiltered] = await Promise.all([run(limit, filter), run(limit, undefined)]);
    if (unfiltered.length === 0) return scoped;
    if (scoped.length === 0) return unfiltered;
    const merged = new Map<string, VerbatimSeedHit>();
    for (const h of scoped) merged.set(h.id, h);
    for (const h of unfiltered) if (!merged.has(h.id)) merged.set(h.id, h);
    // Re-rank by score so the union is ordered the way a single query would
    // be: RRF downstream consumes rank position, not the raw score.
    return [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** BM25 twin of {@link seedWithEcosystemUnion}. Returns the ORIGINAL envelope
 *  value untouched on the unscoped path, so search-everything is byte-for-byte
 *  what it was. `ranked` is fail-closed on merge: a union is only as
 *  trustworthy as its least-ranked half (see readBm25Envelope's contract). */
export async function bm25WithEcosystemUnion(
    run: (limit: number, filter?: { ecosystem: string }) => Promise<Bm25Envelope<VerbatimSeedHit>>,
    limit: number,
    filter: { ecosystem: string } | undefined,
): Promise<Bm25Envelope<VerbatimSeedHit>> {
    if (!filter) return run(limit, undefined);
    const [first, second] = await Promise.all([run(limit, filter), run(limit, undefined)]);
    const firstEnv = readBm25Envelope<VerbatimSeedHit>(first);
    const secondEnv = readBm25Envelope<VerbatimSeedHit>(second);
    if (secondEnv.hits.length === 0) return first;
    if (firstEnv.hits.length === 0) return second;
    const merged = new Map<string, VerbatimSeedHit>();
    for (const h of firstEnv.hits) merged.set(h.id, h);
    for (const h of secondEnv.hits) if (!merged.has(h.id)) merged.set(h.id, h);
    return {
        hits: [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
        ranked: firstEnv.ranked && secondEnv.ranked,
    };
}

