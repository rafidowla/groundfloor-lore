#!/usr/bin/env tsx
/**
 * test/pg-keyword-candidate-unit.ts - the candidate-volume probe and the trigram statistics target on REAL Postgres.
 *
 *   corpus   60k rows. Every row contains `linen`, `business` and `best` (so every row holds the 3-grams lin / ine / nes / est but
 *            never the word `linest`); 3% also contain the word `linest`; ~1.5% contain the rare token `zqclean`.
 *   stats    ensureKeywordIndexes lifts both trigram indexes to statistics target 1000 and is idempotent (no change, no ANALYZE,
 *            no throw on the second call)
 *   probe    `linest` (M = 3% of N, inside the M / N window) WALKS because its candidates are ~N; `zqclean` (M = 1.5%) takes the
 *            CTE; both decisions are identical across three consecutive ANALYZEs. The walk / M / N probes are canned to the TRUE
 *            counts (planner M estimates on a 60k table move between ANALYZEs); the candidate probe and the CTE's own EXPLAIN
 *            are real Postgres output.
 *   graph    PostgresGraph.search() passes the query terms to the planner: the candidate probe statement is issued and its
 *            estimate appears on the decision; LORE_PG_KEYWORD_CTE=0 issues no probe at all
 *
 * Skips (printed reason, exit 0) when LORE_PG_URL is unset. Run: npx tsx test/pg-keyword-candidate-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { PgParams } from '../packages/lore/src/engines/postgres/postgresGraphRow.js';
import { searchWhere } from '../packages/lore/src/engines/postgres/postgresGraphReads.js';
import { KEYWORD_STATISTICS_TARGET, applyKeywordIndexStatistics, ensureKeywordIndexes } from '../packages/lore/src/engines/postgres/postgresKeywordIndex.js';
import {
    CTE_BREAK_EVEN, candidateProbeSql, decideKeywordPlan, probeKeywordPlan, setKeywordPlanObserver, type KeywordPlanDecision,
} from '../packages/lore/src/engines/postgres/postgresKeywordPlan.js';
import { keywordSearchTerms } from '../packages/lore/src/engines/searchRanking.js';
import { gateDbUrl } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-keyword-candidate: LORE_PG_URL is not set - postgres cases skipped cleanly');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(0);
}

const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const urlFor = (db: string): string => { const u = new URL(gate); u.pathname = `/${db}`; return u.toString(); };
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
const DB = 'lore_gate_kwcand';
const WS = 'pg-gate-kwcand';
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);

const N = 60_000, CAP = 1200; // T = sqrt(K * CAP * N) = 3000: linest (M = 1818) and zqclean (M = ~900) are inside (CAP/2 = 600, T]
const pool: Pool = createPostgresPool({ url: urlFor(DB) });
const env = process.env as Record<string, string | undefined>;
const savedSwitch = env['LORE_PG_KEYWORD_CTE'];
try {
    const graph = new PostgresGraph(WS, pool);
    await graph.initialize();
    await graph.waitForKeywordIndexes();
    await pool.query(`
        INSERT INTO nodes (workspace_id, id, type, label, content, tags, project, ecosystem, metadata, "createdAt", "updatedAt", status, supersededat)
        SELECT $1, 'n' || substr(md5(i::text), 1, 12), 'note', 'label ' || i,
               'body ' || i || ' linen business best ' || md5(i::text) || ' ' || md5((i + 7)::text)
                 || CASE WHEN i % 33 = 0 THEN ' linest' ELSE '' END || CASE WHEN i % 67 = 0 THEN ' zqclean' ELSE '' END,
               '[]', 'p', '*', '{}', '2026-01-01T00:00:00.000Z',
               to_char(timestamp '2026-01-01' + ((i / 40)::int) * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'), 'active', ''
        FROM generate_series(0, $2::int - 1) AS i`, [WS, N]);
    await pool.query('ANALYZE nodes');
    const count = async (term: string): Promise<number> =>
        Number((await pool.query('SELECT count(*) AS n FROM nodes WHERE workspace_id = $1 AND lower(content) LIKE $2', [WS, `%${term}%`])).rows[0].n);
    const M_LINEST = await count('linest'), M_CLEAN = await count('zqclean');
    const trigramsEverywhere = Number((await pool.query(
        `SELECT count(*) AS n FROM nodes WHERE workspace_id = $1 AND lower(content) LIKE '%lin%' AND lower(content) LIKE '%ine%' AND lower(content) LIKE '%nes%' AND lower(content) LIKE '%est%'`, [WS])).rows[0].n);

    // Legacy trigram indexes (expression in column 1) then the workspace-led ones (expression in column 2).
    const statTargets = async (): Promise<Array<number | null>> =>
        (await pool.query(`SELECT a.attstattarget AS t FROM pg_attribute a
            WHERE (a.attrelid IN ('idx_nodes_content_trgm'::regclass, 'idx_nodes_label_trgm'::regclass) AND a.attnum = 1)
               OR (a.attrelid IN ('idx_nodes_ws_content_trgm'::regclass, 'idx_nodes_ws_label_trgm'::regclass) AND a.attnum = 2)
            ORDER BY a.attnum, a.attrelid::regclass::text`)).rows.map((r) => r.t as number | null);

    console.log('\ncorpus');
    await test('corpus shape: every row has the 4 trigrams of linest, 3% have the word, ~1.5% the clean token', () => {
        assert.equal(trigramsEverywhere, N);
        assert.ok(M_LINEST > CAP / 2 && M_LINEST < 3000, `linest matches ${M_LINEST}`);
        assert.ok(M_CLEAN > CAP / 2 && M_CLEAN < 3000, `zqclean matches ${M_CLEAN}`);
        assert.ok(M_LINEST * M_LINEST <= CTE_BREAK_EVEN * CAP * N, 'precondition: linest passes the M / N rule alone, so only the candidate probe can stop it');
        assert.equal(decideKeywordPlan(M_LINEST, N, CAP), 'cte');
    });

    console.log('\nstats');
    await test('both trigram indexes sit at statistics target 1000 after initialize(); ensureKeywordIndexes is idempotent and never throws', async () => {
        assert.deepEqual(await statTargets(), Array(4).fill(KEYWORD_STATISTICS_TARGET));
        const client = await pool.connect();
        try {
            const warns: string[] = [];
            const realWarn = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
            try {
                const r1 = await ensureKeywordIndexes(client);
                const r2 = await ensureKeywordIndexes(client);
                assert.deepEqual([r1.built, r1.pending, r1.analyzePending], [[], false, undefined]);
                assert.deepEqual([r2.built, r2.pending, r2.analyzePending], [[], false, undefined]);
                assert.equal(await applyKeywordIndexStatistics(client), false, 'already at target: nothing changed');
                // an index reset to the default target is lifted again, and a table this small is ANALYZEd inline
                await client.query('ALTER INDEX idx_nodes_content_trgm ALTER COLUMN 1 SET STATISTICS -1');
                assert.equal(await applyKeywordIndexStatistics(client), true);
                assert.deepEqual(await statTargets(), Array(4).fill(KEYWORD_STATISTICS_TARGET));
                await client.query('ALTER INDEX idx_nodes_label_trgm ALTER COLUMN 1 SET STATISTICS 100');
                const r3 = await ensureKeywordIndexes(client, { inlineRowLimit: 100_000 });
                assert.deepEqual([r3.pending, r3.analyzePending], [false, undefined], 'under the inline limit: ANALYZE ran inline, nothing left pending');
                assert.deepEqual(await statTargets(), Array(4).fill(KEYWORD_STATISTICS_TARGET));
                // over the inline limit (60k rows > 50k default) the lift is applied but the ANALYZE is handed to the background build
                await client.query('ALTER INDEX idx_nodes_label_trgm ALTER COLUMN 1 SET STATISTICS 100');
                const r4 = await ensureKeywordIndexes(client);
                assert.deepEqual([r4.pending, r4.analyzePending], [false, true], 'large table: analyzePending, no inline ANALYZE');
                assert.deepEqual(await statTargets(), Array(4).fill(KEYWORD_STATISTICS_TARGET));
                await client.query('ANALYZE nodes');
            } finally { console.warn = realWarn; }
            assert.deepEqual(warns, [], 'no warning on the happy path');
        } finally { client.release(); }
    });
    await test('applyKeywordIndexStatistics never throws: a client whose ALTER fails only logs', async () => {
        const warns: string[] = [];
        const realWarn = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
        try {
            const failing = { query: async (sql: string) => { if (/^ALTER INDEX/.test(sql)) throw new Error('permission denied'); return { rows: [{ t: -1 }] }; } };
            assert.equal(await applyKeywordIndexStatistics(failing as never), false);
        } finally { console.warn = realWarn; }
        assert.equal(warns.length, 4); // the four trigram indexes: two legacy, two workspace-led
        assert.ok(warns.every((w) => /permission denied/.test(w)));
    });

    console.log('\nprobe');
    const build = (query: string) => { const params = new PgParams(); params.add(WS); const where = searchWhere(params, query, {}); return { params, where }; };
    const withPlanner = (settings: string[]): Pick<Pool, 'query'> => ({
        query: (async (sql: string, values?: unknown[]) => {
            const c = await pool.connect();
            try {
                await c.query('BEGIN');
                for (const s of settings) await c.query(`SET LOCAL ${s}`);
                const r = await c.query(sql, values);
                await c.query('ROLLBACK');
                return r;
            } finally { c.release(); }
        }) as never,
    });
    const walkPlan = [{ 'QUERY PLAN': [{ Plan: { Plans: [{ 'Index Name': 'idx_nodes_updatedat' }] } }] }];
    const rowsOf = (v: number) => [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': v } }] }];
    /** walk / M / N canned to the true counts; the candidate probe and the CTE statement's EXPLAIN are real Postgres. */
    const hybrid = (trueM: number, settings: string[]): Pick<Pool, 'query'> => {
        const real = withPlanner(settings);
        return {
            query: (async (sql: string, values?: unknown[]) => {
                if (/^EXPLAIN \(FORMAT JSON\) WITH m AS MATERIALIZED/.test(sql)) return real.query(sql, values);
                if (/^EXPLAIN \(FORMAT JSON\) SELECT 1 FROM nodes WHERE workspace_id = \$1 AND \(\(lower\(label\) LIKE/.test(sql)) return real.query(sql, values);
                if (/SELECT 1 FROM nodes WHERE workspace_id = \$1 AND/.test(sql)) return { rows: rowsOf(trueM) };
                if (/SELECT 1 FROM nodes WHERE workspace_id = \$1$/.test(sql)) return { rows: rowsOf(N) };
                return { rows: walkPlan };
            }) as never,
        };
    };
    // seq scans off pins the CTE statement to an index plan (see the guard test: tiny tables otherwise prefer a Seq Scan),
    // SSD page costs keep the GIN BitmapOr ahead of the workspace btree bitmap at statistics target 1000
    const GIN = ['enable_seqscan = off', 'random_page_cost = 1.1'];

    const decide = async (term: string, trueM: number) => {
        const { params, where } = build(term);
        return probeKeywordPlan(hybrid(trueM, GIN), WS, where, params.values, CAP, keywordSearchTerms(term));
    };
    await test('the real candidate probe answers with a row estimate for both terms (and is planning-only)', async () => {
        for (const term of ['linest', 'zqclean']) {
            const p = candidateProbeSql(WS, term)!;
            const rows = (await pool.query(p.sql, p.values)).rows;
            const planRows = (rows[0]['QUERY PLAN'] as Array<{ Plan: { 'Plan Rows': number } }>)[0]!.Plan['Plan Rows'];
            assert.ok(Number.isFinite(planRows) && planRows > 0, `${term}: ${planRows}`);
        }
    });
    await test('linest (3%, all four trigrams in every row) WALKS: candidates ~N, far above the M / N window it otherwise passes', async () => {
        const d = await decide('linest', M_LINEST);
        assert.equal(d.plan, 'ordered-walk', JSON.stringify(d));
        assert.ok(d.estCandidates !== undefined && d.estCandidates !== null && d.estCandidates > N / 4, `estCandidates ${d.estCandidates}: ${JSON.stringify(d)}`);
        assert.equal(d.ctePlanOk, undefined, 'stopped before the CTE statement was explained');
    });
    await test('zqclean (~1.5%, rare trigrams) takes the CTE: candidates stay near the matches, plan is GIN-backed', async () => {
        const d = await decide('zqclean', M_CLEAN);
        assert.deepEqual([d.plan, d.ctePlanOk], ['cte', true], JSON.stringify(d));
        assert.ok(typeof d.estCandidates === 'number' && d.estCandidates < N / 10, JSON.stringify(d));
    });
    await test('decisions are identical across three ANALYZEs (statistics target 1000)', async () => {
        const seen: string[] = [];
        for (let a = 0; a < 3; a++) {
            await pool.query('ANALYZE nodes');
            const l = await decide('linest', M_LINEST), z = await decide('zqclean', M_CLEAN);
            seen.push(`${l.plan}/${z.plan}`);
        }
        assert.deepEqual(seen, ['ordered-walk/cte', 'ordered-walk/cte', 'ordered-walk/cte']);
    });
    await test('an unreadable candidate probe keeps the original statement', async () => {
        const { params, where } = build('zqclean');
        const base = hybrid(M_CLEAN, GIN);
        const broken: Pick<Pool, 'query'> = {
            query: (async (sql: string, values?: unknown[]) => /LIKE \$2 AND/.test(sql) ? { rows: [{ 'QUERY PLAN': 'garbage' }] } : base.query(sql, values)) as never,
        };
        const d = await probeKeywordPlan(broken, WS, where, params.values, CAP, keywordSearchTerms('zqclean'));
        assert.deepEqual([d.plan, d.estCandidates], ['ordered-walk', null], JSON.stringify(d));
    });

    console.log('\ngraph');
    await test('PostgresGraph.search() hands the query terms to the planner: the candidate probe is issued and reported; the off switch issues no probe', async () => {
        const sqlSeen: string[] = [];
        const realQuery = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
        // walk / M / N canned like above so the planner's own noisy M estimate cannot decide whether the candidate probe is reached
        (pool as unknown as { query: unknown }).query = (...a: unknown[]) => {
            const sql = a[0];
            if (typeof sql === 'string') {
                sqlSeen.push(sql);
                if (/^EXPLAIN \(FORMAT JSON\) SELECT 1 FROM nodes WHERE workspace_id = \$1 AND \(\(lower\(label\) LIKE/.test(sql)) return realQuery(...a);
                if (/^EXPLAIN \(FORMAT JSON\) SELECT 1 FROM nodes WHERE workspace_id = \$1 AND/.test(sql)) return Promise.resolve({ rows: rowsOf(M_LINEST) });
                if (/^EXPLAIN \(FORMAT JSON\) SELECT 1 FROM nodes WHERE workspace_id = \$1$/.test(sql)) return Promise.resolve({ rows: rowsOf(N) });
                if (/^EXPLAIN \(FORMAT JSON\) SELECT \*/.test(sql) || /^EXPLAIN \(FORMAT JSON\) SELECT n\./.test(sql)) return Promise.resolve({ rows: walkPlan });
            }
            return realQuery(...a);
        };
        const decisions: KeywordPlanDecision[] = [];
        setKeywordPlanObserver((d) => decisions.push(d));
        const realWarn = console.warn; console.warn = () => { /* scan-cap warnings are expected */ };
        try {
            const nodes = await graph.search('linest', 7);
            assert.equal(nodes.length, 7);
            assert.ok(sqlSeen.some((s) => /LIKE \$2 AND/.test(s) && /^EXPLAIN/.test(s)), `candidate probe issued: ${sqlSeen.filter((s) => /^EXPLAIN/.test(s)).join(' | ').slice(0, 400)}`);
            assert.equal(decisions.length, 1);
            assert.equal(decisions[0]!.plan, 'ordered-walk');
            assert.ok(typeof decisions[0]!.estCandidates === 'number' && decisions[0]!.estCandidates > N / 4, JSON.stringify(decisions[0]));
            assert.ok(sqlSeen.every((s) => !/^WITH m AS MATERIALIZED/.test(s)), 'the CTE statement was not sent');

            sqlSeen.length = 0; decisions.length = 0;
            env['LORE_PG_KEYWORD_CTE'] = '0';
            await graph.search('linest', 8);
            assert.ok(sqlSeen.every((s) => !/^EXPLAIN/.test(s)), 'off switch: no EXPLAIN of any kind');
            assert.equal(decisions.length, 0);
        } finally {
            console.warn = realWarn; setKeywordPlanObserver(null);
            (pool as unknown as { query: unknown }).query = realQuery;
            if (savedSwitch === undefined) delete env['LORE_PG_KEYWORD_CTE']; else env['LORE_PG_KEYWORD_CTE'] = savedSwitch;
        }
    });
} finally {
    if (savedSwitch === undefined) delete env['LORE_PG_KEYWORD_CTE']; else env['LORE_PG_KEYWORD_CTE'] = savedSwitch;
    await closePostgresPool(pool);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
