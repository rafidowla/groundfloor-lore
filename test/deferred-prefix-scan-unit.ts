#!/usr/bin/env tsx
/**
 * test/deferred-prefix-scan-unit.ts - the deferred-node scan costs the size of the deferred set, not the corpus.
 *
 * Bug (found in the 1M-node Postgres run, 2026-10-22): every recall called findDeferredMatches, whose scan paged
 * the WHOLE node table (all columns incl. content) to keep the few `deferred-*` rows. At 1M nodes each recall
 * spent seconds there, and concurrent recalls on a cold cache each started their own full walk. SQLite does the
 * same walk (cheaper per row, still linear).
 *
 *   engine-agnostic   with an id-prefix lookup on the graph the corpus pager is never touched; resolved nodes are
 *                     still filtered; a failing lookup falls back to the corpus walk; concurrent cold calls share
 *                     ONE scan (single flight); a resolve during a scan cannot repopulate the cache with stale data
 *   sqlite            listNodesByIdPrefix is exact (case-sensitive, `_`/`%` are literals), ordered like the pager,
 *                     answered from the primary-key index (EXPLAIN QUERY PLAN), and recall's scan never pages
 *   postgres          same, plus: workspace-scoped, the text_pattern_ops index exists and the planner can use it
 *                     (skips cleanly when LORE_PG_URL is unset)
 *
 * Run: npx tsx test/deferred-prefix-scan-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, type Pool } from 'pg';

// The scan cache TTL is read at module load: 0 disables it so the cache cannot mask the scan itself.
process.env['LORE_DEFERRED_SCAN_CACHE_TTL_MS'] = '0';
const { findDeferredMatches, stampResolved } = await import('../packages/lore/src/engines/deferred.js');
const { SqliteGraph } = await import('../packages/lore/src/engines/sqliteGraph.js');
const { openSqliteGraph, closeSqliteGraph } = await import('../packages/lore/src/engines/sqlite/sqliteGraphSchema.js');
const { PostgresGraph } = await import('../packages/lore/src/engines/postgres/postgresGraph.js');
const { createPostgresPool, closePostgresPool } = await import('../packages/lore/src/engines/postgres/postgresClient.js');
const { gateDbUrl } = await import('./helpers/testPostgres.js');

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const FILLER = 1500;
const node = (id: string, over: Record<string, unknown> = {}) => ({
    id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}',
    security_scopes: [], ...over,
}) as never;
const deferredNode = (id: string, over: Record<string, unknown> = {}) =>
    node(id, { label: `deferred ${id}`, content: 'reconnect hook lands later', ...over });

/** Ids that must NEVER come back for the prefix `deferred-`. */
const DECOYS = ['Deferred-upper', 'deferredXnodash', 'deferred_underscore', 'xdeferred-inside', 'deferred.dot'];
const DEFERRED = ['deferred-a', 'deferred-b', 'deferred-c-resolved'];

/** Wrap a pager so the test can see how many rows the corpus walk served. */
function spyOnPager(g: { bulkListProjected: (...a: never[]) => Promise<unknown> }): { rows: () => number; calls: () => number } {
    const orig = g.bulkListProjected.bind(g);
    let rows = 0, calls = 0;
    (g as unknown as { bulkListProjected: unknown }).bulkListProjected = async (...a: never[]) => {
        calls++;
        const res = await orig(...a) as { rows: unknown[] };
        rows += res.rows.length;
        return res;
    };
    return { rows: () => rows, calls: () => calls };
}

async function seed(g: { upsertNode: (n: never) => Promise<unknown> }): Promise<void> {
    for (let i = 0; i < FILLER; i++) await g.upsertNode(node(`n-${i}`));
    for (const id of DECOYS) await g.upsertNode(node(id, { content: 'reconnect hook' }));
    for (const id of DEFERRED) await g.upsertNode(deferredNode(id));
    await g.upsertNode(deferredNode('deferred-c-resolved', { metadata: JSON.stringify({ resolved_at: '2026-01-01T00:00:00.000Z' }) }));
}

/* ─── engine-agnostic: fake graph with call counters ─────────────────────────────────────────────────────── */

