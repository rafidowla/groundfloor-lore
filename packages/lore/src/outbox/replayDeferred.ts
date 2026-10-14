/**
 * replayDeferred.ts — 3.34.0: a substrate handler that could not START a replay
 * (today: the arcade node handlers waiting on the per-node lock held by a live
 * request) throws {@link ReplayDeferredError}. The replicator then puts the row
 * back to 'pending', without counting an attempt, instead of marking it 'failed':
 * the replay never ran, so it must not burn the row's retry budget or wait out an
 * exponential backoff.
 *
 * To keep per-entity order, later rows of the same tick that touch the same
 * entity (same workspace, family and key) are skipped until the next tick; see
 * {@link DeferredEntities}.
 */
import type { OutboxEntry, OutboxStore } from './types.js';
import { keyOfEntry } from './supersession.js';

export class ReplayDeferredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReplayDeferredError';
    }
}

/** Entities with a deferred row in the current tick. */
export class DeferredEntities {
    private readonly keys = new Set<string>();

    private keyOf(entry: OutboxEntry): string | null {
        const k = keyOfEntry(entry);
        return k ? `${entry.workspace ?? ''}\u0000${k.family}\u0000${k.key}` : null;
    }

    add(entry: OutboxEntry): void { const k = this.keyOf(entry); if (k) this.keys.add(k); }
    has(entry: OutboxEntry): boolean { const k = this.keyOf(entry); return k !== null && this.keys.has(k); }
    /** Called at every tick start (arcade wiring resets its per-tick lock-wait budget here). */
    onTickStart: (() => void) | undefined;
    clear(): void { this.keys.clear(); this.onTickStart?.(); }
}

/** Put a claimed row back to 'pending' (no attempt counted) and remember its entity. Always false: not replicated. */
export async function releaseDeferred(
    store: OutboxStore,
    entry: OutboxEntry,
    err: ReplayDeferredError,
    deferred: DeferredEntities,
    log: (msg: string) => void,
): Promise<false> {
    deferred.add(entry);
    await store.markEntryStatus!(entry.id, 'pending');
    log(`[outbox replicator] entry ${entry.id} (${entry.operationKind}) deferred, back to pending: ${err.message}`);
    return false;
}
