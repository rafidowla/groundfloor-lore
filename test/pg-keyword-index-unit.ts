#!/usr/bin/env tsx
/**
 * test/pg-keyword-index-unit.ts - Postgres keyword search is index-served and returns the same candidates as before.
 *
 * Runs against a throwaway database `lore_gate_kwidx` on the LORE_PG_URL server (the pure clause cases run even
 * without it; the rest skip with a printed reason when LORE_PG_URL is unset).
 *
 *   clause       LIKE escaping, short terms keep the old arms, CNF shape (pure, no database)
 *   schema       the three indexes exist and are valid after open; a re-open builds nothing; an INVALID leftover
 *                is dropped and rebuilt; a large table is NOT built inline (pending) and the background build
 *                finishes it; a second builder is refused while one holds the lock; the last owner out cancels
 *   equivalence  new clause vs the legacy strpos clause select the identical rows over edge-case data (%, _, \, ',
 *                unicode, case, tags, short terms, punctuation-only queries) and over a randomised corpus
 *   plan         the REAL search() statement can use all three indexes (seq scan disabled, so a regression to a
 *                non-indexable predicate shows up as a seq scan); the legacy clause cannot (negative control)
 *
 * Run: npx tsx test/pg-keyword-index-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { PgParams } from '../packages/lore/src/engines/postgres/postgresGraphRow.js';
import { runSchemaBootstrap } from '../packages/lore/src/engines/postgres/postgresStartup.js';
import { ensureGraphSchema } from '../packages/lore/src/engines/postgres/postgresGraphSchema.js';
import {
    KEYWORD_INDEXES, buildKeywordIndexes, releaseKeywordIndexBuild, startKeywordIndexBuild, validKeywordIndexes,
} from '../packages/lore/src/engines/postgres/postgresKeywordIndex.js';
import { escapeLike, keywordMatchClause, legacyKeywordMatchClause } from '../packages/lore/src/engines/postgres/postgresKeywordMatch.js';
import { keywordSearchTerms } from '../packages/lore/src/engines/searchRanking.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_kwidx';
const WS = 'pg-gate-kwidx';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const clauseFor = (query: string, legacy = false): { sql: string; values: unknown[] } => {
    const p = new PgParams();
    p.add(WS);
    const sql = (legacy ? legacyKeywordMatchClause : keywordMatchClause)(p, keywordSearchTerms(query), query.toLowerCase());
    return { sql, values: p.values };
};

console.log('\nclause');
await test('escapeLike makes % _ and backslash literal', () => {
    assert.equal(escapeLike('100%_done\\x'), '100\\%\\_done\\\\x');
    assert.equal(escapeLike('plain'), 'plain');
});
await test('3+ char term: LIKE arms + containment tag arm, no strpos; the whole-query tag arm sits inside every term', () => {
    const { sql, values } = clauseFor('alpha beta');
    assert.doesNotMatch(sql, /strpos|EXISTS/);
    assert.equal((sql.match(/LIKE/g) ?? []).length, 4);
    assert.equal((sql.match(/@>/g) ?? []).length, 4); // per term: the whole-query tag arm + the term's own tag arm
    assert.equal(values.filter((v) => v === '["alpha beta"]').length, 1, 'the whole-query tag value is one shared placeholder')
    assert.ok(values.includes('%alpha%') && values.includes('%beta%'));
    assert.equal(sql.split(' AND ').length, 2); // CNF: one OR-group per term
});
await test('a term shorter than a trigram keeps the legacy arms (and so the legacy plan)', () => {
    const { sql } = clauseFor('ab');
    assert.match(sql, /strpos\(lower\(label\)/);
    assert.doesNotMatch(sql, /LIKE|@>/);
});
await test('no terms -> TRUE', () => assert.equal(clauseFor('').sql, 'TRUE'));

console.log('\nbuild retry (fake client, no database)');
/** A client whose CREATE INDEX statements fail with the given errors in order, then succeed. */
function fakeBuildClient(createErrors: Array<Error | null>) {
    const log: string[] = [];
    let creates = 0;
    const client = {
        async query(sql: string) {
            log.push(sql.replace(/\s+/g, ' ').slice(0, 40));
            if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }], rowCount: 1 };
            if (/pg_extension/.test(sql)) return { rows: [{}], rowCount: 1 };
            if (/CREATE INDEX/.test(sql)) { const e = createErrors[creates++]; if (e) throw e; return { rows: [], rowCount: 0 }; }
            return { rows: [], rowCount: 0 };
        },
    };
    return { client: client as never, log, creates: () => creates };
}
const deadlock = (): Error => Object.assign(new Error('deadlock detected'), { code: '40P01' });
await test('a deadlock victim (manual ANALYZE/VACUUM vs CREATE INDEX CONCURRENTLY) is retried and the index is built', async () => {
    const f = fakeBuildClient([deadlock(), null, null, null]);
    const out = await buildKeywordIndexes(f.client, { isCancelled: () => false });
    assert.deepEqual(out.failed, []);
    assert.equal(out.built.length, KEYWORD_INDEXES.length);
    assert.equal(f.creates(), KEYWORD_INDEXES.length + 1);
});
await test('a persistent deadlock gives up after 3 attempts and moves on to the next index; other errors are not retried', async () => {
    const f = fakeBuildClient([deadlock(), deadlock(), deadlock(), new Error('disk full')]);
    const warn = console.warn; console.warn = () => {};
    try {
        const out = await buildKeywordIndexes(f.client, { isCancelled: () => false });
        assert.equal(out.failed.length, 2);
        assert.equal(out.built.length, KEYWORD_INDEXES.length - 2);
        assert.equal(f.creates(), 3 + 1 + (KEYWORD_INDEXES.length - 2), '3 attempts for the first index, 1 for the second (not retried), 1 each for the rest');
    } finally { console.warn = warn; }
});

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-keyword-index (database cases): LORE_PG_URL is not set - postgres cases skipped cleanly');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const node = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}', ...over }) as never;
const oid = async (name: string): Promise<string | undefined> => (await q<{ oid: string }>(`SELECT oid::text FROM pg_class WHERE relname = $1`, [name]))[0]?.oid;

