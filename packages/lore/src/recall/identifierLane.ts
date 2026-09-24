/**
 * identifierLane.ts — D3 follow-up: exact-identifier lane for the anchored
 * (candidateFloor > 0) ranking mode.
 *
 * Problem (docs/design/D3-prefix-stable-ranking.md §3.9): the limit-independent
 * candidate window + anchored lexical base makes rankings prefix-stable, but
 * exact-identifier queries ("fixture symbol #3", `ERR_LEASE_EXPIRED`,
 * `src/job-table/renewToken.ts`) lost rank vs legacy: the row that names the
 * identifier verbatim is often not in the semantic top-W at all (e5 cosines
 * for "#3" vs "#30" are indistinguishable), and a lexical-only row's base is
 * capped by the anchored ceiling. Measured on the real 10k fixture:
 * identifiers rank1 85% -> 65%, found@10 95% -> 85%, on both engines.
 *
 * Fix: when the query carries identifier-shaped tokens (D1's detector,
 * `extractIdentifierTokens`), rows whose label/content contain one of them
 * as a WHOLE token (`containsWholeToken`, case-sensitive — the same test D1's
 * abstention rescue uses) are pinned ahead of the D3-ranked list, then the
 * D3 ranking fills the remaining slots.
 *
 * Prefix stability: the pinned list is computed from (a) the D3-ranked seed
 * list, which is already identical for every `limit <= candLimit`, and (b) a
 * per-token lexical fetch of a FIXED size (`IDENTIFIER_LANE_FETCH`, never
 * `limit`), in a total order (tokens matched desc, rarest matched token
 * first, D3 rank, lane rank). So top-k@k is still the first k of top-50.
 *
 * Reach: (b) queries the store's BM25 index and the graph keyword leg with
 * the TOKEN alone, so an exact match outside the ANN window (and outside the
 * whole-query BM25 window, where glue words dilute it) is still found.
 */

import type { LoreNode } from '../providers/types.js';
import type { Bm25Envelope } from '../engines/verbatimBm25Result.js';
import { readBm25Envelope } from '../engines/verbatimBm25Result.js';
import { mapAliasHitsToParent } from '../core/questionAliases.js';
import { extractIdentifierTokens, containsWholeToken } from './abstention.js';
import type { MatchKind } from './retrieveTypes.js';

/** Per-token lexical fetch size. Fixed (never derived from `limit`) so the
 *  lane's candidate set is limit-independent. */
export const IDENTIFIER_LANE_FETCH = 50;
/** At most this many identifier tokens per query get a lane fetch. */
export const MAX_IDENTIFIER_TOKENS = 3;
/** At most this many rows are pinned. A common identifier (matched by
 *  hundreds of rows) pins its best-ranked 10, never the whole window. */
export const MAX_PINNED = 10;

/** Unique identifier-shaped tokens of `query`, first `MAX_IDENTIFIER_TOKENS`. */
export function identifierLaneTokens(query: string): string[] {
    return [...new Set(extractIdentifierTokens(query))].slice(0, MAX_IDENTIFIER_TOKENS);
}

const nodeText = (n: LoreNode): string => `${n.label ?? ''}\n${n.content ?? ''}`;

/**
 * Pure pinning step. `ranked` is the D3-ranked seed list; `extras` are lane
 * rows fetched by token (in lane order), possibly overlapping `ranked`.
 * Returns `[...pinned, ...ranked minus pinned]` — extras that are not pinned
 * are dropped (they have no D3 score to place them by).
 *
 * Pinned order (a total order, so deterministic):
 *   1. more distinct query identifier tokens matched first;
 *   2. then the rarest matched token first (fewest matching rows in the pool
 *      — "#3" matched by 1 row beats `dispatchBatch.ts` matched by 89);
 *   3. then position in the pool: D3 rank for rows in `ranked`, after every
 *      ranked row for lane-only rows (in lane order).
 */
