/**
 * pieceSeedSearch.ts — D7b (3.23, piece-level vectors), design section 2.5.
 *
 * Retrieval-side counterpart to D7a's per-engine `searchPieces` /
 * `pieceIndexStatus` delegators (engines/verbatimStore.ts,
 * engines/sqliteVerbatimStore.ts). Nothing here talks to LanceDB or SQLite
 * directly — this module only groups piece-level hits up to their owning
 * node and translates an engine's raw piece-index status into the
 * `_meta.pieceVectors` shape `resolveSeedStore`/`retrieve.ts` surface.
 *
 * `PieceSearchCapableStore` is deliberately structural (not the concrete
 * `VerbatimStore`/`SqliteVerbatimStore` classes) — same "feature-detect,
 * don't re-narrow to a class" convention `recallCrossWorkspace.ts` already
 * uses for `LoreGraph`/`LoreVerbatim`. Both engines' `searchPieces` already
 * satisfy this shape (their query embedding differs internally: Lance
 * embeds once via its own `embeddingProvider`, SQLite's `SqlitePieceIndex`
 * embeds a string query internally — this module never embeds anything
 * itself, exactly as `resolveSeedStore`'s existing `vectorSeeds` closure
 * never embeds for the pooled-vector path either).
 */

export interface PieceSearchRow {
    nodeId: string;
    score: number;
}

export interface PieceSearchCapableStore {
    searchPieces(
        query: string,
        topK: number,
        filter?: Record<string, unknown>,
        actorScopes?: ReadonlyArray<string>,
        gate?: { signal?: AbortSignal },
    ): Promise<PieceSearchRow[]>;
    pieceIndexStatus(): { open: boolean; valid: boolean; reason?: string };
}

/** Structural — matches ecosystemSeedUnion.ts's `VerbatimSeedHit` exactly
 *  (`{id, score?}`) without importing it, so this module has no dependency
 *  on retrieveSeedStore.ts's own import graph. */
export interface PieceSeedHit {
    id: string;
    score?: number;
}

export type PieceVectorsStatus = 'active' | 'off' | 'not_built' | 'stale' | 'unsupported';

/** `_meta.pieceVectors` (RetrieveMeta, camelCase) / `_meta.piece_vectors`
 *  (RecallMeta, snake_case) — design 2.5. Absent entirely from meta when
 *  intent is off (status:'off' is still a VALID value of this type, used
 *  internally by resolveSeedStore before it decides to omit the field —
 *  callers that build `_meta` omit the key rather than emitting
 *  `{status:'off'}`, see retrieve.ts/recallPreset.ts). */
export interface PieceVectorsMeta {
    status: PieceVectorsStatus;
    layout?: 'pieces-v1';
    piecesFetched?: number;
    nodesGrouped?: number;
    reason?: string;
}

/** LORE_RECALL_PIECE_FANOUT — int, default 8, clamped to [2, 32] (design
 *  2.5 / envScrub.ts). Read fresh each call, same convention as
 *  candidateWindow.ts's resolveCandidateFloor — no caching, so tests can
 *  flip it per case via process.env. Bad/unset input falls back to the
 *  default, then is clamped like any other value (matches
 *  resolveCandidateFloor's "malformed config never silently activates an
 *  extreme" stance). */
export const DEFAULT_PIECE_FANOUT = 8;
export const MIN_PIECE_FANOUT = 2;
export const MAX_PIECE_FANOUT = 32;

const MIN_PIECE_N = 64;
const MAX_PIECE_N = 2000;
const MAX_PIECE_REQUERY_N = 4000;

export function resolvePieceFanout(): number {
    const env = Number(process.env.LORE_RECALL_PIECE_FANOUT);
    const raw = Number.isFinite(env) ? env : DEFAULT_PIECE_FANOUT;
    const floored = Math.floor(raw);
    if (!Number.isFinite(floored)) return DEFAULT_PIECE_FANOUT;
    return Math.min(Math.max(floored, MIN_PIECE_FANOUT), MAX_PIECE_FANOUT);
}

