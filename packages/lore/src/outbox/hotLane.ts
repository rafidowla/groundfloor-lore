/**
 * outbox/hotLane.ts — O2 helper for routing hot single-write endpoints
 * through the outbox foundation O1 shipped.
 *
 * Sprint O2 (2026-05-24). Every API-reachable single-write endpoint
 * (POST /api/node, POST /api/edge, DELETE /api/edge, DELETE /api/node/:id,
 * supersede, unsupersede, …) commits a row to the outbox BEFORE
 * returning success to the caller. The replicator (O1) reads the row
 * asynchronously and fans out to the substrate (graph, vector, verbatim).
 *
 * Why a thin helper rather than direct withOutbox calls:
 *   - The outbox row carries `operationKind` + `workspace` + `payload`
 *     in the entry-level fields O1 added to OutboxEntry. The legacy
 *     `withOutbox` coordinator is per-step shaped (a checklist) and
 *     doesn't expose the entry-level universal-write fields.
 *   - Hot-lane writes have a single substrate target; the multi-step
 *     checklist shape is overkill for them. We record a single
 *     placeholder step (`done` immediately) so legacy boot-recovery
 *     still sees the entry shape it expects.
 *   - Sprint L workspace_required check happens BEFORE we call this
 *     helper — callers always pass a resolved workspace string. The
 *     store throws if workspace is empty, matching Sprint L's
 *     invariant at the storage layer.
 *
 * Idempotency:
 *   - `node.upsert`: LocalGraph.upsertNode is match-then-set OR create
 *     keyed on stable id (audit Section 3) — safe to replay.
 *   - `edge.upsert`: LocalGraph.addEdge is read-decide-write (L-014) —
 *     it MATCHes for an existing relation on the directed (source,
 *     target, relation) triple and skips the CREATE when one exists, so
 *     the route's direct write and a replay converge to ONE row. Safe
 *     to replay; a replay after the edge was deleted re-creates it.
 *   - `node.delete` / `edge.delete`: delete-by-id is idempotent;
 *     re-running returns 0 rows affected.
 *   - `verbatim.upsert`: LanceDB upsert is keyed on the canonical
 *     `lore:<id>`; replaying overwrites.
 */

import { randomUUID } from 'node:crypto';
import type {
    OutboxEntry,
    OutboxOperationKind,
    OutboxStore,
} from './types.js';

export interface HotWriteSpec {
    /** Required — Sprint L invariant. Caller resolves before calling. */
    workspace: string;
    /** Which substrate write the replicator will dispatch. */
    operationKind: OutboxOperationKind;
    /** Operation-specific payload. Shape must match the dispatcher
     *  branch in outbox/dispatcher.ts for the given operationKind. */
    payload: Record<string, unknown>;
    /** kind:id of the caller. Defaults to 'system:hot-lane'. */
    initiator?: string;
    /** Human label for logs. Defaults to operationKind. */
    operation?: string;
}

/**
 * Record a hot-lane write to the outbox. Returns when the commit
 * lands (file rename atomic). The replicator picks the row up on its
 * next tick and dispatches to the substrate. The caller does not
 * wait for replication — that's the whole point of the outbox-first
 * contract (O-D3, O-D4).
 *
 * Throws if workspace is missing or empty — defense in depth against
 * a caller that forgot to run the Sprint L workspace check.
 */
export async function recordHotWrite(
    store: OutboxStore,
    spec: HotWriteSpec,
): Promise<OutboxEntry> {
    if (!spec.workspace || typeof spec.workspace !== 'string') {
        throw new Error(
            `outbox.recordHotWrite: workspace is required (Sprint L invariant; ` +
            `operationKind='${spec.operationKind}')`,
        );
    }
    const now = new Date().toISOString();
    const entry: OutboxEntry = {
        id: randomUUID(),
        operation: spec.operation ?? spec.operationKind,
        initiator: spec.initiator ?? 'system:hot-lane',
        createdAt: now,
        updatedAt: now,
        // Single placeholder step. The replicator drives the substrate
        // fan-out via the entry-level operationKind + payload; the
        // legacy per-step state machine is left at 'done' so boot
        // recovery doesn't see the entry as unfinished.
        steps: [{ kind: spec.operationKind, status: 'done', payload: spec.payload }],
        completed: false,
        workspace: spec.workspace,
        operationKind: spec.operationKind,
        payload: spec.payload,
        status: 'pending',
        attempts: 0,
    };
    await store.record(entry);
    return entry;
}

