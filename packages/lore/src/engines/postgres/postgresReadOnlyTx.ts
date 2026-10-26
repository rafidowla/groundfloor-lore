/**
 * postgresReadOnlyTx.ts - run a unit of work in a READ ONLY, snapshot-consistent transaction with timeouts.
 *
 * Used by the query-plan executor. Properties:
 *   - `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`: any write statement fails with SQLSTATE 25006, and every
 *     statement of the question sees ONE snapshot, so per-step counts and the final rows agree;
 *   - `statement_timeout` / `lock_timeout` are set LOCAL via `set_config(..., true)` with bound values (no SQL text
 *     is built from the numbers);
 *   - the transaction is always ROLLED BACK - there is nothing to commit.
 */

import type { Pool, PoolClient } from 'pg';

export interface ReadOnlyTxOptions { statementTimeoutMs: number; lockTimeoutMs: number }

export async function withReadOnlyTransaction<T>(pool: Pool, opts: ReadOnlyTxOptions, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
            await client.query(
                `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`,
                [`${Math.floor(opts.statementTimeoutMs)}ms`, `${Math.floor(opts.lockTimeoutMs)}ms`]);
            return await fn(client);
        } finally {
            try { await client.query('ROLLBACK'); } catch { /* the original error (if any) is the one to report */ }
        }
    } finally {
        client.release();
    }
}
