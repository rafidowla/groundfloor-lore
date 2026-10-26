#!/usr/bin/env tsx
/**
 * test/pg-keyword-cte-unit.ts - lane e1: the Postgres graph keyword leg (search) collects its matches in a
 * MATERIALIZED CTE when that is the cheaper plan, and returns EXACTLY the rows the recency-ordered statement did.
 *
 *   pure        decideKeywordPlan table, EXPLAIN-JSON parsing, SQL shape (plain `workspace_id = $1`, MATERIALIZED, same sort key)
 *   parity      real Postgres, 24k-row corpus + a second workspace: for ~15 queries (rare / mid / common / all-rows,
 *               two-term, short-term fallback, tag-only, case, no match) x 6 scopes x 8 limits, the ORIGINAL statement
 *               (kept verbatim below as the reference) and the CTE statement return the identical full rows in the identical
 *               order - including 40-way updatedAt ties, archived / superseded rows, other workspaces and entity/topic scopes
 *   plan        the CTE form answers a mid term from the trigram GIN bitmap (no recency-index walk); the guard keeps the
 *               original plan for a very common term because forcing the CTE there reads many times more buffers
 *   graph       PostgresGraph.search() acts on the decision (observer): CTE for the mid term, original for rare/common, and its
 *               candidate set equals ranking the original statement's rows
 *   recall      REAL entry point: embedded createLore() over a Postgres workspace, lore.recall() reaches the new statement
 *
 * Skips the database cases (printed reason, exit 0) when LORE_PG_URL is unset. Run: npx tsx test/pg-keyword-cte-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { PgParams } from '../packages/lore/src/engines/postgres/postgresGraphRow.js';
import { searchWhere, type SearchScope } from '../packages/lore/src/engines/postgres/postgresGraphReads.js';
import {
    CTE_BREAK_EVEN, CTE_MAX_MATCHES, candidateCteSql, decideKeywordPlan, orderedWalkSql, planRowsOf,
    probeKeywordPlan, setKeywordPlanForce, setKeywordPlanObserver, walksRecencyIndex, type KeywordPlanDecision,
} from '../packages/lore/src/engines/postgres/postgresKeywordPlan.js';
import { rankSearchResults, SEARCH_SCAN_CAP } from '../packages/lore/src/engines/searchRanking.js';
import { rowToLoreNode } from '../packages/lore/src/engines/loreNodeRow.js';
import { fromPgNodeRow, type PgRow } from '../packages/lore/src/engines/postgres/postgresGraphRow.js';
import { gateDbUrl, stampGateManifest } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

/** The statement the engine ran before this lane, verbatim (reference for the parity cases). */
function referenceSql(where: string, limitPlaceholder: string): string {
    return `SELECT * FROM nodes WHERE workspace_id = $1 AND ${where} ORDER BY "updatedAt" DESC, id ASC LIMIT ${limitPlaceholder}::int`;
}

