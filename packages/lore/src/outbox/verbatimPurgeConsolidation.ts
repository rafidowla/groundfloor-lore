/**
 * verbatimPurgeConsolidation.ts — 3.27.1.
 *
 * Collapse a run of adjacent `verbatim.purge` outbox rows into ONE
 * `purgeVerbatim(union of ids)` dispatch. nodeDeleteMany writes one purge row
 * PER NODE (supersession keys on `payload.id`; see core/nodeDeleteManyService.ts
 * header), so a reindex that deletes 16k nodes queued 16k rows, and replaying
 * them one by one cost one store call each (3.27.0: one empty LanceDB version
 * each on the verbatim AND piece tables, fixed separately in
 * engines/verbatimPurgeRows.ts). Here a run of up to `cap` rows costs one call:
 * ceil(ids / PURGE_QUERY_IDS) queries and no commit when nothing is left.
 *
 * Mirrors the SP-13 verbatim.upsert run (verbatimConsolidation.ts): same
 * workspace only, a row cap, superseded-failed rows marked dead first (RA-6),
 * fewer than two survivors fall back to the per-row path, and each row's
 * status is advanced individually so the replicator's seq watermark moves as
 * for the upsert run. Two deliberate differences:
 *   - rows are CLAIMED (replicatorClaim.ts) like replicateOne does, so a row
 *     another replayer holds, or one retracted after the snapshot, is not
 *     purged from the in-memory copy;
 *   - on a failed union dispatch every claimed row is retried ON ITS OWN, so
 *     one bad row only fails itself (purge is idempotent, so a partially
 *     applied union is safe to replay row by row).
 * Rows stay individual in the outbox, so the dispatcher verify case
 * 'verbatim.purge' (every id absent) is unchanged.
 */

import { dispatch, purgeIdsOf, UnwiredOperationKindError, MissingPayloadError } from './dispatcher.js';
import type { OutboxEntry } from './types.js';
import { SUPERSEDED_DEAD_ERROR } from './supersession.js';
import { claimEntry } from './replicatorClaim.js';
import { collectVerbatimUpsertRun, consolidateVerbatimRun } from './verbatimConsolidation.js';
import type { VerbatimConsolidationDeps, VerbatimConsolidationGuard } from './verbatimConsolidation.js';

/**
 * Collect adjacent `verbatim.purge` rows starting at `start`, up to `cap`
 * rows. Stops at another kind, another workspace, a malformed payload (no
 * ids — left to the per-row path, which marks it dead via
 * MissingPayloadError), or the cap. Always returns >= 1 entry.
 */
export function collectVerbatimPurgeRun(batch: readonly OutboxEntry[], start: number, cap: number): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    const ws = batch[start]?.workspace;
    for (let j = start; j < batch.length; j++) {
        const e = batch[j];
        if (e.operationKind !== 'verbatim.purge' || e.workspace !== ws) break;
        if (purgeIdsOf((e.payload ?? {}) as Record<string, unknown>).length === 0) {
            if (out.length === 0) out.push(e);
            break;
        }
        if (out.length >= cap) break;
        out.push(e);
    }
    return out;
}

/** Record one row's failure exactly as replicateOne does (minus the
 *  node.upsert-only half-completion reaper). */
async function settleFailure(deps: VerbatimConsolidationDeps, e: OutboxEntry, err: unknown): Promise<void> {
    const msg = (err as Error).message;
    const attempts = (e.attempts ?? 0) + 1;
    if (err instanceof UnwiredOperationKindError || err instanceof MissingPayloadError || attempts >= deps.maxAttempts) {
        await deps.store.markEntryStatus!(e.id, 'dead', { error: msg, bumpAttempt: true });
        deps.onDead();
        deps.log(`[outbox replicator] entry ${e.id} (verbatim.purge consolidated) marked dead: ${msg}`);
    } else {
        await deps.store.markEntryStatus!(e.id, 'failed', { error: msg, bumpAttempt: true });
        deps.onFailure();
    }
}

