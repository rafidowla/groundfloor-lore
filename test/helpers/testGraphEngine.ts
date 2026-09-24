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
 * class to instantiate.
 *
 * Return type is the UNION `SurrealGraph | SqliteGraph`, not the narrower
 * `LoreGraphHandle` — the contract suites exercise members beyond that
 * interface (`getStats`, `getTopology`, `lintGraph`, `archiveNode`,
 * `traverseDirected`, the cache-admin trio, …). `SqliteGraph` implements
 * EVERY public member `SurrealGraph` has (mechanically checked by
 * `test/graph-engine-parity-unit.ts`'s prototype-subset assertion), so any
 * member accessible on the union is accessible on both concrete engines —
 * a test body written against this factory's return type cannot
 * accidentally call something only one engine has.
 */

import { SurrealGraph, type SurrealGraphOptions } from '../../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph, type SqliteGraphOptions } from '../../packages/lore/src/engines/sqliteGraph.js';

export type TestGraphEngineName = 'surreal' | 'sqlite';

/** Which engine `createTestGraphEngine` builds — reads `LORE_TEST_GRAPH_ENGINE`, default `'surreal'`. */
export function testGraphEngineName(): TestGraphEngineName {
    const raw = process.env['LORE_TEST_GRAPH_ENGINE'];
    return raw === 'sqlite' ? 'sqlite' : 'surreal';
}

export interface TestGraphOptions {
    workspaceId?: string;
    cacheMaxSize?: number;
    cacheTtlMs?: number;
    cacheDisabled?: boolean;
}

/**
 * createTestGraphEngine — build a graph handle on whichever engine
 * `LORE_TEST_GRAPH_ENGINE` selects, sharing the SAME test fixture / op
 * sequence across both.
 */
export function createTestGraphEngine(
    basePath: string,
    opts: TestGraphOptions = {},
): SurrealGraph | SqliteGraph {
    const engine = testGraphEngineName();
    if (engine === 'sqlite') {
        return new SqliteGraph(basePath, opts as SqliteGraphOptions);
    }
    return new SurrealGraph(basePath, opts as SurrealGraphOptions);
}
