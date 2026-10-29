/**
 * postgresStartup.ts — startup checks and the schema-bootstrap guard for the
 * Postgres engine.
 *
 * Two jobs, both about the FIRST thing that happens when a workspace opens:
 *
 *   1. Operator-readable failures. The raw `pg` errors for "server not
 *      running", "wrong password", "database does not exist" and "pgvector
 *      not installed" are terse and do not say what to do. {@link
 *      explainPostgresStartupError} rewrites them into one message that
 *      names the (redacted) target and the fix. The credentials in
 *      `LORE_PG_URL` are never part of any message.
 *   2. Race-free DDL. Several Lore processes (a multi-server deployment, or a
 *      daemon plus a CLI tool) can open the same database at once, and
 *      `CREATE TABLE IF NOT EXISTS` / `CREATE EXTENSION IF NOT EXISTS` are NOT
 *      safe under concurrency (two sessions both pass the "does not exist"
 *      check and one fails with a unique-violation on `pg_type` /
 *      `pg_extension`). {@link runSchemaBootstrap} serializes every schema
 *      bootstrap behind one SESSION-level advisory lock. The DDL itself runs
 *      autocommitted, statement by statement, NOT in one transaction: a single
 *      DDL transaction accumulates table locks across statements and
 *      deadlocks against live writers that take the same tables in another
 *      order (seen in the delete-honesty gate). Every statement is idempotent,
 *      so a bootstrap that dies midway is simply re-run.
 *
 * Nothing here ever falls back to another engine.
 */

import type { Pool, PoolClient } from 'pg';
import { redactPgUrl } from './postgresClient.js';

/**
 * Oldest supported server: 15. `ON DELETE SET NULL (column_list)` (the lore_entity -> nodes composite foreign key,
 * postgresWorkspaceSk.ts) needs 15; `CREATE OR REPLACE TRIGGER` (the verbatim schema) needs 14.
 */
export const MIN_POSTGRES_SERVER_VERSION_NUM = 150000;
/**
 * Oldest supported pgvector. 0.8.0 added iterative index scans (`hnsw.iterative_scan`): without them an HNSW search
 * that is post-filtered by scope/ecosystem/type returns only the ef_search (default 40) nearest candidates that
 * happen to pass the filter, so a scoped actor can get far fewer than topK rows. The vector leg relies on it.
 */
export const MIN_PGVECTOR_VERSION = [0, 8, 0] as const;

/**
 * Arbitrary constant key for the schema-bootstrap advisory lock. Session-level
 * (`pg_advisory_lock`): Postgres releases it if the connection dies, so a
 * crashed process can never leave it held; the happy path unlocks explicitly.
 */
const SCHEMA_LOCK_KEY = 7_364_920_117;

/** Thrown for every startup failure so callers can tell "Postgres is not usable" from a query bug. */
export class PostgresStartupError extends Error {
    public readonly code = 'postgres_startup_failed' as const;
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'PostgresStartupError';
        if (cause !== undefined) this.cause = cause;
    }
}

/** The redacted target for messages: never the credentials. */
function targetLabel(): string {
    const url = process.env['LORE_PG_URL'];
    return url && url.trim() !== '' ? redactPgUrl(url) : 'the configured Postgres (LORE_PG_URL)';
}

function parseVersion(text: string): number[] {
    return text.split('.').map((part) => Number.parseInt(part, 10)).map((n) => (Number.isFinite(n) ? n : 0));
}

function versionAtLeast(have: number[], want: readonly number[]): boolean {
    for (let i = 0; i < want.length; i++) {
        const a = have[i] ?? 0;
        const b = want[i] ?? 0;
        if (a !== b) return a > b;
    }
    return true;
}

/**
 * explainPostgresStartupError — turn a raw driver/server failure into an
 * operator-readable {@link PostgresStartupError}. Already-explained errors are
 * returned unchanged. Unrecognized failures keep their own message, prefixed
 * with the target, so nothing is hidden.
 */
export function explainPostgresStartupError(err: unknown): PostgresStartupError {
    if (err instanceof PostgresStartupError) return err;
    const target = targetLabel();
    const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : '';
    const raw = err instanceof Error ? err.message : String(err);
    let hint: string;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ETIMEDOUT'
        || /connection terminated due to connection timeout/i.test(raw)) {
        hint = `cannot reach Postgres at ${target} (${code || 'connection timeout'}). Is the server running, and is LORE_PG_URL's host and port correct?`;
    } else if (code === '28P01' || code === '28000') {
        hint = `Postgres at ${target} rejected the credentials in LORE_PG_URL (${code}). Check the user, password and pg_hba.conf.`;
    } else if (code === '3D000') {
        hint = `the database named in LORE_PG_URL does not exist on ${target}. Create it first (CREATE DATABASE), then retry.`;
    } else if (code === '42501') {
        hint = `the Postgres role in LORE_PG_URL lacks a privilege needed to create Lore's schema on ${target}`
            + ' (CREATE on the schema, and for the first bootstrap CREATE EXTENSION vector — a superuser or a trusted-extension setup).';
    } else {
        hint = `Postgres startup failed at ${target}: ${raw}`;
    }
    return new PostgresStartupError(`postgres engine: ${hint}`, err);
}

