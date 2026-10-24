/**
 * postgresClient.ts — Postgres engine: the client seam.
 * This module owns everything that touches the `pg` driver:
 *   - pool construction from `LORE_PG_URL` (never logged; see `redactPgUrl`),
 *   - per-session guards (`statement_timeout`,
 *     `idle_in_transaction_session_timeout`) applied on EVERY client connect,
 *   - a transaction wrapper with honest BEGIN/COMMIT/ROLLBACK semantics,
 *   - error classification (SQLSTATE `40001`/`40P01` -> `contention`,
 *     statement/connection timeouts -> `timeout`, everything else ->
 *     `unknown`) and the mapping helpers into the SHARED outcome errors.
 *
 * The outcome error classes are imported from `engines/graphShared/` exactly
 * as the SQLite and ArcadeDB engines use them — they are re-declared NOWHERE
 * here, so the contract tests and the shared retry helper keep working
 * unchanged when the postgres store lands on top of this file.
 *
 * Fallback rule (the pm-scope-app incident rule): when no URL is configured
 * this module THROWS. It never falls back to another engine's store — a
 * silently-served SQLite file where Postgres was asked for is the exact
 * failure mode the engine selector forbids.
 */

import { Pool, type PoolClient } from 'pg';
import { NodeBatchContentionError } from '../graphShared/nodeBatchRetry.js';
import { OutcomeUnknownError } from '../graphShared/writeOutcome.js';
import { cancelBackgroundWork, configurePoolGuard, type PoolGuardOptions } from './postgresPoolGuard.js';

/** How the caller configures {@link createPostgresPool}; every field falls back to env. */
export interface PostgresPoolOptions extends PoolGuardOptions {
    /** Connection string. Falls back to `LORE_PG_URL`. Never logged. */
    url?: string;
    /** Max pool size. Falls back to `LORE_PG_POOL_MAX`, then 16. */
    max?: number;
    // Inherited from PoolGuardOptions (postgresPoolGuard.ts): backgroundReserve (falls back to
    // LORE_PG_BACKGROUND_RESERVE), backgroundConcurrency (LORE_PG_BACKGROUND_CONCURRENCY),
    // backgroundStatementTimeoutMs (LORE_PG_BACKGROUND_STATEMENT_TIMEOUT_MS; default 0 = unbounded).
}

/** Coarse failure class used by the transaction wrapper and the store slices. */
export type PostgresErrorClass = 'contention' | 'timeout' | 'unknown';

const DEFAULT_POOL_MAX = 16;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TX_TIMEOUT_MS = 60_000;
/** Bounds both dialing a dead host and waiting for a free pooled client (pg-pool covers both). */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Serialization failure and deadlock: Postgres aborted the unit of work before committing anything. */
const SQLSTATE_CONTENTION: Record<string, true> = { '40001': true, '40P01': true };
/** `canceling statement due to statement timeout` (also what idle-in-transaction abort surfaces as). */
const SQLSTATE_TIMEOUT: Record<string, true> = { '57014': true };

/** Error carrying the transaction wrapper's classification (stamped on rollback, read by callers upstream). */
interface ClassifiableError {
    pgErrorClass?: PostgresErrorClass;
}

/** Read a positive-integer env knob; a set-but-invalid value fails loudly instead of being ignored. */
function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
        throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return value;
}

/** Read a non-negative-integer env knob (0 is meaningful); a set-but-invalid value fails loudly. */
function nonNegIntEnv(name: string): number | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    }
    return value;
}

/**
 * redactPgUrl — the ONLY shape of a Postgres URL this codebase may ever log:
 * `postgres://<host>:<port>/<db>`. Credentials (user, password) are dropped.
 * Unparseable input degrades to a fixed placeholder rather than risking a
 * partial echo of the secret.
 */
