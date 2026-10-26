#!/usr/bin/env tsx
/**
 * pg-keyword-explain.mts - BENCH ONLY (not shipped). EXPLAIN (ANALYZE, BUFFERS) of the graph keyword statement, original
 * recency-ordered form vs the MATERIALIZED-CTE form, for one term, on a database seeded by pg-seed-1m.mts.
 *
 *   LORE_PG_URL=postgres://.../lore_bench npx tsx scripts/bench/pg-keyword-explain.mts --seed-info <seed-info.json> --word must [--cap 2000]
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { argv } from './pg-bench-common.mts';
import { PgParams } from '../../packages/lore/src/engines/postgres/postgresGraphRow.js';
import { keywordMatchClause } from '../../packages/lore/src/engines/postgres/postgresKeywordMatch.js';
import { candidateCteSql, orderedWalkSql, probeKeywordPlan } from '../../packages/lore/src/engines/postgres/postgresKeywordPlan.js';
import { keywordSearchTerms } from '../../packages/lore/src/engines/searchRanking.js';

const seedInfo = JSON.parse(readFileSync(argv('seed-info')!, 'utf8'));
const cap = Number(argv('cap', '2000'));
const word = argv('word')!;
const url = process.env.LORE_PG_URL;
if (!url) throw new Error('LORE_PG_URL required');
const pool = new pg.Pool({ connectionString: seedInfo.database ? url.replace(/\/[^/]*$/, `/${seedInfo.database}`) : url, max: 1 });
const params = new PgParams();
params.add(seedInfo.ws);
const where = keywordMatchClause(params, keywordSearchTerms(word), word.toLowerCase());
const decision = await probeKeywordPlan(pool, seedInfo.ws, where, params.values, cap);
const lim = params.add(cap);
console.log(`# term=${word} cap=${cap} decision=${JSON.stringify(decision)}`);
for (const [label, sql] of [['BEFORE (original statement)', orderedWalkSql(where, lim)], ['AFTER (MATERIALIZED CTE)', candidateCteSql(where, lim)]] as const) {
    await pool.query(sql, params.values); // warm
    const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`, params.values);
    console.log(`\n## ${label}\n${r.rows.map((x) => x['QUERY PLAN']).join('\n')}`);
}
await pool.end();
