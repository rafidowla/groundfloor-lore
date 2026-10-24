#!/usr/bin/env tsx
/**
 * test/measure-pg-edge-sizes.ts - before/after edge size for the Postgres edge layout 2 migration
 * (PK (workspace_id, src_sk, dst_sk, relation), no text endpoint columns), on a seeded sample in a throwaway database.
 *
 *   [EDGE_SIZE_KEEP=1] LORE_PG_URL=postgres://... npx tsx test/measure-pg-edge-sizes.ts [nodes=20000] [edgesPerNode=10]
 *
 * Creates database `lore_edge_size` on the server (dropped at the end; the database named by LORE_PG_URL is not
 * touched), seeds a LEGACY-shaped edges table (layout 1, text endpoints), measures it, runs the real in-place migration
 * (timed), measures with edges_pre_pk kept and after it is dropped, then times an offset page and a keyset page.
 * Sizes are bytes; "avg row" is avg(pg_column_size(t.*)).
 */
import { Client } from 'pg';

import { makeLegacyEdgesTable } from './helpers/legacyEdges.js';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';

const NODES = Number(process.argv[2] ?? 20_000);
const PER_NODE = Number(process.argv[3] ?? 10);
const DB = 'lore_edge_size';
const WS = 'sz-sample';

const raw = process.env['LORE_PG_URL'];
if (!raw) { console.log('SKIP: LORE_PG_URL is not set'); process.exit(0); }
const adminUrl = new URL(raw); adminUrl.pathname = '/postgres';
const dbUrl = new URL(raw); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}

await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool = createPostgresPool({ url: dbUrl.toString() });
const one = async <T>(sql: string, p: unknown[] = []): Promise<T> => ((await pool.query(sql, p)).rows[0]) as T;

try {
    // 1. schema (layout 2 + nodes.sk), then replace edges with the legacy text-keyed table
    const boot = new PostgresGraph(WS, pool); await boot.initialize(); await boot.close();
    await makeLegacyEdgesTable(pool);

    // 2. seed: UUID-shaped node ids (36 chars, like real Lore ids), 3 relations, random targets
    await pool.query(
        `INSERT INTO nodes (workspace_id, id, type, label, content) SELECT $1, 'lore:' || gen_random_uuid()::text, 'note', 'n' || g, 'c' FROM generate_series(1, $2) g`,
        [WS, NODES],
    );
    await pool.query(
        `INSERT INTO edges (workspace_id, source_id, target_id, relation, confidence, "confidenceScore")
         SELECT $1, s.id, t.id, (ARRAY['semantic_neighbor','depends_on','refers_to'])[1 + (s.rn + k) % 3], 'inferred', 0.9
         FROM (SELECT id, row_number() OVER () AS rn FROM nodes WHERE workspace_id = $1) s
         CROSS JOIN generate_series(1, $2) k
         JOIN (SELECT id, row_number() OVER () AS rn FROM nodes WHERE workspace_id = $1) t ON t.rn = 1 + ((s.rn * 7919 + k * 104729) % $3)
         ON CONFLICT DO NOTHING`,
        [WS, PER_NODE, NODES],
    );
    await pool.query('VACUUM (ANALYZE) nodes'); await pool.query('VACUUM (ANALYZE) edges');

    interface Sizes { rows: number; avgRowBytes: number; heap: number; indexes: number; total: number }
    const measure = async (table: string): Promise<Sizes> => {
        const r = await one<{ rows: string; avg: string; heap: string; idx: string; total: string }>(
            `SELECT count(*) AS rows, avg(pg_column_size(t.*)) AS avg, pg_relation_size('${table}') AS heap,
                    pg_indexes_size('${table}') AS idx, pg_total_relation_size('${table}') AS total FROM ${table} t`);
        return { rows: Number(r.rows), avgRowBytes: Math.round(Number(r.avg) * 10) / 10, heap: Number(r.heap), indexes: Number(r.idx), total: Number(r.total) };
    };
    const before = await measure('edges');

    // 3. the real in-place migration (bootstrap detects layout 1)
    const t0 = Date.now();
    const g = new PostgresGraph(WS, pool); await g.initialize();
    const migrateMs = Date.now() - t0;
    const preKept = await one<{ n: string }>(`SELECT pg_total_relation_size('edges_pre_pk') AS n`);
    const quarantined = await one<{ n: string }>('SELECT count(*) AS n FROM edges_dangling');
    await pool.query('VACUUM (ANALYZE) edges');
    const after = await measure('edges');
    await pool.query('DROP TABLE edges_pre_pk');         // what dropPrePkEdges does

    // 4. reads on the new key: offset page (text order, via join) vs keyset page (physical key)
    const timeIt = async (label: string, f: () => Promise<unknown>): Promise<void> => {
        await f(); const t = process.hrtime.bigint(); await f();
        console.log(`${label.padEnd(46)} ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms`);
    };
    const half = Math.floor(after.rows / 2);
    await timeIt('queryEdges offset 0, limit 100', () => g.queryEdges({ limit: 100, offset: 0 }));
    await timeIt(`queryEdges offset ${half}, limit 100`, () => g.queryEdges({ limit: 100, offset: half }));
    const first = await g.queryEdgesPage({ limit: 100 });
    await timeIt('queryEdgesPage first page, limit 100', () => g.queryEdgesPage({ limit: 100 }));
    await timeIt('queryEdgesPage 2nd page (cursor), limit 100', () => g.queryEdgesPage({ limit: 100, cursor: first.nextCursor ?? undefined }));
    await g.close();

    const mb = (b: number): string => (b / 1048576).toFixed(1) + ' MiB';
    const line = (label: string, s: Sizes): void => console.log(
        `${label.padEnd(34)} rows=${s.rows}  avg row=${String(s.avgRowBytes).padStart(6)} B  heap=${mb(s.heap).padStart(9)}  indexes=${mb(s.indexes).padStart(9)}  total=${mb(s.total).padStart(9)}  per row=${(s.total / s.rows).toFixed(0)} B`);
    console.log(`\nsample: ${NODES} nodes, ${before.rows} edges (id shape: 'lore:' + uuid), Postgres ${(await one<{ server_version: string }>('SHOW server_version')).server_version}`);
    line('edges BEFORE (layout 1, text keys)', before);
    line('edges AFTER (layout 2)', after);
    console.log(`edges_pre_pk (rollback copy, kept until dropPrePkEdges): ${mb(Number(preKept.n))}; quarantined: ${quarantined.n}`);
    console.log(`\nmigrated ${after.rows}/${before.rows} edges in ${migrateMs} ms (bootstrap incl. DDL)`);
    console.log(`delta: ${(((after.total - before.total) / before.total) * 100).toFixed(1)}%  (${(before.total / before.rows).toFixed(0)} -> ${(after.total / after.rows).toFixed(0)} bytes per edge)`);
} finally {
    await closePostgresPool(pool);
    if (process.env['EDGE_SIZE_KEEP'] !== '1') await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);   // EDGE_SIZE_KEEP=1 keeps it for EXPLAIN
}