const maxSeq = (rows: OutboxEntry[], from: number | null): number | null =>
    rows.reduce<number | null>((m, e) => (typeof e.sequenceId === 'number' && (m === null || e.sequenceId > m) ? e.sequenceId : m), from);

/**
 * Replay a collected run. Returns the highest sequenceId replicated (or null).
 */
export async function consolidateVerbatimPurgeRun(
    deps: VerbatimConsolidationDeps & VerbatimConsolidationGuard,
    run: OutboxEntry[],
): Promise<number | null> {
    const survivors: OutboxEntry[] = [];
    for (const e of run) {
        if (e.status === 'failed' && await deps.isSupersededFailed(e)) {
            await deps.store.markEntryStatus!(e.id, 'dead', { error: SUPERSEDED_DEAD_ERROR });
            deps.onDead();
            deps.log(`[outbox replicator] entry ${e.id} (verbatim.purge consolidated) skipped: superseded by newer same-key write`);
            continue;
        }
        survivors.push(e);
    }
    if (survivors.length < 2) {
        let seq: number | null = null;
        for (const e of survivors) if (await deps.dispatchOne(e)) seq = maxSeq([e], seq);
        return seq;
    }
    const claimed: OutboxEntry[] = [];
    for (const e of survivors) if (await claimEntry(deps.store, e.id)) claimed.push(e);
    if (claimed.length === 0) return null;
    const ids = [...new Set(claimed.flatMap((e) => purgeIdsOf((e.payload ?? {}) as Record<string, unknown>)))];
    const synth: OutboxEntry = { ...claimed[0], payload: { ids } };
    try {
        await dispatch(synth, deps.substrates);
        for (const e of claimed) {
            await deps.store.markEntryStatus!(e.id, 'replicated');
            deps.onReplicated();
        }
        return maxSeq(claimed, null);
    } catch (err) {
        deps.log(`[outbox replicator] consolidated verbatim.purge of ${claimed.length} row(s) failed, retrying per row: ${(err as Error).message}`);
    }
    let seq: number | null = null;
    for (const e of claimed) {
        try {
            await dispatch(e, deps.substrates);
            await deps.store.markEntryStatus!(e.id, 'replicated');
            deps.onReplicated();
            seq = maxSeq([e], seq);
        } catch (err) {
            await settleFailure(deps, e, err);
        }
    }
    return seq;
}

/**
 * Replicator entry point for both verbatim consolidations at `fresh[i]`:
 * SP-13 adjacent verbatim.upsert rows (when the batch hook is wired) and
 * 3.27.1 adjacent verbatim.purge rows (when purgeVerbatim is wired). Returns
 * null — the caller takes the per-row path — for any other kind, a disabled
 * cap (0), an unwired hook, or a run of one row (no win). Otherwise returns
 * how many rows were consumed and the highest replicated sequenceId.
 */
export async function consolidateVerbatimAt(
    deps: VerbatimConsolidationDeps & VerbatimConsolidationGuard,
    fresh: readonly OutboxEntry[],
    i: number,
    cap: number,
): Promise<{ consumed: number; advancedSeq: number | null } | null> {
    const kind = fresh[i]?.operationKind;
    if (cap <= 0) return null;
    if (kind === 'verbatim.upsert' && typeof deps.substrates.upsertVerbatimBatch === 'function') {
        const group = collectVerbatimUpsertRun(fresh, i, cap);
        if (group.entries.length < 2) return null; // RA-6 per-key guard for a lone row lives in replicateOne (F-S04)
        return { consumed: group.entries.length, advancedSeq: await consolidateVerbatimRun(deps, group) };
    }
    if (kind === 'verbatim.purge' && typeof deps.substrates.purgeVerbatim === 'function') {
        const run = collectVerbatimPurgeRun(fresh, i, cap);
        if (run.length < 2) return null;
        return { consumed: run.length, advancedSeq: await consolidateVerbatimPurgeRun(deps, run) };
    }
    return null;
}
