#!/usr/bin/env tsx
/**
 * test/pg-keyword-cte-guard-unit.ts - lane f1: guards on the Postgres graph keyword CTE route (follow-up to pg-keyword-cte-unit.ts).
 *
 *   pure     cteUsesKeywordIndexes plan-JSON table (Seq Scan inside `CTE m` -> false), keywordCteEnabled, canned-probe flows:
 *            a seq-scan CTE plan keeps the original, an index-backed one takes the CTE, every probe stage that throws falls back
 *   guard    real Postgres: with bitmap scans disabled the planner builds `CTE m` from a Seq Scan (the review's finding 1) while the
 *            estimates alone would still say "cte": the guard now keeps the original; with seq scans disabled the CTE is built
 *            from the GIN bitmap and is taken. Unpinned decisions are internally consistent.
 *   graph    PostgresGraph.search(): a throwing probe (EXPLAIN error / statement_timeout) returns the original statement's rows;
 *            LORE_PG_KEYWORD_CTE=0 issues no EXPLAIN at all (even with the plan force seam set to 'cte') and returns identical rows
 *   recall   REAL entry point: embedded createLore() recall honours LORE_PG_KEYWORD_CTE (decisions seen when on, none when off)
 *
 * Skips the database cases (printed reason, exit 0) when LORE_PG_URL is unset. Run: npx tsx test/pg-keyword-cte-guard-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { PgParams, fromPgNodeRow, type PgRow } from '../packages/lore/src/engines/postgres/postgresGraphRow.js';
import { searchWhere } from '../packages/lore/src/engines/postgres/postgresGraphReads.js';
import {
    candidateCteSql, chooseKeywordPlan, cteUsesKeywordIndexes, decideKeywordPlan, keywordCteEnabled, orderedWalkSql,
    probeKeywordPlan, setKeywordPlanForce, setKeywordPlanObserver, type KeywordPlanDecision,
} from '../packages/lore/src/engines/postgres/postgresKeywordPlan.js';
import { rankSearchResults, SEARCH_SCAN_CAP } from '../packages/lore/src/engines/searchRanking.js';
import { rowToLoreNode } from '../packages/lore/src/engines/loreNodeRow.js';
import { gateDbUrl, stampGateManifest } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

/** An `EXPLAIN (FORMAT JSON)` result whose `CTE m` subtree is `cteChildren` (the outer join side is a plain Seq Scan on n, which must not count). */
const cteDoc = (cteChildren: unknown[], nodeType = 'Bitmap Heap Scan') => [{
    'QUERY PLAN': [{ Plan: { 'Node Type': 'Nested Loop', Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'nodes', Alias: 'n' },
        { 'Node Type': 'CTE Scan', 'Parent Relationship': 'InitPlan', 'Subplan Name': 'CTE m', Plans: [{ 'Node Type': nodeType, Plans: cteChildren }] },
    ] } }],
}];
const bitmap = (index: string) => ({ 'Node Type': 'Bitmap Index Scan', 'Index Name': index });

