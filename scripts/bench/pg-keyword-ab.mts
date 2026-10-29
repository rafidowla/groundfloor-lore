#!/usr/bin/env tsx
/**
 * pg-keyword-ab.mts - BENCH ONLY (not shipped). Statement-level A/B of the graph keyword leg on a database seeded by
 * pg-seed-1m.mts: the original recency-ordered statement, the unconditional MATERIALIZED-CTE form, and what the
 * engine actually does (probe + choose). Same match clause the engine builds (keywordMatchClause).
 *
 *   LORE_PG_URL=postgres://.../lore_bench npx tsx scripts/bench/pg-keyword-ab.mts --seed-info <seed-info.json> \
 *       [--cap 2000] [--reps 7] [--words a,b,c]
 *
 * Terms: with no --words, picks real words from the stored text at a spread of document frequencies (rare .. very common).
 * Each (term, variant) is run --reps times, variants interleaved per rep (old, cte, adaptive, old, ...), p50 reported
 * together with the match count, the planner's estimate and the plan the engine chose. Prints `uptime` load first.
 * Also asserts the three variants return the same id sequence.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { argv, pgWorkspaceKey } from './pg-bench-common.mts';
import { PgParams } from '../../packages/lore/src/engines/postgres/postgresGraphRow.js';
import { keywordMatchClause } from '../../packages/lore/src/engines/postgres/postgresKeywordMatch.js';
import { candidateCteSql, orderedWalkSql, probeKeywordPlan } from '../../packages/lore/src/engines/postgres/postgresKeywordPlan.js';
import { keywordSearchTerms } from '../../packages/lore/src/engines/searchRanking.js';

const seedInfo = JSON.parse(readFileSync(argv('seed-info')!, 'utf8'));
// workspace_id holds the permanent workspace id since 3.37.0, not the name.
const ws: string = seedInfo.wsKey ?? await pgWorkspaceKey(seedInfo.home, seedInfo.ws);
const cap = Number(argv('cap', '2000'));
const reps = Number(argv('reps', '7'));
const url = process.env.LORE_PG_URL;
if (!url) throw new Error('LORE_PG_URL required');
const pool = new pg.Pool({ connectionString: seedInfo.database ? url.replace(/\/[^/]*$/, `/${seedInfo.database}`) : url, max: 2 });
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function pickWords(): Promise<string[]> {
    const rows = (await pool.query(
        `SELECT word, ndoc FROM ts_stat($$SELECT to_tsvector('simple', label || ' ' || content) FROM nodes WHERE workspace_id = '${ws}'$$)
         WHERE length(word) >= 3 AND word ~ '^[a-z]+$' ORDER BY ndoc DESC`)).rows as { word: string; ndoc: number }[];
    const total = Number((await pool.query('SELECT count(*) c FROM nodes WHERE workspace_id = $1', [ws])).rows[0].c);
    // target document frequencies as a share of the table
    const shares = [0.0001, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2, 0.4, 0.8];
    const out: string[] = [];
    for (const s of shares) {
        const hit = rows.reduce((best, r) => (Math.abs(r.ndoc / total - s) < Math.abs(best.ndoc / total - s) ? r : best), rows[0]!);
        if (!out.includes(hit.word)) out.push(hit.word);
    }
    return out;
}

const words = argv('words') ? argv('words')!.split(',') : await pickWords();
console.log(`# uptime: ${execSync('uptime').toString().trim()}`);
console.log(`# ws=${ws} cap=${cap} reps=${reps}`);
console.log('term | matches | planner walks | est M | cand est | est N | engine plan | old p50 ms | cte p50 ms | engine p50 ms | same ids');
for (const w of words) {
    const params = new PgParams();
    params.add(ws);
    const where = keywordMatchClause(params, keywordSearchTerms(w), w.toLowerCase());
    const decision = await probeKeywordPlan(pool, ws, where, params.values, cap, keywordSearchTerms(w));
    const lim = params.add(cap);
    const oldSql = orderedWalkSql(where, lim), cteSql = candidateCteSql(where, lim);
    const engSql = decision.plan === 'cte' ? cteSql : oldSql;
    const times: Record<string, number[]> = { old: [], cte: [], eng: [] };
    const ids: Record<string, string> = {};
    const run = async (k: string, sql: string) => {
        const t0 = performance.now();
        const r = await pool.query(sql, params.values);
        times[k]!.push(performance.now() - t0);
        ids[k] = r.rows.map((x: any) => x.id).join(',');
    };
    await run('old', oldSql); await run('cte', cteSql); times.old = []; times.cte = []; times.eng = [];
    for (let i = 0; i < reps; i++) { await run('old', oldSql); await run('cte', cteSql); await run('eng', engSql); }
    const m = Number((await pool.query(`SELECT count(*) c FROM nodes WHERE workspace_id = $1 AND ${where}`, params.values.slice(0, params.values.length - 1))).rows[0].c);
    const same = ids.old === ids.cte && ids.old === ids.eng;
    console.log(`${w} | ${m} | ${decision.walks} | ${decision.estMatches} | ${decision.estCandidates ?? '-'} | ${decision.estRows} | ${decision.plan} | ${p50(times.old!).toFixed(1)} | ${p50(times.cte!).toFixed(1)} | ${p50(times.eng!).toFixed(1)} | ${same}`);
}
await pool.end();