/** Connect a pool client, mapping connection failures to {@link PostgresStartupError}. */
export async function connectForStartup(pool: Pool): Promise<PoolClient> {
    try {
        return await pool.connect();
    } catch (err) {
        throw explainPostgresStartupError(err);
    }
}

/** Server-version gate: fails with the supported minimum instead of a syntax error mid-DDL. */
async function assertServerVersion(client: PoolClient): Promise<void> {
    const res = await client.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`);
    const num = Number(res.rows[0]?.v ?? 0);
    if (num < MIN_POSTGRES_SERVER_VERSION_NUM) {
        throw new PostgresStartupError(
            `postgres engine: server at ${targetLabel()} is version ${num} — Lore requires PostgreSQL 15 or newer `
            + `(the per-workspace node key uses ON DELETE SET NULL (column), added in 15). `
            + `Upgrade the server (pg_upgrade or dump/restore to a PostgreSQL 15+ instance, e.g. the pgvector/pgvector:pg16 image), then restart Lore. `
            + `Nothing was changed in this database.`,
        );
    }
}

/**
 * pgvector gate for the verbatim (vector) substrate. Checks the extension is
 * installable on this server (or already installed) at a version with HNSW
 * iterative-scan support (0.8+), so a missing package fails with an install hint, not with
 * `extension "vector" is not available` out of a CREATE EXTENSION.
 */
async function assertPgvector(client: PoolClient): Promise<void> {
    const res = await client.query<{ installed: string | null; available: string | null }>(
        `SELECT (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS installed,
                (SELECT default_version FROM pg_available_extensions WHERE name = 'vector') AS available`,
    );
    const row = res.rows[0];
    const installed = row?.installed ?? null;
    const available = row?.available ?? null;
    const have = installed ?? available;
    if (have === null) {
        throw new PostgresStartupError(
            `postgres engine: the pgvector extension is not installed on the server at ${targetLabel()}. `
            + "Lore's vector store needs it — install pgvector (e.g. the `pgvector/pgvector` image, or your OS's "
            + 'postgresql-<version>-pgvector package) and retry. The graph substrate alone does not need it.',
        );
    }
    if (!versionAtLeast(parseVersion(have), MIN_PGVECTOR_VERSION)) {
        throw new PostgresStartupError(
            `postgres engine: pgvector ${have} at ${targetLabel()} is too old — Lore needs ${MIN_PGVECTOR_VERSION.join('.')} `
            + 'or newer (HNSW iterative index scans, `hnsw.iterative_scan`, which scope-filtered vector search needs). '
            + 'To upgrade: install the pgvector 0.8+ package for your server (e.g. the `pgvector/pgvector:pg16` image tag, or your '
            + "OS's postgresql-<version>-pgvector package), then run `ALTER EXTENSION vector UPDATE;` in this database and retry.",
        );
    }
}

/** Options for {@link runSchemaBootstrap}. */
export interface SchemaBootstrapOptions {
    /** Also require pgvector (the verbatim substrate). Default false. */
    requirePgvector?: boolean;
}

/**
 * runSchemaBootstrap — run `fn` (the schema DDL) on a pooled client while
 * holding the schema advisory lock, after the startup checks (reachable,
 * server version, pgvector when asked). `fn` runs autocommitted (see header). Every failure is
 * rewritten into a {@link PostgresStartupError} except errors `fn` itself
 * raises deliberately (e.g. the embedding-dimension mismatch gate), which pass
 * through unchanged so their wording stays exact.
 */
export async function runSchemaBootstrap<T>(
    pool: Pool,
    opts: SchemaBootstrapOptions,
    fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await connectForStartup(pool);
    let locked = false;
    let poisoned: Error | undefined;
    try {
        await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
        locked = true;
        await assertServerVersion(client);
        if (opts.requirePgvector) await assertPgvector(client);
        try {
            return await fn(client);
        } catch (err) {
            // fn's own deliberate errors keep their message; privilege failures get the hint.
            const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : '';
            throw code === '42501' ? explainPostgresStartupError(err) : err;
        }
    } catch (err) {
        throw err instanceof PostgresStartupError ? err : (isDriverFailure(err) ? explainPostgresStartupError(err) : err);
    } finally {
        if (locked) {
            try {
                await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]);
            } catch (unlockErr) {
                // Never hand a connection that may still hold the lock back to the pool.
                poisoned = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr));
            }
        }
        client.release(poisoned);
    }
}

/** True for connection-level failures (socket/auth/db-missing) as opposed to a deliberate Error from DDL code. */
function isDriverFailure(err: unknown): boolean {
    if (!err || typeof err !== 'object' || !('code' in err)) return false;
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && /^(E[A-Z]+|28P01|28000|3D000|08.*)$/.test(code);
}
