/**
 * pg-explain.mts — EXPLAIN (ANALYZE, BUFFERS) on the statements that dominate Lore's Postgres read/write path, run
 * against a database seeded by pg-seed-1m.mts. Statement SHAPES are copied from the product code (they are the same
 * SQL the engine issues; only the parameters are literal here so the planner sees real values).
 *
 *   LORE_PG_URL=postgres://.../lore_bench1m npx tsx scripts/bench/pg-explain.mts \
 *       --seed-info <seed-info.json> --out <file.txt> [--label before|after]
 *
 * Each statement runs twice (cold-ish then warm); the SECOND plan is recorded. Read-only (EXPLAIN ANALYZE of SELECTs).
 * The vector literal is a point from the corpus's own cluster model so HNSW traverses a realistic neighbourhood.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { argv, pgWorkspaceKey } from './pg-bench-common.mts';
import { clusterCenters, queryVector, vecText } from './pg-corpus.mts';

const seedInfo = JSON.parse(readFileSync(argv('seed-info')!, 'utf8'));
const out = argv('out')!;
const label = argv('label', 'run')!;
// workspace_id holds the permanent workspace id since 3.37.0, not the name.
const ws: string = seedInfo.wsKey ?? await pgWorkspaceKey(seedInfo.home, seedInfo.ws);
const params = seedInfo.params;
const url = process.env.LORE_PG_URL;
if (!url) throw new Error('LORE_PG_URL required');
const dbName = seedInfo.database as string | undefined;
const pool = new pg.Pool({ connectionString: dbName ? url.replace(/\/[^/]*$/, `/${dbName}`) : url, max: 2 });

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const vec = vecText(queryVector(params, clusterCenters(params), 'the mid query'));
const qs = (words: string[]) => words.map((w) => `phraseto_tsquery('simple', ${lit(w)})`).join(' || ');

interface Stmt { name: string; sql: string }

async function main(): Promise<void> {
    // Pick real terms: the most common word, a mid-frequency one and a rare one from the stored text.
    const common = (await pool.query(`SELECT word FROM ts_stat($$SELECT text_tsv FROM verbatim WHERE workspace_id = ${lit(ws)} LIMIT 50000$$) ORDER BY ndoc DESC OFFSET 30 LIMIT 1`)).rows[0]?.word as string;
    const mid = (await pool.query(`SELECT word FROM ts_stat($$SELECT text_tsv FROM verbatim WHERE workspace_id = ${lit(ws)} LIMIT 50000$$) ORDER BY ndoc DESC OFFSET 600 LIMIT 1`)).rows[0]?.word as string;
    const a = (await pool.query(`SELECT sk FROM nodes WHERE workspace_id = ${lit(ws)} ORDER BY sk LIMIT 1 OFFSET 12345`)).rows[0]?.sk as string;
    const stmts: Stmt[] = [
        { name: `graph keyword leg, mid term "${mid}" (nodes, LIMIT 2000)`, sql: `SELECT * FROM nodes WHERE workspace_id = ${lit(ws)} AND ((nodes.tags::jsonb @> ${lit(JSON.stringify([`tag-${mid}`]))}::jsonb) OR lower(label) LIKE ${lit(`%${mid}%`)} OR lower(content) LIKE ${lit(`%${mid}%`)}) ORDER BY "updatedAt" DESC, id ASC LIMIT 2000` },
        { name: `verbatim BM25 ts_rank, common term "${common}" (1 token)`, sql: `SELECT v.id, v.text, v.type, v.label, v.tags, v.project, v.ecosystem, v."updatedAt", v.security_scopes, ts_rank(v.text_tsv, q.query) AS raw_score FROM verbatim v, (SELECT ${qs([common])} AS query) q WHERE v.workspace_id = ${lit(ws)} AND v.is_canonical = 1 AND v.is_tombstone = 0 AND v.text_tsv @@ q.query ORDER BY raw_score DESC, v.id ASC LIMIT 40` },
        { name: `verbatim BM25 ts_rank, mid term "${mid}" (1 token)`, sql: `SELECT v.id, v.text, v.type, v.label, v.tags, v.project, v.ecosystem, v."updatedAt", v.security_scopes, ts_rank(v.text_tsv, q.query) AS raw_score FROM verbatim v, (SELECT ${qs([mid])} AS query) q WHERE v.workspace_id = ${lit(ws)} AND v.is_canonical = 1 AND v.is_tombstone = 0 AND v.text_tsv @@ q.query ORDER BY raw_score DESC, v.id ASC LIMIT 40` },
        { name: `verbatim BM25 ts_rank, 2 tokens "${common} ${mid}"`, sql: `SELECT v.id, v.text, v.type, v.label, v.tags, v.project, v.ecosystem, v."updatedAt", v.security_scopes, ts_rank(v.text_tsv, q.query) AS raw_score FROM verbatim v, (SELECT ${qs([common, mid])} AS query) q WHERE v.workspace_id = ${lit(ws)} AND v.is_canonical = 1 AND v.is_tombstone = 0 AND v.text_tsv @@ q.query ORDER BY raw_score DESC, v.id ASC LIMIT 40` },
        { name: 'verbatim vector kNN (HNSW, top 20, canonical+non-tombstone filter)', sql: `SELECT id, text, type, label, tags, project, ecosystem, "updatedAt", security_scopes, 1 - (vector <=> ${lit(vec)}::vector) AS score FROM verbatim WHERE workspace_id = ${lit(ws)} AND is_canonical = 1 AND is_tombstone = 0 ORDER BY vector <=> ${lit(vec)}::vector LIMIT 20` },
        { name: 'verbatim count(*) (the cached count)', sql: `SELECT count(*) AS c FROM verbatim WHERE workspace_id = ${lit(ws)}` },
        { name: 'traverse edge fetch (src side)', sql: `SELECT f.id AS from_id, t.id AS to_id, e.relation FROM nodes f JOIN edges e ON e.src_sk = f.sk JOIN nodes t ON t.sk = e.dst_sk AND t.workspace_id = e.workspace_id WHERE f.workspace_id = ${lit(ws)} AND e.workspace_id = ${lit(ws)} AND f.sk = ${a}` },
    ];
    const lines: string[] = [`# EXPLAIN (ANALYZE, BUFFERS) — ${label} — ws ${ws} — ${new Date().toISOString()}`, ''];
    await pool.query(`SET max_parallel_workers_per_gather = 2`);
    for (const s of stmts) {
        let plan = '';
        for (let pass = 0; pass < 2; pass++) {
            const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${s.sql}`);
            plan = r.rows.map((x) => x['QUERY PLAN']).join('\n');
        }
        lines.push(`## ${s.name}`, '```', plan, '```', '');
        console.log(`[explain] ${s.name}: ${(plan.match(/Execution Time: ([\d.]+) ms/) ?? [])[1]} ms`);
    }
    writeFileSync(out, lines.join('\n'));
    await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