try {
    console.log('\nschema');
    const g = new PostgresGraph(WS, pool);
    await g.initialize();
    await test('open creates pg_trgm and all three indexes, valid', async () => {
        assert.equal((await q(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)).length, 1);
        const have = await validKeywordIndexes(pool);
        for (const s of KEYWORD_INDEXES) assert.ok(have.has(s.name), `${s.name} missing or invalid`);
        const defs = (await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'nodes' AND indexname LIKE '%trgm' OR indexname = 'idx_nodes_tags_gin'`)).map((r) => r.indexdef).join('\n');
        assert.match(defs, /lower\(label\) gin_trgm_ops/);
        assert.match(defs, /lower\(content\) gin_trgm_ops/);
        assert.match(defs, /jsonb_path_ops/);
    });
    await test('re-open is idempotent: nothing rebuilt (index oids unchanged)', async () => {
        const before = await Promise.all(KEYWORD_INDEXES.map((s) => oid(s.name)));
        const g2 = new PostgresGraph(WS, pool);
        await g2.initialize();
        assert.deepEqual(await Promise.all(KEYWORD_INDEXES.map((s) => oid(s.name))), before);
        await g2.close();
    });
    await test('an INVALID leftover (cancelled CREATE INDEX CONCURRENTLY) is dropped and rebuilt on next open', async () => {
        const before = await oid('idx_nodes_label_trgm');
        await q(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_nodes_label_trgm'::regclass`);
        assert.ok(!(await validKeywordIndexes(pool)).has('idx_nodes_label_trgm'));
        const g2 = new PostgresGraph(WS, pool);
        await g2.initialize();
        assert.ok((await validKeywordIndexes(pool)).has('idx_nodes_label_trgm'));
        assert.notEqual(await oid('idx_nodes_label_trgm'), before, 'the invalid index must be replaced, not kept');
        await g2.close();
    });
    await test('a missing index (older DB) is added without touching the others', async () => {
        const keep = await oid('idx_nodes_content_trgm');
        await q('DROP INDEX idx_nodes_tags_gin');
        const g2 = new PostgresGraph(WS, pool);
        await g2.initialize();
        assert.ok((await validKeywordIndexes(pool)).has('idx_nodes_tags_gin'));
        assert.equal(await oid('idx_nodes_content_trgm'), keep);
        await g2.close();
    });

    await test('a large table is not built inline: ensure reports pending, creates nothing; the background build finishes it', async () => {
        for (let i = 0; i < 30; i++) await g.upsertNode(node(`bulk${i}`));
        for (const s of KEYWORD_INDEXES) await q(`DROP INDEX IF EXISTS ${s.name}`);
        const res = await runSchemaBootstrap(pool, {}, (c) => ensureGraphSchema(c, WS, { keywordIndexInlineRowLimit: 5 }));
        assert.equal(res.pending, true);
        assert.equal((await validKeywordIndexes(pool)).size, 0, 'nothing may be built inline above the limit');
        const owner = {};
        await startKeywordIndexBuild(pool, owner);
        assert.equal((await validKeywordIndexes(pool)).size, KEYWORD_INDEXES.length);
        await releaseKeywordIndexBuild(pool, owner);
    });
    await test('PostgresGraph above the limit opens fast, stays searchable, and waitForKeywordIndexes() completes the build', async () => {
        for (const s of KEYWORD_INDEXES) await q(`DROP INDEX IF EXISTS ${s.name}`);
        const g2 = new PostgresGraph(WS, pool, { keywordIndexInlineRowLimit: 5 });
        await g2.initialize();
        assert.ok((await g2.search('bulk7', 5)).length >= 1); // works whether or not the build has landed
        await g2.waitForKeywordIndexes();
        assert.equal((await validKeywordIndexes(pool)).size, KEYWORD_INDEXES.length);
        await g2.close();
    });
    await test('a second builder is refused while one holds the build lock (never drops an index mid-build)', async () => {
        const holder = await pool.connect();
        try {
            await holder.query('SELECT pg_advisory_lock(7364920118)');
            for (const s of KEYWORD_INDEXES) await q(`DROP INDEX IF EXISTS ${s.name}`);
            const c = await pool.connect();
            try {
                const out = await buildKeywordIndexes(c, { isCancelled: () => false });
                assert.equal(out.busy, true);
                assert.equal((await validKeywordIndexes(pool)).size, 0);
            } finally { c.release(); }
        } finally {
            await holder.query('SELECT pg_advisory_unlock(7364920118)');
            holder.release();
        }
    });
    await test('the last owner out cancels a running build promptly and leaves the lock free', async () => {
        for (const s of KEYWORD_INDEXES) await q(`DROP INDEX IF EXISTS ${s.name}`);
        const blocker = await pool.connect();
        const owner = {};
        try {
            await blocker.query('BEGIN');
            await blocker.query('LOCK TABLE nodes IN SHARE MODE'); // CREATE INDEX CONCURRENTLY must queue behind this
            const done = startKeywordIndexBuild(pool, owner);
            await new Promise((r) => setTimeout(r, 400));
            const t0 = Date.now();
            await releaseKeywordIndexBuild(pool, owner);
            await done;
            assert.ok(Date.now() - t0 < 5000, 'cancel must not wait for the blocked statement');
        } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
        }
        const c = await pool.connect();
        try {
            const out = await buildKeywordIndexes(c, { isCancelled: () => false });
            assert.equal(out.busy, false, 'the cancelled build must have released the lock');
            assert.equal((await validKeywordIndexes(pool)).size, KEYWORD_INDEXES.length, 'a later build completes (clears any INVALID leftover)');
        } finally { c.release(); }
    });

    console.log('\nequivalence');
    const edge: Array<[string, string, string[]]> = [
        ['100% done', 'progress is 100%_complete', ['release-1']],
        ['a_b', 'snake_case under_score', []],
        ['path', 'C:\\dir\\file and back\\\\slash', ['c:\\dir']],
        ["O'Brien", "it's the \"quoted\" one", ["o'brien"]],
        ['Café ÉCOLE', 'naïve résumé ÜBER straße', ['café']],
        ['UPPER lower MiXeD', 'Token AUTH oauth2 bearer', ['auth']],
        ['', '', []],
        ['tok', 'token tokens detokenize', ['token', 'release']],
        ['release', 'notes', ['release-1', 'release-2']],
        ['x', 'y', ['x']],
        ['percent', '%%%', ['%']],
        ['underscore', '___', ['_']],
        ['ab cd', 'ab cd ef', ['ab cd']],
        ['two words', 'alpha beta gamma', ['alpha beta']],
    ];
    const g3 = new PostgresGraph(WS, pool);
    await g3.initialize();
    await q('DELETE FROM nodes WHERE workspace_id = $1', [WS]);
    for (const [i, [label, content, tags]] of edge.entries()) await g3.upsertNode(node(`e${i}`, { label, content, tags }));
    const ids = async (query: string, legacy: boolean): Promise<string[]> => {
        const { sql, values } = clauseFor(query, legacy);
        return (await q<{ id: string }>(`SELECT id FROM nodes WHERE workspace_id = $1 AND ${sql} ORDER BY id`, values)).map((r) => r.id);
    };
    const queries = [
        'auth', 'AUTH token', '100%', '%', '_', '___', 'a_b', 'snake_case', 'c:\\dir', '\\', "o'brien", "it's", 'café', 'école', 'ÉCOLE',
        'x', 'ab', 'ab cd', 'tok', 'token', 'release', 'release-1', 'release 1', 'alpha beta', 'alpha', 'alpha gamma', 'beta alpha',
        'zzzz', '...', '%%', '"quoted"', 'two words', 'bearer oauth2', 'the', 'is the', '',
    ];
    await test(`new clause selects exactly the legacy rows for ${queries.length} edge queries`, async () => {
        for (const query of queries) {
            assert.deepEqual(await ids(query, false), await ids(query, true), `query ${JSON.stringify(query)}`);
        }
    });
    await test('the edge queries are not vacuous (several select rows, several select none)', async () => {
        const counts = await Promise.all(queries.map(async (x) => (await ids(x, true)).length));
        assert.ok(counts.filter((n) => n > 0).length >= 15, `only ${counts.filter((n) => n > 0).length} non-empty`);
        assert.ok(counts.filter((n) => n === 0).length >= 3);
    });
    await test('randomised corpus: 400 nodes x 120 queries over an alphabet heavy in LIKE metacharacters', async () => {
        let seed = 7;
        const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const alpha = ['a', 'b', 'c', 'Ab', '%', '_', '\\', "'", 'é', 'Z', 'ab', 'abc', ' ', 'x1'];
        const word = (): string => Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => alpha[Math.floor(rnd() * alpha.length)]).join('');
        await q('DELETE FROM nodes WHERE workspace_id = $1', [WS]);
        for (let i = 0; i < 400; i++) {
            const tags = rnd() < 0.5 ? [word().toLowerCase()] : [];
            await g3.upsertNode(node(`r${i}`, { label: `${word()} ${word()}`, content: Array.from({ length: 6 }, word).join(' '), tags }));
        }
        let nonEmpty = 0;
        for (let i = 0; i < 120; i++) {
            const query = rnd() < 0.5 ? word() : `${word()} ${word()}`;
            const a = await ids(query, false);
            assert.deepEqual(a, await ids(query, true), `query ${JSON.stringify(query)}`);
            if (a.length > 0) nonEmpty++;
        }
        assert.ok(nonEmpty >= 20, `corpus too sparse to mean anything (${nonEmpty})`);
    });
    await test('search() end to end: substring, mixed case, exact tag, metacharacter literal', async () => {
        await q('DELETE FROM nodes WHERE workspace_id = $1', [WS]);
        await g3.upsertNode(node('s1', { label: 'OAuth2 flow', content: 'bearer TOKEN handling', tags: ['security'] }));
        await g3.upsertNode(node('s2', { label: 'other', content: 'about 100%_done', tags: ['release-9'] }));
        await g3.upsertNode(node('s3', { label: 'noise', content: 'unrelated', tags: [] }));
        const find = async (x: string): Promise<string[]> => (await g3.search(x, 10)).map((n) => n.id).sort();
        assert.deepEqual(await find('auth'), ['s1']);       // substring of "OAuth2"
        assert.deepEqual(await find('Token'), ['s1']);      // case-insensitive
        assert.deepEqual(await find('security'), ['s1']);   // exact tag
        assert.deepEqual(await find('release-9'), ['s2']);
        // A punctuation-only query is searched as one literal term: % and _ must not act as wildcards.
        await g3.upsertNode(node('s4', { label: 'pct', content: 'a%%b', tags: [] }));
        await g3.upsertNode(node('s5', { label: 'und', content: 'a__b', tags: [] }));
        assert.deepEqual(await find('%%'), ['s4']);
        assert.deepEqual(await find('__'), ['s5']);
        assert.deepEqual(await find('zzzz'), []);
    });

    console.log('\nplan');
    // Capture the statement the real search() sends, then EXPLAIN it with seq scans disabled: whichever indexes
    // the predicate CAN use are then the ones the planner picks, independent of table size.
    const seen: Array<{ text: string; values: unknown[] }> = [];
    const spy = new Proxy(pool, {
        get(target, prop, recv) {
            if (prop === 'query') {
                return (text: unknown, values?: unknown[]) => {
                    if (typeof text === 'string' && text.startsWith('SELECT * FROM nodes WHERE workspace_id = $1 AND')) seen.push({ text, values: values ?? [] });
                    return (target.query as (...a: unknown[]) => unknown)(text, values);
                };
            }
            return Reflect.get(target, prop, recv);
        },
    }) as Pool;
    const g4 = new PostgresGraph(WS, spy, { cacheDisabled: true });
    await g4.initialize();
    // Enough rows, all in this workspace, for the planner to see the keyword indexes as the selective access path.
    await q('DELETE FROM nodes WHERE workspace_id = $1', [WS]);
    await q(`INSERT INTO nodes (workspace_id, id, label, content, tags, "updatedAt")
             SELECT $1, 'p' || g, md5(g::text), md5((g * 7)::text) || ' ' || md5((g * 13)::text), '["t' || (g % 40) || '"]',
                    to_char(timestamp '2026-01-01' + (g || ' seconds')::interval, 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')
               FROM generate_series(1, 30000) g`, [WS]);
    await g4.upsertNode(node('hit1', { label: 'alpha', content: 'beta', tags: ['beta'] }));
    await q('VACUUM ANALYZE nodes'); // flushes the GIN pending lists the planner would otherwise cost in
    /** `only` drops (inside the rolled-back transaction) every keyword index outside that family, so the plan shows what that family can do. */
    const planOf = async (text: string, values: unknown[], only?: 'legacy' | 'workspace'): Promise<string> => {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            await c.query('SET LOCAL enable_seqscan = off');
            for (const s of KEYWORD_INDEXES) {
                if (only === 'legacy' && s.workspaceLed) await c.query(`DROP INDEX IF EXISTS ${s.name}`);
                if (only === 'workspace' && !s.workspaceLed) await c.query(`DROP INDEX IF EXISTS ${s.name}`);
            }
            const r = await c.query(`EXPLAIN (FORMAT TEXT) ${text}`, values);
            await c.query('ROLLBACK');
            return r.rows.map((x) => x['QUERY PLAN']).join('\n');
        } finally { c.release(); }
    };
    await test('search() statement can use the label, content and tag indexes and a BitmapOr (2 terms, 3+ chars)', async () => {
        seen.length = 0;
        await g4.search('alpha beta', 5);
        assert.equal(seen.length, 1);
        const wsPlan = await planOf(seen[0]!.text, seen[0]!.values, 'workspace');
        for (const s of KEYWORD_INDEXES.filter((x) => x.workspaceLed)) assert.match(wsPlan, new RegExp(s.name), `plan does not use ${s.name}:\n${wsPlan}`);
        assert.match(wsPlan, /BitmapOr/);
        const legacyPlan = await planOf(seen[0]!.text, seen[0]!.values, 'legacy');
        for (const s of KEYWORD_INDEXES.filter((x) => !x.workspaceLed)) assert.match(legacyPlan, new RegExp(s.name), `plan does not use ${s.name}:\n${legacyPlan}`);
        if (process.env.LORE_PRINT_PLANS) console.log(`--- plan, legacy indexes only:\n${legacyPlan}\n--- plan, workspace-led indexes only:\n${wsPlan}`);
    });
    await test('negative control: the legacy statement cannot use any keyword index', async () => {
        const { sql, values } = clauseFor('alpha beta', true);
        const plan = await planOf(`SELECT * FROM nodes WHERE workspace_id = $1 AND ${sql} ORDER BY "updatedAt" DESC, id ASC LIMIT 2000`, values);
        for (const s of KEYWORD_INDEXES) assert.doesNotMatch(plan, new RegExp(s.name));
    });
    await test('a 2-char term still works and uses no trigram index (old plan, documented)', async () => {
        seen.length = 0;
        await g4.search('ab', 5);
        const plan = await planOf(seen[0]!.text, seen[0]!.values);
        assert.doesNotMatch(plan, /idx_nodes_(ws_)?(label|content)_trgm/);
    });
    await g4.close();
    await g3.close();
    await g.close();
} finally {
    await closePostgresPool(pool);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
