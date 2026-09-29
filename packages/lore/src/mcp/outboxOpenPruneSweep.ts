/**
 * outboxOpenPruneSweep.ts — storage-growth fix 2/3 (R4): outbox hygiene.
 *
 * Prune `replicated` outbox rows older than the retention threshold once a
 * workspace opens, not only from the replicator's own running loop. Closes
 * the exact gap that grew nirman-harness's outbox.sqlite to 3.8GB/27% of
 * Atlas's total: the loop's cadence-gated prune
 * (`OutboxReplicator.maybePruneReplicated`) only fires while
 * `replicator.start()`'s tick loop is actually running (daemon `main()`, or
 * embedded auto-sync via `startEmbeddedReplication`) — a workspace that's
 * opened, written to, and closed again (or reopened after a long gap, with
 * the loop never started) never gets pruned at all between opens.
 *
 * Unlike R3's version-prune sweeper (`versionPruneScheduler.ts`), this one
 * is NOT gated on `startsDaemonTimers` — it runs for every `createLore()`
 * host, daemon and embedded alike. Reasoning: "not only from the replicator
 * loop" (Sprint 2 spec) means IN ADDITION to whatever the loop does, and
 * running it once at open is cheap, bounded (same
 * `PRUNE_SWEEP_BATCH_LIMIT` the loop itself uses), and idempotent
 * (`force:true` only bypasses the cadence gate — it still only ever deletes
 * `status='replicated'` rows, never `pending`/`dead`) — so double-running it
 * against a daemon that also has its loop running wastes at most one cheap
 * indexed DELETE, not a correctness risk.
 *
 * Deferred via a zero-delay, unref'd `setTimeout` — never inline/awaited —
 * so it can never block `createLore()`'s return or a host's first write on
 * a potentially large DELETE. `unref()`'d so it can never itself keep a
 * process alive; cancellable via `stop()` (wired into `buildOrderedDrain` in
 * server.ts) so a fast open-then-dispose() sequence can't let it fire a
 * write against an already-closed outbox store — see shutdownDrain.ts's
 * `outboxOpenPruneSweep` step (placed right after the replicator's own
 * `stop()`, well before `versionPruneSweeper`'s step, since a short-lived
 * instance closes the outbox store far earlier than that later step runs).
 *
 * Reclaim: `incrementalVacuum()` (bounded, `wal_checkpoint(PASSIVE)`), never
 * a full VACUUM — same online/offline split as R3. It is a no-op on any
 * outbox.sqlite that predates this change (not yet
 * `auto_vacuum=INCREMENTAL`); Sprint 3's offline tool converts those.
 *
 * ## Full-drain loop (storage-growth fix 2/3 follow-up, 2026-09-28)
 *
 * `runPruneSweep({force:true})` is already bounded per call — one indexed
 * `DELETE ... WHERE id IN (SELECT ... LIMIT ?)` subquery
 * (`outbox/sqliteStore.ts`'s `pruneReplicated`), `PRUNE_SWEEP_BATCH_LIMIT`
 * (5,000) rows — not the same full-table-scan problem R3's version pruning
 * had, so no per-call rewrite was needed here (checked: `replicator.ts`
 * lines ~296-335, `sqliteStore.ts` lines ~570-644). But the ORIGINAL code
 * above called it exactly ONCE per open. A backlog bigger than one batch —
 * the motivating nirman-harness case cited in common-rules.md has 144,617
 * never-pruned `replicated` rows — would need ~29 separate opens to fully
 * drain, one batch per open, which defeats "prune on open" for exactly the
 * store that needed it most. The loop below keeps each individual call
 * exactly as bounded and cheap as before, but repeats it (yielding to the
 * event loop between calls via `setImmediate`, same yield shape as R3's
 * batched pruner) until a call returns fewer than the batch limit — i.e.
 * the backlog is actually drained, not just nibbled — then runs
 * `incrementalVacuum()` once at the end rather than after every batch
 * (`incremental_vacuum` is itself a bounded PRAGMA call, but there is no
 * reason to pay for N of them when N-1 would reclaim pages `pruneReplicated`
 * had not freed yet). `stop()` still interrupts between calls, same as
 * before.
 */

import type { OutboxStore } from '../outbox/types.js';
import type { OutboxReplicator } from '../outbox/replicator.js';
import { PRUNE_SWEEP_BATCH_LIMIT } from '../outbox/replicator.js';

export interface OutboxOpenPruneSweepHandle {
    stop(): Promise<void>;
}

export function scheduleOutboxOpenPruneSweep(
    replicator: Pick<OutboxReplicator, 'runPruneSweep'>,
    store: Pick<OutboxStore, 'incrementalVacuum'>,
): OutboxOpenPruneSweepHandle {
    let inflight: Promise<void> | null = null;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
        timer = undefined;
        const p = (async () => {
            try {
                let totalPruned = 0;
                for (;;) {
                    if (aborted) break;
                    const n = await replicator.runPruneSweep({ force: true });
                    totalPruned += n;
                    if (n < PRUNE_SWEEP_BATCH_LIMIT) break; // drained
                    await new Promise((resolve) => setImmediate(resolve));
                }
                if (totalPruned > 0 && !aborted) store.incrementalVacuum?.();
            } catch (err) {
                console.error(`[outbox-open-prune] pass failed: ${(err as Error).message}`);
            }
        })();
        inflight = p;
        p.finally(() => { if (inflight === p) inflight = null; });
    }, 0);
    if (typeof timer.unref === 'function') timer.unref();
    return {
        async stop(): Promise<void> {
            if (timer) { clearTimeout(timer); timer = undefined; }
            aborted = true;
            if (inflight) await inflight.catch(() => { /* already logged above */ });
        },
    };
}