export function redactPgUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `postgres://${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
    } catch {
        return 'postgres://<unparsable-url>';
    }
}

/**
 * createPostgresPool — build the `pg` pool for this engine.
 *
 *   - URL: `opts.url`, else `LORE_PG_URL`. Neither present -> throw. NEVER a
 *     fallback to SQLite/Surreal/Dataplane.
 *   - `max`: `opts.max`, else `LORE_PG_POOL_MAX`, else 16 (overridable).
 *   - background budget: `backgroundReserve` / `backgroundConcurrency` (env
 *     `LORE_PG_BACKGROUND_RESERVE` / `LORE_PG_BACKGROUND_CONCURRENCY`), see postgresPoolGuard.ts.
 *   - `application_name = 'lore'` (override: `LORE_PG_APPLICATION_NAME`) so
 *     `pg_stat_activity` can attribute connections to this engine.
 *   - `connectionTimeoutMillis` from `LORE_PG_CONNECT_TIMEOUT_MS` (default
 *     30000) so a dead host fails with a clear timeout instead of hanging.
 *   - Every new client connects with `statement_timeout` and
 *     `idle_in_transaction_session_timeout` already in effect as session
 *     startup parameters, from `LORE_PG_STATEMENT_TIMEOUT_MS` (default
 *     30000) and `LORE_PG_IDLE_TX_TIMEOUT_MS` (default 60000) — see the
 *     comment at pool construction for why these are startup parameters
 *     rather than connect-time SET statements.
 */
export function createPostgresPool(opts: PostgresPoolOptions = {}): Pool {
    const url = opts.url ?? process.env.LORE_PG_URL;
    if (!url || url.trim() === '') {
        throw new Error(
            'createPostgresPool: no Postgres URL configured — pass opts.url or set LORE_PG_URL. '
            + 'The postgres engine never falls back to another engine.',
        );
    }
    const max = opts.max ?? intEnv('LORE_PG_POOL_MAX', DEFAULT_POOL_MAX);
    const statementTimeoutMs = intEnv('LORE_PG_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS);
    const idleTxTimeoutMs = intEnv('LORE_PG_IDLE_TX_TIMEOUT_MS', DEFAULT_IDLE_TX_TIMEOUT_MS);
    const connectTimeoutMs = intEnv('LORE_PG_CONNECT_TIMEOUT_MS', DEFAULT_CONNECT_TIMEOUT_MS);
    const appName = process.env.LORE_PG_APPLICATION_NAME?.trim() || 'lore';

    // Per-session guards, applied on EVERY client connect as startup parameters —
    // equivalent to running `SET statement_timeout = …` / `SET idle_in_transaction_
    // session_timeout = …` as the connection's first statements, but enforced by the
    // server BEFORE any query can run. (Issuing the SETs from pool.on('connect') was
    // the classic pg recipe; pg 8.19+ deprecates that fire-and-forget query overlap
    // and pg 9 removes it. Values are validated integers from intEnv.)
    const pool = new Pool({
        connectionString: url,
        max,
        application_name: appName,
        connectionTimeoutMillis: connectTimeoutMs,
        statement_timeout: statementTimeoutMs,
        idle_in_transaction_session_timeout: idleTxTimeoutMs,
    });

    // Background-work budget for this pool (postgresPoolGuard.ts): reserves a floor of connections for foreground queries.
    const reserve = opts.backgroundReserve ?? nonNegIntEnv('LORE_PG_BACKGROUND_RESERVE');
    const concurrency = opts.backgroundConcurrency ?? nonNegIntEnv('LORE_PG_BACKGROUND_CONCURRENCY');
    const bgTimeout = opts.backgroundStatementTimeoutMs ?? nonNegIntEnv('LORE_PG_BACKGROUND_STATEMENT_TIMEOUT_MS');
    configurePoolGuard(pool, {
        ...(reserve !== undefined ? { backgroundReserve: reserve } : {}),
        ...(concurrency !== undefined ? { backgroundConcurrency: concurrency } : {}),
        ...(bgTimeout !== undefined ? { backgroundStatementTimeoutMs: bgTimeout } : {}),
    });

    // An idle client dying (restart of the server, network blip) must not crash the
    // process as an unhandled 'error' event; the redacted URL is all that may print.
    pool.on('error', (err) => {
        console.error(`[lore-pg] idle client error (${redactPgUrl(url)}): ${err.message}`);
    });

    return pool;
}

