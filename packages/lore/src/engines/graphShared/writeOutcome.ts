/**
 * writeOutcome.ts — 3.34.0 (M2): a graph write whose result could not be
 * established. The write command failed in a way that does not say whether it
 * committed (a client-side timeout or socket error, or the read-back after an
 * acknowledged write failed) and a re-read could not settle it either.
 *
 * The bulk route answers such an item `outcome_unknown: ...` with the node's
 * current revision (when known) and does NOT retract the item's outbox row: a
 * compensating row built from a state that may be stale could replay pre-write
 * content over a write that did commit. The row stays pending and replays.
 */
import type { LoreNode } from '../../providers/types.js';

export class OutcomeUnknownError extends Error {
    readonly code = 'outcome_unknown';
    /** The revision found by the last successful re-read: a number, null when the node was absent, undefined when no read succeeded. */
    constructor(readonly id: string, readonly currentRevision: number | null | undefined, cause: unknown) {
        super(`outcome_unknown: the write of ${id} may or may not have been applied (${cause instanceof Error ? cause.message : String(cause)})`);
        this.name = 'OutcomeUnknownError';
    }
}

export const isOutcomeUnknown = (e: unknown): e is OutcomeUnknownError =>
    e instanceof OutcomeUnknownError || (e as { name?: unknown } | null)?.name === 'OutcomeUnknownError';

/** Re-read a node after a failed write command. A failed re-read leaves the outcome unknown. */
export async function rereadAfterWriteError(read: () => Promise<LoreNode | null>, id: string, cause: unknown): Promise<LoreNode | null> {
    try { return await read(); }
    catch { throw new OutcomeUnknownError(id, undefined, cause); }
}

/** Read the node back after an ACKNOWLEDGED write (one retry). The write committed, so a failed read is not a failed write: it is an unknown outcome. */
export async function readBackAfterWrite(read: () => Promise<LoreNode | null>, id: string): Promise<LoreNode> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const node = await read();
            if (node) return node;
            throw new Error(`failed to persist ${id}`);
        } catch (err) { last = err; }
    }
    throw new OutcomeUnknownError(id, undefined, `the write was acknowledged but could not be read back: ${(last as Error).message}`);
}