/**
 * Sprint O3 — bulk variant of `recordHotWrite`. Builds N OutboxEntry
 * rows from the supplied specs and commits them via the store's
 * `batchRecord` (single atomic file rewrite). Falls back to N×record()
 * if the store doesn't implement batchRecord (legacy in-memory test
 * shims), but every shipped FileOutboxStore supports the batch path.
 *
 * Throws if any spec lacks workspace. Per-spec validation is identical
 * to recordHotWrite — we keep the validation here (not at the store)
 * so bulk callers see the same error shape.
 *
 * Returns the N OutboxEntry rows that were committed, in the same
 * order as `specs`. Bulk endpoints don't currently surface the entry
 * ids back to the HTTP caller, but the array shape is convenient for
 * tests + audit-log correlation.
 *
 * Why a single batchRecord call rather than N×recordHotWrite: at
 * N=1000 the JSON file rewrite cost dominates everything else. The
 * O3 perf gate (O-D11) requires staying within ±10% of the W9
 * baseline (median 9644 ms for 1000-node bulk). Batching the commit
 * keeps outbox overhead to a single readAll + writeAll regardless
 * of N — well under budget.
 *
 * Marker tokens for the Sprint O gate test (O-D2):
 *   - outboxBatch  (regex match in bulkWrite.ts)
 *   - // O3: outbox-batch
 */
export async function recordHotWriteBatch(
    store: OutboxStore,
    specs: HotWriteSpec[],
): Promise<OutboxEntry[]> {
    if (specs.length === 0) return [];
    const now = new Date().toISOString();
    const entries: OutboxEntry[] = specs.map((spec) => {
        if (!spec.workspace || typeof spec.workspace !== 'string') {
            throw new Error(
                `outbox.recordHotWriteBatch: workspace is required (Sprint L invariant; ` +
                `operationKind='${spec.operationKind}')`,
            );
        }
        return {
            id: randomUUID(),
            operation: spec.operation ?? spec.operationKind,
            initiator: spec.initiator ?? 'system:hot-lane',
            createdAt: now,
            updatedAt: now,
            steps: [{ kind: spec.operationKind, status: 'done', payload: spec.payload }],
            completed: false,
            workspace: spec.workspace,
            operationKind: spec.operationKind,
            payload: spec.payload,
            status: 'pending',
            attempts: 0,
        };
    });
    if (typeof store.batchRecord === 'function') {
        await store.batchRecord(entries);
    } else {
        for (const e of entries) await store.record(e);
    }
    return entries;
}

/**
 * Sprint E4 (QA A2 round-4, finding 2) — retract a single already-committed
 * outbox row for an id whose downstream substrate write then failed, so a
 * later replicator tick cannot replay a write the caller was just told
 * failed. Mirrors `core/nodeService.ts`'s node.upsert retraction
 * ("retracting the node.upsert outbox row so the replicator cannot replay
 * a write the caller was told failed", `nodeServiceVerbatim.ts`'s
 * `rollbackPartialWrite`) and `storeEdge.ts`'s edge.upsert retraction —
 * same conditional-`removeIfPending`-else-compensate shape, factored out
 * here for the bulk hot-lane call sites that need it (bulkWrite.ts,
 * bulkWriteEdgesDelete.ts).
 *
 * `removeIfPending` (when the store implements it) atomically no-ops when
 * the replicator already claimed the row between the commit and this call
 * — in that case the row's effect already landed for real, so `compensating`
 * (when supplied) records a follow-up write that undoes or reconciles it
 * (e.g. a compensating `node.delete` for a resurrected node.upsert, or a
 * `verbatim.tombstone` for a graph delete that raced ahead of its own
 * tombstone). Pass `null` when no compensating write is needed (the "already
 * claimed" case has no side effect left to reconcile).
 *
 * Throws if the store lacks `removeIfPending` and `remove` also throws, or
 * if the compensating `recordHotWrite` fails — callers are expected to wrap
 * this in a try/catch and log rather than let a retraction failure mask the
 * original substrate error it's responding to.
 */
export async function retractHotWriteOrCompensate(
    store: OutboxStore,
    entryId: string,
    compensating: HotWriteSpec | null,
): Promise<void> {
    let removed = true;
    if (store.removeIfPending) {
        removed = await store.removeIfPending(entryId);
    } else {
        await store.remove(entryId);
    }
    if (!removed && compensating) {
        await recordHotWrite(store, compensating);
    }
}
