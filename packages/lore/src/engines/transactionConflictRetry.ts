/**
 * transactionConflictRetry.ts — retry wrapper for SurrealDB's optimistic-
 * concurrency "Transaction conflict... this transaction can be retried"
 * error under concurrent writes to overlapping keys — expected, retryable
 * behavior per SurrealDB's own error message. LocalGraph (Kùzu) serializes
 * writes internally (globalWriteQueue) and never hits this error class, so
 * this retry is a no-op there.
 *
 * Originally inlined in bulkIngest.ts (2026-08-13, found: 27/550 nodes
 * failed on a real workload without it). That first version used a short
 * linear backoff (max ~150ms total, ~10ms jitter) and later lost nodes on a
 * BIGGER real workload (467-node batch, 16-way concurrent fan-out) — with
 * 16 writers retrying near-simultaneously and only 10ms of jitter to
 * desynchronize them, repeated retriers kept re-colliding in the same short
 * window. Widened to exponential backoff (capped) + 5x wider jitter, and
 * extracted here so the retry logic itself is unit-testable in isolation
 * (see transaction-conflict-retry-unit.ts) instead of only provable by
 * re-running the real workload that broke it.
 *
 * `backoffMs` is injectable so tests can run near-instantly — production
 * callers omit it and get the real exponential+jitter schedule.
 */

import { log } from '../logger.js';

export interface TransactionConflictRetryOpts {
    maxAttempts?: number;
    /** attempt is 1-based — the attempt number that just failed. */
    backoffMs?: (attempt: number) => number;
}

const DEFAULT_MAX_ATTEMPTS = 8;

function defaultBackoffMs(attempt: number): number {
    return Math.min(1000, 25 * 2 ** attempt) + Math.floor(Math.random() * 50);
}

export function isTransactionConflictError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    return /transaction conflict/i.test(msg);
}

export async function withTransactionConflictRetry<T>(
    fn: () => Promise<T>,
    opts: TransactionConflictRetryOpts = {},
): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoffMs = opts.backoffMs ?? defaultBackoffMs;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const conflict = isTransactionConflictError(err);
            if (!conflict || attempt >= maxAttempts) {
                if (conflict) {
                    log.error(`[transactionConflictRetry] giving up after ${attempt} attempt(s)`);
                }
                throw err;
            }
            log.warn(`[transactionConflictRetry] conflict on attempt ${attempt}/${maxAttempts}; retrying`);
            await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        }
    }
}