console.log('\nengine-agnostic');
type Row = Record<string, unknown>;
function fakeGraph(opts: { prefix?: boolean; prefixThrows?: boolean; delayMs?: number } = {}) {
    const rows: Row[] = [
        ...Array.from({ length: 400 }, (_, i) => ({ id: `n-${i}`, label: `n${i}`, content: '', tags: [], metadata: '{}', createdAt: '' })),
        { id: 'deferred-x', label: 'deferred x', content: 'topic-xyz', tags: [], metadata: '{}', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'deferred-gone', label: 'deferred gone', content: 'topic-xyz', tags: [], metadata: JSON.stringify({ resolved_at: '2026-02-02T00:00:00.000Z' }), createdAt: '' },
    ];
    const c = { pagedRows: 0, pagerCalls: 0, prefixCalls: 0, listNodesCalls: 0 };
    const sleep = (): Promise<void> => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
    const g: Record<string, unknown> = {
        async bulkListProjected(_p: string, _cols: readonly string[], limit: number, cursor: { id: string } | null) {
            c.pagerCalls++; await sleep();
            const start = cursor ? rows.findIndex((r) => r['id'] === cursor.id) + 1 : 0;
            const page = rows.slice(start, start + limit);
            c.pagedRows += page.length;
            const more = start + limit < rows.length;
            return { rows: page, nextCursor: more ? { updatedAt: '', id: String(page[page.length - 1]!['id']) } : null };
        },
        async listNodes() { c.listNodesCalls++; return []; },
        async getNode() { return null; },
        async upsertNode(n: unknown) { return n; },
    };
    if (opts.prefix || opts.prefixThrows) {
        g['listNodesByIdPrefix'] = async (prefix: string) => {
            c.prefixCalls++; await sleep();
            if (opts.prefixThrows) throw new Error('boom');
            return rows.filter((r) => String(r['id']).startsWith(prefix));
        };
    }
    return { g: g as never, c, rows };
}

await test('with an id-prefix lookup the corpus is never paged; resolved nodes stay filtered', async () => {
    const { g, c } = fakeGraph({ prefix: true });
    const m = await findDeferredMatches(g, { topic: 'topic-xyz' });
    assert.deepEqual(m.map((x) => x.id), ['deferred-x']);
    assert.equal(c.pagedRows, 0, `corpus walk served ${c.pagedRows} rows`);
    assert.equal(c.pagerCalls, 0);
    assert.equal(c.prefixCalls, 1);
});

await test('without a lookup the old corpus walk still works (cloud / fake handles)', async () => {
    const { g, c } = fakeGraph();
    const m = await findDeferredMatches(g, { topic: 'topic-xyz' });
    assert.deepEqual(m.map((x) => x.id), ['deferred-x']);
    assert.ok(c.pagedRows >= 400);
});

await test('a failing lookup falls back to the corpus walk instead of failing recall', async () => {
    const { g, c } = fakeGraph({ prefixThrows: true });
    const m = await findDeferredMatches(g, { topic: 'topic-xyz' });
    assert.deepEqual(m.map((x) => x.id), ['deferred-x']);
    assert.equal(c.prefixCalls, 1);
    assert.ok(c.pagedRows >= 400);
});

await test('concurrent cold calls share ONE scan (corpus walk)', async () => {
    const { g, c } = fakeGraph({ delayMs: 20 });
    const all = await Promise.all(Array.from({ length: 8 }, () => findDeferredMatches(g, { topic: 'topic-xyz' })));
    for (const m of all) assert.deepEqual(m.map((x) => x.id), ['deferred-x']);
    // one walk = ceil(402 / page) pager calls; eight independent walks would be 8x that
    const oneWalk = (await (async () => { const f = fakeGraph(); await findDeferredMatches(f.g, { topic: 'x' }); return f.c.pagerCalls; })());
    assert.equal(c.pagerCalls, oneWalk, `expected ${oneWalk} pager calls (one walk), saw ${c.pagerCalls}`);
});

await test('concurrent cold calls share ONE scan (prefix lookup)', async () => {
    const { g, c } = fakeGraph({ prefix: true, delayMs: 20 });
    await Promise.all(Array.from({ length: 8 }, () => findDeferredMatches(g, { topic: 'topic-xyz' })));
    assert.equal(c.prefixCalls, 1);
});

await test('a later call after the scan finished starts a new scan (single flight is not a cache)', async () => {
    const { g, c } = fakeGraph({ prefix: true });
    await findDeferredMatches(g, { topic: 'topic-xyz' });
    await findDeferredMatches(g, { topic: 'topic-xyz' });
    assert.equal(c.prefixCalls, 2); // TTL is 0 in this file
});

await test('a failed shared scan is not remembered: the next call retries', async () => {
    const { g, c } = fakeGraph({ delayMs: 5 });
    const orig = (g as unknown as { bulkListProjected: (...a: unknown[]) => Promise<unknown> }).bulkListProjected;
    let fail = true;
    (g as unknown as Record<string, unknown>)['bulkListProjected'] = async (...a: unknown[]) => { if (fail) throw new Error('x'); return orig(...a); };
    (g as unknown as Record<string, unknown>)['listNodes'] = async () => { if (fail) throw new Error('y'); return []; };
    await assert.rejects(findDeferredMatches(g, { topic: 'topic-xyz' }));
    fail = false;
    const m = await findDeferredMatches(g, { topic: 'topic-xyz' });
    assert.deepEqual(m.map((x) => x.id), ['deferred-x']);
    assert.ok(c.pagerCalls >= 1);
});

