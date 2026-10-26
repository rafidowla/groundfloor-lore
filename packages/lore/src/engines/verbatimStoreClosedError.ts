/**
 * verbatimStoreClosedError.ts - a mutating call reached a verbatim store that has been closed.
 *
 * Before this, `SqliteVerbatimStore.close()` set `initialized = false` and every write method opened with
 * `if (!this.initialized) return;`, so a write on a closed store RESOLVED without writing anything. A caller
 * (the outbox replicator above all) read that as success: the row was marked replicated and the data was
 * gone. Now every mutator throws this instead.
 *
 * Deliberately NOT a {@link VerbatimStoreRetiredError} (verbatimWriteBarrier.ts):
 *   - Retired means "the promotion committed while this write was parked; the promoted store is about to be
 *     swapped in", so verbatimRetiredRetry.ts waits for and replays onto the successor.
 *   - Closed means "this instance is shut down" - after a daemon drain, an idle eviction or the swap's own
 *     close of the retired instance. Replaying through the workspace resolver would call `getOrOpen`, which
 *     re-opens a store that shutdown just closed (a handle leak after `closeAll`; the resolver is now sealed at
 *     shutdown, which refuses that, but a replay for an evicted store still must not chase it). So the retired-retry path
 *     does not touch it; the caller sees the error, and the outbox treats it as transient (replay later,
 *     attempt not counted) because nothing was applied.
 */

/** Thrown by every mutating method of a closed store. Nothing was applied. */
export class VerbatimStoreClosedError extends Error {
    /** Always false: the write was rejected BEFORE it ran. */
    readonly applied = false as const;
    constructor(basePath: string, method?: string) {
        super(`[verbatim store] ${method ? `${method}() called` : 'write'} on a closed store (${basePath}); the write was NOT applied - re-resolve the workspace's current store and retry`);
        this.name = 'VerbatimStoreClosedError';
    }
}

/** True for a {@link VerbatimStoreClosedError} (also across module copies, by name). Transient: nothing was applied. */
export function isVerbatimStoreClosedError(err: unknown): boolean {
    return err instanceof VerbatimStoreClosedError || (err as { name?: unknown } | null | undefined)?.name === 'VerbatimStoreClosedError';
}

/**
 * A mutating call reached a verbatim store that was never initialized and could not be initialized on demand.
 * Before this, the same call RESOLVED without writing (`if (!this.initialized) return;`), which the outbox read as
 * "replicated". Nothing was applied, so it is safe to retry once the store is open.
 */
export class VerbatimStoreNotInitializedError extends Error {
    /** Always false: the write was rejected BEFORE it ran. */
    readonly applied = false as const;
    constructor(basePath: string, method?: string) {
        super(`[verbatim store] ${method ? `${method}() called` : 'write'} on a store that is not initialized (${basePath}); the write was NOT applied - initialize() the store first`);
        this.name = 'VerbatimStoreNotInitializedError';
    }
}

/** True for a {@link VerbatimStoreNotInitializedError} (also across module copies, by name). Transient: nothing was applied. */
export function isVerbatimStoreNotInitializedError(err: unknown): boolean {
    return err instanceof VerbatimStoreNotInitializedError || (err as { name?: unknown } | null | undefined)?.name === 'VerbatimStoreNotInitializedError';
}

/**
 * The workspace verbatim resolver was SEALED at shutdown (`WorkspaceVerbatimResolver.closeAll()`): it opens, reopens
 * and promotes nothing any more. Thrown by `getOrOpen` once sealed, so that a
 * forwarded retired write (verbatimRetiredRetry.ts) or an outbox replay fails fast and cleanly instead of reopening a
 * store shutdown just closed. A resolver is single-lifecycle: a new `createLore()` / daemon boot builds a fresh one.
 * Nothing was applied, so it is transient for the outbox (replay on the next lifecycle).
 */
export class VerbatimResolverSealedError extends Error {
    /** Always false: the call was refused BEFORE anything ran. */
    readonly applied = false as const;
    constructor(workspace?: string) {
        super(`[verbatim resolver] sealed at shutdown${workspace ? ` - refusing to open workspace "${workspace}"` : ''}; nothing was opened or applied - use the next lifecycle's resolver`);
        this.name = 'VerbatimResolverSealedError';
    }
}

/** True for a {@link VerbatimResolverSealedError} (also across module copies, by name). */
export function isVerbatimResolverSealedError(err: unknown): boolean {
    return err instanceof VerbatimResolverSealedError || (err as { name?: unknown } | null | undefined)?.name === 'VerbatimResolverSealedError';
}
