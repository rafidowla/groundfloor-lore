/**
 * outbox/coordinator.ts — `withOutbox` execution wrapper.
 *
 * Adopting callers wrap a multi-substrate write like:
 *
 *   await withOutbox(store, {
 *       id: uuid(),
 *       operation: 'store_node',
 *       initiator: 'human:rafi',
 *       steps: [
 *           { kind: 'graph.upsert',  payload: { nodeId } },
 *           { kind: 'vector.upsert', payload: { nodeId } },
 *       ],
 *   }, async ({ markStep }) => {
 *       await graph.upsertNode(...);
 *       await markStep(0, 'done');
 *       await vector.store(...);
 *       await markStep(1, 'done');
 *   });
 *
 * The coordinator records the entry BEFORE the callback runs, so a
 * crash inside the callback leaves a durable trace OutboxRecovery
 * can finish on next boot. On full success, the entry is marked
 * completed; the operator chooses (via `removeOnComplete`) whether
 * to delete the row immediately or keep it as a tombstone for audit.
 *
 * Convention: handler should call `markStep(i, 'done')` after the
 * i-th step's side effect lands. If the handler throws without
 * marking, the step is left at 'pending' and recovery sees it as
 * unfinished. If the handler explicitly marks 'failed', recovery
 * picks the entry up too (the retry policy is recovery's call).
 */

import { randomUUID } from 'node:crypto';
import type {
    OutboxEntry,
    OutboxStore,
    PlannedStep,
    StepStatus,
} from './types.js';

export interface WithOutboxSpec {
    /** Stable id. Generated when omitted. */
    id?: string;
    operation: string;
    initiator: string;
    steps: PlannedStep[];
    /** When true, fully-completed entries are removed from the outbox
     *  rather than left as tombstones. Defaults to true (lower disk
     *  cost; the schema-changes.jsonl audit log carries the durable
     *  trail). Set false when an operator wants to introspect history. */
    removeOnComplete?: boolean;
}

export interface OutboxHandlerCtx {
    /** The persisted entry, in case the handler wants its id for
     *  cross-referencing logs. */
    entry: OutboxEntry;
    /** Mark the i-th step's status. Persists immediately so a crash
     *  before the next call still records progress. */
    markStep: (stepIndex: number, status: StepStatus, error?: string) => Promise<void>;
}

/**
 * Wrap a multi-substrate write. Records → invokes the handler →
 * marks completed on full success → optionally removes the entry.
 * Re-throws whatever the handler throws so the caller's normal
 * error path runs unchanged.
 */
export async function withOutbox<T>(
    store: OutboxStore,
    spec: WithOutboxSpec,
    handler: (ctx: OutboxHandlerCtx) => Promise<T>,
): Promise<T> {
    const now = new Date().toISOString();
    const entry: OutboxEntry = {
        id: spec.id ?? randomUUID(),
        operation: spec.operation,
        initiator: spec.initiator,
        createdAt: now,
        updatedAt: now,
        steps: spec.steps.map(s => ({
            kind: s.kind,
            status: 'pending' as StepStatus,
            ...(s.payload !== undefined ? { payload: s.payload } : {}),
        })),
        completed: false,
    };
    await store.record(entry);

    try {
        const result = await handler({
            entry,
            markStep: (i, status, error) => store.markStep(entry.id, i, status, error),
        });
        // F-S03/S04/S05 — Verify every step landed before marking
        // completed. The decision MUST be atomic with respect to the
        // row's own state: the old path re-queried listUnfinished() (a
        // table scan) and then called markCompleted() in a separate step,
        // so a concurrent worker (self-heal sweep, recovery, a racing
        // markStep) could change the row between the scan and the mark —
        // the completion decision raced against a snapshot that was
        // already stale. Use the store's transactional decide-and-complete
        // path when available: it reads steps and flips to completed in one
        // better-sqlite3 transaction, so no window exists.
        const completeAtomic = (store as {
            completeIfAllStepsDone?: (id: string) => Promise<boolean>;
        }).completeIfAllStepsDone;
        if (typeof completeAtomic === 'function') {
            const completed = await completeAtomic.call(store, entry.id);
            if (!completed) {
                // A step is still unfinished (handler succeeded but didn't
                // mark every step). Leave it for recovery; log rather than
                // throw so the caller still gets its result.
                console.error(
                    `[outbox] entry ${entry.id} (${spec.operation}) finished without ` +
                    `marking every step done; recovery will pick it up.`,
                );
                return result;
            }
        } else {
            // Legacy stores without the atomic path: best-effort scan.
            const reread = await store.listUnfinished();
            const stillPending = reread.find(e => e.id === entry.id);
            if (stillPending && stillPending.steps.some(s => s.status !== 'done')) {
                console.error(
                    `[outbox] entry ${entry.id} (${spec.operation}) finished without ` +
                    `marking every step done; recovery will pick it up.`,
                );
                return result;
            }
            await store.markCompleted(entry.id);
        }
        if (spec.removeOnComplete !== false) {
            await store.remove(entry.id);
        }
        return result;
    } catch (err) {
        // Don't mark completed — entry sits with whichever steps the
        // handler did mark, ready for recovery to finish.
        throw err;
    }
}