function groupByNodeMax(rows: PieceSearchRow[]): Map<string, PieceSeedHit> {
    const grouped = new Map<string, PieceSeedHit>();
    for (const row of rows) {
        const cur = grouped.get(row.nodeId);
        if (!cur || row.score > (cur.score ?? -Infinity)) {
            grouped.set(row.nodeId, { id: row.nodeId, score: row.score });
        }
    }
    return grouped;
}

/** Optional out-param this function fills by side effect so callers that
 *  need `_meta.pieceVectors.piecesFetched`/`nodesGrouped` (resolveSeedStore)
 *  can read them without changing this function's primary, design-documented
 *  return shape (`Promise<PieceSeedHit[]>`). Last-call-wins when a caller
 *  reuses one object across multiple `pieceAwareSearch` calls within a
 *  single retrieve() — the design does not ask for cumulative stats across
 *  the ecosystem/project-union legs, only for what fed the final fused seed
 *  set, so "the most recent call's numbers" is the documented contract, not
 *  an implementation shortcut. */
export interface PieceSearchStats {
    piecesFetched: number;
    nodesGrouped: number;
}

/**
 * pieceAwareSearch(store, q, w, filter, scopes, gate) — design 2.5.
 *
 * `N = clamp(w * FANOUT, 64, 2000)`. Calls `store.searchPieces(q, N, filter,
 * scopes, gate)`, groups the returned `{nodeId, score}` rows by node (max
 * score per node), and returns the top `w` as `{id: nodeId, score}` sorted
 * descending. If there are fewer distinct nodes than `w` AND the rows
 * returned equal `N` exactly (a real "wall", not just fewer pieces than
 * asked for), re-queries ONCE with `min(2N, 4000)` — bounded, single retry.
 * Scores follow each engine's own convention (Lance `1 - _distance/2`,
 * SQLite `1 - cosine distance`) and are never normalised across engines
 * here, matching the pooled-vector path today.
 */
export async function pieceAwareSearch(
    store: PieceSearchCapableStore,
    query: string,
    limit: number,
    filter?: Record<string, unknown>,
    actorScopes?: ReadonlyArray<string>,
    gate?: { signal?: AbortSignal },
    statsOut?: PieceSearchStats,
): Promise<PieceSeedHit[]> {
    const fanout = resolvePieceFanout();
    const n = Math.min(Math.max(limit * fanout, MIN_PIECE_N), MAX_PIECE_N);
    let rows = await store.searchPieces(query, n, filter, actorScopes, gate);
    let grouped = groupByNodeMax(rows);
    if (grouped.size < limit && rows.length === n) {
        const n2 = Math.min(n * 2, MAX_PIECE_REQUERY_N);
        if (n2 > n) {
            rows = await store.searchPieces(query, n2, filter, actorScopes, gate);
            grouped = groupByNodeMax(rows);
        }
    }
    if (statsOut) {
        statsOut.piecesFetched = rows.length;
        statsOut.nodesGrouped = grouped.size;
    }
    return [...grouped.values()]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);
}

/** Reasons `pieceLayout.ts`'s `isPieceSidecarValid` (and
 *  `LancePieceIndex.initialize`'s own "sidecar valid but table missing"
 *  fallback) actually produce for "never built" vs. "built, now unusable"
 *  — split here rather than in each engine, so both engines' `reason`
 *  strings map to the same two buckets by the same rule. */
const NOT_BUILT_REASONS = new Set(['no sidecar', 'incomplete build']);

/**
 * pieceStatusOf(store, intentOn) — translate a raw per-engine
 * `PieceIndexStatus` (`{open, valid, reason}`) plus the resolved intent
 * flag into the `_meta.pieceVectors` status enum.
 *
 * - `intentOn` false → `'off'` (the field is omitted from `_meta` entirely
 *   by the caller — see retrieve.ts/recallPreset.ts — this function only
 *   returns the status value, it does not decide presence/absence).
 * - No store, or the store doesn't expose `searchPieces`/`pieceIndexStatus`
 *   (cloud/Dataplane, or a store without the D7 hooks) → `'unsupported'`.
 * - `open && valid` → `'active'`.
 * - Otherwise → `'not_built'` when the reason means the index was never
 *   built (no sidecar / an interrupted build), else `'stale'` (a sidecar
 *   exists but disagrees with the live layout/embedding fingerprint, or the
 *   table itself went missing out from under a valid sidecar).
 */
