/**
 * nodeBatchRetry.ts - 3.35.0 (D10): THE retry helper around `commitNodeBatch`. Every caller that commits
 * through the primitive goes through {@link commitNodeBatchWithRetry}; nothing else loops on `contention`.
 *
 * Why a retry exists at all: ArcadeDB's conflicts are page-level (one bucket), so two batches that touch
 * DIFFERENT nodes can still abort each other with a ConcurrentModificationException. The engine answers
 * `contention` (nothing was written). This helper then:
 *   1. backs off (full jitter, base 20 ms * 2^(attempt-1)),
 *   2. calls `prepare(attempt)` AGAIN - the caller re-reads, re-stamps and re-judges its conditions
 *      against what is stored NOW (still under the same in-process node locks the caller holds) and
 *      returns the plan to submit, or throws the domain error that ends the write (a revision conflict,
 *      a failed precondition, ...),
 *   3. submits the whole batch again.
 * At most {@link MAX_BATCH_ATTEMPTS} attempts. Exhausted -> {@link NodeBatchContentionError}: a retryable
 * 503 `{code:'contention', retryable:true}` (never a 500); nothing was written.
 *
 * `refused` (item 9, 3.35.0): the connection was REFUSED, so nothing was sent (arcade `isArcadeConnectRefused`).
 * It is re-submitted on the shared transient budget (transientRetry.ts: 2 retries, the same full-jitter backoff
 * as `retryIdempotentArcadeWrite`), re-judged by `prepare` each time. Exhausted, it throws the original connect
 * error (`cause`), which every route already maps to `arcade_unavailable` - never `outcome_unknown`.
 * Reset / EPIPE / hang-up / timeout are NOT `refused` (the request may have been sent): they are `unknown`.
 *
 * `unknown` (the engine could not say whether the batch committed) is NEVER retried: replaying a batch whose
 * first run may have committed double-applies. It is SETTLED by re-reading the written nodes against the
 * plan's own stamps ({@link settleNodeBatchUnknown}); when that cannot prove the outcome the caller gets an
 * {@link OutcomeUnknownError}, and its outbox row stays `pending_commit` for the slice-2b sweep to decide.
 *
 * The helper is deliberately not specific to preconditions: a PLAIN write (no checks, one `cas` or
 * `insert` write) is the same call - that is the seam for the bulk/ifAbsent contention retry (item r).
 */
import type { LoreNode } from '../../providers/types.js';
import {
    traceNodeBatch,
    batchLandedRevision,
    type NodeBatchCapable, type NodeBatchCheck, type NodeBatchOutcome, type NodeBatchSupersedes, type NodeBatchWrite,
} from './nodeBatch.js';
import { TRANSIENT_MAX_RETRIES, transientBackoffCeilMs } from './transientRetry.js';
import { OutcomeUnknownError } from './writeOutcome.js';

export const MAX_BATCH_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 20;

export interface NodeBatchPlan { checks: NodeBatchCheck[]; writes: NodeBatchWrite[]; supersedes?: NodeBatchSupersedes }

/** Contention outlasted every attempt: nothing was written; the caller may retry later. Maps to HTTP 503. */
export class NodeBatchContentionError extends Error {
    readonly code = 'contention';
    readonly retryable = true;
    readonly status = 503;
    constructor(readonly attempts: number) {
        super(`contention: other writers kept the database busy through ${attempts} attempts; nothing was written, retry`);
        this.name = 'NodeBatchContentionError';
    }
}

export const isNodeBatchContention = (e: unknown): e is NodeBatchContentionError =>
    e instanceof NodeBatchContentionError || (e as { name?: unknown } | null)?.name === 'NodeBatchContentionError';

/** What the helper hands back: every outcome except `contention` (retried, then thrown) and an unsettled `unknown` (thrown). */
export type NodeBatchResult =
    | { ok: true; revisions: Record<string, number>; attempts: number }
    | { ok: false; code: 'precondition' | 'revision' | 'exists' | 'supersede'; index: number; id: string; actual?: number; attempts: number };