/**
 * withTransaction — run `fn` inside one honest transaction.
 *
 * BEGIN -> fn -> COMMIT; on ANY error (in fn, COMMIT, or BEGIN) the unit of
 * work is ROLLBACKed, the client is released back to the pool, and the
 * ORIGINAL error is rethrown unchanged (callers classify it with
 * {@link classifyPostgresError} or the `to*` mapping helpers — mutating the
 * error's identity here would break `isNodeBatchContention`-style checks).
 * The wrapper stamps `err.pgErrorClass` (when not already set) so a caller
 * that only sees the error can read the classification without re-deriving it.
 * A ROLLBACK that itself fails never masks the original error.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let committed = false;
        try {
            const result = await fn(client);
            await client.query('COMMIT');
            committed = true;
            return result;
        } finally {
            if (!committed) {
                try {
                    await client.query('ROLLBACK');
                } catch {
                    // The original error is the one to report; a broken rollback usually
                    // means the connection died, which the caller will also see.
                }
            }
        }
    } catch (err) {
        // pg failures are plain Error objects; stamping one extra property is safe. Named cast
        // (not inline member access): `Error` itself has no pgErrorClass field for TS to see.
        const stamped = err as ClassifiableError;
        if (stamped.pgErrorClass === undefined) stamped.pgErrorClass = classifyPostgresError(err);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * classifyPostgresError — map a driver/server failure to the coarse class the
 * engine contract speaks:
 *   - `contention`: SQLSTATE `40001` (serialization_failure) / `40P01`
 *     (deadlock_detected). Postgres aborted the unit of work before it
 *     committed anything, so the shared bounded retry may re-run it.
 *   - `timeout`: statement timeout (SQLSTATE `57014`) and the driver-level
 *     connection timeout (`Connection terminated due to connection timeout`),
 *     where whether anything committed CANNOT be assumed — these surface as
 *     `unknown` outcomes upstream, never as retryable contention.
 *   - `unknown`: everything else, including connect refused and auth failures.
 */
export function classifyPostgresError(err: unknown): PostgresErrorClass {
    if (!err || typeof err !== 'object') return 'unknown';
    if ('code' in err && typeof err.code === 'string') {
        if (SQLSTATE_CONTENTION[err.code]) return 'contention';
        if (SQLSTATE_TIMEOUT[err.code]) return 'timeout';
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/connection terminated due to connection timeout|timeout expired|connection timeout/i.test(message)) {
        return 'timeout';
    }
    return 'unknown';
}

/**
 * toNodeBatchContention — wrap a classified-contention failure in the SHARED
 * {@link NodeBatchContentionError} (the retryable 503 `{code:'contention'}`),
 * keeping the original error as `cause` so the SQLSTATE survives for logs.
 * `attempts` is the retry count the caller actually burned (default 1 when
 * the caller cannot know better).
 */
export function toNodeBatchContention(err: unknown, attempts = 1): NodeBatchContentionError {
    const mapped = new NodeBatchContentionError(attempts);
    // ES2022 Error.cause: keeps the original SQLSTATE reachable for logs without a cast.
    mapped.cause = err;
    return mapped;
}

/**
 * toOutcomeUnknown — wrap a failure whose commit status cannot be established
 * (statement/connection timeout, socket drop after send) in the SHARED
 * {@link OutcomeUnknownError} so the bulk route answers `outcome_unknown`
 * with the node's current revision and leaves the outbox row pending.
 */
export function toOutcomeUnknown(
    err: unknown, id: string, currentRevision: number | null | undefined,
): OutcomeUnknownError {
    return new OutcomeUnknownError(id, currentRevision, err);
}

/**
 * closePostgresPool — drain and close: `pool.end()` refuses new checkouts and
 * resolves once every checked-out client has been released and every socket
 * is closed. Await this on shutdown so the process can exit with no leaked
 * handles. Idempotent — `end()` on an already-ended pool resolves.
 * In-flight background jobs (postgresPoolGuard.ts) are cancelled first: otherwise
 * `end()` would wait for a multi-minute index build to finish.
 */
export async function closePostgresPool(pool: Pool): Promise<void> {
    await cancelBackgroundWork(pool);
    await pool.end();
}
