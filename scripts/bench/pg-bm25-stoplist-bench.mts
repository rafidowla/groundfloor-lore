#!/usr/bin/env tsx
/**
 * pg-bm25-stoplist-bench.mts - BENCH ONLY (not shipped). Before/after for the Postgres BM25 common-token stop-list.
 *
 *   LORE_PG_URL=... npx tsx scripts/bench/pg-bm25-stoplist-bench.mts --seed-info <dir>/seed-info.json [--iters 15] [--rounds 2]
 *
 * Opens the seeded workspace's PostgresVerbatimStore directly (fake embedder, no model) and times bm25Search for a
 * common-only, an all-common, a mixed (common + mid-frequency) and a rare-only query. Alternates
 * LORE_BM25_COMMON_TOKEN_RATIO=0 (before = pre-feature behaviour) and the default 0.2 (after) back to back
 * (b, a, b, a ...) and records the load average next to each run. Also times the stop-list build itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { argv, makeFakeEmbedder, pct, pgWorkspaceKey, now } from './pg-bench-common.mts';

process.env.LORE_CACHE_DISABLED = '1'; // measure the query, not the read cache
const url = process.env['LORE_PG_URL'];
if (!url) { console.error('LORE_PG_URL is required'); process.exit(2); }
const info = JSON.parse(fs.readFileSync(argv('seed-info')!, 'utf8')) as { home: string; wsPath: string; ws: string; wsKey?: string; dim?: number; n: number };
// The store and the raw SQL both take the Postgres key (the permanent workspace id since 3.37.0), not the name.
const wsKey = info.wsKey ?? await pgWorkspaceKey(info.home, info.ws);
const iters = Number(argv('iters', '15'));
const rounds = Number(argv('rounds', '2'));
const { PostgresVerbatimStore } = await import('../../packages/lore/src/engines/postgres/postgresVerbatimStore.js');
const pool = new pg.Pool({ connectionString: url, max: 8 });
const store = new PostgresVerbatimStore(path.join(info.wsPath, '.lore'), pool, wsKey, makeFakeEmbedder(384) as never);
await store.initialize();

// Pick real tokens by document frequency from the seeded corpus.
const st = await pool.query<{ word: string; ndoc: string }>(
    `SELECT word, ndoc FROM ts_stat($$SELECT text_tsv FROM verbatim TABLESAMPLE SYSTEM (30) WHERE workspace_id = '${wsKey.replace(/'/g, "''")}'$$) ORDER BY ndoc DESC`);
const total = Number((await pool.query(`SELECT count(*) c FROM verbatim WHERE workspace_id=$1`, [wsKey])).rows[0].c);
const nearRatio = (r: number) => st.rows.filter((x) => /^[a-z]{3,}$/.test(x.word)).reduce((b, x) => Math.abs(Number(x.ndoc) / (0.3 * total) - r) < Math.abs(Number(b.ndoc) / (0.3 * total) - r) ? x : b).word;
const mid = nearRatio(0.01), rare = nearRatio(0.001);
const queries: Record<string, string> = { 'common-only': 'the', 'all-common': 'the of', 'mixed': `the ${mid}`, 'mixed-2': `of and ${mid}`, 'rare-only': `${mid} ${rare}` };

const timeQuery = async (q: string): Promise<{ p50: number; hits: number }> => {
    await store.bm25Search(q, 40);
    const xs: number[] = [];
    let hits = 0;
    for (let i = 0; i < iters; i++) { const t = now(); const r = await store.bm25Search(q, 40); xs.push(now() - t); hits = r.hits.length; }
    return { p50: pct(xs, 50), hits };
};

const build = now();
await store.refreshBm25StopList({ force: true });
const buildMs = now() - build;
console.log(`stop-list build at ${total} rows: ${buildMs.toFixed(0)} ms; common lexemes: ${store.bm25CommonLexemes().length} [${store.bm25CommonLexemes().slice(0, 8).join(',')}...]`);
console.log(`tokens: mid="${mid}" rare="${rare}"`);

const out: Array<Record<string, unknown>> = [];
for (let r = 0; r < rounds; r++) {
    for (const [label, ratio] of [['before', '0'], ['after', '0.2']] as const) {
        process.env.LORE_BM25_COMMON_TOKEN_RATIO = ratio;
        const load = os.loadavg()[0]!.toFixed(1);
        const row: Record<string, unknown> = { round: r + 1, variant: label, load1: load };
        for (const [name, q] of Object.entries(queries)) { const m = await timeQuery(q); row[name] = `${m.p50.toFixed(1)}ms/${m.hits}h`; }
        out.push(row);
        console.log(JSON.stringify(row));
    }
}
await store.close();
await pool.end();
