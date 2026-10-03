/**
 * replicatorClaim.ts — 3.26.0: claim an outbox row before replaying it.
 *
 * The replicator used to mark a row 'replicating' with an unconditional
 * UPDATE and then dispatch it regardless of the outcome. Two things went
 * wrong with that:
 *
 *   - Two overlapping replayers (the background loop and a host-driven
 *     `tickOnce()`, e.g. `awaitEmbeds()`) each took the same snapshot of
 *     pending rows and replayed every row twice.
 *   - A row retracted by `removeIfPending` (a rolled-back save) between the
 *     tick's snapshot and its dispatch was still dispatched from the
 *     snapshot's in-memory copy: a node the writer had already rolled back
 *     was created again.
 *
 * `claimEntry` makes the 'pending'/'failed' → 'replicating' transition the
 * gate: a row that cannot be claimed is not dispatched.
 */

import type { OutboxStore } from './types.js';

/**
 * True when the caller now owns the row and must dispatch it. A store
 * without `claimForReplication` (legacy / test double) keeps the old
 * unconditional transition and always reports a successful claim.
 */
export async function claimEntry(store: OutboxStore, entryId: string): Promise<boolean> {
    if (typeof store.claimForReplication === 'function') {
        return store.claimForReplication(entryId);
    }
    await store.markEntryStatus!(entryId, 'replicating');
    return true;
}

/**
 * Runs async tasks one at a time, in call order. The replicator puts every
 * tick through one of these so the background loop and a host-driven
 * `tickOnce()` never walk the outbox at the same moment. (The claim above
 * already stops a double replay of a single row; the gate also covers the
 * consolidated embed/verbatim runs, which mark their rows in bulk.)
 *
 * A failed task rejects its own caller only; the next task still runs.
 */
export class SerialGate {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const next = this.tail.then(task);
        this.tail = next.catch(() => undefined);
        return next;
    }
}