console.log('\npure');
await test('decideKeywordPlan: the CTE only in the window where it beats the recency walk; unknown estimates keep the original', () => {
    const cap = 2000, n = 1_000_000;
    assert.equal(decideKeywordPlan(29_000, n, cap), 'cte', 'the 1M mid term from the bench');
    assert.equal(decideKeywordPlan(1_000, n, cap), 'ordered-walk', 'M <= cap/2: planner already uses the bitmap');
    assert.equal(decideKeywordPlan(2_500, n, cap), 'cte');
    assert.equal(decideKeywordPlan(650_000, n, cap), 'ordered-walk', 'very common term');
    assert.equal(decideKeywordPlan(CTE_MAX_MATCHES + 1, 1e12, cap), 'ordered-walk', 'absolute cap on the materialised set');
    assert.equal(decideKeywordPlan(40_000, n, cap), 'ordered-walk', 'just past break-even (M^2 > K*cap*N)');
    assert.equal(decideKeywordPlan(Math.floor(Math.sqrt(CTE_BREAK_EVEN * cap * n)), n, cap), 'cte', 'at break-even');
    assert.equal(decideKeywordPlan(12_000, 100_000, cap), 'ordered-walk', 'same M ratio at 100k rows: the walk is cheap there');
    for (const bad of [null, 0, -1, Number.NaN]) {
        assert.equal(decideKeywordPlan(bad as never, n, cap), 'ordered-walk');
        assert.equal(decideKeywordPlan(5_000, bad as never, cap), 'ordered-walk');
    }
});
await test('planRowsOf reads the root Plan Rows from parsed or string EXPLAIN JSON and refuses anything else', () => {
    assert.equal(planRowsOf([{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 123 } }] }]), 123);
    assert.equal(planRowsOf([{ 'QUERY PLAN': JSON.stringify([{ Plan: { 'Plan Rows': 7 } }]) }]), 7);
    assert.equal(planRowsOf([]), null);
    assert.equal(planRowsOf([{ 'QUERY PLAN': 'not json' }]), null);
    assert.equal(planRowsOf([{ 'QUERY PLAN': [{ Plan: {} }] }]), null);
});
await test('walksRecencyIndex finds idx_nodes_updatedat anywhere in the plan tree and refuses unreadable shapes', () => {
    const walk = [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'idx_nodes_updatedat' }] } }] }];
    const bitmap = [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Sort', Plans: [{ 'Node Type': 'Bitmap Heap Scan', Plans: [{ 'Index Name': 'idx_nodes_content_trgm' }] }] }] } }] }];
    assert.equal(walksRecencyIndex(walk), true);
    assert.equal(walksRecencyIndex([{ 'QUERY PLAN': JSON.stringify(walk[0]!['QUERY PLAN']) }]), true);
    assert.equal(walksRecencyIndex(bitmap), false);
    assert.equal(walksRecencyIndex([]), null);
    assert.equal(walksRecencyIndex([{ 'QUERY PLAN': 'garbage' }]), null);
});
await test('probeKeywordPlan with canned planner answers: stops after the first probe unless the planner walks; CTE only in the window', async () => {
    const okCte = [{ 'QUERY PLAN': [{ Plan: { Plans: [{ 'Subplan Name': 'CTE m', 'Node Type': 'Bitmap Heap Scan', Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'idx_nodes_content_trgm' }] }] } }] }];
    const canned = (walkRows: unknown, m: number | null, n: number | null) => {
        const seen: string[] = [];
        const planRows = (v: number | null) => [{ 'QUERY PLAN': v === null ? 'x' : [{ Plan: { 'Plan Rows': v } }] }];
        return {
            seen,
            pool: { async query(sql: string) { seen.push(sql); return { rows: /SELECT 1 FROM nodes WHERE workspace_id = \$1 AND/.test(sql) ? planRows(m) : /SELECT 1 FROM nodes WHERE workspace_id = \$1$/.test(sql) ? planRows(n) : /WITH m AS MATERIALIZED/.test(sql) ? okCte : walkRows } as never; } },
        };
    };
    const walkPlan = [{ 'QUERY PLAN': [{ Plan: { Plans: [{ 'Index Name': 'idx_nodes_updatedat' }] } }] }];
    const bitmapPlan = [{ 'QUERY PLAN': [{ Plan: { Plans: [{ 'Index Name': 'idx_nodes_content_trgm' }] } }] }];
    const run = async (walkRows: unknown, m: number | null, n: number | null) => {
        const c = canned(walkRows, m, n);
        const d = await probeKeywordPlan(c.pool as never, 'ws', 'X', ['ws'], 2000);
        return { d, trips: c.seen.length, firstIsWalkExplain: /^EXPLAIN \(FORMAT JSON\) SELECT \* FROM nodes WHERE workspace_id = \$1 AND X ORDER BY "updatedAt" DESC, id ASC LIMIT \$2::int$/.test(c.seen[0]!) };
    };
    let r = await run(bitmapPlan, 29_000, 1_000_000);
    assert.deepEqual([r.d.plan, r.trips, r.firstIsWalkExplain], ['ordered-walk', 1, true], 'planner already uses the GIN: one round trip, original statement');
    r = await run(walkPlan, 29_000, 1_000_000);
    assert.deepEqual([r.d.plan, r.trips, r.d.walks, r.d.estMatches, r.d.estRows], ['cte', 4, true, 29_000, 1_000_000]);
    r = await run(walkPlan, 650_000, 1_000_000);
    assert.deepEqual([r.d.plan, r.trips], ['ordered-walk', 2], 'M above the cap on the materialised set: no N probe');
    r = await run(walkPlan, 900, 1_000_000);
    assert.deepEqual([r.d.plan, r.trips], ['ordered-walk', 2], 'M below the window');
    r = await run(walkPlan, 29_000, null);
    assert.equal(r.d.plan, 'ordered-walk', 'unknown N keeps the original');
    r = await run(walkPlan, null, null);
    assert.equal(r.d.plan, 'ordered-walk', 'unknown M keeps the original');
    r = await run([{ 'QUERY PLAN': 'garbage' }], 29_000, 1_000_000);
    assert.deepEqual([r.d.plan, r.d.walks, r.trips], ['ordered-walk', null, 1], 'unreadable walk probe keeps the original');
});
await test('SQL shape: workspace_id stays a plain equality, the match set is MATERIALIZED, the sort key is unchanged', () => {
    const cte = candidateCteSql('X', '$9');
    assert.match(cte, /WITH m AS MATERIALIZED \(SELECT id, "updatedAt" FROM nodes WHERE workspace_id = \$1 AND X\)/);
    assert.match(cte, /ORDER BY "updatedAt" DESC, id ASC LIMIT \$9::int\) t/);
    assert.match(cte, /ON n\.workspace_id = \$1 AND n\.id = t\.id ORDER BY t\."updatedAt" DESC, t\.id ASC$/);
    assert.equal(orderedWalkSql('X', '$9'), referenceSql('X', '$9'), 'the fallback statement is byte-identical to the original');
    assert.doesNotMatch(cte, /workspace_id\s*(=\s*ANY|IN|LIKE)/);
});

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-keyword-cte (database cases): LORE_PG_URL is not set - postgres cases skipped cleanly');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