console.log('\npure');
await test('cteUsesKeywordIndexes: only a CTE built from the keyword GIN indexes passes; a Seq Scan inside CTE m fails, one outside it does not count', () => {
    assert.equal(cteUsesKeywordIndexes(cteDoc([bitmap('idx_nodes_content_trgm')])), true);
    assert.equal(cteUsesKeywordIndexes(cteDoc([{ 'Node Type': 'BitmapOr', Plans: [bitmap('idx_nodes_label_trgm'), bitmap('idx_nodes_content_trgm'), bitmap('idx_nodes_tags_gin')] }])), true);
    assert.equal(cteUsesKeywordIndexes(cteDoc([{ 'Node Type': 'BitmapAnd', Plans: [bitmap('idx_nodes_project'), bitmap('IDX_NODES_CONTENT_TRGM')] }])), true, 'workspace/btree arm AND a GIN arm is fine');
    assert.equal(cteUsesKeywordIndexes(cteDoc([], 'Seq Scan')), false, 'the review repro: Seq Scan on nodes inside CTE m');
    assert.equal(cteUsesKeywordIndexes(cteDoc([], 'Parallel Seq Scan')), false);
    assert.equal(cteUsesKeywordIndexes(cteDoc([{ 'Node Type': 'Gather', Plans: [{ 'Node Type': 'Parallel Seq Scan' }] }], 'Gather')), false);
    assert.equal(cteUsesKeywordIndexes(cteDoc([bitmap('idx_nodes_project')])), false, 'bitmap over a btree only: touches the whole workspace');
    assert.equal(cteUsesKeywordIndexes(cteDoc([{ 'Node Type': 'Index Scan', 'Index Name': 'idx_nodes_updatedAt' }], 'Index Scan')), false, 'recency walk inside the CTE');
    assert.equal(cteUsesKeywordIndexes(cteDoc([bitmap('idx_nodes_content_trgm'), { 'Node Type': 'Seq Scan' }])), false, 'any Seq Scan fails even beside a GIN arm');
    assert.equal(cteUsesKeywordIndexes([{ 'QUERY PLAN': JSON.stringify(cteDoc([bitmap('idx_nodes_tags_gin')])[0]!['QUERY PLAN']) }]), true, 'string JSON accepted');
    assert.equal(cteUsesKeywordIndexes([{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan' } }] }]), null, 'no CTE m node');
    assert.equal(cteUsesKeywordIndexes([]), null);
    assert.equal(cteUsesKeywordIndexes([{ 'QUERY PLAN': 'garbage' }]), null);
});
await test('keywordCteEnabled: on by default; 0 / false / off / no (any case, padded) turn it off', () => {
    assert.equal(keywordCteEnabled({}), true);
    for (const v of ['', ' ', '1', 'on', 'true', 'yes', 'garbage', '2']) assert.equal(keywordCteEnabled({ LORE_PG_KEYWORD_CTE: v }), true, JSON.stringify(v));
    for (const v of ['0', ' 0 ', 'false', 'FALSE', 'off', 'Off', 'no']) assert.equal(keywordCteEnabled({ LORE_PG_KEYWORD_CTE: v }), false, JSON.stringify(v));
});

/** A pool that answers EXPLAINs from canned planner output and counts every statement; `failAt` throws at the Nth statement (1-based). */
function canned(opts: { walk: unknown; m: number; n: number; cte: unknown; failAt?: number }) {
    const seen: string[] = [];
    const rows = (v: number) => [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': v } }] }];
    return {
        seen,
        pool: {
            async query(sql: string) {
                seen.push(sql);
                if (opts.failAt === seen.length) throw Object.assign(new Error('canceling statement due to statement timeout: SECRET-QUERY-TEXT'), { code: '57014' });
                const r = /WITH m AS MATERIALIZED/.test(sql) ? opts.cte
                    : /SELECT 1 FROM nodes WHERE workspace_id = \$1 AND/.test(sql) ? rows(opts.m)
                    : /SELECT 1 FROM nodes WHERE workspace_id = \$1$/.test(sql) ? rows(opts.n) : opts.walk;
                return { rows: r } as never;
            },
        },
    };
}
const walkPlan = [{ 'QUERY PLAN': [{ Plan: { Plans: [{ 'Index Name': 'idx_nodes_updatedat' }] } }] }];
const goodCte = cteDoc([bitmap('idx_nodes_content_trgm')]);
const seqCte = cteDoc([], 'Seq Scan');

await test('probe flow: estimates favour the CTE but its plan is a Seq Scan -> original (4 round trips); index-backed -> CTE; unreadable -> original', async () => {
    let c = canned({ walk: walkPlan, m: 1000, n: 60_000, cte: seqCte });
    assert.equal(decideKeywordPlan(1000, 60_000, 200), 'cte', 'the estimates alone would pick the CTE (the pre-f1 behaviour)');
    let d = await probeKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 200);
    assert.deepEqual([d.plan, d.ctePlanOk, c.seen.length], ['ordered-walk', false, 4]);
    assert.match(c.seen[3]!, /^EXPLAIN \(FORMAT JSON\) WITH m AS MATERIALIZED/, 'the 4th probe explains the CTE statement');
    c = canned({ walk: walkPlan, m: 1000, n: 60_000, cte: goodCte });
    d = await probeKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 200);
    assert.deepEqual([d.plan, d.ctePlanOk, c.seen.length], ['cte', true, 4]);
    for (const bad of [[{ 'QUERY PLAN': 'garbage' }], [], cteDoc([bitmap('idx_nodes_project')])]) {
        c = canned({ walk: walkPlan, m: 1000, n: 60_000, cte: bad });
        d = await probeKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 200);
        assert.equal(d.plan, 'ordered-walk');
    }
    c = canned({ walk: walkPlan, m: 900_000, n: 1_000_000, cte: goodCte }); // outside the window: the CTE is never probed
    d = await probeKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 200);
    assert.deepEqual([d.plan, c.seen.length], ['ordered-walk', 2]);
});
await test('probe flow: a throw at ANY probe stage keeps the original and never propagates; the warning carries class/SQLSTATE, not query text', async () => {
    const warns: string[] = [];
    const realWarn = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
        for (const failAt of [1, 2, 3, 4]) {
            const c = canned({ walk: walkPlan, m: 1000, n: 60_000, cte: goodCte, failAt });
            const d = await probeKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 200);
            assert.equal(d.plan, 'ordered-walk', `failAt=${failAt}`);
            assert.equal(d.probeError, 'Error 57014');
            assert.equal(c.seen.length, failAt, 'no further probe after the failure');
        }
        const c = canned({ walk: walkPlan, m: 1000, n: 60_000, cte: goodCte, failAt: 1 });
        c.pool.query = async () => { throw 'a string, not an Error'; };
        assert.equal((await probeKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 200)).plan, 'ordered-walk');
    } finally { console.warn = realWarn; }
    assert.equal(warns.length, 2, `one warning per distinct error signature, got ${warns.length}`);
    assert.ok(warns.every((w) => !/SECRET-QUERY-TEXT|SELECT|EXPLAIN/.test(w)), warns.join('|'));
});
await test('chooseKeywordPlan with LORE_PG_KEYWORD_CTE=0: no statement issued, original plan, even when the force seam asks for the CTE', async () => {
    const c = canned({ walk: walkPlan, m: 1000, n: 60_000, cte: goodCte });
    const seen: KeywordPlanDecision[] = [];
    setKeywordPlanObserver((d) => seen.push(d)); setKeywordPlanForce('cte');
    try {
        const off = await chooseKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 200, { LORE_PG_KEYWORD_CTE: '0' });
        assert.deepEqual([off.plan, off.disabled, c.seen.length, seen.length], ['ordered-walk', true, 0, 0]);
        const on = await chooseKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 200, {});
        assert.equal(on.plan, 'cte'); assert.equal(c.seen.length, 4); assert.equal(seen.length, 1);
    } finally { setKeywordPlanObserver(null); setKeywordPlanForce(null); }
});

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-keyword-cte-guard (database cases): LORE_PG_URL is not set - postgres cases skipped cleanly');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

