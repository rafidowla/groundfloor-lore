/**
 * deleteOutcome.ts — 3.34.0 (M3a): the engine-neutral "honest delete" contract.
 *
 * A node delete is two writes: the graph node, then the node's text (the verbatim row the
 * text search reads). The old routes ran the second write inside a try/catch that only logged,
 * so a failed text delete still answered `deleted:true` while the record stayed searchable.
 * The rule here: a delete NEVER reports success while its text may still be searchable.
 *
 *   deleted            node removed AND text removed/tombstoned (or there is no text store).
 *   not_found          no node held the id. Nothing else is touched (existing, idempotent shape).
 *   delete_incomplete  node removed, text delete failed after the bounded retries. The caller is
 *                      told (`delete_incomplete: ...`) and the routes still enqueue the
 *                      `verbatim.tombstone` outbox row so the replicator keeps converging, which
 *                      is what makes the operation safe to retry: a second call finds no node
 *                      (not_found) and the outbox row finishes the text. Without an outbox lane
 *                      (SQLite without the replicator) a retry will NOT clear the text; the
 *                      response says so and the operator must re-store/purge the id.
 *
 * A failure of the node delete itself (after retries) is thrown to the caller unchanged: nothing
 * was applied, so the route's existing error path (retract the node.delete outbox row) is right.
 *
 * The retry helper is engine-neutral: each engine supplies `isTransient(err)` (optional
 * `isTransientDeleteError` on its graph handle). Engines that do not supply one fall back to the
 * historical `/transaction conflict/i` classifier, which is what the delete routes always used.
 */
import { isTransactionConflictError } from '../transactionConflictRetry.js';
import { log } from '../../logger.js';

export const DELETE_INCOMPLETE_CODE = 'delete_incomplete';

export interface BoundedRetryOptions {
    /** Engine-supplied: true when the failure is worth another attempt. */
    isTransient: (err: unknown) => boolean;
    /** Total attempts including the first. Default 5. */
    maxAttempts?: number;
    /** attempt is 1-based (the attempt that just failed). Injectable so tests run instantly. */
    backoffMs?: (attempt: number) => number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const defaultBackoffMs = (attempt: number): number => Math.min(400, 20 * 2 ** attempt) + Math.floor(Math.random() * 20);

/** Run `fn`, retrying only failures `isTransient` accepts, at most `maxAttempts` times. */
export async function withBoundedRetry<T>(fn: () => Promise<T>, opts: BoundedRetryOptions): Promise<T> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const backoffMs = opts.backoffMs ?? defaultBackoffMs;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= maxAttempts || !opts.isTransient(err)) throw err;
            log.warn(`[deleteOutcome] transient delete failure on attempt ${attempt}/${maxAttempts}; retrying`);
            await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        }
    }
}

export interface DeleteGraphLike {
    deleteNode(id: string): Promise<boolean>;
    /** Optional engine classifier (additive on GraphProvider). */
    isTransientDeleteError?(err: unknown): boolean;
}

export interface DeleteTextStore {
    tombstone?: (id: string, reason: string) => Promise<void>;
    delete: (id: string) => Promise<void>;
}

export type DeleteOutcome =
    | { status: 'deleted'; tombstoned: boolean }
    | { status: 'not_found' }
    | { status: 'delete_incomplete'; tombstoned: boolean; textError: unknown };

export interface DeleteNodeAndTextArgs {
    graph: DeleteGraphLike;
    /** The text/verbatim store; omitted = the engine keeps no separate text. */
    text?: DeleteTextStore | undefined;
    nodeId: string;
    /** Id the text store knows the node by (`lore:<id>` for the verbatim store). */
    textId: string;
    reason: string;
    retry?: Partial<Pick<BoundedRetryOptions, 'maxAttempts' | 'backoffMs'>>;
}

/** The engine's own transient classifier, else the historical default. */
export function transientClassifierFor(graph: DeleteGraphLike): (err: unknown) => boolean {
    return typeof graph.isTransientDeleteError === 'function'
        ? (e) => graph.isTransientDeleteError!(e)
        : isTransactionConflictError;
}

export async function deleteNodeAndText(args: DeleteNodeAndTextArgs): Promise<DeleteOutcome> {
    const isTransient = transientClassifierFor(args.graph);
    const retry = { isTransient, ...args.retry };
    const removed = await withBoundedRetry(() => args.graph.deleteNode(args.nodeId), retry);
    if (!removed) return { status: 'not_found' };
    const text = args.text;
    if (!text) return { status: 'deleted', tombstoned: false };
    const tombstoned = typeof text.tombstone === 'function';
    try {
        await withBoundedRetry(
            () => (tombstoned ? text.tombstone!(args.textId, args.reason) : text.delete(args.textId)),
            retry,
        );
    } catch (textError) {
        return { status: 'delete_incomplete', tombstoned, textError };
    }
    return { status: 'deleted', tombstoned };
}

/** Stable per-item / response message: `delete_incomplete: ...` (code prefix first). */
export function deleteIncompleteMessage(id: string, textError: unknown): string {
    const detail = textError instanceof Error ? textError.message : String(textError);
    return (
        `${DELETE_INCOMPLETE_CODE}: node ${id} was deleted but its text delete did not succeed (${detail}); ` +
        `the text may still be searchable. Safe to retry: a repeat answers not-found and the queued tombstone converges the text.`
    );
}

export const isDeleteIncompleteResult = (r: { ok?: boolean; error?: string }): boolean =>
    r.ok === false && typeof r.error === 'string' && r.error.startsWith(`${DELETE_INCOMPLETE_CODE}:`);

/**
 * SQLite lock contention only: better-sqlite3 surfaces another connection's (or process's) held
 * write lock as code SQLITE_BUSY / SQLITE_LOCKED[_*] with the message "database is locked" /
 * "database table is locked". The condition ends when the holder's transaction commits, so it is
 * transient. Shared by the delete retry (below) and the outbox replicator's transientClassifier
 * (outbox/wiring.ts): a lock error must be retried with backoff, never counted toward the
 * `dead (permanent)` bin. Deliberately narrow: constraint/corruption/readonly errors stay permanent.
 */
export function isSqliteLockedError(err: unknown): boolean {
    const e = err as { code?: unknown; message?: unknown } | null | undefined;
    // A SQLite error code is authoritative: SQLITE_CONSTRAINT / SQLITE_CORRUPT etc. must stay
    // permanent even if their message happens to mention a lock. The message regex is only a
    // fallback for errors that carry no SQLite code (wrapped or re-thrown errors).
    if (typeof e?.code === 'string' && /^SQLITE_/.test(e.code)) return /^SQLITE_(BUSY|LOCKED)/.test(e.code);
    const msg = typeof e?.message === 'string' ? e.message : '';
    return /database (table )?is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg);
}

/**
 * SQLite's delete classifier: lock contention (the stores set busy_timeout=5000 so this is rare and
 * worth one more try) plus the historical `transaction conflict` wording the delete routes always
 * retried.
 */
export function isSqliteTransientDeleteError(err: unknown): boolean {
    return isSqliteLockedError(err) || isTransactionConflictError(err);
}
