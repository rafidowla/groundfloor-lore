/**
 * arcadeDeleteClassifier.ts — 3.34.0 (M3a): which ArcadeDB failures a delete may retry.
 *
 * Retried (the delete is idempotent: `DELETE ... WHERE id = :id` of an already-gone id is a no-op):
 *   - HTTP 503 (server busy / restarting). `ArcadeHttp.command` never retries on its own, so the
 *     delete routes' bounded retry is the only place this is absorbed.
 *   - A concurrent-modification answer. Captured live on 26.7.1 (40 parallel writers on one record):
 *     HTTP 503 `{"error":"Cannot execute command","detail":"Concurrent modification on page
 *     PageId(db/1/0) in file 'LoreNode_0...bucket' (current v.9 <> database v.10). Please retry the
 *     operation (threadId=90)","exception":"com.arcadedb.exception.ConcurrentModificationException"}`.
 *     The body match below also accepts `NeedRetryException` wording should another path return it
 *     with a different status.
 *
 * NOT retried: 4xx (a refused command will be refused again), a client-side timeout (the outcome
 * is unknown; deleting again is safe but the caller should hear about it), and anything else.
 */
import { ArcadeHttpError } from './arcadeHttp.js';
import { isTransactionConflictError } from '../transactionConflictRetry.js';

const CONCURRENT_BODY = /ConcurrentModification|NeedRetry|concurrent modification|try again|retry the operation/i;

export function isArcadeTransientDeleteError(err: unknown): boolean {
    if (!(err instanceof ArcadeHttpError)) return isTransactionConflictError(err);
    if (err.status === 503) return true;
    return CONCURRENT_BODY.test(err.body) || isTransactionConflictError(err);
}
