/**
 * postgresPoolOwner.ts — the process-wide `pg` pool for the postgres
 * engine.
 *
 * WHY A OWNER MODULE: both postgres substrates (PostgresGraph and
 * PostgresVerbatimStore) take an INJECTED pool and deliberately never end it
 * (their close() releases only their own claim — see each class's pool-
 * ownership comment). The graph registry, openWorkspaceGraph and
 * openWorkspaceVerbatim may each construct handles, and per-workspace
 * workspace_id slicing means ONE database serves every workspace, so the
 * right pool topology is one shared pool per process, created lazily on the
 * first postgres open and drained once at daemon shutdown.
 *
 * URL RULE (unchanged from postgresClient.ts): the pool is built from
 * `LORE_PG_URL`; when it is unset createPostgresPool THROWS — the engine
 * never falls back to another engine's store (pm-scope-app rule). The URL
 * itself is never logged; `redactedPostgresLocation()` is the only shape of
 * it this codebase may print or report.
 */

import type { Pool } from 'pg';
import { closePostgresPool, createPostgresPool, redactPgUrl } from './postgresClient.js';

let shared: Pool | null = null;

/**
 * sharedPostgresPool — the lazily-created, process-wide pool. First call
 * (and only the first) reads `LORE_PG_URL`; a missing URL is a loud
 * construction-time error naming the env var.
 */
export function sharedPostgresPool(): Pool {
    if (!shared) shared = createPostgresPool();
    return shared;
}

/**
 * closeSharedPostgresPool — drain and forget the shared pool. Safe to call
 * when no pool was ever opened (no-op) and from a double-drain (the second
 * call sees null). The shutdown drain calls this LAST — after both
 * substrates' handles are closed — because `pool.end()` refuses new
 * checkouts and waits for in-flight queries to settle.
 */
export async function closeSharedPostgresPool(): Promise<void> {
    const pool = shared;
    shared = null;
    if (pool) await closePostgresPool(pool);
}

/**
 * redactedPostgresLocation — the `graphPath` / banner string for a
 * postgres-backed workspace: `postgres://<host>:<port>/<db>`, credentials
 * dropped. Names the env var explicitly when no URL is configured rather
 * than inventing a host that would look real.
 */
export function redactedPostgresLocation(): string {
    const url = process.env['LORE_PG_URL'];
    return url && url.trim() !== '' ? redactPgUrl(url) : 'postgres://<LORE_PG_URL-unset>';
}
