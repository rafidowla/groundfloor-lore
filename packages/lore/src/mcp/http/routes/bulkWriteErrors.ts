/**
 * bulkWriteErrors.ts — 3.34.0 (M2): stable, machine-matchable per-item error codes for the bulk
 * node write. Additive: the `error` string always STARTS with `<code>: ` (the shape
 * `already_exists` already had) and keeps the underlying message after it.
 *
 *   already_exists       ifAbsent refused: a node holds the id (unchanged)
 *   revision_conflict    the stored revision moved under a conditional write
 *   outcome_unknown      the write may or may not have been applied; `currentRevision` is the
 *                        last revision read (null = absent, omitted = no read succeeded). The
 *                        item's outbox row is NOT retracted — it stays pending and replays.
 *   arcade_unavailable   ArcadeDB answered 502/503/504, or refused the connection (nothing was applied)
 *   arcade_error         ArcadeDB refused the command (nothing was applied)
 *   node_busy            3.35.0: the per-node lock was not free within the bounded wait (a stuck holder); nothing was written
 *   contention           3.35.0: the atomic node batch lost every concurrent-modification retry; nothing was written, retry
 *   timeout              a client-side timeout before the write was attempted or acknowledged
 *   write_failed         any other failure of the item's write
 */
import { isSupersedeRefused } from '../../../core/atomicSupersede.js';
import { alreadyExistsError, isNodeAlreadyExists } from '../../../engines/graphShared/conditionalInsert.js';
import { isRevisionConflict } from '../../../engines/graphShared/revision.js';
import { NodeLockTimeoutError } from '../../../core/nodeWriteLock.js';
import { isNodeBatchContention } from '../../../engines/graphShared/nodeBatchRetry.js';
import { isArcadeConnectRefused } from '../../../engines/arcade/arcadeTransientErrors.js';
import { isOutcomeUnknown, type OutcomeUnknownError } from '../../../engines/graphShared/writeOutcome.js';

export interface ItemWriteFailure {
    ok: false;
    error: string;
    /** outcome_unknown only. */
    currentRevision?: number | null;
}

const hasPrefix = (m: string): boolean => /^[a-z][a-z_]*: /.test(m);
const withCode = (code: string, m: string): string => (m.startsWith(`${code}: `) ? m : `${code}: ${m}`);

export function classifyItemWriteError(err: unknown): ItemWriteFailure {
    const e = err as { name?: string; message?: string; status?: number };
    const message = typeof e?.message === 'string' ? e.message : String(err);
    if (isNodeAlreadyExists(err)) return { ok: false, error: alreadyExistsError(err as Error) };
    if (isOutcomeUnknown(err)) {
        const cur = (err as OutcomeUnknownError).currentRevision;
        return { ok: false, error: message, ...(cur !== undefined ? { currentRevision: cur } : {}) };
    }
    if (isRevisionConflict(err)) return { ok: false, error: message };
    if (isSupersedeRefused(err)) return { ok: false, error: withCode(err.code, message) }; // (q) atomic supersede refused: nothing was written
    if (isNodeBatchContention(err)) return { ok: false, error: withCode('contention', message) };
    if (err instanceof NodeLockTimeoutError) return { ok: false, error: withCode('node_busy', message) };
    if (e?.name === 'ArcadeHttpError') {
        return { ok: false, error: withCode([502, 503, 504].includes(e.status ?? 0) ? 'arcade_unavailable' : 'arcade_error', message) };
    }
    if (isArcadeConnectRefused(err)) return { ok: false, error: withCode('arcade_unavailable', message) }; // refused at connect: nothing was sent
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /\btimed? ?out\b|ETIMEDOUT/i.test(message)) return { ok: false, error: withCode('timeout', message) };
    return { ok: false, error: hasPrefix(message) ? message : `write_failed: ${message}` };
}

/**
 * The message for an item refused because reading it BEFORE the write failed (nothing was
 * written). Same `<code>: ` contract as a write failure — `arcade_unavailable`, `timeout`,
 * `write_failed`, ... — so a read-side outage is matchable like a write-side one.
 */
export function preReadFailureMessage(err: unknown): string {
    const classified = classifyItemWriteError(err).error;
    const at = classified.indexOf(': ');
    const [code, message] = at > 0 ? [classified.slice(0, at), classified.slice(at + 2)] : ['write_failed', classified];
    return `${code}: could not read the node before writing: ${message}; nothing was written`;
}

/** True for an item result the bulk route must NOT retract the outbox row of. */
export const isOutcomeUnknownResult = (r: { ok: boolean; error?: string }): boolean => !r.ok && typeof r.error === 'string' && r.error.startsWith('outcome_unknown:');