const DB = 'lore_gate_kwguard', DB_LORE = 'lore_gate_kwguard_lore';
const WS = 'pg-gate-kwguard';
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const urlFor = (db: string): string => { const u = new URL(gate); u.pathname = `/${db}`; return u.toString(); };
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
for (const db of [DB, DB_LORE]) { await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin(`CREATE DATABASE ${db}`); }

const N = 30_000, EVERY = 30; // zqguard in 3.3% of rows, zqgood in 0.2%
/** The review's shape: ~230-byte content, a mid-frequency term, 40-way updatedAt ties. */
async function loadCorpus(pool: Pool, ws: string, n: number, salt: string): Promise<void> {
    await pool.query(`
        INSERT INTO nodes (workspace_id, id, type, label, content, tags, project, ecosystem, metadata, "createdAt", "updatedAt", status, supersededat)
        SELECT $1, 'n' || substr(md5($2 || i::text), 1, 12), 'note', 'label ' || i,
               'body ' || i || ' ' || repeat(md5(i::text) || ' ', 6) || CASE WHEN i % $4::int = 0 THEN ' zqguard' ELSE '' END || CASE WHEN i % 500 = 0 THEN ' zqgood' ELSE '' END || ' zqall',
               '[]', 'p', '*', '{}', '2026-01-01T00:00:00.000Z',
               to_char(timestamp '2026-01-01' + ((i / 40)::int) * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'), 'active', ''
        FROM generate_series(0, $3::int - 1) AS i`, [ws, salt, n, EVERY]);
}

