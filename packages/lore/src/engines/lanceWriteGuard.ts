/**
 * lanceWriteGuard.ts - the state check every mutating LanceDB VerbatimStore call makes first.
 *
 * Before this, physicalDelete / physicalDeleteMany / purgeWithHistory / tombstone opened with
 * `if (!this.initialized || !this.db) return;`, so a call on a store that was never initialized, or had been
 * closed, RESOLVED without writing and the caller (the outbox replicator above all) read that as success.
 * store() / storeBatch() already threw, but an untyped `Error('Store not initialized')` that no classifier
 * could tell apart from a real failure. Now each throws a typed error with `applied === false`:
 *   - closed:          the caller's own close() ran (or is running) - VerbatimStoreClosedError
 *   - never opened:    initialize() has not completed        - VerbatimStoreNotInitializedError
 * Both are transient for the outbox (nothing applied, replay later, attempt not counted).
 */
import { VerbatimStoreNotInitializedError } from './verbatimStoreClosedError.js';

export interface LanceWriteState {
    initialized: boolean;
    db: unknown;
    /** True from the start of close() until the next initialize() reconnects. */
    closed: boolean;
}

/** Throws unless the store is open for writing. `makeClosed` builds the store's own closed error. */
export function assertLanceWritable(state: LanceWriteState, basePath: string, method: string, makeClosed: () => Error): void {
    if (state.closed) throw makeClosed();
    if (!state.initialized || !state.db) throw new VerbatimStoreNotInitializedError(basePath, method);
}
