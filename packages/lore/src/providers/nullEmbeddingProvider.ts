/**
 * nullEmbeddingProvider.ts — 3.21 step 3(c): an EmbeddingProvider that
 * deliberately does nothing, for hosts that run Lore with embeddings
 * disabled (`LORE_EMBEDDING_PROVIDER=none`, or
 * `createLore({ embeddingProvider: new NullEmbeddingProvider() })`).
 *
 * Lore stays a database — this provider has NO model calls of its own; it
 * exists purely as an explicit, typed "embeddings are off" marker that every
 * write/read path can recognise and degrade around cleanly:
 *
 *   - `initialize()` is a no-op that never throws (it is not an embed call).
 *   - Every EMBED method (`embed`/`embedQuery`/`embedDocument`/
 *     `embedDocumentBatch`) throws `EmbeddingDisabledError` — callers that
 *     reach one without checking `modelId === 'none'` first get a clear,
 *     typed, attributable failure instead of a confusing model-load error.
 *
 * Write paths (VerbatimStore.store()/storeBatch(), engines/verbatimFingerprintGate.ts)
 * check `modelId === 'none'` PROACTIVELY and skip the vector write / the
 * fingerprint stamp-or-compare entirely — they never call an embed method on
 * this provider at all, so a node write always succeeds with no vector
 * attempted. Read paths (recall/retrieve.ts's semantic seed fetch) catch
 * `EmbeddingDisabledError` specifically (never a broad catch) and degrade the
 * semantic leg to "not consulted", flagging `vectorLegSkipped` on the
 * response — the lexical/keyword path (item 3.21-a) is unaffected, since it
 * never calls an embed method either.
 */

/** Thrown by every embed-shaped method on {@link NullEmbeddingProvider}, and
 *  the shared "no embedder" contract any other disabled-embedder stand-in
 *  (e.g. a test double, or a store's own local null-object) is expected to
 *  throw. A caller reaching this means it did not check for embeddings being
 *  disabled before attempting an embed — the fix belongs at the call site,
 *  never here.
 *
 *  Unified 3.21 integration (i1): this was briefly defined twice — once here
 *  (r3, the "recall" stream) and once, independently, as
 *  `providers/embeddingDisabledError.ts` (v3, the "vectors" stream, written
 *  against a worktree that did not yet have this file). That file is now
 *  deleted in favor of this one, per its own header's stated convergence
 *  plan. `isEmbeddingDisabledError` below is the duck-typed check the
 *  deleted file offered — kept here so callers do not need `instanceof`
 *  across module/branch boundaries. */
export class EmbeddingDisabledError extends Error {
    readonly code = 'embedding_disabled';
    constructor(method = 'embed') {
        super(`Embeddings are disabled (LORE_EMBEDDING_PROVIDER=none / a NullEmbeddingProvider is configured) — ${method}() must not be called. Vector writes/reads should have been skipped before reaching the embedding provider.`);
        this.name = 'EmbeddingDisabledError';
    }
}

/**
 * NullEmbeddingProvider — the explicit "no embeddings" provider.
 *
 * `modelId` is the literal string `'none'`; every write/read path that needs
 * to recognise "embeddings are off" checks THIS value (not `instanceof`, so
 * a host's own equivalent stand-in — e.g. a test double — is recognised the
 * same way a real instance is).
 */
export class NullEmbeddingProvider {
    readonly modelId = 'none';
    /** No real vector space, so no real width. 0 is never written to disk —
     *  every write path skips this provider before touching LanceDB's
     *  vector column. */
    readonly dimension = 0;
    /** Deliberately undefined — never valid to fingerprint-compare against a
     *  real store's on-disk `dtype`. The fingerprint gate skips this
     *  provider entirely (see verbatimFingerprintGate.ts), so this is never
     *  read for that purpose; declared for interface completeness only. */
    readonly dtype: string | undefined = undefined;

    async initialize(): Promise<void> {
        // Not an embed call — never throws. A caller that only initializes
        // stores (count/search-by-bm25/etc.) must not be blocked by
        // embeddings being off.
    }

    async embed(): Promise<never> {
        throw new EmbeddingDisabledError('embed');
    }

    async embedQuery(): Promise<never> {
        throw new EmbeddingDisabledError('embedQuery');
    }

    async embedDocument(): Promise<never> {
        throw new EmbeddingDisabledError('embedDocument');
    }

    async embedDocumentBatch(): Promise<never> {
        throw new EmbeddingDisabledError('embedDocumentBatch');
    }
}

/** True when `provider` is the "embeddings are off" marker — checked by
 *  value (`modelId === 'none'`), not `instanceof`, so any equivalent stand-in
 *  (a test double, a future host-supplied null-object) is recognised too. */
export function isEmbeddingDisabled(provider: { modelId: string } | null | undefined): boolean {
    return provider?.modelId === 'none';
}

/**
 * True for an {@link EmbeddingDisabledError} instance OR any error carrying
 * the same recognizable shape (`name === 'EmbeddingDisabledError'` or
 * `code === 'embedding_disabled'`) — duck-typed so an error thrown by a
 * DIFFERENT module's disabled-embedder stand-in (a test stub, a future
 * host-supplied provider) is recognized without an `instanceof` coupling
 * across module boundaries. This is the ONE guard callers use to catch
 * "embeddings are off" and degrade (skip the vector write / flag the
 * semantic leg unconsulted) instead of failing the write or the read.
 */
export function isEmbeddingDisabledError(err: unknown): boolean {
    if (err instanceof EmbeddingDisabledError) return true;
    if (!err || typeof err !== 'object') return false;
    const e = err as { name?: unknown; code?: unknown };
    return e.name === 'EmbeddingDisabledError' || e.code === 'embedding_disabled';
}