const pool: Pool = createPostgresPool({ url: urlFor(DB) });
const graph = new PostgresGraph(WS, pool);
let loreHome = '';
const env = process.env as Record<string, string | undefined>;
const savedSwitch = env['LORE_PG_KEYWORD_CTE'];
try {
    await graph.initialize();
    await graph.waitForKeywordIndexes();
    await loadCorpus(pool, WS, N, 'g');
    await pool.query('ANALYZE nodes');

    const build = (query: string) => { const params = new PgParams(); params.add(WS); const where = searchWhere(params, query, {}); return { params, where }; };
    /** Run `fn` against a pool wrapper whose every statement runs in a transaction with the given planner switches (SET LOCAL). */
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
    const explainText = async (p: Pick<Pool, 'query'>, sql: string, values: unknown[]): Promise<string> =>
        (await p.query(`EXPLAIN (COSTS OFF, FORMAT TEXT) ${sql}`, values) as { rows: Array<Record<string, string>> }).rows.map((r) => r['QUERY PLAN']).join('\n');

    console.log('\nguard');
    const CAP = 200;
    /** Planner estimates on a small test table are noisy (they move between ANALYZE runs), so probes 1-3 are canned to the values
     *  of the review's repro (walks the recency index, M=1000 of N=60000: the estimate rule alone says "cte") while probe 4 - the
     *  CTE statement's own EXPLAIN, the thing under test - is REAL Postgres output, optionally under planner switches. */
    const realCteExplain = (settings: string[]): Pick<Pool, 'query'> => {
        const real = settings.length ? withPlanner(settings) : pool;
        const rows = (v: number) => [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': v } }] }];
        return {
            query: (async (sql: string, values?: unknown[]) => {
                if (/^EXPLAIN \(FORMAT JSON\) WITH m AS MATERIALIZED/.test(sql)) return real.query(sql, values);
                if (/SELECT 1 FROM nodes WHERE workspace_id = \$1 AND/.test(sql)) return { rows: rows(1000) };
                if (/SELECT 1 FROM nodes WHERE workspace_id = \$1$/.test(sql)) return { rows: rows(60_000) };
                return { rows: walkPlan };
            }) as never,
        };
    };
    await test('Seq Scan inside CTE m (bitmap scans off): estimates alone say cte, the real CTE plan is a full scan, the guard keeps the original', async () => {
        const { params, where } = build('zqguard');
        const d = await probeKeywordPlan(realCteExplain(['enable_bitmapscan = off']), WS, where, params.values, CAP);
        assert.equal(decideKeywordPlan(d.estMatches, d.estRows, CAP), 'cte', `precondition: the estimate rule alone picks the CTE: ${JSON.stringify(d)}`);
        const lim = params.add(CAP);
        assert.match(await explainText(withPlanner(['enable_bitmapscan = off']), candidateCteSql(where, lim), params.values), /CTE m\n\s+->\s+Seq Scan on nodes/, 'precondition: Postgres builds CTE m from a Seq Scan here');
        assert.deepEqual([d.plan, d.ctePlanOk], ['ordered-walk', false], JSON.stringify(d));
    });
    await test('Bitmap over the workspace btree only (seq scans off, 3.3% term) is also a full-workspace read: kept as the original', async () => {
        const { params, where } = build('zqguard');
        const d = await probeKeywordPlan(realCteExplain(['enable_seqscan = off']), WS, where, params.values, CAP);
        assert.deepEqual([d.plan, d.ctePlanOk], ['ordered-walk', false], JSON.stringify(d));
    });
    /** With statistics target 1000 on the trigram indexes the content estimate for this term is 90 (was 3), which makes the planner's
     *  workspace-btree bitmap + filter marginally cheaper than the 3-arm GIN BitmapOr on this tiny table; SSD-style page costs restore the
     *  GIN plan. The guard still rejects the btree shape (previous test), so this only pins the plan under test. */
    const GIN_SWITCHES = ['enable_seqscan = off', 'random_page_cost = 1.1'];
    await test('GIN-backed CTE (rare term, seq scans off): real Postgres plan JSON passes the shape check, so the CTE is still taken (good case kept)', async () => {
        const { params, where } = build('zqgood');
        const d = await probeKeywordPlan(realCteExplain(GIN_SWITCHES), WS, where, params.values, CAP);
        assert.deepEqual([d.plan, d.ctePlanOk], ['cte', true], JSON.stringify(d));
        const lim = params.add(CAP);
        assert.match(await explainText(withPlanner(GIN_SWITCHES), candidateCteSql(where, lim), params.values), /CTE m\n\s+->\s+Bitmap Heap Scan on nodes\n[\s\S]*?Bitmap Index Scan on idx_nodes_(content|label)_trgm/);
    });
    await test('unpinned decisions on the real planner are consistent: a CTE decision rests on a GIN-backed CTE plan and a walking original', async () => {
        for (const query of ['zqguard', 'zqgood', 'zqall', 'nomatchatall', 'body 12']) {
            const { params, where } = build(query);
            const d = await probeKeywordPlan(pool, WS, where, params.values, CAP);
            assert.equal(d.probeError, undefined, `${query}: ${JSON.stringify(d)}`);
            if (d.plan === 'cte') {
                assert.deepEqual([d.walks, d.ctePlanOk], [true, true], `${query}: ${JSON.stringify(d)}`);
                const lim = params.add(CAP);
                assert.doesNotMatch(await explainText(pool, candidateCteSql(where, lim), params.values), /CTE m\n\s+->\s+Seq Scan/);
            }
        }
    });

    console.log('\ngraph');
    const referenceSearch = async (query: string, limit: number) => {
        const { params, where } = build(query);
        const rows = (await pool.query(orderedWalkSql(where, params.add(SEARCH_SCAN_CAP)), params.values)).rows;
        return rankSearchResults(rows.map((r) => rowToLoreNode(fromPgNodeRow(r as PgRow))), query, limit).map((n) => n.id);
    };
    const sqlSeen: string[] = [];
    const realQuery = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
    let failExplain: { code: string } | null = null;
    (pool as unknown as { query: unknown }).query = (...a: unknown[]) => {
        if (typeof a[0] === 'string') {
            sqlSeen.push(a[0]);
            if (failExplain && /^EXPLAIN/.test(a[0])) return Promise.reject(Object.assign(new Error('boom: SECRET-QUERY-TEXT'), failExplain));
        }
        return realQuery(...a);
    };
    const originalSql = (query: string): string => { const { params, where } = build(query); return orderedWalkSql(where, params.add(SEARCH_SCAN_CAP)); };
    let limitSeq = 20; // the read cache keys on limit: a fresh limit per call forces a real statement
    const queries = ['zqguard', 'zqall', 'zqguard zqall', 'nomatchatall'];
    const realWarn = console.warn; console.warn = () => { /* scan-cap and probe warnings are expected here */ };
    try {
        await test('probe throws (EXPLAIN error, statement_timeout): PostgresGraph.search() still returns exactly the original statement\'s rows', async () => {
            for (const code of ['42601', '57014', '08006']) {
                failExplain = { code };
                try {
                    for (const query of queries) {
                        sqlSeen.length = 0;
                        const lim = ++limitSeq;
                        const got = (await graph.search(query, lim)).map((n) => n.id);
                        assert.ok(sqlSeen.some((s) => /^EXPLAIN/.test(s)), 'the probe was attempted');
                        assert.ok(sqlSeen.every((s) => !/^WITH m AS MATERIALIZED/.test(s)), 'the CTE statement was not sent');
                        assert.deepEqual(got, await referenceSearch(query, lim), `${code} ${query}`);
                    }
                } finally { failExplain = null; }
                            }
        });
        await test('LORE_PG_KEYWORD_CTE=0: search() issues no EXPLAIN (even with the force seam on cte), sends the original statement, identical rows', async () => {
            const observed: KeywordPlanDecision[] = [];
            setKeywordPlanObserver((d) => observed.push(d)); setKeywordPlanForce('cte');
            env['LORE_PG_KEYWORD_CTE'] = '0';
            try {
                for (const query of queries) {
                    sqlSeen.length = 0;
                    const lim = ++limitSeq;
                    const got = (await graph.search(query, lim)).map((n) => n.id);
                    assert.ok(sqlSeen.every((s) => !/^EXPLAIN/.test(s)), `${query}: no EXPLAIN`);
                    assert.ok(sqlSeen.every((s) => !/MATERIALIZED/.test(s)), `${query}: no CTE`);
                    assert.ok(sqlSeen.some((s) => s === originalSql(query)), `${query}: the original statement text`);
                    assert.deepEqual(got, await referenceSearch(query, lim), query);
                }
                assert.equal(observed.length, 0, 'no decision made');
            } finally { delete env['LORE_PG_KEYWORD_CTE']; setKeywordPlanObserver(null); setKeywordPlanForce(null); }
            // and back on: the probes run again
            sqlSeen.length = 0;
            await graph.search('zqguard', ++limitSeq);
            assert.ok(sqlSeen.some((s) => /^EXPLAIN/.test(s)), 'default on: probes are issued');
        });
    } finally { console.warn = realWarn; (pool as unknown as { query: unknown }).query = realQuery; }

    console.log('\nrecall (embedded createLore over the same Postgres server)');
    {
        const LWS = 'pg-gate-kwguard-lore';
        env['LORE_PG_URL'] = urlFor(DB_LORE);
        env['LORE_MODEL_SERVER'] = '0';
        delete env['LORE_HOME'];
        const embedder = {
            dimension: 4, modelId: 'gate/kwguard-fixed-4', dtype: 'fp32', maxBatchSize: 8,
            async initialize() { /* no-op */ },
            async embed() { return [1, 0, 0, 0]; }, async embedQuery() { return [1, 0, 0, 0]; },
            async embedDocument() { return [1, 0, 0, 0]; }, async embedDocumentBatch(ts: string[]) { return ts.map(() => [1, 0, 0, 0]); },
        };
        loreHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-kwguard-'));
        const wsPath = path.join(loreHome, 'workspaces', LWS);
        fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
        fs.writeFileSync(path.join(loreHome, 'workspaces.json'), JSON.stringify({
            version: 1, active: LWS,
            workspaces: [{ name: LWS, path: wsPath, graphEngine: 'postgres', vectorEngine: 'postgres', createdAt: new Date().toISOString() }],
        }));
        stampGateManifest(wsPath, embedder.modelId, 4);
        const { createLore } = await import('../packages/lore/src/index.js');
        const lore = await createLore({ dataDir: loreHome, deploymentMode: 'embedded', embeddingProvider: embedder as never, modelServer: false } as never) as any;
        const lpool = createPostgresPool({ url: urlFor(DB_LORE) });
        try {
            await lore.nodeUpsert({ id: 'seed-1', workspace: LWS, ecosystem: '*', nodeData: { id: 'seed-1', type: 'note', label: 'seed', content: 'seed node', tags: '', project: LWS, ecosystem: '*', metadata: '{}' } });
            await lore.awaitEmbeds?.();
            await loadCorpus(lpool, LWS, N, 'l');
            await lpool.query('ANALYZE nodes');
            await test('lore.recall(): decisions are made when the switch is on; none when LORE_PG_KEYWORD_CTE=0; both answer from the keyword leg', async () => {
                const seen: KeywordPlanDecision[] = [];
                setKeywordPlanObserver((d) => seen.push(d));
                try {
                    const on = await lore.recall('zqguard', { workspace: LWS, depth: 1, mode: 'summary' });
                    assert.match(JSON.stringify(on), /zqguard/i);
                    assert.ok(seen.length > 0, 'default on: the keyword leg consulted the planner');
                    seen.length = 0;
                    env['LORE_PG_KEYWORD_CTE'] = '0';
                    const off = await lore.recall('zqguard', { workspace: LWS, depth: 1, mode: 'summary' });
                    assert.match(JSON.stringify(off), /zqguard/i);
                    assert.equal(seen.length, 0, 'off: no plan decision');
                } finally { delete env['LORE_PG_KEYWORD_CTE']; setKeywordPlanObserver(null); }
            });
        } finally {
            await closePostgresPool(lpool);
            await lore.dispose();
        }
    }
} finally {
    if (savedSwitch === undefined) delete env['LORE_PG_KEYWORD_CTE']; else env['LORE_PG_KEYWORD_CTE'] = savedSwitch;
    setKeywordPlanObserver(null); setKeywordPlanForce(null);
    await graph.close().catch(() => {});
    await closePostgresPool(pool);
    if (loreHome) fs.rmSync(loreHome, { recursive: true, force: true });
    for (const db of [DB, DB_LORE]) await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
