/**
 * test/helpers/testGraphEngine.ts — LORE_TEST_GRAPH_ENGINE factory.
 *
 * The five Surreal contract suites (surreal-graph-contract, parity-graph,
 * temporal-valid-time, surreal-edge-pagination, surreal-backup-roundtrip)
 * are parameterized over this env var (3.21 step 1b): `surreal` (default,
 * so the existing `npm test` chain's behaviour is unchanged) or `sqlite`.
 * Each suite constructs its graph handle through `createTestGraphEngine`
 * instead of `new SurrealGraph(...)` directly, so the SAME test body
 * exercises either engine.
 *
 * `SurrealGraph` and `SqliteGraph` share a compatible constructor shape —
 * `(basePath: string, opts?: { workspaceId?; cacheMaxSize?; cacheTtlMs?;
 * cacheDisabled? })` — by design (see each class's `*GraphOptions`
 * interface), so this factory needs no per-engine branching beyond which
 * class to instantiate. `PostgresGraph` does NOT share that shape (its
 * identity is the workspace id + pool, not a base path), so the postgres
 * branch maps `basePath`'s role onto a shared gate pool. It skips NOTHING
 * here by design: selecting `postgres` without `LORE_PG_URL` is a LOUD
 * construction error — the clean skip lives with the caller (the
 * gate prints the reason and exits 0 before constructing anything).
 *
 * Return type is the UNION `SurrealGraph | SqliteGraph | PostgresGraph`, not
 * the narrower `LoreGraphHandle` — the contract suites exercise members
 * beyond that interface (`getStats`, `getTopology`, `lintGraph`,
 * `archiveNode`, `traverseDirected`, the cache-admin trio, …).
 * `SqliteGraph` implements EVERY public member `SurrealGraph` has
 * (mechanically checked by `test/graph-engine-parity-unit.ts`'s
 * prototype-subset assertion) and `PostgresGraph` is a method-by-method port
 * of `SqliteGraph`, so any member accessible on the union is accessible on
 * all concrete engines — a test body written against this factory's return
 * type cannot accidentally call something only one engine has.
 */

import { SurrealGraph, type SurrealGraphOptions } from '../../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph, type SqliteGraphOptions } from '../../packages/lore/src/engines/sqliteGraph.js';
import { PostgresGraph, type PostgresGraphOptions } from '../../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../../packages/lore/src/engines/postgres/postgresClient.js';
import type { Pool } from 'pg';
import { cleanupGateWorkspaces, gateDbUrl } from './testPostgres.js';

export type TestGraphEngineName = 'surreal' | 'sqlite' | 'postgres';

/** Which engine `createTestGraphEngine` builds — reads `LORE_TEST_GRAPH_ENGINE`, default `'surreal'`. */
export function testGraphEngineName(): TestGraphEngineName {
    const raw = process.env['LORE_TEST_GRAPH_ENGINE'];
    return raw === 'sqlite' ? 'sqlite' : raw === 'postgres' ? 'postgres' : 'surreal';
}

export interface TestGraphOptions {
    workspaceId?: string;
    cacheMaxSize?: number;
    cacheTtlMs?: number;
    cacheDisabled?: boolean;
}

/** The gate process owns ONE shared postgres pool (constructed lazily). */
let postgresTestPool: Pool | null = null;

/**
 * createTestGraphEngine — build a graph handle on whichever engine
 * `LORE_TEST_GRAPH_ENGINE` selects, sharing the SAME test fixture / op
 * sequence across engines.
 */
export function createTestGraphEngine(
    basePath: string,
    opts: TestGraphOptions = {},
): SurrealGraph | SqliteGraph | PostgresGraph {
    const engine = testGraphEngineName();
    if (engine === 'sqlite') {
        return new SqliteGraph(basePath, opts as SqliteGraphOptions);
    }
    if (engine === 'postgres') {
        const url = gateDbUrl();
        if (!url) {
            throw new Error(
                'createTestGraphEngine: LORE_TEST_GRAPH_ENGINE=postgres requires LORE_PG_URL — '
                + 'callers that must skip cleanly check gateDbUrl() BEFORE constructing',
            );
        }
        if (!postgresTestPool) postgresTestPool = createPostgresPool({ url });
        const pgOpts: PostgresGraphOptions = {
            cacheMaxSize: opts.cacheMaxSize,
            cacheTtlMs: opts.cacheTtlMs,
            cacheDisabled: opts.cacheDisabled,
        };
        return new PostgresGraph(opts.workspaceId ?? 'parity', postgresTestPool, pgOpts);
    }
    return new SurrealGraph(basePath, opts as SurrealGraphOptions);
}

/**
 * disposeTestGraphEngine — postgres teardown for the factory's own resources:
 * deletes every `pg-gate-` workspace row the suite wrote and drains the
 * shared pool. A no-op unless the postgres branch ran. Call it in the suite's
 * finally block; other engines close their own handles.
 */
export async function disposeTestGraphEngine(): Promise<void> {
    if (!postgresTestPool) return;
    const pool = postgresTestPool;
    postgresTestPool = null;
    await cleanupGateWorkspaces(pool);
    await closePostgresPool(pool);
}