const DB = 'lore_gate_kwcte', DB_LORE = 'lore_gate_kwcte_lore';
const WS_A = 'pg-gate-kwcte-a', WS_B = 'pg-gate-kwcte-b';
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const urlFor = (db: string): string => { const u = new URL(gate); u.pathname = `/${db}`; return u.toString(); };
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
for (const db of [DB, DB_LORE]) { await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin(`CREATE DATABASE ${db}`); }

const N = 24_000;
/**
 * Bulk-load a corpus straight into nodes (the graph schema owns every column default). Row i:
 *   zqall    every row (content)                       zqcommon  i % 3 <> 0 (content)
 *   zqmid    i % 8 = 0 (content, some upper-cased) + i % 64 = 0 (label)   -> 3000 rows
 *   zqrare   i % 8000 = 0 (3 rows; label or content)   zqtag     tag only, i % 101 = 0
 *   zqmid    also as a tag-only match on i % 997 = 1   'ab' (2 chars: legacy arm) i % 5 = 0
 * updatedAt moves one minute per 40 rows -> 40-way ties, so the id tie-break decides inside each group; ids are hashes, so
 * id order is unrelated to insertion order. Some rows archived / superseded / other project / other ecosystem; metadata
 * carries entities/topics arrays, with a few malformed documents.
 */
async function loadCorpus(pool: Pool, ws: string, n: number, idSalt: string): Promise<void> {
    await pool.query(`
        INSERT INTO nodes (workspace_id, id, type, label, content, tags, project, ecosystem, metadata, "createdAt", "updatedAt", status, supersededat)
        SELECT $1, 'n' || substr(md5($2 || i::text), 1, 12),
               CASE WHEN i % 2 = 0 THEN 'note' ELSE 'decision' END,
               'label ' || i || CASE WHEN i % 8000 = 0 AND i % 16000 = 0 THEN ' zqrare' ELSE '' END || CASE WHEN i % 64 = 0 THEN ' zqmid' ELSE '' END,
               'body ' || i || ' zqall'
                 || CASE WHEN i % 3 <> 0 THEN ' zqcommon' ELSE '' END
                 || CASE WHEN i % 8 = 0 THEN CASE WHEN i % 16 = 0 THEN ' ZqMid' ELSE ' zqmid' END ELSE '' END
                 || CASE WHEN i % 8000 = 0 AND i % 16000 <> 0 THEN ' ZQRARE' ELSE '' END
                 || CASE WHEN i % 5 = 0 THEN ' ab' ELSE '' END,
               CASE WHEN i % 101 = 0 THEN '["zqtag"]' WHEN i % 997 = 1 THEN '["zqmid","other"]' ELSE '[]' END,
               'proj' || (i % 3), CASE i % 4 WHEN 0 THEN '*' WHEN 1 THEN '' WHEN 2 THEN 'eco1' ELSE 'eco2' END,
               CASE WHEN i % 1009 = 0 THEN 'not json'
                    WHEN i % 7 = 0 THEN '{"entities":["ent' || (i % 5) || '"],"topics":["top' || (i % 3) || '"]}'
                    ELSE '{}' END,
               '2026-01-01T00:00:00.000Z',
               to_char(timestamp '2026-01-01' + ((i / 40)::int) * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
               CASE WHEN i % 11 = 0 THEN 'archived' ELSE 'active' END,
               CASE WHEN i % 13 = 0 THEN '2026-02-01T00:00:00.000Z' ELSE '' END
        FROM generate_series(0, $3::int - 1) AS i`, [ws, idSalt, n]);
}

