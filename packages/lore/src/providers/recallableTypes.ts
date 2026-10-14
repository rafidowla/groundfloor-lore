/**
 * 3.34.0 (N5) - engine-neutral "recallable now" contract types (`awaitRecallable`,
 * `POST /api/nodes/recallable`). Kept out of `types.ts` for the file-size budget;
 * re-exported from there, so import from either.
 */
/** 3.34.0 (N5) - per-id answer of `awaitRecallable`. */
export type RecallableState = 'recallable' | 'pending' | 'not_found';
/**
 * Why an id is not (yet) recallable. `queued` = an embed/verbatim write is still in the outbox;
 * `awaiting_index` = nothing queued but the vector index does not answer yet (index lag, or a node
 * written without an embedding - indistinguishable once the outbox row has been pruned);
 * `embed_failed` = the outbox row is dead-lettered (will never embed without operator action).
 */
export type RecallablePendingReason = 'queued' | 'awaiting_index' | 'embed_failed';
export interface RecallableIdStatus {
    id: string;
    status: RecallableState;
    reason?: RecallablePendingReason;
}
/** The engine-neutral request: an explicit capped id list, or everything queued before now. */
export type RecallableRequest =
    | { ids: string[]; timeoutMs: number; signal?: AbortSignal }
    | { allBeforeNow: true; timeoutMs: number; signal?: AbortSignal };
/** A timeout is a STATUS (`timedOut: true`, `ready: false`), never an error. */
export interface RecallableResult {
    supported: true;
    mode: 'ids' | 'all_before_now';
    /** true when every requested id is recallable (ids mode) / the whole backlog drained and a sample verified (all mode). */
    ready: boolean;
    timedOut: boolean;
    waitedMs: number;
    /** Round trips to the vector index (bounded; not proportional to waited time). */
    indexChecks: number;
    counts: { recallable: number; pending: number; notFound: number };
    ids?: RecallableIdStatus[];
    /** all_before_now only: outbox position snapshotted at request time. */
    highWaterSequenceId?: number;
    /** all_before_now only: embed rows at or below the high-water mark still queued. */
    queuedRemaining?: number;
    /** all_before_now only: how many of the newest replicated nodes were verified in the index. */
    sampled?: number;
}
export interface RecallableNotSupported {
    supported: false;
    code: 'not_supported';
    reason: string;
}