export function pieceStatusOf(
    store: PieceSearchCapableStore | null | undefined,
    intentOn: boolean,
): PieceVectorsMeta {
    if (!intentOn) return { status: 'off' };
    if (!store || typeof store.searchPieces !== 'function' || typeof store.pieceIndexStatus !== 'function') {
        return { status: 'unsupported' };
    }
    const raw = store.pieceIndexStatus();
    if (raw.open && raw.valid) return { status: 'active', layout: 'pieces-v1' };
    const reason = raw.reason ?? 'unknown';
    return { status: NOT_BUILT_REASONS.has(reason) ? 'not_built' : 'stale', reason };
}

export interface PieceRoutingDecision {
    /** True exactly when the caller should route seed search through
     *  `pieceAwareSearch` instead of the pooled-vector path. */
    active: boolean;
    /** `raw` narrowed to `PieceSearchCapableStore`, populated only when
     *  `active` (never a half-usable reference otherwise). */
    capable: PieceSearchCapableStore | null;
    /** `_meta.pieceVectors` value. Present whenever intent is on — even when
     *  not currently active (`'not_built'`/`'stale'`/`'unsupported'`, so a
     *  caller who turned intent on can see WHY it isn't serving yet) —
     *  `undefined` when intent is off, so the caller omits the key entirely
     *  and default responses stay byte-identical (design 2.5). */
    meta: PieceVectorsMeta | undefined;
}

/**
 * resolvePieceRouting(raw) — the single gating decision design 2.5 step 3
 * describes ("if intent is on, `searchPieces` exists, and status is
 * 'active'"), centralized so `retrieveSeedStore.ts` and
 * `recallCrossWorkspace.ts` don't each re-derive it. `raw` is untyped on
 * purpose: it is whatever structural store object the caller already has
 * (a boot `rawVerbatim()` handle, a resolver's per-workspace store, or a
 * cross-workspace `LoreVerbatim` union member) — feature-detected here the
 * same way the rest of this codebase narrows a `LoreGraph`/`LoreVerbatim`
 * union without naming a concrete class.
 */
export function resolvePieceRouting(raw: unknown): PieceRoutingDecision {
    const candidate = raw as
        | (Partial<PieceSearchCapableStore> & { pieceVectorsIntentOn?: () => boolean })
        | null
        | undefined;
    const capableRaw = candidate && typeof candidate.searchPieces === 'function' && typeof candidate.pieceIndexStatus === 'function'
        ? (candidate as PieceSearchCapableStore)
        : null;
    const intentOn = !!candidate && typeof candidate.pieceVectorsIntentOn === 'function' && candidate.pieceVectorsIntentOn();
    if (!intentOn) return { active: false, capable: null, meta: undefined };
    const meta = pieceStatusOf(capableRaw, true);
    const active = meta.status === 'active';
    return { active, capable: active ? capableRaw : null, meta };
}

/**
 * pieceCalibrationIdentityFor(raw) — a stable, distinct object per raw store
 * for D1's calibration WeakMap key (design 2.5: "set calibrationIdentity to
 * the piece index object... so D1 re-fits"). Lazily created and cached
 * per-`raw` so repeated calls within (and across) retrieve() invocations
 * against the SAME open store reuse one fit rather than re-fitting every
 * call — only a different `raw` (a reopen, a different workspace) gets a
 * different identity. Deliberately NOT `raw` itself: that would collide
 * with the pooled-vector path's own `calibrationIdentity: raw`, defeating
 * the whole point of forcing a re-fit when a seed store switches into piece
 * mode.
 */
const pieceCalibrationIdentities = new WeakMap<object, object>();

export function pieceCalibrationIdentityFor(raw: object): object {
    let id = pieceCalibrationIdentities.get(raw);
    if (!id) {
        id = { pieceVectorsFor: raw };
        pieceCalibrationIdentities.set(raw, id);
    }
    return id;
}
