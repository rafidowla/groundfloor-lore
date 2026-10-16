/**
 * arcadeTransientErrors.ts — 3.35.0 (a)/(p): the ONE place that decides which ArcadeDB failures
 * are TRANSIENT (the write did not commit and replaying it later is safe), shared by the
 * request-path retry (`retryIdempotentArcadeWrite`) and the outbox replicator, and exported for
 * later slices to reuse.
 *
 * Two classes, deliberately narrow:
 *
 *  - {@link isArcadeConcurrentModification} — ArcadeDB aborted the transaction because another
 *    writer touched the same page ("Concurrent modification on page ..."). The commit did not
 *    happen. Captured live on 26.7.1:
 *      sqlscript commit  -> HTTP 500 {"error":"Error on transaction commit","detail":"Concurrent
 *                           modification on page PageId(...) ...","exception":"com.arcadedb.exception.ConcurrentModificationException"}
 *      session commit    -> HTTP 503 {"error":"Cannot execute command","detail":"Concurrent
 *                           modification on page ...","exception":"com.arcadedb.exception.ConcurrentModificationException"}
 *    The STATUS differs by call path (500 vs 503), so detection keys on the parsed body's
 *    `exception` field, never on the status. A DuplicatedKeyException (HTTP 409) and a plain 500
 *    without the CME exception are NOT concurrent modifications.
 *
 *  - {@link isArcadeUnreachable} — the server could not be reached at all (connection refused /
 *    reset / DNS failure) or answered 502/503/504 with no CME body (gateway or restart window).
 *    A client-side TIMEOUT is deliberately NOT unreachable: the request may have been processed and
 *    committed, so treating it as "nothing happened" could hide an applied write. Search-worker
 *    timeouts are likewise left as ordinary counted failures (deliberate follow-up).
 *
 *  - {@link isArcadeCommitRecordNotFound} — (3.35.0 slice 4, A) a sqlscript `COMMIT` that lost a race with a
 *    writer that deleted/replaced a record the transaction had touched. Captured live on 26.7.1:
 *      HTTP 500 {"error":"Error on transaction commit","detail":"Record #N:M not found","exception":"com.arcadedb.exception.RecordNotFoundException"}
 *    Verified against the real container (see the slice-4 PR): ArcadeDB aborts the whole transaction on this
 *    path exactly as it does for a CME - across ~470 failed script attempts (including RNF ones) no row, mark,
 *    edge, revision bump or txTouch survived. Matched NARROWLY (status 500 + the commit-time error text + the
 *    exception class); a plain 500, or a RecordNotFoundException from a read/other path, is not it. It is only
 *    ever treated as contention by `commitNodeBatch` (a sqlscript, all-or-nothing), never by the single-statement
 *    `retryIdempotentArcadeWrite`, whose all-or-nothing behaviour for this error was not reproduced.
 *
 * Duck-typed on `{ status, body }` (what ArcadeHttpError carries) so this module has no import of
 * arcadeHttp.ts and cannot create a cycle with it.
 */

export const ARCADE_CME_EXCEPTION = 'com.arcadedb.exception.ConcurrentModificationException';

const UNREACHABLE_CODES = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
]);
const UNREACHABLE_STATUS = new Set([502, 503, 504]);
const MAX_CAUSE_DEPTH = 4;

interface HttpShaped { status: number; body: string }

function isHttpShaped(e: unknown): e is HttpShaped {
    return typeof e === 'object' && e !== null
        && typeof (e as { status?: unknown }).status === 'number'
        && typeof (e as { body?: unknown }).body === 'string';
}

/** The `exception` class name from a JSON error body, or undefined when the body is not JSON / has none. */
function bodyException(body: string): string | undefined | null {
    try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === 'object') {
            const ex = (parsed as { exception?: unknown }).exception;
            return typeof ex === 'string' ? ex : undefined;
        }
        return undefined;
    } catch {
        return null; // not JSON
    }
}

function* chain(err: unknown): Generator<unknown> {
    let cur: unknown = err;
    for (let i = 0; i < MAX_CAUSE_DEPTH && cur !== undefined && cur !== null; i++) {
        yield cur;
        cur = (cur as { cause?: unknown }).cause;
    }
}

/** True when ArcadeDB aborted the write with a ConcurrentModificationException (any HTTP status). */
export function isArcadeConcurrentModification(err: unknown): boolean {
    for (const e of chain(err)) {
        if (isHttpShaped(e)) {
            const ex = bodyException(e.body);
            if (ex === null) { if (e.body.includes('ConcurrentModificationException')) return true; continue; }
            if (ex === ARCADE_CME_EXCEPTION) return true;
            continue;
        }
        // A wrapped error that kept only the text: the exception class name travels in the message.
        if (e instanceof Error && e.message.includes(ARCADE_CME_EXCEPTION)) return true;
    }
    return false;
}

export const ARCADE_RECORD_NOT_FOUND_EXCEPTION = 'com.arcadedb.exception.RecordNotFoundException';
const ARCADE_COMMIT_ERROR = 'Error on transaction commit';

/** True for the commit-time RecordNotFoundException: HTTP 500, `error` = "Error on transaction commit", that exception class. */
export function isArcadeCommitRecordNotFound(err: unknown): boolean {
    for (const e of chain(err)) {
        if (!isHttpShaped(e) || e.status !== 500) continue;
        try {
            const parsed = JSON.parse(e.body) as { error?: unknown; exception?: unknown } | null;
            if (parsed && parsed.error === ARCADE_COMMIT_ERROR && parsed.exception === ARCADE_RECORD_NOT_FOUND_EXCEPTION) return true;
        } catch { /* not JSON: not this error */ }
    }
    return false;
}

/** True when ArcadeDB could not be reached (never a timeout, never a CME body). */
export function isArcadeUnreachable(err: unknown): boolean {
    for (const e of chain(err)) {
        if (isHttpShaped(e)) {
            if (UNREACHABLE_STATUS.has(e.status) && !isArcadeConcurrentModification(e)) return true;
            continue;
        }
        if (typeof e !== 'object' || e === null) continue;
        const code = (e as { code?: unknown }).code;
        if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
        // Aggregate connect failures (Node 20+ happy-eyeballs) carry the codes on .errors.
        const inner = (e as { errors?: unknown }).errors;
        if (Array.isArray(inner) && inner.some((x) => typeof (x as { code?: unknown })?.code === 'string' && UNREACHABLE_CODES.has((x as { code: string }).code))) return true;
    }
    return false;
}

/**
 * True when the connection was REFUSED (`ECONNREFUSED`, bare, via `cause`, or on every member of a
 * happy-eyeballs `AggregateError`). A refusal is raised by the TCP connect itself, before a single byte of the
 * request exists on the wire, so the server provably did nothing: unlike a reset, a broken pipe, a hang-up or a
 * timeout (all of which can follow a sent request), it is safe to replay even a non-idempotent write.
 */
export function isArcadeConnectRefused(err: unknown): boolean {
    for (const e of chain(err)) {
        if (typeof e !== 'object' || e === null || isHttpShaped(e)) continue;
        if ((e as { code?: unknown }).code === 'ECONNREFUSED') return true;
        const inner = (e as { errors?: unknown }).errors;
        if (Array.isArray(inner) && inner.length > 0 && inner.every((x) => (x as { code?: unknown } | null)?.code === 'ECONNREFUSED')) return true;
    }
    return false;
}

/** The outbox replicator's transient test for Arcade lanes: replay later, do not count an attempt. */
export function isArcadeTransientReplayError(err: unknown): boolean {
    return isArcadeConcurrentModification(err) || isArcadeUnreachable(err);
}