export function pinIdentifierMatches(
    ranked: readonly LoreNode[],
    extras: readonly LoreNode[],
    tokens: readonly string[],
    maxPinned = MAX_PINNED,
): { ordered: LoreNode[]; pinned: LoreNode[] } {
    if (tokens.length === 0 || maxPinned <= 0) return { ordered: [...ranked], pinned: [] };
    const pool: LoreNode[] = [];
    const seen = new Set<string>();
    for (const n of [...ranked, ...extras]) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        pool.push(n);
    }
    const matchedBy = pool.map((n) => { const text = nodeText(n); return tokens.filter((t) => containsWholeToken(text, t)); });
    const freq = new Map<string, number>(tokens.map((t) => [t, 0]));
    for (const m of matchedBy) for (const t of m) freq.set(t, freq.get(t)! + 1);
    const cands: Array<{ idx: number; count: number; rarity: number }> = [];
    matchedBy.forEach((m, idx) => {
        if (m.length > 0) cands.push({ idx, count: m.length, rarity: Math.min(...m.map((t) => freq.get(t)!)) });
    });
    cands.sort((a, b) => (b.count - a.count) || (a.rarity - b.rarity) || (a.idx - b.idx));
    const pinned = cands.slice(0, maxPinned).map((c) => pool[c.idx]!);
    const pinnedIds = new Set(pinned.map((n) => n.id));
    return { ordered: [...pinned, ...ranked.filter((n) => !pinnedIds.has(n.id))], pinned };
}

export interface IdentifierLaneDeps {
    /** Store BM25 (lexical) search; omitted when there is no seed store or the
     *  mode forbids it. Never the semantic `search` (no embedding call). */
    bm25Search?: (q: string, n: number) => Promise<Bm25Envelope<{ id: string; score?: number }>>;
    /** Graph keyword leg (`graph.search`), catches rows with no verbatim row. */
    keywordSearch: (q: string, n: number) => Promise<LoreNode[]>;
    hydrate: (ids: string[]) => Promise<Map<string, LoreNode>>;
    /** The same seed-level visibility/filter chain the seeds went through. */
    admit: (nodes: LoreNode[]) => LoreNode[];
    /** Seed provenance map; lane-only pinned rows get an entry. */
    provenance: Map<string, { matchedBy: Set<MatchKind>; score: number; rrf?: number; lists?: number }>;
}

/**
 * Fetch lane rows for each identifier token of `query` and pin exact matches
 * ahead of `ranked`. Returns `ranked` unchanged when the query has no
 * identifier-shaped token. Fetch errors propagate exactly as the seed legs'
 * do (abort/deadline included).
 */
export async function applyIdentifierLane(query: string, ranked: LoreNode[], deps: IdentifierLaneDeps): Promise<LoreNode[]> {
    const tokens = identifierLaneTokens(query);
    if (tokens.length === 0) return ranked;
    const laneIds: string[] = [];
    const via = new Map<string, MatchKind>();
    const keywordNodes = new Map<string, LoreNode>();
    const push = (id: string, kind: MatchKind): void => { if (!via.has(id)) { via.set(id, kind); laneIds.push(id); } };
    for (const tok of tokens) {
        if (deps.bm25Search) {
            const env = readBm25Envelope<{ id: string; score?: number }>(await deps.bm25Search(tok, IDENTIFIER_LANE_FETCH));
            // An unranked envelope (LIKE fallback) carries no order worth using.
            if (env.ranked) for (const h of mapAliasHitsToParent(env.hits)) push(h.id.startsWith('lore:') ? h.id.slice(5) : h.id, 'bm25');
        }
        for (const n of await deps.keywordSearch(tok, IDENTIFIER_LANE_FETCH)) { keywordNodes.set(n.id, n); push(n.id, 'keyword'); }
    }
    const rankedIds = new Set(ranked.map((n) => n.id));
    const toHydrate = laneIds.filter((id) => !rankedIds.has(id) && !keywordNodes.has(id));
    const hydrated = toHydrate.length > 0 ? await deps.hydrate(toHydrate) : new Map<string, LoreNode>();
    const raw: LoreNode[] = [];
    for (const id of laneIds) {
        if (rankedIds.has(id)) continue;
        const n = keywordNodes.get(id) ?? hydrated.get(id);
        if (n) raw.push(n);
    }
    const extras = deps.admit(raw);
    const { ordered, pinned } = pinIdentifierMatches(ranked, extras, tokens);
    pinned.forEach((n) => {
        if (!deps.provenance.has(n.id)) {
            const laneRank = laneIds.indexOf(n.id);
            deps.provenance.set(n.id, { matchedBy: new Set<MatchKind>([via.get(n.id) ?? 'keyword']), score: 1 / (laneRank + 1) });
        }
    });
    return ordered;
}
