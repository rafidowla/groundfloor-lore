/**
 * bulkWriteLocks.ts - 3.35.0 (b): the chunk-lock wrapper the bulk node write uses.
 *
 * `withNodeLocks` now fails with NodeLockTimeoutError when a chunk's locks are not all free within the
 * bounded wait (a holder stuck on a hung ArcadeDB). Nothing of the chunk has run by then, so the
 * wrapper turns that into a `node_busy: ...` failure on each of the chunk's items (nothing recorded,
 * nothing written, safe to retry) and lets the batch carry on with its other chunks, instead of
 * failing the whole request with a 500 after earlier chunks already landed.
 */
import { withNodeLocks, NodeLockTimeoutError } from '../../../core/nodeWriteLock.js';
import { bulkLockIds, type ConditionalSpec } from './bulkWriteConditional.js';

export async function withBulkChunkLocks<S extends ConditionalSpec>(
    workspace: string,
    specs: readonly S[],
    results: Array<unknown>,
    fn: () => Promise<void>,
): Promise<void> {
    try {
        await withNodeLocks(workspace, bulkLockIds(specs), fn);
    } catch (err) {
        if (!(err instanceof NodeLockTimeoutError)) throw err;
        for (const s of specs) results[s.idx] = { ok: false, id: s.raw.id as string, error: `node_busy: ${err.message}; nothing was written` };
    }
}
