/**
 * outbox/recovery.ts — boot-time replay of unfinished outbox entries.
 *
 * Called once at daemon startup: walks every unfinished entry and
 * dispatches each pending step to a registered handler. The handler
 * does the actual substrate write (re-running graph.upsert etc.) and
 * is responsible for being idempotent — recovery may replay a step
 * that already succeeded if the daemon crashed before the 'done'
 * mark landed.
 *
 * The handler registry is populated at boot by each module that
 * wraps writes with `withOutbox`. Step kinds the recovery sees with
 * no registered handler are flagged in the report — that's a
 * programming error (something wrote an outbox entry without
 * registering a recovery handler for its step kind).
 *
 * Recovery never DELETES entries. It either:
 *   - Completes them (every step now 'done' → mark completed and
 *     remove if removeOnComplete was the wrapper's policy; but
 *     recovery doesn't know that policy, so leaves the completion
 *     decision to the wrapper's normal happy path on next attempt).
 *   - Leaves them at 'failed' so an operator can decide.
 *
 * SP-F2 (2026-06-10) — replicator-owned rows are NOT recovery's to
 * complete. Hot-lane producers (outbox/hotLane.ts) write a single
 * placeholder step that is ALREADY 'done' at record() time; the real
 * delivery state lives in the entry-level `status` machine driven by
 * the replicator. Before this fix, recovery saw allDone=true for every
 * such row and marked it completed (status='replicated') WITHOUT any
 * substrate dispatch — silently abandoning every write still
 * undelivered at crash time and erasing the 'dead' letter queue on
 * each boot. Recovery now only completes entries for which it actually
 * dispatched at least one step this pass; rows with zero outstanding
 * steps are left to the replicator (with crashed-mid-dispatch
 * 'replicating' rows re-queued to 'pending' for idempotent replay).
 */

import type { OutboxEntry, OutboxStore } from './types.js';

export type OutboxStepHandler = (
    payload: Record<string, unknown> | undefined,
    entry: OutboxEntry,
) => Promise<void>;

export interface OutboxStepHandlerRegistry {
    get(kind: string): OutboxStepHandler | undefined;
}

export class InMemoryOutboxHandlerRegistry implements OutboxStepHandlerRegistry {
    private readonly handlers = new Map<string, OutboxStepHandler>();

    register(kind: string, handler: OutboxStepHandler): void {
        if (this.handlers.has(kind)) {
            throw new Error(`outbox step handler for '${kind}' is already registered`);
        }
        this.handlers.set(kind, handler);
    }

    get(kind: string): OutboxStepHandler | undefined {
        return this.handlers.get(kind);
    }

    /** Test helper. */
    clear(): void { this.handlers.clear(); }
}

export interface RecoveryReport {
    /** Total unfinished entries discovered at boot. */
    discovered: number;
    /** Entries the recovery successfully drove to completion. */
    completed: number;
    /** Entries still unfinished after the pass (handler failure
     *  or missing handler). Each line is `<id>: <reason>`. */
    stillUnfinished: string[];
    /** Per-step failures the recovery saw, for log triage. */
    stepFailures: Array<{ entryId: string; kind: string; error: string }>;
    /** SP-F2 — entries with zero outstanding steps (replicator-owned
     *  hot-lane rows, or legacy rows that finished every step before
     *  the crash). Recovery dispatched nothing for them and left their
     *  entry-level status untouched; the replicator owns delivery. */
    skippedReplicatorRows: number;
    /** SP-F2 — rows found stuck at status='replicating' (daemon died
     *  mid-dispatch) that recovery re-queued to 'pending' so the
     *  replicator retries them. Replay is idempotent by contract
     *  (dispatcher.ts header). */
    requeuedReplicating: number;
}

/**
 * Walk the outbox once. Best-effort: a single handler failure does
 * NOT abort the pass — recovery moves on to the next entry. The
 * report summarises what happened.
 */
export async function recoverOutbox(
    store: OutboxStore,
    registry: OutboxStepHandlerRegistry,
): Promise<RecoveryReport> {
    const report: RecoveryReport = {
        discovered: 0, completed: 0, stillUnfinished: [], stepFailures: [],
        skippedReplicatorRows: 0, requeuedReplicating: 0,
    };
    const unfinished = await store.listUnfinished();
    report.discovered = unfinished.length;

    for (const entry of unfinished) {
        // SP-F2 (2026-06-10): zero outstanding steps means there is
        // nothing for step-based recovery to dispatch — this is a
        // replicator-owned row (hot-lane placeholder step is pre-'done')
        // or a legacy row that finished its checklist pre-crash. Do NOT
        // mark it completed: doing so flipped undelivered rows to
        // 'replicated' with zero substrate writes (data loss) and wiped
        // 'dead' rows (completed=0) from the dead-letter queue at every
        // boot. Leave 'pending'/'failed'/'dead' to the replicator +
        // operator; re-queue crashed-mid-dispatch 'replicating' rows.
        if (entry.steps.every((s) => s.status === 'done')) {
            if (entry.status === 'replicating' && typeof store.markEntryStatus === 'function') {
                await store.markEntryStatus(entry.id, 'pending');
                report.requeuedReplicating++;
            }
            report.skippedReplicatorRows++;
            continue;
        }
        let allDone = true;
        for (let i = 0; i < entry.steps.length; i++) {
            const step = entry.steps[i];
            if (step.status === 'done') continue;
            const handler = registry.get(step.kind);
            if (!handler) {
                allDone = false;
                report.stepFailures.push({
                    entryId: entry.id, kind: step.kind,
                    error: `no handler registered for step kind '${step.kind}'`,
                });
                continue;
            }
            try {
                await handler(step.payload, entry);
                await store.markStep(entry.id, i, 'done');
            } catch (err) {
                allDone = false;
                const msg = (err as Error).message;
                await store.markStep(entry.id, i, 'failed', msg);
                report.stepFailures.push({ entryId: entry.id, kind: step.kind, error: msg });
            }
        }
        if (allDone) {
            await store.markCompleted(entry.id);
            report.completed++;
        } else {
            report.stillUnfinished.push(
                `${entry.id} (${entry.operation}): ${entry.steps.filter(s => s.status !== 'done').length} step(s) outstanding`,
            );
        }
    }

    return report;
}