/* ─── sqlite (real engine) ───────────────────────────────────────────────────────────────────────────────── */

console.log('\nsqlite');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-deferred-prefix-'));
try {
    const g = new SqliteGraph(dir, { workspaceId: 'w', cacheDisabled: true });
    await g.initialize();
    await seed(g);
    const lookup = (g as unknown as { listNodesByIdPrefix: (p: string, c: readonly string[]) => Promise<Row[]> }).listNodesByIdPrefix.bind(g);

    await test('listNodesByIdPrefix returns exactly the deferred- ids (case-sensitive, _ and . are literals)', async () => {
        const rows = await lookup('deferred-', ['label', 'content', 'tags', 'metadata', 'createdAt']);
        assert.deepEqual(rows.map((r) => r['id']).sort(), [...DEFERRED].sort());
        for (const r of rows) {
            assert.equal(typeof r['label'], 'string');
            assert.ok(Array.isArray(r['tags']), 'tags normalised like the pager');
            assert.equal(typeof r['metadata'], 'string');
        }
    });

    await test('a prefix made of LIKE/GLOB metacharacters matches literally', async () => {
        await g.upsertNode(node('a%b-1')); await g.upsertNode(node('a_b-1')); await g.upsertNode(node('axb-1')); await g.upsertNode(node('a*b-1'));
        assert.deepEqual((await lookup('a%b', [])).map((r) => r['id']), ['a%b-1']);
        assert.deepEqual((await lookup('a_b', [])).map((r) => r['id']), ['a_b-1']);
        assert.deepEqual((await lookup('a*b', [])).map((r) => r['id']), ['a*b-1']);
    });

    await test('ordered like the corpus pager (updatedAt DESC, id ASC)', async () => {
        const viaLookup = (await lookup('deferred-', [])).map((r) => r['id']);
        const viaPager: unknown[] = [];
        let cursor: { updatedAt: string; id: string } | null = null;
        do {
            const page: { rows: Row[]; nextCursor: { updatedAt: string; id: string } | null } = await g.bulkListProjected('*', [], 500, cursor);
            for (const r of page.rows) if (String(r['id']).startsWith('deferred-')) viaPager.push(r['id']);
            cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(viaLookup, viaPager);
    });

    await test('recall scan on a real SqliteGraph never pages the corpus, and still finds + filters correctly', async () => {
        const spy = spyOnPager(g as never);
        const m = await findDeferredMatches(g as never, { topic: 'reconnect hook' });
        assert.deepEqual(m.map((x) => x.id).sort(), ['deferred-a', 'deferred-b']); // c is resolved, decoys are not deferred-*
        assert.equal(spy.rows(), 0, `corpus walk served ${spy.rows()} of ${FILLER + 12} rows`);
    });

    await test('stampResolved takes a node out of the scan immediately', async () => {
        await stampResolved(g as never, 'deferred-a');
        const m = await findDeferredMatches(g as never, { topic: 'reconnect hook' });
        assert.deepEqual(m.map((x) => x.id), ['deferred-b']);
    });
    await g.close();

    await test('EXPLAIN QUERY PLAN: the prefix query is a primary-key SEARCH, not a table SCAN', async () => {
        const { db } = openSqliteGraph(dir);
        try {
            const { listNodesByIdPrefix } = await import('../packages/lore/src/engines/sqlite/sqliteGraphAggregates.js');
            const { sqliteIdPrefixSql } = await import('../packages/lore/src/engines/sqlite/sqliteGraphAggregates.js') as unknown as { sqliteIdPrefixSql?: (cols: string[], prefix: string) => { sql: string; params: unknown[] } };
            assert.equal(typeof listNodesByIdPrefix, 'function');
            assert.equal(typeof sqliteIdPrefixSql, 'function', 'aggregates must export the SQL builder so the plan can be asserted');
            const q = sqliteIdPrefixSql!(['id', 'updatedAt'], 'deferred-');
            const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
            assert.match(plan, /SEARCH nodes USING (COVERING )?INDEX sqlite_autoindex_nodes_1 \(id>\? AND id<\?\)|SEARCH nodes USING (COVERING )?INDEX sqlite_autoindex_nodes_1 \(id>=\? AND id<\?\)/, plan);
            assert.doesNotMatch(plan, /SCAN nodes(?! USING)/, plan);
        } finally { closeSqliteGraph(db); }
    });
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

/* ─── postgres (real engine, gated) ──────────────────────────────────────────────────────────────────────── */

console.log('\npostgres');
const gate = gateDbUrl();
if (!gate) {
    console.log('  SKIP postgres: LORE_PG_URL is not set - postgres cases skipped cleanly');
} else {
    const DB = 'lore_gate_deferred';
    const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
    const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
    const admin = async (sql: string): Promise<void> => {
        const c = new Client({ connectionString: adminUrl.toString() });
        await c.connect();
        try { await c.query(sql); } finally { await c.end(); }
    };
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${DB}`);
    const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
    try {
        const g = new PostgresGraph('pg-gate-deferred-a', pool); await g.initialize();
        const other = new PostgresGraph('pg-gate-deferred-b', pool); await other.initialize();
        await other.upsertNode(deferredNode('deferred-other-workspace'));
        await seed(g);
        const lookup = (g as unknown as { listNodesByIdPrefix: (p: string, c: readonly string[]) => Promise<Row[]> }).listNodesByIdPrefix.bind(g);

        await test('listNodesByIdPrefix returns exactly this workspace\'s deferred- ids (case-sensitive, _ literal)', async () => {
            const rows = await lookup('deferred-', ['label', 'content', 'tags', 'metadata', 'createdAt']);
            assert.deepEqual(rows.map((r) => r['id']).sort(), [...DEFERRED].sort());
            for (const r of rows) assert.ok(Array.isArray(r['tags']));
        });

        await test('a prefix made of LIKE metacharacters matches literally', async () => {
            await g.upsertNode(node('a%b-1')); await g.upsertNode(node('a_b-1')); await g.upsertNode(node('axb-1')); await g.upsertNode(node('a\\b-1'));
            assert.deepEqual((await lookup('a%b', [])).map((r) => r['id']), ['a%b-1']);
            assert.deepEqual((await lookup('a_b', [])).map((r) => r['id']), ['a_b-1']);
            assert.deepEqual((await lookup('a\\b', [])).map((r) => r['id']), ['a\\b-1']);
        });

        await test('ordered like the corpus pager (updatedAt DESC, id ASC)', async () => {
            const viaLookup = (await lookup('deferred-', [])).map((r) => r['id']);
            const viaPager: unknown[] = [];
            let cursor: { updatedAt: string; id: string } | null = null;
            do {
                const page: { rows: Row[]; nextCursor: { updatedAt: string; id: string } | null } = await g.bulkListProjected('*', [], 500, cursor);
                for (const r of page.rows) if (String(r['id']).startsWith('deferred-')) viaPager.push(r['id']);
                cursor = page.nextCursor;
            } while (cursor);
            assert.deepEqual(viaLookup, viaPager);
        });

        await test('recall scan on a real PostgresGraph never pages the corpus, and still finds + filters correctly', async () => {
            const spy = spyOnPager(g as never);
            const m = await findDeferredMatches(g as never, { topic: 'reconnect hook' });
            assert.deepEqual(m.map((x) => x.id).sort(), ['deferred-a', 'deferred-b']);
            assert.equal(spy.rows(), 0, `corpus walk served ${spy.rows()} rows`);
        });

        await test('the (workspace_id, id text_pattern_ops) index exists', async () => {
            const r = await pool.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'nodes' AND indexname = 'idx_nodes_id_prefix'`);
            assert.equal(r.rows.length, 1);
            assert.match(String(r.rows[0].indexdef), /\(workspace_id, id text_pattern_ops\)/);
        });

        await test('the planner answers the prefix query from that index (seqscan disabled: tiny table)', async () => {
            const c = await pool.connect();
            try {
                await c.query('BEGIN');
                await c.query('SET LOCAL enable_seqscan = off');
                const plan = (await c.query(
                    `EXPLAIN SELECT id FROM nodes WHERE workspace_id = $1 AND id LIKE $2`, ['pg-gate-deferred-a', 'deferred-%'],
                )).rows.map((r) => r['QUERY PLAN']).join('\n');
                await c.query('ROLLBACK');
                assert.match(plan, /idx_nodes_id_prefix/, plan);
            } finally { c.release(); }
        });

        await test('re-opening a graph on an existing database is idempotent (index DDL runs on every open)', async () => {
            const g2 = new PostgresGraph('pg-gate-deferred-a', pool); await g2.initialize();
            assert.equal((await (g2 as never as { listNodesByIdPrefix: (p: string, c: readonly string[]) => Promise<Row[]> }).listNodesByIdPrefix('deferred-', [])).length, DEFERRED.length);
        });
        await g.close(); await other.close();
    } finally {
        await closePostgresPool(pool);
        await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
