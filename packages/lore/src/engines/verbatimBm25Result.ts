/**
 * verbatimBm25Result.ts — the bm25Search() result contract.
 *
 * fix/fts-index-and-tokenizer follow-up (closes two holes in the original
 * ranked/unranked guard). The original mechanism attached the ranked/
 * unranked signal as a non-enumerable Symbol-keyed property on the result
 * ARRAY, banking on reference identity to carry it through. Verified two
 * ways it doesn't:
 *
 *   - Symbol-keyed properties do not survive v8 structured clone
 *     (`v8.serialize`/`deserialize` — the same algorithm
 *     `child_process`'s `serialization: 'advanced'` uses for IPC), so the
 *     signal was lost crossing into the opt-in search-worker process
 *     (engines/verbatimSearchWorkerProxy.ts, LORE_SEARCH_WORKER). Worse:
 *     the worker entry additionally JSON-round-trips the return value
 *     before that (toCloneable() in verbatimSearchWorkerEntry.ts), which
 *     strips symbol keys by itself — two independent loss mechanisms.
 *   - `Array.prototype.map()` never copies non-index own properties
 *     (symbol or otherwise) from the source array onto its result — a
 *     language guarantee, not something to test — so
 *     verbatimStoreAdapter.ts's `hits.map(fromLegacy)` silently dropped
 *     the tag (not on the live retrieve.ts path today, but a real bug in
 *     a facade that exists to be routed through).
 *
 * Replacement: the signal travels EXPLICITLY INSIDE the returned data —
 * `{ hits, ranked }` — so it survives any transform that touches `hits`
 * without knowing about `ranked`, any serialization boundary that
 * round-trips plain data, and any cache that returns the same or an
 * equal-shaped value. Every bm25Search() implementer (VerbatimStore,
 * DataplaneVectorStore, ArcadeVectorStore, VerbatimStoreAdapter,
 * VerbatimSearchWorkerProxy via inherited IPC forwarding) returns this
 * envelope; `ranked` states plainly whether `hits` is a genuine BM25/
 * lexical ranking (safe to fuse via RRF) or an unranked substring/LIKE
 * scan (every hit force-scored 1.0 — NOT a ranking, must be excluded).
 *
 * Fail-closed contract: `readBm25Envelope` treats anything that is not
 * STRUCTURALLY a well-formed `{hits: array, ranked: boolean}` envelope —
 * wrong type, null, undefined, a stripped/corrupted value that crossed a
 * boundary and lost `ranked`, a legacy caller that returned a bare array —
 * as UNRANKED with an EMPTY hit list. A lost or corrupted signal degrades
 * the read to semantic-only; it must never silently corrupt the fused
 * order by defaulting to "ranked".
 */

/** One bm25Search() response: the hits plus whether they are a genuine
 *  ranking. Generic over the element shape — the legacy `VectorProvider`
 *  world (providers/types.ts VerbatimSearchResult) and the newer
 *  `IVerbatimStore` contract (contracts/verbatim.ts VerbatimSearchResult)
 *  use different hit shapes; this envelope wraps either. */
export interface Bm25Envelope<T> {
    hits: T[];
    ranked: boolean;
}

export function makeBm25Envelope<T>(hits: T[], ranked: boolean): Bm25Envelope<T> {
    return { hits, ranked };
}

/**
 * Fail-closed reader. `value` is `unknown` deliberately: it may have
 * crossed a process boundary, come back from an old/foreign caller, or be
 * garbage. Anything that isn't a well-formed envelope is read as UNRANKED
 * with zero hits — never as "ranked", and this never throws.
 */
export function readBm25Envelope<T>(value: unknown): Bm25Envelope<T> {
    if (!value || typeof value !== 'object') return { hits: [], ranked: false };
    if (!('hits' in value) || !('ranked' in value)) return { hits: [], ranked: false };
    const hits = value.hits;
    const ranked = value.ranked;
    if (!Array.isArray(hits) || typeof ranked !== 'boolean') return { hits: [], ranked: false };
    // `hits` is verified to be an array; its element shape is the generic
    // `T` the caller supplies (the same trust boundary every bm25Search
    // implementer's own return-type declaration already relies on).
    return { hits: hits as T[], ranked };
}

/**
 * Shape of a lore_verbatim row as returned by LanceDB's `.toArray()` —
 * typed `any[]` by the library itself (node_modules/@lancedb/lancedb/dist/
 * query.d.ts: `toArray(): Promise<any[]>`). Every field is a value
 * VerbatimStore wrote under the schema in buildVerbatimSchema(); the cast
 * at each `.toArray() as unknown as VerbatimFtsRow[]` call site is a
 * one-time narrowing at the library boundary, not a trust decision about
 * external data.
 */
export interface VerbatimFtsRow {
    id: string;
    text?: string;
    _score?: number;
    score?: number;
    type?: string;
    label?: string;
    tags?: string;
    project?: string;
    ecosystem?: string;
    updatedAt?: string;
    security_scopes?: string[];
}
