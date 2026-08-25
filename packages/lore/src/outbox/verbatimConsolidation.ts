/**
 * verbatimConsolidation.ts — SP-13.
 *
 * Extracted from replicator.ts (file-size cap) so the replicator stays
 * under budget. Mirrors the embed.batch consolidation: collect a run of
 * adjacent `verbatim.upsert` outbox rows and dispatch them as ONE
 * `verbatim.upsert.batch` so the verbatim store writes a single LanceDB
 * fragment for the whole run instead of one per row (the per-row write
 * amplification — 5,334 fragments / ~5k rows observed in the field).
 */

import { dispatch, UnwiredOperationKindError, MissingPayloadError } from './dispatcher.js';
import type { DispatcherSubstrates } from './dispatcher.js';
import type { OutboxEntry, OutboxStore } from './types.js';

/**
 * Collect a run of adjacent `verbatim.upsert` entries starting at `start`,
 * up to `cap` rows. Stops at the first non-verbatim.upsert row, a malformed
 * payload (no string id), or the cap. Returns the consumed entries
 * (always ≥1) plus the merged `items` array the caller dispatches once.
 */
export function collectVerbatimUpsertRun(
    batch: readonly OutboxEntry[],
    start: number,
    cap: number,
): { entries: OutboxEntry[]; items: Array<Record<string, unknown>> } {
    const items: Array<Record<string, unknown>> = [];
    const consumed: OutboxEntry[] = [];
    for (let j = start; j < batch.length; j++) {
        const e = batch[j];
        if (e.operationKind !== 'verbatim.upsert') break;
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        const id = payload['id'];
        if (typeof id !== 'string' || !id) {
            // Malformed — let the per-row path mark it dead via
            // MissingPayloadError rather than poison the batch.
            if (consumed.length === 0) consumed.push(e);
            break;
        }
        if (consumed.length >= cap) break;
        consumed.push(e);
        items.push(payload);
    }
    return { entries: consumed, items };
}

/** Handles the replicator threads in so the consolidation logic stays a
 *  pure function rather than a method on the replicator class. */
export interface VerbatimConsolidationDeps {
    store: OutboxStore;
    substrates: DispatcherSubstrates;
    maxAttempts: number;
    onReplicated: () => void;
    onFailure: () => void;
    onDead: () => void;
    log: (msg: string) => void;
}

/**
 * Dispatch a merged verbatim.upsert.batch covering N rows. On success every
 * row is marked 'replicated' in one pass; on failure each row records the
 * failure individually (bumpAttempt) so per-row retry budget + dead-letter
 * behaviour is preserved. Mirrors replicateConsolidatedEmbedBatch.
 */
export async function replicateConsolidatedVerbatim(
    deps: VerbatimConsolidationDeps,
    entries: OutboxEntry[],
    items: Array<Record<string, unknown>>,
): Promise<boolean> {
    for (const e of entries) {
        await deps.store.markEntryStatus!(e.id, 'replicating');
    }
    const first = entries[0];
    const synth: OutboxEntry = {
        ...first,
        operationKind: 'verbatim.upsert.batch',
        payload: { items },
    };
    try {
        await dispatch(synth, deps.substrates);
        for (const e of entries) {
            await deps.store.markEntryStatus!(e.id, 'replicated');
            deps.onReplicated();
        }
        return true;
    } catch (err) {
        const msg = (err as Error).message;
        const isUnwired = err instanceof UnwiredOperationKindError;
        const isInvalid = err instanceof MissingPayloadError;
        for (const e of entries) {
            const attempts = (e.attempts ?? 0) + 1;
            if (isUnwired || isInvalid || attempts >= deps.maxAttempts) {
                await deps.store.markEntryStatus!(e.id, 'dead', { error: msg, bumpAttempt: true });
                deps.onDead();
                deps.log(`[outbox replicator] entry ${e.id} (verbatim.upsert consolidated) marked dead: ${msg}`);
            } else {
                await deps.store.markEntryStatus!(e.id, 'failed', { error: msg, bumpAttempt: true });
                deps.onFailure();
            }
        }
        return false;
    }
}

/** Extra callbacks the replicator threads in for the RA-6 guard (2026-08-17). */
export interface VerbatimConsolidationGuard {
    /** True when a strictly-newer replicated op already committed this key. */
    isSupersededFailed: (e: OutboxEntry) => Promise<boolean>;
    /** Per-row dispatch (replicateOne) for the 0/1-survivor fallback. */
    dispatchOne: (e: OutboxEntry) => Promise<boolean>;
}

/**
 * RA-6 guard for the consolidated dispatch (2026-08-17 launch blocker). The
 * SP-13 `verbatim.upsert.batch` fast path never reached `replicateOne`'s
 * supersession check, so a stale `failed` verbatim.upsert could replay OVER
 * newer committed verbatim content. Partition the run: mark superseded-failed
 * rows dead, then consolidate the survivors — or fall back to per-row when
 * fewer than two survive. Returns the highest replicated sequenceId (or null).
 */
export async function consolidateVerbatimRun(
    deps: VerbatimConsolidationDeps & VerbatimConsolidationGuard,
    group: { entries: OutboxEntry[]; items: Array<Record<string, unknown>> },
): Promise<number | null> {
    const entries: OutboxEntry[] = [];
    const items: Array<Record<string, unknown>> = [];
    for (let k = 0; k < group.entries.length; k++) {
        const e = group.entries[k];
        if (e.status === 'failed' && await deps.isSupersededFailed(e)) {
            await deps.store.markEntryStatus!(e.id, 'dead', { error: 'superseded by newer same-key write (RA-6)' });
            deps.onDead();
            deps.log(`[outbox replicator] entry ${e.id} (verbatim.upsert consolidated) skipped: superseded by newer same-key write`);
            continue;
        }
        entries.push(e);
        items.push(group.items[k]);
    }
    let advancedSeq: number | null = null;
    if (entries.length >= 2) {
        const ok = await replicateConsolidatedVerbatim(deps, entries, items);
        if (ok) {
            advancedSeq = entries.reduce(
                (m, e) => typeof e.sequenceId === 'number' && e.sequenceId > m ? e.sequenceId : m,
                -1,
            );
        }
    } else {
        for (const e of entries) {
            const ok = await deps.dispatchOne(e);
            if (ok && typeof e.sequenceId === 'number') {
                advancedSeq = advancedSeq === null ? e.sequenceId : Math.max(advancedSeq, e.sequenceId);
            }
        }
    }
    return advancedSeq;
}