export interface NodeBatchRetryOptions {
    /** Reads one node (the settle path). Defaults to `graph.getNode` when the graph has it. */
    read?: (id: string) => Promise<LoreNode | null>;
    /** Injectable for tests: milliseconds to wait before attempt `n + 1`. */
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    maxAttempts?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Commit a batch with the D10 retry. `prepare(attempt)` runs before EVERY attempt (attempt 1 included): it
 * must read what it needs afresh and return the plan, or throw to end the write. It runs under whatever
 * locks the caller already holds - the helper takes none.
 */
export async function commitNodeBatchWithRetry(
    graph: NodeBatchCapable & { getNode?(id: string): Promise<LoreNode | null> },
    prepare: (attempt: number) => Promise<NodeBatchPlan>,
    opts: NodeBatchRetryOptions = {},
): Promise<NodeBatchResult> {
    const max = opts.maxAttempts ?? MAX_BATCH_ATTEMPTS;
    const sleep = opts.sleep ?? realSleep;
    const random = opts.random ?? Math.random;
    const read = opts.read ?? (typeof graph.getNode === 'function' ? (id: string) => graph.getNode!(id) : undefined);
    let refusedRetries = 0;
    for (let attempt = 1; attempt <= max + refusedRetries; attempt++) {
        const plan = await prepare(attempt);
        const out = await graph.commitNodeBatch(plan.checks, plan.writes, plan.supersedes);
        if (out.ok) return { ok: true, revisions: out.revisions, attempts: attempt };
        if (out.code === 'refused') {
            // Nothing was sent: re-submit on the transient budget, which is separate from the contention budget.
            if (refusedRetries >= TRANSIENT_MAX_RETRIES) throw out.cause;
            const wait = Math.floor(random() * transientBackoffCeilMs(refusedRetries));
            refusedRetries++;
            traceNodeBatch('retry', plan.checks.length, plan.writes.length, `refused attempt=${attempt} backoffMs=${wait}`);
            await sleep(wait);
            continue;
        }
        if (out.code === 'contention') {
            if (attempt - refusedRetries >= max) break;
            const wait = Math.floor(random() * BACKOFF_BASE_MS * 2 ** (attempt - refusedRetries - 1));
            traceNodeBatch('retry', plan.checks.length, plan.writes.length, `contention attempt=${attempt} backoffMs=${wait}`);
            await sleep(wait);
            continue;
        }
        if (out.code === 'unknown') return settleNodeBatchUnknown(read, plan, attempt);
        // `supersede` (a target's mark guard failed) and the plain refusals fall through to the caller.
        return { ...out, attempts: attempt };
    }
    traceNodeBatch('retry', 0, 0, `exhausted attempts=${max}`);
    throw new NodeBatchContentionError(max);
}

/**
 * Decide an `unknown` outcome by re-reading the plan's written nodes against the stamps the plan carries:
 *   - every write shows its own stamp (`updatedAt` and landed revision) -> the batch committed;
 *   - a `cas` row sits at a revision other than expected and is not ours -> the batch can no longer commit
 *     (its guard would fail): `revision` conflict;
 *   - an `insert` id holds a row that is not ours -> `exists`;
 *   - otherwise nothing proves anything (it may still be in flight) -> {@link OutcomeUnknownError}.
 */
export async function settleNodeBatchUnknown(
    read: ((id: string) => Promise<LoreNode | null>) | undefined, plan: NodeBatchPlan, attempts: number,
): Promise<NodeBatchResult> {
    const first = plan.writes[0]!.node.id;
    if (!read) throw new OutcomeUnknownError(first, undefined, 'the batch may or may not have committed and the graph cannot be re-read');
    const revisions: Record<string, number> = {};
    let landed = 0;
    let conflict: NodeBatchResult | undefined;
    for (let i = 0; i < plan.writes.length; i++) {
        const w = plan.writes[i]!;
        let row: LoreNode | null;
        try { row = await read(w.node.id); }
        catch (e) { throw new OutcomeUnknownError(w.node.id, undefined, e); }
        const rev = typeof row?.revision === 'number' ? row.revision : 0;
        if (row && row.updatedAt === w.updatedAt && rev === batchLandedRevision(w, plan.supersedes)) { revisions[w.node.id] = rev; landed++; continue; }
        if (conflict) continue;
        if (w.kind === 'insert' && row) conflict = { ok: false, code: 'exists', index: i, id: w.node.id, attempts };
        else if (w.kind === 'cas' && rev !== w.expectedRevision) conflict = { ok: false, code: 'revision', index: i, id: w.node.id, actual: rev, attempts };
    }
    if (landed === plan.writes.length) return { ok: true, revisions, attempts };
    if (landed > 0) {
        // 3.35.0 (S2): a multi-write batch is all-or-nothing, so SOME writes showing this attempt's stamp means it committed and
        // a later writer moved the rest - or that the engine broke atomicity. Either way no single answer is provable: say so loudly.
        console.error(`[Lore] node batch outcome unknown: ${landed} of ${plan.writes.length} writes show this attempt's stamp (first write ${first}); leaving the outbox rows for the sweep`);
        throw new OutcomeUnknownError(first, undefined, `mixed outcome: ${landed} of ${plan.writes.length} writes show the batch's stamp, the others do not`);
    }
    if (conflict) return conflict;
    throw new OutcomeUnknownError(first, undefined, 'the batch may or may not have committed (timeout or connection loss); the written nodes still show their old state');
}

/** Re-exported so callers do not import the outcome type from two places. */
export type { NodeBatchOutcome };
