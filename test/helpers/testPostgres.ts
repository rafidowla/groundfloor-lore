/**
 * test/helpers/testPostgres.ts — shared rig for the Postgres engine-contract
 * test cases.
 *
 * The cases run PostgresGraph / PostgresVerbatimStore against a REAL
 * throwaway Postgres (with the pgvector extension) named by `LORE_PG_URL`.
 * Two rules shape this helper:
 *
 *  1. SKIP PATH (mandatory): when `LORE_PG_URL` is unset every contract file
 *     must skip its postgres cases CLEANLY — a printed reason and exit 0 —
 *     never a failure, so machines without Postgres keep a green run.
 *     `createGatePool` returns null and prints the reason; callers branch on it.
 *
 *  2. ISOLATION + CLEAN RERUNS: the cases use a DEDICATED database
 *     (`lore_gate`) on the same server — whatever database `LORE_PG_URL`
 *     names keeps its own schema and embedding dimension untouched — and every
 *     workspace row these tests create is named `pg-gate-*`.
 *     `cleanupGateWorkspaces` deletes exactly those rows (nodes, edges,
 *     verbatim, changes log) so a rerun starts clean; nothing outside the
 *     `pg-gate-` prefix is touched.
 *
 * The URL is never echoed: only `redactPgUrl`-shaped text may print.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Client, type Pool } from 'pg';

import { createPostgresPool, closePostgresPool, redactPgUrl } from '../../packages/lore/src/engines/postgres/postgresClient.js';

/** Dedicated database for the gate tests, carved out of the same container. */
export const PG_GATE_DB = 'lore_gate';

/** Every workspace row the gate tests create starts with this prefix. */
export const PG_GATE_WS_PREFIX = 'pg-gate-';

/**
 * The gate connection URL (same server/credentials as `LORE_PG_URL`, database
 * swapped to the dedicated `lore_gate`), or null when `LORE_PG_URL` is unset —
 * the caller prints a skip reason and exits cleanly. NEVER log the return value.
 */
export function gateDbUrl(): string | null {
    const raw = process.env['LORE_PG_URL'];
    if (!raw || raw.trim() === '') return null;
    const u = new URL(raw);
    u.pathname = `/${PG_GATE_DB}`;
    return u.toString();
}

/**
 * createGatePool — ensure `lore_gate` exists on the container, then build the
 * gate pool over it. Returns null (after printing the skip reason) when
 * `LORE_PG_URL` is unset. The caller owns the pool: pair every non-null
 * return with `cleanupGateWorkspaces(pool)` + `closePostgresPool(pool)`.
 */
export async function createGatePool(label: string): Promise<Pool | null> {
    const url = gateDbUrl();
    if (!url) {
        console.log(`  SKIP ${label}: LORE_PG_URL is not set — postgres gate cases skipped cleanly `);
        return null;
    }
    // CREATE DATABASE cannot run inside a transaction: one short admin client
    // on the server's default `postgres` database decides, then closes.
    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
        const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [PG_GATE_DB]);
        if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${PG_GATE_DB}`);
    } finally {
        await admin.end();
    }
    console.log(`  pg   ${label}: ${redactPgUrl(url)} (dedicated db, workspace rows cleaned at end)`);
    return createPostgresPool({ url });
}

/**
 * cleanupGateWorkspaces — delete every row the gate tests created, keyed by
 * the `pg-gate-` workspace prefix, so a rerun (or the next gate file) starts
 * clean. The tables themselves are shared engine schema and stay.
 */
export async function cleanupGateWorkspaces(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        for (const table of ['nodes', 'edges', 'verbatim']) {
            // A gate file may run before any verbatim-bearing file created the
            // table in lore_gate; skip absent tables rather than fail cleanup.
            const present = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`]);
            if (!present.rows[0]?.ok) continue;
            await client.query(`DELETE FROM ${table} WHERE workspace_id LIKE $1`, [`${PG_GATE_WS_PREFIX}%`]);
        }
        // verbatim_changes_log is a per-DATABASE staging tail with no
        // workspace_id column (mirrors the sqlite sidecar): its gate rows are
        // exactly the ones whose verbatim row the deletes above removed.
        const logPresent = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['public.verbatim_changes_log']);
        const verbatimPresent = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['public.verbatim']);
        if (logPresent.rows[0]?.ok && verbatimPresent.rows[0]?.ok) {
            await client.query('DELETE FROM verbatim_changes_log WHERE row_rowid NOT IN (SELECT row_id FROM verbatim)');
        }
    } finally {
        client.release();
    }
}

/** Drain + close a gate pool (pass-through so tests name one ownership rule). */
export async function closeGatePool(pool: Pool): Promise<void> {
    await closePostgresPool(pool);
}

/**
 * stampGateManifest — write the embedding manifest the verbatim engine reads
 * at open (`<basePath>/.lore/lancedb/embedding_model.json`), the way
 * PostgresVerbatimStore's dimension sourcing expects. The gate tests use a
 * 4-dimension fixed embedder; the manifest (not the provider) is the
 * dimension source of truth, exactly as in production.
 */
export function stampGateManifest(basePath: string, modelId: string, dimension: number): void {
    const dir = path.join(basePath, '.lore', 'lancedb');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'embedding_model.json'),
        JSON.stringify({ modelId, dimension, writtenAt: new Date().toISOString(), version: 1 }, null, 2) + '\n',
    );
}