const pool: Pool = createPostgresPool({ url: urlFor(DB) });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const graphA = new PostgresGraph(WS_A, pool);
const graphB = new PostgresGraph(WS_B, pool);
let loreHome = '';
try {
    await graphA.initialize();
    await graphB.initialize();
    await graphA.waitForKeywordIndexes();
    await loadCorpus(pool, WS_A, N, 'a');
    await loadCorpus(pool, WS_B, 3_000, 'b'); // same terms, different workspace: must never leak
    await q('ANALYZE nodes');

    /** where + values for (query, scope) in WS_A, and the number of values the where consumed. */
    const build = (query: string, scope: SearchScope = {}) => {
        const params = new PgParams();
        params.add(WS_A);
        const where = searchWhere(params, query, scope);
        return { params, where };
    };
    const run = async (sql: string, values: unknown[]) => (await pool.query(sql, values)).rows as Record<string, unknown>[];

    console.log('\nparity');
    const queries = ['zqrare', 'zqmid', 'ZQMID', 'zqcommon', 'zqall', 'zqtag', 'zqmid zqcommon', 'zqrare zqmid', 'zqmid ab',
        'ab', 'zqmid zqmid zqtag', 'body 12', 'zq%', 'nomatchatall', 'label 100'];
    const scopes: Array<[string, SearchScope]> = [
        ['none', {}],
        ['project', { project: 'proj1' }],
        ['ecosystem', { ecosystem: 'eco1' }],
        ['hidden', { excludeHidden: true }],
        ['types', { types: ['decision'] }],
        ['entities+topics', { entities: ['ent2'], topics: ['top1'], excludeHidden: true, project: 'proj0' }],
    ];
    const limits = [1, 2, 10, 100, 500, 2000, 5000, 100_000];
    let compared = 0, nonEmpty = 0, differentFromUnsorted = 0;
    await test(`${queries.length} queries x ${scopes.length} scopes x ${limits.length} limits: identical full rows, identical order`, async () => {
        for (const query of queries) for (const [scopeName, scope] of scopes) {
            const { params, where } = build(query, scope);
            for (const limit of limits) {
                const p = new PgParams();
                p.values.push(...params.values);
                const lim = p.add(limit);
                const want = await run(referenceSql(where, lim), p.values);
                const got = await run(candidateCteSql(where, lim), p.values);
                assert.deepEqual(got, want, `query=${JSON.stringify(query)} scope=${scopeName} limit=${limit}`);
                compared++;
                if (want.length > 0) nonEmpty++;
                if (want.length > 1 && want.some((r, i) => i > 0 && r['updatedAt'] === want[i - 1]!['updatedAt'])) differentFromUnsorted++;
            }
        }
    });
    await test('the corpus really exercises the cases (non-empty results, updatedAt ties inside the returned window, empty results)', () => {
        assert.equal(compared, queries.length * scopes.length * limits.length);
        assert.ok(nonEmpty > compared * 0.6, `non-empty comparisons ${nonEmpty}/${compared}`);
        assert.ok(differentFromUnsorted > 100, `windows containing updatedAt ties: ${differentFromUnsorted}`);
        assert.ok(compared - nonEmpty > 5, 'some comparisons are the empty set (no-match query, narrow scopes)');
    });
    await test('ties on updatedAt are ordered by id ASC in both statements; no other workspace and no duplicate ids appear', async () => {
        const { params, where } = build('zqmid');
        const lim = params.add(5000);
        const got = await run(candidateCteSql(where, lim), params.values);
        assert.ok(got.length > 1000);
        const ids = new Set(got.map((r) => r['id']));
        assert.equal(ids.size, got.length, 'no duplicates');
        assert.ok(got.every((r) => r['workspace_id'] === WS_A));
        for (let i = 1; i < got.length; i++) {
            const a = got[i - 1]!, b = got[i]!;
            assert.ok(a['updatedAt']! > b['updatedAt']! || (a['updatedAt'] === b['updatedAt'] && String(a['id']) < String(b['id'])), `order broken at ${i}`);
        }
    });
    await test('a workspace-B search through the same SQL sees only workspace B (partition equality kept)', async () => {
        const params = new PgParams(); params.add(WS_B);
        const where = searchWhere(params, 'zqmid', {});
        const lim = params.add(100_000);
        const rows = await run(candidateCteSql(where, lim), params.values);
        assert.ok(rows.length > 100 && rows.length < 3_000);
        assert.ok(rows.every((r) => r['workspace_id'] === WS_B));
        assert.deepEqual(rows, await run(referenceSql(where, lim), params.values));
    });

    console.log('\nplan');
    const explain = async (sql: string, values: unknown[]): Promise<string> =>
        (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, FORMAT TEXT) ${sql}`, values)).rows.map((r) => r['QUERY PLAN']).join('\n');
    const buffers = (plan: string): number => {
        const m = /Buffers: shared (.*)\n/.exec(plan); // first (root) Buffers line
        return [...(m?.[1] ?? '').matchAll(/(hit|read)=(\d+)/g)].reduce((s, x) => s + Number(x[2]), 0);
    };
    /** The planner estimates on a 24k-row corpus are noisy (777..15k for the same 3k matches across ANALYZE runs), so the
     *  plan SHAPE cases pin it with enable_seqscan=off in one transaction and the DECISION cases assert consistency, not a number. */
    const explainNoSeq = async (sql: string, values: unknown[]): Promise<string> => {
        const c = await pool.connect();
        try {
            await c.query('BEGIN'); await c.query('SET LOCAL enable_seqscan = off');
            const r = await c.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, FORMAT TEXT) ${sql}`, values);
            await c.query('ROLLBACK');
            return r.rows.map((x) => x['QUERY PLAN']).join('\n');
        } finally { c.release(); }
    };
    await test('mid term: the CTE materialises the matches with a bitmap scan and never walks idx_nodes_updatedat', async () => {
        const { params, where } = build('zqmid');
        const lim = params.add(SEARCH_SCAN_CAP);
        const cte = await explainNoSeq(candidateCteSql(where, lim), params.values);
        assert.match(cte, /CTE m\n\s+->\s+Bitmap Heap Scan on nodes/);
        /* which bitmap index (keyword GIN or the workspace index) is a planner statistics call on a 24k corpus; the guarantee is the shape */
        assert.match(cte, /Bitmap Index Scan on idx_nodes_/);
        assert.doesNotMatch(cte, /Index Scan using idx_nodes_updatedat/);
        assert.match(cte, /Sort Key: m\."updatedAt" DESC, m\.id/);
    });
    await test('very common term: forcing the CTE reads more buffers than the original walk, and the guard keeps the walk', async () => {
        const { params, where } = build('zqall');
        const lim = params.add(SEARCH_SCAN_CAP);
        const walk = await explain(orderedWalkSql(where, lim), params.values);
        const cte = await explain(candidateCteSql(where, lim), params.values);
        assert.ok(buffers(cte) > buffers(walk) * 1.5, /* gap grows with N: the walk stays ~cap rows, the CTE reads every match */ `cte ${buffers(cte)} vs walk ${buffers(walk)} buffers`);
        const d = await probeKeywordPlan(pool, WS_A, where, params.values.slice(0, params.values.length - 1), SEARCH_SCAN_CAP);
        assert.equal(d.plan, 'ordered-walk', JSON.stringify(d));
    });
    await test('probe decisions on the corpus: rare and all-rows terms keep the original; a CTE decision always rests on a walking plan and in-window estimates', async () => {
        const decide = async (query: string): Promise<KeywordPlanDecision> => {
            const { params, where } = build(query);
            return probeKeywordPlan(pool, WS_A, where, params.values, SEARCH_SCAN_CAP);
        };
        const rare = await decide('zqrare');
        assert.equal(rare.plan, 'ordered-walk'); assert.equal(rare.estRows, null, 'N is not probed for a term the planner already handles');
        assert.equal((await decide('zqall')).plan, 'ordered-walk');
        for (const query of ['zqmid', 'zqcommon', 'zqtag', 'zqmid zqcommon', 'ab', 'nomatchatall']) {
            const d = await decide(query);
            if (d.plan === 'cte') {
                assert.equal(d.walks, true, `${query}: ${JSON.stringify(d)}`);
                assert.equal(decideKeywordPlan(d.estMatches, d.estRows, SEARCH_SCAN_CAP), 'cte', `${query}: ${JSON.stringify(d)}`);
            }
        }
    });

    console.log('\ngraph');
    /** Candidate rows of the ORIGINAL statement, ranked exactly as search() ranks its own candidates. */
    const referenceSearch = async (query: string, limit: number, scope: SearchScope = {}) => {
        const { params, where } = build(query, scope);
        const rows = await run(referenceSql(where, params.add(SEARCH_SCAN_CAP)), params.values);
        return rankSearchResults(rows.map((r) => rowToLoreNode(fromPgNodeRow(r as PgRow))), query, limit).map((n) => n.id);
    };
    const seen: KeywordPlanDecision[] = [];
    setKeywordPlanObserver((d) => seen.push(d));
    /** Record the statement text search() sends, to prove decision -> statement. */
    const sqlSeen: string[] = [];
    const realQuery = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
    (pool as unknown as { query: unknown }).query = (...a: unknown[]) => { if (typeof a[0] === 'string') sqlSeen.push(a[0]); return realQuery(...a); };
    try {
        await test('PostgresGraph.search() sends the statement its decision names, and its results equal the original statement (decision as the planner made it)', async () => {
            for (const query of ['zqmid', 'zqrare', 'zqall', 'zqmid zqcommon', 'zqtag']) {
                seen.length = 0; sqlSeen.length = 0;
                const got = (await graphA.search(query, 25)).map((n) => n.id);
                assert.equal(seen.length, 1, `${query}: exactly one decision`);
                const main = sqlSeen.find((x) => /FROM nodes/.test(x) && !/^EXPLAIN/.test(x) && /LIMIT/.test(x))!;
                assert.equal(/^WITH m AS MATERIALIZED/.test(main), seen[0]!.plan === 'cte', `${query}: ${JSON.stringify(seen[0])}`);
                assert.deepEqual(got, await referenceSearch(query, 25), query);
            }
        });
        await test('forced CTE through PostgresGraph.search(): same ids as the original for every query x scope, scanCapHit unchanged', async () => {
            setKeywordPlanForce('cte');
            try {
                for (const query of ['zqmid', 'zqrare', 'zqall', 'zqcommon', 'zqmid zqcommon', 'zqtag', 'ab', 'nomatchatall']) {
                    seen.length = 0; sqlSeen.length = 0;
                    const got = (await graphA.search(query, 40)).map((n) => n.id);
                    assert.equal(seen[0]!.plan, 'cte');
                    assert.ok(sqlSeen.some((x) => /^WITH m AS MATERIALIZED/.test(x)), `${query}: the CTE statement was sent`);
                    assert.deepEqual(got, await referenceSearch(query, 40), query);
                }
                const got = (await graphA.search('zqmid', 40, 'proj1', '*', true, undefined, ['note'])).map((n) => n.id);
                assert.deepEqual(got, await referenceSearch('zqmid', 40, { project: 'proj1', excludeHidden: true, types: ['note'] }));
                const got2 = (await graphA.search('zqmid zqall', 40, '*', '*', false, undefined, undefined, ['ent2'], ['top1'])).map((n) => n.id);
                assert.deepEqual(got2, await referenceSearch('zqmid zqall', 40, { entities: ['ent2'], topics: ['top1'] }));
                const sig = { scanCapHit: false };
                await graphA.search('zqall', 5, '*', '*', false, sig);
                assert.equal(sig.scanCapHit, true, 'zqall matches every row, window is full');
                const sig2 = { scanCapHit: true };
                await graphA.search('zqrare', 5, '*', '*', false, sig2);
                assert.equal(sig2.scanCapHit, false);
            } finally { setKeywordPlanForce(null); }
        });
    } finally { (pool as unknown as { query: unknown }).query = realQuery; setKeywordPlanObserver(null); setKeywordPlanForce(null); }

    console.log('\nrecall (embedded createLore over the same Postgres server)');
    {
        const WS = 'pg-gate-kwcte-lore';
        process.env['LORE_PG_URL'] = urlFor(DB_LORE);
        process.env['LORE_MODEL_SERVER'] = '0';
        delete process.env['LORE_HOME'];
        const DIM = 4;
        const embedder = {
            dimension: DIM, modelId: 'gate/kwcte-fixed-4', dtype: 'fp32', maxBatchSize: 8,
            async initialize() { /* no-op */ },
            async embed() { return [1, 0, 0, 0]; }, async embedQuery() { return [1, 0, 0, 0]; },
            async embedDocument() { return [1, 0, 0, 0]; }, async embedDocumentBatch(ts: string[]) { return ts.map(() => [1, 0, 0, 0]); },
        };
        loreHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-kwcte-'));
        const wsPath = path.join(loreHome, 'workspaces', WS);
        fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
        fs.writeFileSync(path.join(loreHome, 'workspaces.json'), JSON.stringify({
            version: 1, active: WS,
            workspaces: [{ name: WS, path: wsPath, graphEngine: 'postgres', vectorEngine: 'postgres', createdAt: new Date().toISOString() }],
        }));
        stampGateManifest(wsPath, embedder.modelId, DIM);
        const { createLore } = await import('../packages/lore/src/index.js');
        const lore = await createLore({ dataDir: loreHome, deploymentMode: 'embedded', embeddingProvider: embedder as never, modelServer: false } as never) as any;
        const lpool = createPostgresPool({ url: urlFor(DB_LORE) });
        try {
            await lore.nodeUpsert({ id: 'seed-1', workspace: WS, ecosystem: '*', nodeData: { id: 'seed-1', type: 'note', label: 'seed', content: 'seed node', tags: '', project: WS, ecosystem: '*', metadata: '{}' } });
            await lore.awaitEmbeds?.();
            await loadCorpus(lpool, WS, N, 'l');
            await lpool.query('ANALYZE nodes');
            await test('lore.recall() reaches the CTE statement through the real keyword leg (plan pinned: small-corpus estimates are noisy) and surfaces the matches', async () => {
                seen.length = 0;
                setKeywordPlanObserver((d) => seen.push(d));
                setKeywordPlanForce('cte');
                try {
                    const res = await lore.recall('zqmid', { workspace: WS, depth: 1, mode: 'summary' });
                    assert.ok(res, 'recall returned');
                    assert.ok(seen.some((d) => d.plan === 'cte'), `decisions: ${JSON.stringify(seen)}`);
                    const text = JSON.stringify(res);
                    assert.match(text, /zqmid/i, 'recall surfaced keyword matches');
                } finally { setKeywordPlanObserver(null); setKeywordPlanForce(null); }
            });
            await test('lore.recall() unpinned: every keyword-leg decision is made by the probe; the all-rows term keeps the original statement and still answers', async () => {
                seen.length = 0;
                setKeywordPlanObserver((d) => seen.push(d));
                try {
                    const res = await lore.recall('zqall', { workspace: WS, depth: 1, mode: 'summary' });
                    assert.ok(res);
                    assert.ok(seen.length > 0 && seen.every((d) => d.plan === 'ordered-walk'), JSON.stringify(seen));
                } finally { setKeywordPlanObserver(null); }
            });
        } finally {
            await closePostgresPool(lpool);
            await lore.dispose();
        }
    }
} finally {
    setKeywordPlanObserver(null);
    await graphA.close().catch(() => {});
    await graphB.close().catch(() => {});
    await closePostgresPool(pool);
    if (loreHome) fs.rmSync(loreHome, { recursive: true, force: true });
    for (const db of [DB, DB_LORE]) await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
